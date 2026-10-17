import {
  collection,
  doc,
  getDocs,
  runTransaction,
  type Firestore,
} from 'firebase/firestore';
import {
  getBytes,
  getMetadata,
  ref,
  uploadBytesResumable,
  type FirebaseStorage,
  type UploadTask,
} from 'firebase/storage';
import type { QuietNote } from '../quiet-storage';
import { quietStorage } from '../quiet-storage.ts';

type CloudNote = {
  note: QuietNote;
  schemaVersion: 1;
};

export type NoteSyncConflict = {
  id: string;
  localNote: QuietNote | null;
  cloudNote: QuietNote;
};

export type SyncResult = {
  downloaded: number;
  uploaded: number;
  deleted: number;
  conflicts: NoteSyncConflict[];
  imageFailures: ImageSyncFailure[];
};

export type ImageSyncFailure = {
  noteId: string;
  noteTitle: string;
  imageNumber: number;
};

export type SyncDecision = 'download' | 'upload' | 'same' | 'conflict' | 'none';

const cloudImagePrefix = 'quiet-cloud-image:';
export const cloudImageUploadTimeoutMs = 8_000;

export type PreparedCloudNote = {
  note: QuietNote;
  uploadedImages: number;
  imageFailures: ImageSyncFailure[];
  storageUnavailable: boolean;
};

export type SyncStageReporter = (stage: string) => void;

export class CloudSyncStageError extends Error {
  readonly stage: string;
  readonly code: string;

  constructor(
    stage: string,
    cause: unknown,
  ) {
    super(`Cloud sync failed during ${stage}.`, { cause });
    this.name = 'CloudSyncStageError';
    this.stage = stage;
    this.code = errorCode(cause);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return '';
}

async function atSyncStage<T>(
  stage: string,
  operation: () => Promise<T>,
  reportStage?: SyncStageReporter,
): Promise<T> {
  reportStage?.(stage);
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CloudSyncStageError) throw error;
    throw new CloudSyncStageError(stage, error);
  }
}

export function decideNoteSync(
  local: QuietNote | undefined,
  cloud: QuietNote | undefined,
  baseUpdatedAt: number | undefined,
): SyncDecision {
  if (!local && cloud) return 'download';
  if (local && !cloud) return 'upload';
  if (!local || !cloud) return 'none';
  if (baseUpdatedAt === undefined) {
    return JSON.stringify(local) === JSON.stringify(cloud)
      ? 'same'
      : 'conflict';
  }
  const localChanged = local.updatedAt !== baseUpdatedAt;
  const cloudChanged = cloud.updatedAt !== baseUpdatedAt;
  if (localChanged && cloudChanged) return 'conflict';
  if (localChanged) return 'upload';
  if (cloudChanged) return 'download';
  return 'none';
}

function pathNoteId(noteId: string): string {
  if (!noteId || noteId.includes('/')) {
    throw new Error('This note ID cannot be represented safely in cloud storage.');
  }
  return noteId;
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('A synced image could not be read.'));
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('A synced image could not be converted.'));
    };
    reader.readAsDataURL(blob);
  });
}

export function waitForImageUpload(
  subscribe: (complete: () => void, fail: (error: Error) => void) => () => void,
  cancel: () => void,
  timeoutMs = cloudImageUploadTimeoutMs,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();
      const timeoutError = new Error(`Image upload did not finish within ${timeoutMs} ms.`);
      try {
        cancel();
        reject(timeoutError);
      } catch (error) {
        reject(new Error('The timed-out image upload could not be cancelled.', { cause: error }));
      }
    }, timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      if (error) reject(error);
      else resolve();
    };
    unsubscribe = subscribe(() => finish(), error => finish(error));
  });
}

function withImageTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`Image transfer did not finish within ${cloudImageUploadTimeoutMs} ms.`)),
        cloudImageUploadTimeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

export async function noteForCloud(
  note: QuietNote,
  userId: string,
  storage: FirebaseStorage | undefined,
  reportStage?: SyncStageReporter,
  existingCloudNote?: QuietNote,
): Promise<PreparedCloudNote> {
  if (!/<img\b/i.test(note.content)) {
    return { note, uploadedImages: 0, imageFailures: [], storageUnavailable: false };
  }
  const content = new DOMParser().parseFromString(note.content, 'text/html');
  const images = Array.from(content.querySelectorAll<HTMLImageElement>('img'));
  const existingImages = existingCloudNote
    ? new DOMParser().parseFromString(existingCloudNote.content, 'text/html')
      .querySelectorAll<HTMLImageElement>('img')
    : [];
  const imageFailures: ImageSyncFailure[] = [];
  let uploadedImages = 0;
  let imageStorage = storage;
  for (const [index, image] of images.entries()) {
    const source = image.getAttribute('src') ?? '';
    if (!source.startsWith('data:image/')) continue;
    const path = `users/${userId}/notes/${pathNoteId(note.id)}/images/${note.updatedAt}-${index}`;
    const cloudImageSource = `${cloudImagePrefix}${encodeURIComponent(path)}`;
    if (existingImages[index]?.getAttribute('src') === cloudImageSource) {
      image.setAttribute('src', cloudImageSource);
      continue;
    }
    if (!imageStorage) {
      image.remove();
      imageFailures.push({
        noteId: note.id,
        noteTitle: note.title,
        imageNumber: index + 1,
      });
      continue;
    }
    try {
      const storageForImage = imageStorage;
      await atSyncStage('uploading an image to Firebase Storage', async () => {
        const response = await fetch(source);
        if (!response.ok) throw new Error('The local image data could not be read.');
        const blob = await response.blob();
        const task = uploadBytesResumable(ref(storageForImage, path), blob, {
          contentType: source.slice(5, source.indexOf(';')),
        });
        await waitForImageUpload(
          (complete, fail) => task.on('state_changed', undefined, fail, complete),
          () => { task.cancel(); },
        );
      }, reportStage);
      image.setAttribute('src', cloudImageSource);
      uploadedImages += 1;
    } catch {
      imageStorage = undefined;
      image.remove();
      imageFailures.push({
        noteId: note.id,
        noteTitle: note.title,
        imageNumber: index + 1,
      });
    }
  }
  return {
    note: { ...note, content: content.body.innerHTML },
    uploadedImages,
    imageFailures,
    storageUnavailable: imageStorage === undefined,
  };
}

async function noteFromCloud(
  note: QuietNote,
  userId: string,
  storage: FirebaseStorage | undefined,
  reportStage?: SyncStageReporter,
  onImageFailure?: (failure: ImageSyncFailure) => void,
): Promise<QuietNote> {
  const content = new DOMParser().parseFromString(note.content, 'text/html');
  const images = Array.from(content.querySelectorAll<HTMLImageElement>('img'));
  let imageStorage = storage;
  for (const [index, image] of images.entries()) {
    const source = image.getAttribute('src') ?? '';
    if (!source.startsWith(cloudImagePrefix)) continue;
    try {
      const path = decodeURIComponent(source.slice(cloudImagePrefix.length));
      if (!path.startsWith(`users/${userId}/notes/`)) {
        throw new Error('The cloud backup references an image outside this account.');
      }
      if (!imageStorage) throw new Error('Firebase Storage is not configured.');
      const storageForImage = imageStorage;
      const [bytes, metadata] = await atSyncStage(
        'downloading an image from Firebase Storage',
        () => withImageTimeout(Promise.all([
          getBytes(ref(storageForImage, path), 13 * 1024 * 1024),
          getMetadata(ref(storageForImage, path)),
        ])),
        reportStage,
      );
      const blob = new Blob([bytes], { type: metadata.contentType ?? 'application/octet-stream' });
      image.setAttribute('src', await atSyncStage(
        'restoring a downloaded image on this device',
        () => withImageTimeout(toDataUrl(blob)),
        reportStage,
      ));
    } catch {
      imageStorage = undefined;
      image.remove();
      onImageFailure?.({
        noteId: note.id,
        noteTitle: note.title,
        imageNumber: index + 1,
      });
    }
  }
  return { ...note, content: content.body.innerHTML };
}

function asCloudNote(value: unknown, id: string): CloudNote {
  if (typeof value !== 'object' || value === null || !('note' in value)) {
    throw new Error(`Cloud note "${id}" has an unsupported format.`);
  }
  const record = value as Partial<CloudNote>;
  if (record.schemaVersion !== 1 || !record.note || record.note.id !== id) {
    throw new Error(`Cloud note "${id}" failed validation.`);
  }
  return record as CloudNote;
}

async function writeCloudNote(
  db: Firestore,
  uid: string,
  note: QuietNote,
  expectedRemoteUpdatedAt: number | undefined,
  storage: FirebaseStorage | undefined,
  reportStage?: SyncStageReporter,
  preparedNote?: QuietNote,
): Promise<boolean> {
  const cloudNote = preparedNote ?? (await noteForCloud(note, uid, storage, reportStage)).note;
  const noteRef = doc(db, 'users', uid, 'notes', pathNoteId(note.id));
  return atSyncStage('writing a note to Firestore', () => runTransaction(db, async transaction => {
    const current = await transaction.get(noteRef);
    if (current.exists()) {
      const currentNote = asCloudNote(current.data(), note.id).note;
      if (expectedRemoteUpdatedAt === undefined || currentNote.updatedAt !== expectedRemoteUpdatedAt) return false;
    } else if (expectedRemoteUpdatedAt !== undefined) {
      return false;
    }
    transaction.set(noteRef, { schemaVersion: 1, note: cloudNote });
    return true;
  }), reportStage);
}

async function deleteCloudNoteIfUnchanged(
  db: Firestore,
  uid: string,
  noteId: string,
  expectedUpdatedAt: number,
  reportStage?: SyncStageReporter,
): Promise<boolean> {
  const noteRef = doc(db, 'users', uid, 'notes', pathNoteId(noteId));
  return atSyncStage('deleting a note from Firestore', () => runTransaction(db, async transaction => {
    const current = await transaction.get(noteRef);
    if (!current.exists()) return true;
    const currentNote = asCloudNote(current.data(), noteId).note;
    if (currentNote.updatedAt !== expectedUpdatedAt) return false;
    transaction.delete(noteRef);
    return true;
  }), reportStage);
}

export async function syncUserNotes(
  uid: string,
  db: Firestore,
  storage: FirebaseStorage | undefined,
  reportStage?: SyncStageReporter,
): Promise<SyncResult> {
  if (!navigator.onLine) throw new Error('You are offline. Your edits are saved on this device and will sync when connection returns.');
  const localNotes = await atSyncStage('reading local notes', () => quietStorage.listNotes(), reportStage);
  const snapshot = await atSyncStage(
    'listing notes in Firestore',
    () => getDocs(collection(db, 'users', uid, 'notes')),
    reportStage,
  );
  const cloudNotes = new Map<string, QuietNote>();
  for (const cloudDocument of snapshot.docs) {
    cloudNotes.set(cloudDocument.id, asCloudNote(cloudDocument.data(), cloudDocument.id).note);
  }

  const result: SyncResult = { downloaded: 0, uploaded: 0, deleted: 0, conflicts: [], imageFailures: [] };
  let activeStorage = storage;
  const hydrateCloudNote = (note: QuietNote) =>
    noteFromCloud(note, uid, activeStorage, reportStage, failure => {
      activeStorage = undefined;
      result.imageFailures.push(failure);
    });
  const handled = new Set<string>();
  const localIds = new Set(localNotes.map(note => note.id));
  const deletedIds = await atSyncStage(
    'reading local deletion markers',
    () => quietStorage.listDeletedNoteIds(uid),
    reportStage,
  );
  for (const id of deletedIds) {
    handled.add(id);
    if (localIds.has(id)) continue;
    const cloudNote = cloudNotes.get(id);
    if (!cloudNote) {
      await atSyncStage('clearing local sync markers', () => quietStorage.clearNoteDeletedForSync(uid, id), reportStage);
      await atSyncStage('clearing local sync markers', () => quietStorage.clearSyncBase(uid, id), reportStage);
      continue;
    }
    const baseUpdatedAt = await atSyncStage(
      'reading a local sync revision',
      () => quietStorage.getSyncBase(uid, id),
      reportStage,
    );
    if (baseUpdatedAt !== undefined && baseUpdatedAt === cloudNote.updatedAt) {
      if (await deleteCloudNoteIfUnchanged(db, uid, id, baseUpdatedAt, reportStage)) {
        await atSyncStage('clearing local sync markers', () => quietStorage.clearNoteDeletedForSync(uid, id), reportStage);
        await atSyncStage('clearing local sync markers', () => quietStorage.clearSyncBase(uid, id), reportStage);
        cloudNotes.delete(id);
        result.deleted += 1;
        continue;
      }
    }
    result.conflicts.push({
      id,
      localNote: null,
      cloudNote: await hydrateCloudNote(cloudNote),
    });
  }

  for (const localNote of localNotes) {
    let cloudNote = cloudNotes.get(localNote.id);
    handled.add(localNote.id);
    const baseUpdatedAt = await atSyncStage(
      'reading a local sync revision',
      () => quietStorage.getSyncBase(uid, localNote.id),
      reportStage,
    );
    if (cloudNote && baseUpdatedAt === undefined) {
      cloudNote = await hydrateCloudNote(cloudNote);
      cloudNotes.set(localNote.id, cloudNote);
    }
    const decision = decideNoteSync(localNote, cloudNote, baseUpdatedAt);
    if (decision === 'upload') {
      const prepared = await noteForCloud(localNote, uid, activeStorage, reportStage, cloudNote);
      result.imageFailures.push(...prepared.imageFailures);
      if (prepared.storageUnavailable) activeStorage = undefined;
      const success = await writeCloudNote(
        db, uid, localNote, baseUpdatedAt, activeStorage, reportStage, prepared.note,
      );
      if (success) {
        await atSyncStage(
          'saving the local sync revision',
          () => quietStorage.setSyncBase(uid, localNote.id, localNote.updatedAt),
          reportStage,
        );
        result.uploaded += 1;
      } else {
        const latest = await atSyncStage(
          'rechecking notes in Firestore after a concurrent change',
          () => getDocs(collection(db, 'users', uid, 'notes')),
          reportStage,
        );
        const current = latest.docs.find(item => item.id === localNote.id);
        if (current) {
          const latestNote = await hydrateCloudNote(asCloudNote(current.data(), current.id).note);
          result.conflicts.push({ id: localNote.id, localNote, cloudNote: latestNote });
        }
      }
    } else if (decision === 'download' && cloudNote) {
      const hydrated = await hydrateCloudNote(cloudNote);
      if (await atSyncStage(
        'saving a downloaded note on this device',
        () => quietStorage.applyRemoteNote(hydrated, localNote.updatedAt),
        reportStage,
      )) {
        await atSyncStage(
          'saving the local sync revision',
          () => quietStorage.setSyncBase(uid, localNote.id, cloudNote.updatedAt),
          reportStage,
        );
        result.downloaded += 1;
      } else {
        result.conflicts.push({ id: localNote.id, localNote, cloudNote: hydrated });
      }
    } else if (decision === 'same' && cloudNote) {
      const prepared = await noteForCloud(localNote, uid, activeStorage, reportStage, cloudNote);
      result.imageFailures.push(...prepared.imageFailures);
      if (prepared.storageUnavailable) activeStorage = undefined;
      if (prepared.uploadedImages > 0) {
        const saved = await writeCloudNote(
          db, uid, localNote, cloudNote.updatedAt, activeStorage, reportStage, prepared.note,
        );
        if (!saved) {
          result.conflicts.push({
            id: localNote.id,
            localNote,
            cloudNote: await hydrateCloudNote(cloudNote),
          });
          continue;
        }
      }
      await atSyncStage(
        'saving the local sync revision',
        () => quietStorage.setSyncBase(uid, localNote.id, cloudNote.updatedAt),
        reportStage,
      );
    } else if (decision === 'conflict' && cloudNote) {
      result.conflicts.push({
        id: localNote.id,
        localNote,
        cloudNote: await hydrateCloudNote(cloudNote),
      });
    }
  }

  for (const [id, cloudNote] of cloudNotes) {
    if (handled.has(id)) continue;
    const hydrated = cloudNote.content.includes(cloudImagePrefix)
      ? await hydrateCloudNote(cloudNote)
      : cloudNote;
    if (await atSyncStage('saving a downloaded note on this device', () => quietStorage.applyRemoteNote(hydrated), reportStage)) {
      await atSyncStage(
        'saving the local sync revision',
        () => quietStorage.setSyncBase(uid, id, cloudNote.updatedAt),
        reportStage,
      );
      result.downloaded += 1;
    } else {
      const currentLocal = await atSyncStage(
        'checking a local note for conflicts',
        () => quietStorage.getNote(id),
        reportStage,
      );
      if (currentLocal) {
        result.conflicts.push({ id, localNote: currentLocal, cloudNote: hydrated });
      }
    }
  }
  return result;
}

export async function resolveNoteConflict(
  uid: string,
  conflict: NoteSyncConflict,
  choice: 'device' | 'cloud',
  db: Firestore,
  storage: FirebaseStorage | undefined,
): Promise<ImageSyncFailure[]> {
  const selected = choice === 'device' ? conflict.localNote : conflict.cloudNote;
  const expectedRemote = conflict.cloudNote.updatedAt;
  if (!selected) {
    if (choice !== 'device') throw new Error('A cloud version must be selected to resolve this deleted-note conflict.');
    const deleted = await deleteCloudNoteIfUnchanged(db, uid, conflict.id, expectedRemote);
    if (!deleted) throw new Error('The cloud version changed since this conflict was shown. Sync again to review the latest version.');
    await quietStorage.clearNoteDeletedForSync(uid, conflict.id);
    await quietStorage.clearSyncBase(uid, conflict.id);
    return [];
  }
  const prepared = await noteForCloud(selected, uid, storage);
  const saved = await writeCloudNote(db, uid, selected, expectedRemote, storage, undefined, prepared.note);
  if (!saved) throw new Error('The cloud version changed since this conflict was shown. Sync again to review the latest version.');
  if (choice === 'cloud') {
    const restoredCloudNote = await noteFromCloud(
      conflict.cloudNote,
      uid,
      storage,
      undefined,
      failure => prepared.imageFailures.push(failure),
    );
    const applied = await quietStorage.applyRemoteNote(restoredCloudNote, conflict.localNote?.updatedAt);
    if (!applied) throw new Error('This device note changed while the conflict was being resolved. Sync again to avoid losing that edit.');
    await quietStorage.clearNoteDeletedForSync(uid, conflict.id);
  }
  await quietStorage.setSyncBase(uid, conflict.id, selected.updatedAt);
  return prepared.imageFailures;
}
