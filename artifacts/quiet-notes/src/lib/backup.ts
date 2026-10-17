import type { NoteKind, QuietNote, QuietSettings } from '../quiet-storage';

export type QuietNotesBackup = {
  app: 'quiet-notes';
  schemaVersion: 1;
  exportedAt: number;
  notes: QuietNote[];
  settings: QuietSettings;
  tags: string[];
};

export type BackupWorkerRequest =
  | { action: 'parse'; text: string }
  | { action: 'serialize'; notes: QuietNote[]; settings: QuietSettings };

export type BackupWorkerResponse =
  | { ok: true; value: QuietNotesBackup | string; imageCount?: number }
  | { ok: false; error: string };

export type ImportStrategy = 'merge' | 'skip-backup-on-conflict';

export type ImportPlan = {
  notesToImport: QuietNote[];
  duplicateIds: string[];
  skippedCount: number;
};

const noteKinds: NoteKind[] = ['note', 'task', 'journal', 'checklist'];
const dangerousMarkup =
  /<\s*(?:script|iframe|object|embed|svg|math|style|form|video|audio|link|meta|base)\b|\bon[a-z]+\s*=|\bsrcdoc\s*=|javascript\s*:/i;

export function tagsForNotes(notes: QuietNote[]): string[] {
  return Array.from(new Set(
    notes.flatMap(note => `${note.title} ${note.content.replace(/<[^>]*>/g, ' ')}`.match(/#([\w-]+)/g) ?? [])
      .map(tag => tag.slice(1).toLowerCase()),
  )).sort();
}

export function createBackup(
  notes: QuietNote[],
  settings: QuietSettings,
  exportedAt = Date.now(),
): QuietNotesBackup {
  return {
    app: 'quiet-notes',
    schemaVersion: 1,
    exportedAt,
    notes: notes.map(note => ({ ...note })),
    settings,
    tags: tagsForNotes(notes),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSettings(value: unknown): value is QuietSettings {
  if (!isRecord(value)) return false;
  return (value.fontFamily === 'Literata' || value.fontFamily === 'Georgia')
    && typeof value.fontSize === 'number' && Number.isInteger(value.fontSize)
    && value.fontSize >= 16 && value.fontSize <= 30
    && [1.5, 1.8, 2.1].includes(value.lineSpacing as number);
}

function validDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validNote(value: unknown): value is QuietNote {
  if (!isRecord(value)) return false;
  const hasTaskSchedule = value.dueDate !== undefined
    || value.reminderAt !== undefined
    || value.reminderTimezone !== undefined;
  return typeof value.id === 'string' && value.id.trim().length > 0
    && typeof value.title === 'string'
    && typeof value.kind === 'string' && noteKinds.includes(value.kind as NoteKind)
    && typeof value.content === 'string' && !dangerousMarkup.test(value.content)
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) && value.createdAt >= 0
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) && value.updatedAt >= 0
    && typeof value.recentlyOpenedAt === 'number' && Number.isFinite(value.recentlyOpenedAt) && value.recentlyOpenedAt >= 0
    && (value.kind === 'task' || !hasTaskSchedule)
    && (value.dueDate === undefined || (typeof value.dueDate === 'string' && validDateOnly(value.dueDate)))
    && (value.reminderAt === undefined || (typeof value.reminderAt === 'number' && Number.isFinite(value.reminderAt) && value.reminderAt >= 0))
    && (value.reminderTimezone === undefined || validTimeZone(value.reminderTimezone));
}

export function parseBackupText(text: string): QuietNotesBackup {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('This file is not valid JSON.');
  }

  if (!isRecord(input) || input.app !== 'quiet-notes' || input.schemaVersion !== 1) {
    throw new Error('This is not a supported Quiet Notes backup.');
  }
  if (!Array.isArray(input.notes) || !input.notes.every(validNote)) {
    throw new Error('The backup contains a note with missing or invalid fields.');
  }
  if (!validSettings(input.settings)) {
    throw new Error('The backup contains invalid writing preferences.');
  }
  if (typeof input.exportedAt !== 'number' || !Number.isFinite(input.exportedAt) || input.exportedAt < 0) {
    throw new Error('The backup export timestamp is invalid.');
  }
  if (!Array.isArray(input.tags) || !input.tags.every(tag => typeof tag === 'string')) {
    throw new Error('The backup tag list is invalid.');
  }

  const ids = new Set<string>();
  for (const note of input.notes) {
    if (ids.has(note.id)) {
      throw new Error(`The backup contains the note ID "${note.id}" more than once.`);
    }
    ids.add(note.id);
  }
  if (JSON.stringify(input.tags) !== JSON.stringify(tagsForNotes(input.notes))) {
    throw new Error('The backup tag list does not match its notes.');
  }

  return input as QuietNotesBackup;
}

export function planBackupImport(
  incomingNotes: QuietNote[],
  existingIds: Iterable<string>,
  strategy: ImportStrategy,
): ImportPlan {
  const existing = new Set(existingIds);
  const duplicateIds = incomingNotes.filter(note => existing.has(note.id)).map(note => note.id);
  if (strategy === 'skip-backup-on-conflict' && duplicateIds.length > 0) {
    return { notesToImport: [], duplicateIds, skippedCount: incomingNotes.length };
  }
  const duplicateSet = new Set(duplicateIds);
  const notesToImport = incomingNotes.filter(note => !duplicateSet.has(note.id));
  return { notesToImport, duplicateIds, skippedCount: duplicateIds.length };
}

export function runBackupWorker(request: BackupWorkerRequest): Promise<BackupWorkerResponse> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backup-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<BackupWorkerResponse>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = event => {
      worker.terminate();
      reject(new Error(event.message || 'Backup processing failed.'));
    };
    worker.postMessage(request);
  });
}

export function embeddedImageCount(notes: QuietNote[]): number {
  return notes.reduce((total, note) => total + (note.content.match(/<img\b/gi)?.length ?? 0), 0);
}
