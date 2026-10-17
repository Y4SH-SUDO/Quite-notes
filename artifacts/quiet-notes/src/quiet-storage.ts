import { planBackupImport, type ImportStrategy } from './lib/backup.ts';

export type NoteKind = 'note' | 'task' | 'journal' | 'checklist';

export type QuietNote = {
  id: string;
  title: string;
  kind: NoteKind;
  content: string;
  createdAt: number;
  updatedAt: number;
  recentlyOpenedAt: number;
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
};

const DB_NAME = 'quiet-notes-local';
const DB_VERSION = 1;
const NOTES_STORE = 'notes';
const SETTINGS_STORE = 'settings';

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
  getNote: (id: string) => withStore<QuietNote | undefined>('notes', 'readonly', store => store.get(id)),
  saveNote: (note: QuietNote) => withStore<IDBValidKey>('notes', 'readwrite', store => store.put(note)),
  deleteNote: (id: string) => withStore<undefined>('notes', 'readwrite', store => store.delete(id)),
  async getSettings(): Promise<QuietSettings | undefined> {
    const saved = await withStore<{ key: string; value: QuietSettings } | undefined>(
      SETTINGS_STORE, 'readonly', store => store.get('preferences'),
    );
    return saved?.value;
  },
  saveSettings(settings: QuietSettings) {
    return withStore<IDBValidKey>(SETTINGS_STORE, 'readwrite', store => store.put({ key: 'preferences', value: settings }));
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
  async applyRemoteNote(note: QuietNote, expectedLocalUpdatedAt?: number): Promise<boolean> {
    const db = await openDatabase();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const transaction = db.transaction(NOTES_STORE, 'readwrite');
        const store = transaction.objectStore(NOTES_STORE);
        let applied = false;
        transaction.oncomplete = () => resolve(applied);
        transaction.onerror = () => reject(transaction.error ?? new Error('The synced note could not be saved.'));
        transaction.onabort = () => reject(transaction.error ?? new Error('The synced note update was interrupted.'));

        const request = store.get(note.id);
        request.onerror = () => transaction.abort();
        request.onsuccess = () => {
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
    } finally {
      db.close();
    }
  },
  async importBackup(
    notes: QuietNote[],
    settings: QuietSettings,
    strategy: ImportStrategy,
  ): Promise<BackupImportResult> {
    const db = await openDatabase();
    try {
      return await new Promise<BackupImportResult>((resolve, reject) => {
        const transaction = db.transaction([NOTES_STORE, SETTINGS_STORE], 'readwrite');
        const noteStore = transaction.objectStore(NOTES_STORE);
        const settingsStore = transaction.objectStore(SETTINGS_STORE);
        let result: BackupImportResult | undefined;
        let failure: Error | undefined;

        transaction.oncomplete = () => {
          if (result) resolve(result);
          else reject(new Error('The backup import finished without a result.'));
        };
        transaction.onerror = () => reject(transaction.error ?? new Error('The backup could not be imported.'));
        transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('The backup import was interrupted.'));

        const keysRequest = noteStore.getAllKeys();
        keysRequest.onerror = () => {
          failure = keysRequest.error ?? new Error('Existing notes could not be checked.');
        };
        keysRequest.onsuccess = () => {
          const existingIds = keysRequest.result.map(String);
          const plan = planBackupImport(notes, existingIds, strategy);
          if (strategy === 'skip-backup-on-conflict' && plan.duplicateIds.length > 0) {
            result = {
              importedCount: 0,
              skippedCount: notes.length,
              duplicateIds: plan.duplicateIds,
              settingsImported: false,
            };
            return;
          }

          let index = 0;
          const addNextNote = () => {
            if (index < plan.notesToImport.length) {
              const request = noteStore.add(plan.notesToImport[index++]);
              request.onsuccess = addNextNote;
              request.onerror = () => {
                failure = request.error ?? new Error('A note from the backup could not be added.');
              };
              return;
            }
            settingsStore.put({ key: 'preferences', value: settings });
            result = {
              importedCount: plan.notesToImport.length,
              skippedCount: plan.skippedCount,
              duplicateIds: plan.duplicateIds,
              settingsImported: true,
            };
          };
          try {
            addNextNote();
          } catch (error) {
            failure = error instanceof Error ? error : new Error('The backup could not be imported.');
            transaction.abort();
          }
        };
      });
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
