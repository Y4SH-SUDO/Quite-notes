import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CloudSyncStageError,
  NoteConflictResolutionError,
  cloudImageUploadTimeoutMs,
  decidePendingNoteSync,
  decideNoteSync,
  noteForCloud,
  uploadLatestDeviceConflictVersion,
  waitForImageUpload,
} from './cloud-sync.ts';
import type { QuietNote } from '../quiet-storage.ts';
import { NoteFlagSaveCoordinator } from './note-actions.ts';

const note: QuietNote = {
  id: 'sync-task',
  title: 'Task',
  kind: 'task',
  content: '',
  createdAt: 10,
  updatedAt: 20,
  recentlyOpenedAt: 20,
};

test('sync downloads remote-only notes and uploads local-only notes', () => {
  assert.equal(decideNoteSync(undefined, note, undefined), 'download');
  assert.equal(decideNoteSync(note, undefined, undefined), 'upload');
});

test('sync accepts identical first-sync copies without conflict', () => {
  assert.equal(decideNoteSync(note, { ...note }, undefined), 'same');
});

test('sync detects concurrent changes from their last shared revision', () => {
  const local = { ...note, updatedAt: 30 };
  const cloud = { ...note, updatedAt: 40 };
  assert.equal(decideNoteSync(local, cloud, note.updatedAt), 'conflict');
  assert.equal(decideNoteSync(local, note, note.updatedAt), 'upload');
  assert.equal(decideNoteSync(note, cloud, note.updatedAt), 'download');
  assert.equal(decideNoteSync(note, note, note.updatedAt), 'none');
});

test('pin and favorite updates remain in the synchronized note and are conflict-aware', async () => {
  const original = { ...note, pinned: false, favorite: false };
  const updated = { ...original, pinned: true, favorite: true, updatedAt: note.updatedAt + 1 };
  const prepared = await noteForCloud(updated, 'account-id', undefined);

  assert.deepEqual(prepared.note, updated);
  assert.equal(decideNoteSync(updated, original, original.updatedAt), 'upload');
  assert.equal(decideNoteSync(updated, { ...original, updatedAt: original.updatedAt + 1 }, original.updatedAt), 'conflict');
});

test('a pending pin or favorite conflicts with a newer cloud revision instead of downloading over it', async () => {
  for (const flag of ['pinned', 'favorite'] as const) {
    const coordinator = new NoteFlagSaveCoordinator();
    const local = { ...note, pinned: false, favorite: false };
    const intended = { ...local, [flag]: true, updatedAt: note.updatedAt + 1 };
    await coordinator.save(intended, flag, async () => {
      throw new Error('The local flag save failed.');
    });
    const remote = { ...local, [flag]: false, updatedAt: note.updatedAt + 2 };
    const pending = coordinator.getPendingSave(note.id);
    assert.ok(pending);

    const result = decidePendingNoteSync(local, remote, note.updatedAt, pending);

    assert.equal(result.decision, 'conflict');
    assert.equal(result.localNote[flag], true);
    assert.equal(coordinator.hasPending(note.id), true);
  }
});

test('a remote change to another flag preserves independent pending local intent', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  const local = { ...note, pinned: false, favorite: false };
  await coordinator.save(
    { ...local, favorite: true, updatedAt: note.updatedAt + 1 },
    'favorite',
    async () => { throw new Error('The local favorite save failed.'); },
  );
  const pending = coordinator.getPendingSave(note.id);
  assert.ok(pending);

  const result = decidePendingNoteSync(
    local,
    { ...local, pinned: true, updatedAt: note.updatedAt + 2 },
    note.updatedAt,
    pending,
  );

  assert.equal(result.decision, 'conflict');
  assert.equal(result.localNote.favorite, true);
  assert.equal(result.localNote.pinned, false);
  assert.equal(coordinator.getPendingSave(note.id)?.flags.favorite, true);
});

test('device conflict resolution rejects a coordinator revision change before upload', async () => {
  for (const flag of ['pinned', 'favorite'] as const) {
    const coordinator = new NoteFlagSaveCoordinator();
    let local = { ...note, pinned: false, favorite: false };
    let writes = 0;

    await assert.rejects(
      uploadLatestDeviceConflictVersion(
        note.id,
        coordinator.getRevision(note.id),
        30,
        coordinator,
        async () => {
          await coordinator.save(
            { ...local, [flag]: true, updatedAt: 21 },
            flag,
            async () => { throw new Error('Local save is pending.'); },
          );
          return local;
        },
        async () => { writes += 1; return true; },
      ),
      NoteConflictResolutionError,
    );

    assert.equal(writes, 0);
    assert.equal(coordinator.getPendingSave(note.id)?.flags[flag], true);
  }
});

test('device conflict resolution reconciles flag changes made during upload with Firestore CAS', async () => {
  for (const flag of ['pinned', 'favorite'] as const) {
    const coordinator = new NoteFlagSaveCoordinator();
    const local = { ...note, pinned: false, favorite: false };
    const intended = { ...local, [flag]: true, updatedAt: 21 };
    const writes: Array<{ note: QuietNote; expectedRemoteUpdatedAt: number }> = [];

    const resolved = await uploadLatestDeviceConflictVersion(
      note.id,
      coordinator.getRevision(note.id),
      30,
      coordinator,
      async () => local,
      async (uploaded, expectedRemoteUpdatedAt) => {
        writes.push({ note: uploaded, expectedRemoteUpdatedAt });
        if (writes.length === 1) {
          await coordinator.save(
            intended,
            flag,
            async () => { throw new Error('Local save is pending.'); },
          );
        }
        return true;
      },
    );

    assert.equal(writes.length, 2);
    assert.equal(writes[0].note[flag], false);
    assert.equal(writes[0].expectedRemoteUpdatedAt, 30);
    assert.equal(writes[1].note[flag], true);
    assert.equal(writes[1].expectedRemoteUpdatedAt, writes[0].note.updatedAt);
    assert.equal(resolved[flag], true);
  }
});

test('first-sync ID collisions are conflicts unless contents clearly match', () => {
  assert.equal(decideNoteSync(note, { ...note, title: 'Other device edit' }, undefined), 'conflict');
});

test('sync stage errors identify the operation and retain Firebase error codes', () => {
  const firebaseError = Object.assign(new Error('The error message is not shown to users.'), {
    code: 'firestore/permission-denied',
  });
  const error = new CloudSyncStageError('listing notes in Firestore', firebaseError);

  assert.equal(error.stage, 'listing notes in Firestore');
  assert.equal(error.code, 'firestore/permission-denied');
  assert.equal(error.message, 'Cloud sync failed during listing notes in Firestore.');
});

test('a hanging image upload is cancelled after its per-image deadline', async () => {
  let cancelled = false;
  await assert.rejects(
    waitForImageUpload(
      () => () => {},
      () => { cancelled = true; },
      5,
    ),
    /did not finish within 5 ms/,
  );
  assert.equal(cancelled, true);
  assert.equal(cloudImageUploadTimeoutMs, 8_000);
});

test('ordinary text notes and tasks are ready to sync without Firebase Storage', async () => {
  for (const kind of ['note', 'task'] as const) {
    const localNote = { ...note, kind, content: '<p>Keep this text on every device.</p>' };
    const prepared = await noteForCloud(localNote, 'account-id', undefined);

    assert.deepEqual(prepared.note, localNote);
    assert.equal(prepared.uploadedImages, 0);
    assert.deepEqual(prepared.imageFailures, []);
    assert.equal(prepared.storageUnavailable, false);
    assert.equal(decideNoteSync(localNote, undefined, undefined), 'upload');
  }
});

test('an image without Storage is omitted from the cloud copy and remains in the local note', async () => {
  const originalParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  let serializedContent = '<p>Local text</p><img src="data:image/png;base64,AA==" alt="local image">';
  const imageTag = '<img src="data:image/png;base64,AA==" alt="local image">';

  class TestImage {
    private source = 'data:image/png;base64,AA==';

    getAttribute(name: string) {
      return name === 'src' ? this.source : null;
    }

    setAttribute(name: string, value: string) {
      if (name === 'src') this.source = value;
    }

    remove() {
      serializedContent = serializedContent.replace(imageTag, '');
    }
  }

  class TestDOMParser {
    parseFromString() {
      return {
        body: { get innerHTML() { return serializedContent; } },
        querySelectorAll: () => [new TestImage()],
      };
    }
  }

  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: TestDOMParser,
  });
  try {
    const localNote = {
      ...note,
      kind: 'note' as const,
      content: serializedContent,
    };
    const prepared = await noteForCloud(localNote, 'account-id', undefined);

    assert.equal(prepared.note.content, '<p>Local text</p>');
    assert.equal(localNote.content, '<p>Local text</p><img src="data:image/png;base64,AA==" alt="local image">');
    assert.deepEqual(prepared.imageFailures, [{
      noteId: localNote.id,
      noteTitle: localNote.title,
      imageNumber: 1,
    }]);
    assert.equal(prepared.storageUnavailable, true);
  } finally {
    if (originalParser) Object.defineProperty(globalThis, 'DOMParser', originalParser);
    else Reflect.deleteProperty(globalThis, 'DOMParser');
  }
});
