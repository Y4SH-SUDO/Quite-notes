import { planBackupImport, type ImportStrategy } from './lib/backup.ts';
import { noteFlagSaveCoordinator, noteWriteQueue, type NoteFlagValues } from './lib/note-actions.ts';
import {
  restoreLibraryDocument,
  type LibraryDocument,
  type LibraryDocumentBackup,
} from './lib/reading-library.ts';
import type { HandwritingPage } from './lib/handwriting.ts';

export type NoteKind = 'note' | 'task' | 'journal' | 'checklist';

export type QuietNote = {
  id: string;
  title: string;
  kind: NoteKind;
  content: string;
  createdAt: number;
  updatedAt: number;
  recentlyOpenedAt: number;
  pinned?: boolean;
  favorite?: boolean;
  handwriting?: HandwritingPage[];
  dueDate?: string;
  reminderAt?: number;
  reminderTimezone?: string;
};

export type QuietSettings = {
  fontFamily: 'Literata' | 'Georgia';
  fontSize: number;
  lineSpacing: number;
};

export type BackupImportResult = {
  importedCount: number;
  skippedCount: number;
  duplicateIds: string[];
  settingsImported: boolean;
  readingDocumentsImportedCount: number;
};

const DB_NAME = 'quiet-notes-local';
const DB_VERSION = 2;
const NOTES_STORE = 'notes';
const SETTINGS_STORE = 'settings';
const DOCUMENTS_STORE = 'reading-library';
const readingDocumentWrites = new Map<string, Promise<void>>();

function notifyLocalDataChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('quiet-notes-data-changed'));
}

function queueReadingDocumentWrite<T>(id: string, write: () => Promise<T>): Promise<T> {
  const previous = readingDocumentWrites.get(id) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(write);
  const queued = operation.then(() => undefined, () => undefined);
  readingDocumentWrites.set(id, queued);
  void queued.then(() => {
    if (readingDocumentWrites.get(id) === queued) readingDocumentWrites.delete(id);
  });
  return operation;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser does not support local note storage.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
        db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local storage.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Local storage request failed.'));
  });
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(storeName, mode);
    const result = await requestResult(action(transaction.objectStore(storeName)));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save changes.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('The save was interrupted.'));
    });
    return result;
  } finally {
    db.close();
  }
}

export const quietStorage = {
  listNotes: () => withStore<QuietNote[]>('notes', 'readonly', store => store.getAll()),
  listReadingDocuments: () => withStore<LibraryDocument[]>(DOCUMENTS_STORE, 'readonly', store => store.getAll()),
  saveReadingDocument(document: LibraryDocument) {
    return queueReadingDocumentWrite(document.id, () =>
      withStore<IDBValidKey>(DOCUMENTS_STORE, 'readwrite', store => store.put(document)))
      .then(key => {
        notifyLocalDataChanged();
        return key;
      });
  },
  deleteReadingDocument(id: string) {
    return queueReadingDocumentWrite(id, () =>
      withStore<undefined>(DOCUMENTS_STORE, 'readwrite', store => store.delete(id)))
      .then(() => {
        notifyLocalDataChanged();
      });
  },
  getNote: (id: string) => withStore<QuietNote | undefined>('notes', 'readonly', store => store.get(id)),
  saveNote(note: QuietNote) {
    return noteWriteQueue.run(note.id, async () => {
      const db = await openDatabase();
      try {
        return await new Promise<IDBValidKey>((resolve, reject) => {
          const transaction = db.transaction(NOTES_STORE, 'readwrite');
          const store = transaction.objectStore(NOTES_STORE);
          let savedKey: IDBValidKey | undefined;
          let failure: Error | undefined;
          transaction.oncomplete = () => {
            if (failure) reject(failure);
            else if (savedKey !== undefined) {
              notifyLocalDataChanged();
              resolve(savedKey);
            }
            else reject(new Error('The note save finished without a result.'));
          };
          transaction.onerror = () => reject(transaction.error ?? new Error('The note could not be saved.'));
          transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('The note save was interrupted.'));

          const request = store.get(note.id);
          request.onerror = () => {
            failure = request.error ?? new Error('The existing note could not be read before saving.');
            transaction.abort();
          };
          request.onsuccess = () => {
            const existing = request.result as QuietNote | undefined;
            const next = {
              ...note,
              ...(existing?.pinned === undefined ? {} : { pinned: existing.pinned }),
              ...(existing?.favorite === undefined ? {} : { favorite: existing.favorite }),
            };
            const put = store.put(next);
            put.onsuccess = () => { savedKey = put.result; };
            put.onerror = () => {
              failure = put.error ?? new Error('The note could not be saved.');
              transaction.abort();
            };
          };
        });
      } finally {
        db.close();
      }
    });
  },
  saveNoteFlags(noteId: string, flags: NoteFlagValues) {
    return noteWriteQueue.run(noteId, async () => {
      const db = await openDatabase();
      try {
        return await new Promise<QuietNote>((resolve, reject) => {
          const transaction = db.transaction(NOTES_STORE, 'readwrite');
          const store = transaction.objectStore(NOTES_STORE);
          let savedNote: QuietNote | undefined;
          let failure: Error | undefined;
          transaction.oncomplete = () => {
            if (failure) reject(failure);
            else if (savedNote) {
              notifyLocalDataChanged();
              resolve(savedNote);
            }
            else reject(new Error('The note flag save finished without a result.'));
          };
          transaction.onerror = () => reject(transaction.error ?? new Error('The note flags could not be saved.'));
          transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('The note flags save was interrupted.'));

          const request = store.get(noteId);
          request.onerror = () => {
            failure = request.error ?? new Error('The note could not be read before updating its flags.');
            transaction.abort();
          };
          request.onsuccess = () => {
            const existing = request.result as QuietNote | undefined;
            if (!existing) {
              failure = new Error('The note no longer exists on this device.');
              transaction.abort();
              return;
            }
            savedNote = {
              ...existing,
              ...flags,
              updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
            };
            const put = store.put(savedNote);
            put.onerror = () => {
              failure = put.error ?? new Error('The note flags could not be saved.');
              transaction.abort();
            };
          };
        });
      } finally {
        db.close();
      }
    });
  },
  deleteNote(id: string) {
    return noteWriteQueue.run(id, async () => {
      await withStore<undefined>('notes', 'readwrite', store => store.delete(id));
      notifyLocalDataChanged();
    });
  },
  async getSettings(): Promise<QuietSettings | undefined> {
    const saved = await withStore<{ key: string; value: QuietSettings } | undefined>(
      SETTINGS_STORE, 'readonly', store => store.get('preferences'),
    );
    return saved?.value;
  },
  saveSettings(settings: QuietSettings) {
    return withStore<IDBValidKey>(SETTINGS_STORE, 'readwrite', store => store.put({ key: 'preferences', value: settings }))
      .then(key => {
        notifyLocalDataChanged();
        return key;
      });
  },
  async getBackupStatus(): Promise<string | undefined> {
    const saved = await withStore<{ key: string; value: string } | undefined>(
      SETTINGS_STORE, 'readonly', store => store.get('automatic-backup-status'),
    );
    return saved?.value;
  },
  saveBackupStatus(value: string) {
    return withStore<IDBValidKey>(
      SETTINGS_STORE,
      'readwrite',
      store => store.put({ key: 'automatic-backup-status', value }),
    );
  },
  async getSyncBase(uid: string, noteId: string): Promise<number | undefined> {
    const saved = await withStore<{ key: string; value: number } | undefined>(
      SETTINGS_STORE, 'readonly', store => store.get(`sync-base:${uid}:${noteId}`),
    );
    return saved?.value;
  },
  setSyncBase(uid: string, noteId: string, updatedAt: number) {
    return withStore<IDBValidKey>(
      SETTINGS_STORE, 'readwrite',
      store => store.put({ key: `sync-base:${uid}:${noteId}`, value: updatedAt }),
    );
  },
  async listDeletedNoteIds(uid: string): Promise<string[]> {
    const keys = await withStore<IDBValidKey[]>(
      SETTINGS_STORE, 'readonly', store => store.getAllKeys(),
    );
    const prefix = `sync-delete:${uid}:`;
    return keys.map(String).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  },
  markNoteDeletedForSync(uid: string, noteId: string) {
    return withStore<IDBValidKey>(
      SETTINGS_STORE, 'readwrite',
      store => store.put({ key: `sync-delete:${uid}:${noteId}`, value: Date.now() }),
    );
  },
  clearNoteDeletedForSync(uid: string, noteId: string) {
    return withStore<undefined>(
      SETTINGS_STORE, 'readwrite',
      store => store.delete(`sync-delete:${uid}:${noteId}`),
    );
  },
  clearSyncBase(uid: string, noteId: string) {
    return withStore<undefined>(
      SETTINGS_STORE, 'readwrite',
      store => store.delete(`sync-base:${uid}:${noteId}`),
    );
  },
  async applyRemoteNote(
    note: QuietNote,
    expectedLocalUpdatedAt?: number,
    options: { allowPendingFlagSave?: boolean; expectedFlagRevision?: number } = {},
  ): Promise<boolean> {
    return noteWriteQueue.run(note.id, async () => {
      const db = await openDatabase();
      try {
        const applied = await new Promise<boolean>((resolve, reject) => {
          const transaction = db.transaction(NOTES_STORE, 'readwrite');
          const store = transaction.objectStore(NOTES_STORE);
          let applied = false;
          transaction.oncomplete = () => resolve(applied);
          transaction.onerror = () => reject(transaction.error ?? new Error('The synced note could not be saved.'));
          transaction.onabort = () => reject(transaction.error ?? new Error('The synced note update was interrupted.'));

          const request = store.get(note.id);
          request.onerror = () => transaction.abort();
          request.onsuccess = () => {
            if (!noteFlagSaveCoordinator.canApplyRemote(
              note.id,
              options.allowPendingFlagSave === true,
              options.expectedFlagRevision,
            )) return;
            const existing = request.result as QuietNote | undefined;
            if (expectedLocalUpdatedAt === undefined) {
              if (existing) return;
              store.add(note);
              applied = true;
              return;
            }
            if (!existing || existing.updatedAt !== expectedLocalUpdatedAt) return;
            store.put(note);
            applied = true;
          };
        });
        if (applied) notifyLocalDataChanged();
        return applied;
      } finally {
        db.close();
      }
    });
  },
  async importBackup(
    notes: QuietNote[],
    settings: QuietSettings,
    strategy: ImportStrategy,
    library: LibraryDocumentBackup[] = [],
  ): Promise<BackupImportResult> {
    const db = await openDatabase();
    try {
      const result = await new Promise<BackupImportResult>((resolve, reject) => {
        const transaction = db.transaction([NOTES_STORE, SETTINGS_STORE, DOCUMENTS_STORE], 'readwrite');
        const noteStore = transaction.objectStore(NOTES_STORE);
        const settingsStore = transaction.objectStore(SETTINGS_STORE);
        const documentStore = transaction.objectStore(DOCUMENTS_STORE);
        let result: BackupImportResult | undefined;
        let failure: Error | undefined;

        transaction.oncomplete = () => {
          if (result) resolve(result);
          else reject(new Error('The backup import finished without a result.'));
        };
        transaction.onerror = () => reject(transaction.error ?? new Error('The backup could not be imported.'));
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('The backup import was interrupted.'));

        let existingNoteIds: string[] | undefined;
        let existingDocumentIds: string[] | undefined;
        const initializeImport = () => {
          if (!existingNoteIds || !existingDocumentIds) return;
          const existingIds = existingNoteIds;
          const existingDocuments = new Set(existingDocumentIds);
          const plan = planBackupImport(notes, existingIds, strategy);
          if (strategy === 'skip-backup-on-conflict' && plan.duplicateIds.length > 0) {
            result = {
              importedCount: 0,
              skippedCount: notes.length,
              duplicateIds: plan.duplicateIds,
              settingsImported: false,
              readingDocumentsImportedCount: 0,
            };
            return;
          }

          const documentsToImport = library
            .filter(document => !existingDocuments.has(document.id))
            .map(restoreLibraryDocument);
          let noteIndex = 0;
          let documentIndex = 0;
          const addNextDocument = () => {
            if (documentIndex < documentsToImport.length) {
              const request = documentStore.add(documentsToImport[documentIndex++]);
              request.onsuccess = addNextDocument;
              request.onerror = () => {
                failure = request.error ?? new Error('Reading-library details from the backup could not be added.');
              };
              return;
            }
            settingsStore.put({ key: 'preferences', value: settings });
            result = {
              importedCount: plan.notesToImport.length,
              skippedCount: plan.skippedCount,
              duplicateIds: plan.duplicateIds,
              settingsImported: true,
              readingDocumentsImportedCount: documentsToImport.length,
            };
          };
          const addNextNote = () => {
            if (noteIndex < plan.notesToImport.length) {
              const request = noteStore.add(plan.notesToImport[noteIndex++]);
              request.onsuccess = addNextNote;
              request.onerror = () => {
                failure = request.error ?? new Error('A note from the backup could not be added.');
              };
              return;
            }
            addNextDocument();
          };
          try {
            addNextNote();
          } catch (error) {
            failure = error instanceof Error ? error : new Error('The backup could not be imported.');
            transaction.abort();
          }
        };
        const noteKeysRequest = noteStore.getAllKeys();
        noteKeysRequest.onerror = () => {
          failure = noteKeysRequest.error ?? new Error('Existing notes could not be checked.');
        };
        noteKeysRequest.onsuccess = () => {
          existingNoteIds = noteKeysRequest.result.map(String);
          initializeImport();
        };
        const documentKeysRequest = documentStore.getAllKeys();
        documentKeysRequest.onerror = () => {
          failure = documentKeysRequest.error ?? new Error('Existing reading-library entries could not be checked.');
        };
        documentKeysRequest.onsuccess = () => {
          existingDocumentIds = documentKeysRequest.result.map(String);
          initializeImport();
        };
      });
      if (result.importedCount > 0 || result.settingsImported) notifyLocalDataChanged();
      return result;
    } finally {
      db.close();
    }
  },
};

export const defaultSettings: QuietSettings = {
  fontFamily: 'Literata',
  fontSize: 20,
  lineSpacing: 1.8,
};

export function newNote(kind: NoteKind): QuietNote {
  const now = Date.now();
  const checkId = kind === 'task' || kind === 'checklist' ? crypto.randomUUID() : null;
  const content = checkId
    ? `<div data-check-item="" data-check-id="${checkId}"><input type="checkbox" aria-label="Mark checklist item complete" data-testid="checkbox-check-item-${checkId}"><span data-check-text="" contenteditable="true"><br></span></div>`
    : '';
  return {
    id: crypto.randomUUID(),
    title: '',
    kind,
    content,
    createdAt: now,
    updatedAt: now,
    recentlyOpenedAt: now,
  };
}

export function sortNotes(notes: QuietNote[]): QuietNote[] {
  return [...notes].sort((left, right) =>
    Number(right.pinned === true) - Number(left.pinned === true)
    || right.recentlyOpenedAt - left.recentlyOpenedAt,
  );
}
