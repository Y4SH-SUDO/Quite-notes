import assert from 'node:assert/strict';
import test from 'node:test';
import { NoteFlagSaveCoordinator, NoteWriteQueue, type NoteFlagValues, type PendingNoteFlagSave } from './note-actions.ts';
import type { QuietNote } from '../quiet-storage.ts';

const noteA: QuietNote = {
  id: 'note-a',
  title: 'Note A',
  kind: 'note',
  content: '',
  createdAt: 10,
  updatedAt: 20,
  recentlyOpenedAt: 20,
};

const noteB: QuietNote = {
  ...noteA,
  id: 'note-b',
  title: 'Note B',
};

const snapshot = (coordinator: NoteFlagSaveCoordinator): PendingNoteFlagSave[] =>
  coordinator.getPending();

function createMemoryPersistence(initial: QuietNote[]) {
  const queue = new NoteWriteQueue();
  const notes = new Map(initial.map(note => [note.id, note]));
  const writeNote = (note: QuietNote) => {
    const existing = notes.get(note.id);
    notes.set(note.id, {
      ...note,
      ...(existing?.pinned === undefined ? {} : { pinned: existing.pinned }),
      ...(existing?.favorite === undefined ? {} : { favorite: existing.favorite }),
    });
  };
  return {
    notes,
    run: queue.run.bind(queue),
    saveNote(note: QuietNote) {
      return queue.run(note.id, async () => { writeNote(note); });
    },
    saveNoteAfter(note: QuietNote, beforeWrite: () => Promise<void>) {
      return queue.run(note.id, async () => {
        await beforeWrite();
        writeNote(note);
      });
    },
    saveFlags(noteId: string, flags: NoteFlagValues) {
      return queue.run(noteId, async () => {
        const existing = notes.get(noteId);
        if (!existing) throw new Error('The note no longer exists.');
        notes.set(noteId, {
          ...existing,
          ...flags,
          updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
        });
      });
    },
  };
}

test('a failed save for one note remains independently retryable after another note changes', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  const persistence = createMemoryPersistence([noteA, noteB]);
  const failA = async (noteId: string, flags: NoteFlagValues) => {
    if (noteId === noteA.id) throw new Error('A is temporarily unavailable.');
    await persistence.saveFlags(noteId, flags);
  };
  const failB = async (noteId: string, flags: NoteFlagValues) => {
    if (noteId === noteB.id) throw new Error('B is temporarily unavailable.');
    await persistence.saveFlags(noteId, flags);
  };

  await coordinator.save({ ...noteA, pinned: true, updatedAt: 21 }, 'pinned', failA);
  await coordinator.save({ ...noteB, favorite: true, updatedAt: 22 }, 'favorite', failB);

  assert.deepEqual(snapshot(coordinator).map(item => [item.note.id, item.status]), [
    [noteA.id, 'error'],
    [noteB.id, 'error'],
  ]);
  assert.equal(coordinator.getPendingNote(noteA.id)?.pinned, true);
  assert.equal(coordinator.getPendingNote(noteB.id)?.favorite, true);

  await coordinator.retry(noteA.id, persistence.saveFlags);
  assert.equal(persistence.notes.get(noteA.id)?.pinned, true);
  assert.equal(snapshot(coordinator).length, 1);
  assert.equal(snapshot(coordinator)[0].note.id, noteB.id);
});

test('an older failed request cannot overwrite a newer successful state', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  const writes: NoteFlagValues[] = [];
  let rejectOld!: (error: Error) => void;
  let resolveNew!: () => void;
  const persist = (_noteId: string, flags: NoteFlagValues) => new Promise<void>((resolve, reject) => {
    writes.push(flags);
    if (writes.length === 1) rejectOld = reject;
    else resolveNew = resolve;
  });

  const olderSave = coordinator.save({ ...noteA, pinned: true, updatedAt: 21 }, 'pinned', persist);
  const newerSave = coordinator.save({ ...noteA, pinned: false, favorite: true, updatedAt: 22 }, 'favorite', persist);
  await Promise.resolve();
  assert.equal(writes.length, 2);
  resolveNew();
  await newerSave;
  rejectOld(new Error('The older request failed.'));
  await olderSave;
  assert.deepEqual(coordinator.getPending(), []);
  assert.deepEqual(writes, [{ pinned: true }, { pinned: true, favorite: true }]);
});

test('retry merges a failed pin into content saved by the editor afterward', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  const persistence = createMemoryPersistence([noteA]);
  let failFirstWrite!: () => void;
  const pendingPin = coordinator.save(
    { ...noteA, pinned: true, updatedAt: 21 },
    'pinned',
    (noteId, _flags) => persistence.run(noteId, async () => {
      await new Promise<void>(resolve => { failFirstWrite = resolve; });
      throw new Error('Initial flag write failed.');
    }),
  );
  const editorSave = persistence.saveNote({
    ...noteA,
    title: 'Edited title',
    content: '<p>New editor content</p>',
    updatedAt: 22,
  });
  await Promise.resolve();
  failFirstWrite();
  await Promise.all([pendingPin, editorSave]);

  await coordinator.retry(noteA.id, persistence.saveFlags);

  assert.equal(persistence.notes.get(noteA.id)?.title, 'Edited title');
  assert.equal(persistence.notes.get(noteA.id)?.content, '<p>New editor content</p>');
  assert.equal(persistence.notes.get(noteA.id)?.pinned, true);
  assert.deepEqual(coordinator.getPending(), []);
});

test('editor and flag writes serialize safely regardless of which write starts first', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  const persistence = createMemoryPersistence([noteA]);
  let releaseEditor!: () => void;
  const editorSave = persistence.saveNoteAfter({
    ...noteA,
    title: 'Editor first',
    content: '<p>Editor content</p>',
    updatedAt: 21,
  }, () => new Promise<void>(resolve => { releaseEditor = resolve; }));
  const flagSave = coordinator.save(
    { ...noteA, pinned: true, updatedAt: 22 },
    'pinned',
    persistence.saveFlags,
  );
  await Promise.resolve();
  assert.equal(persistence.notes.get(noteA.id)?.content, '');

  releaseEditor();
  await Promise.all([editorSave, flagSave]);
  assert.equal(persistence.notes.get(noteA.id)?.title, 'Editor first');
  assert.equal(persistence.notes.get(noteA.id)?.content, '<p>Editor content</p>');
  assert.equal(persistence.notes.get(noteA.id)?.pinned, true);
  assert.deepEqual(coordinator.getPending(), []);
});

test('a newer pin change carries forward and resolves the pending favorite intent', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  const persistence = createMemoryPersistence([noteA]);
  let initialAttempt = true;
  const persist = async (noteId: string, flags: NoteFlagValues) => {
    if (initialAttempt) {
      initialAttempt = false;
      throw new Error('Favorite write failed.');
    }
    await persistence.saveFlags(noteId, flags);
  };
  await coordinator.save({ ...noteA, favorite: true, updatedAt: 21 }, 'favorite', persist);
  await coordinator.save(
    { ...noteA, pinned: true, favorite: true, updatedAt: 22 },
    'pinned',
    persist,
  );

  await coordinator.retry(noteA.id, persistence.saveFlags);

  assert.equal(persistence.notes.get(noteA.id)?.pinned, true);
  assert.equal(persistence.notes.get(noteA.id)?.favorite, true);
  assert.deepEqual(coordinator.getPending(), []);
});

test('a second retry failure remains visible with the newest error', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  await coordinator.save(
    { ...noteA, pinned: true, updatedAt: 21 },
    'pinned',
    async () => { throw new Error('Initial failure.'); },
  );
  await coordinator.retry(noteA.id, async () => { throw new Error('Retry failed again.'); });

  assert.deepEqual(coordinator.getPending().map(item => ({
    id: item.note.id,
    flags: item.flags,
    status: item.status,
    error: item.error,
    attempt: item.attempt,
  })), [{
    id: noteA.id,
    flags: { pinned: true },
    status: 'error',
    error: 'Retry failed again.',
    attempt: 2,
  }]);
});

test('choosing the cloud version clears pending local intent before retry', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  const persistence = createMemoryPersistence([noteA]);
  await coordinator.save(
    { ...noteA, pinned: true, updatedAt: 21 },
    'pinned',
    async () => { throw new Error('Initial flag write failed.'); },
  );
  persistence.notes.set(noteA.id, {
    ...noteA,
    title: 'Cloud version',
    content: '<p>Cloud content</p>',
    pinned: false,
    updatedAt: 22,
  });

  coordinator.clear(noteA.id);
  await coordinator.retry(noteA.id, persistence.saveFlags);

  assert.equal(persistence.notes.get(noteA.id)?.title, 'Cloud version');
  assert.equal(persistence.notes.get(noteA.id)?.content, '<p>Cloud content</p>');
  assert.equal(persistence.notes.get(noteA.id)?.pinned, false);
  assert.deepEqual(coordinator.getPending(), []);
});

test('remote application is blocked by pending saves and stale cloud resolutions', async () => {
  const coordinator = new NoteFlagSaveCoordinator();
  await coordinator.save(
    { ...noteA, pinned: true, updatedAt: 21 },
    'pinned',
    async () => { throw new Error('The local flag save failed.'); },
  );
  const expectedRevision = coordinator.getRevision(noteA.id);

  assert.equal(coordinator.canApplyRemote(noteA.id, false), false);
  assert.equal(coordinator.canApplyRemote(noteA.id, true, expectedRevision), true);

  await coordinator.save(
    { ...noteA, favorite: true, updatedAt: 22 },
    'favorite',
    async () => { throw new Error('The newer local flag save failed.'); },
  );

  assert.equal(coordinator.canApplyRemote(noteA.id, true, expectedRevision), false);
  assert.equal(coordinator.canApplyRemote(noteB.id, false), true);
});
