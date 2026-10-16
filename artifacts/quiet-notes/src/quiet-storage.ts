export type NoteKind = 'note' | 'task' | 'journal' | 'checklist';

export type QuietNote = {
  id: string;
  title: string;
  kind: NoteKind;
  content: string;
  createdAt: number;
  updatedAt: number;
  recentlyOpenedAt: number;
};

export type QuietSettings = {
  fontFamily: 'Literata' | 'Georgia';
  fontSize: number;
  lineSpacing: number;
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
