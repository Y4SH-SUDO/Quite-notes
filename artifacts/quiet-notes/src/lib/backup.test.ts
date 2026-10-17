import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBackup,
  parseBackupText,
  planBackupImport,
} from './backup.ts';
import type { QuietNote, QuietSettings } from '../quiet-storage.ts';

const settings: QuietSettings = {
  fontFamily: 'Georgia',
  fontSize: 24,
  lineSpacing: 2.1,
};

const notes: QuietNote[] = [
  {
    id: 'note-1',
    title: 'A #Travel note',
    kind: 'note',
    content: '<p>#Weekend</p><figure data-note-image=""><img src="data:image/png;base64,aGVsbG8=" alt="image"><figcaption>Photo</figcaption></figure>',
    createdAt: 100,
    updatedAt: 200,
    recentlyOpenedAt: 300,
  },
  {
    id: 'task-1',
    title: 'Tasks',
    kind: 'task',
    content: '<div data-check-item="" data-check-id="check-1"><input type="checkbox" checked><span data-check-text="">Done</span></div>',
    createdAt: 400,
    updatedAt: 500,
    recentlyOpenedAt: 600,
    dueDate: '2026-10-20',
    reminderAt: 1792512000000,
    reminderTimezone: 'America/Los_Angeles',
  },
  {
    id: 'journal-1',
    title: 'Journal',
    kind: 'journal',
    content: '<p>Today</p>',
    createdAt: 700,
    updatedAt: 800,
    recentlyOpenedAt: 900,
  },
  {
    id: 'checklist-1',
    title: 'Groceries',
    kind: 'checklist',
    content: '<div data-check-item=""><input type="checkbox"><span data-check-text="">Bread</span></div>',
    createdAt: 1000,
    updatedAt: 1100,
    recentlyOpenedAt: 1200,
  },
];

test('backup round-trip preserves note kinds, IDs, timestamps, content, images, and settings', () => {
  const backup = createBackup(notes, settings, 1234);
  const restored = parseBackupText(JSON.stringify(backup));

  assert.deepEqual(restored.notes, notes);
  assert.deepEqual(restored.settings, settings);
  assert.equal(restored.exportedAt, 1234);
  assert.deepEqual(restored.tags, ['Travel', 'Weekend'].map(tag => tag.toLowerCase()));
  assert.match(restored.notes[0].content, /data:image\/png;base64,aGVsbG8=/);
  assert.deepEqual(restored.notes.map(note => note.kind), ['note', 'task', 'journal', 'checklist']);
  assert.equal(restored.notes[1].dueDate, '2026-10-20');
  assert.equal(restored.notes[1].reminderAt, 1792512000000);
  assert.equal(restored.notes[1].reminderTimezone, 'America/Los_Angeles');
});

test('older backups without task schedule fields remain valid and unchanged', () => {
  const legacyNote: QuietNote = {
    id: 'legacy-task',
    title: 'Existing task',
    kind: 'task',
    content: '<p>Keep this task</p>',
    createdAt: 10,
    updatedAt: 20,
    recentlyOpenedAt: 30,
  };
  const olderBackup = createBackup([legacyNote], settings, 40);
  const restored = parseBackupText(JSON.stringify(olderBackup));

  assert.deepEqual(restored.notes[0], legacyNote);
  assert.equal('dueDate' in restored.notes[0], false);
  assert.equal('reminderAt' in restored.notes[0], false);
  assert.equal('reminderTimezone' in restored.notes[0], false);
});

test('existing legacy note records can be backed up without adding or changing fields', () => {
  const existingRecord: QuietNote = {
    id: 'old-record',
    title: 'Saved before schedule support',
    kind: 'task',
    content: '<p>Existing local data</p>',
    createdAt: 100,
    updatedAt: 200,
    recentlyOpenedAt: 300,
  };
  const originalRecord = { ...existingRecord };
  const restored = parseBackupText(JSON.stringify(createBackup([existingRecord], settings)));

  assert.deepEqual(restored.notes[0], originalRecord);
  assert.deepEqual(existingRecord, originalRecord);
});

test('malformed JSON and invalid backup shapes are rejected', () => {
  assert.throws(() => parseBackupText('{broken'), /not valid JSON/i);
  assert.throws(() => parseBackupText(JSON.stringify({ app: 'other', schemaVersion: 1 })), /not a supported/i);

  const invalid = createBackup(notes, settings);
  invalid.notes[0].updatedAt = Number.NaN;
  assert.throws(() => parseBackupText(JSON.stringify(invalid)), /invalid fields/i);
});

test('duplicate IDs inside a backup are rejected before import', () => {
  const backup = createBackup([notes[0], notes[0]], settings);
  assert.throws(() => parseBackupText(JSON.stringify(backup)), /more than once/);
});

test('merge imports only new IDs and never replaces existing note records', () => {
  const existingNote = { ...notes[0], title: 'Keep this local version' };
  const existingById = new Map([[existingNote.id, existingNote]]);
  const plan = planBackupImport(notes, existingById.keys(), 'merge');

  for (const note of plan.notesToImport) {
    if (!existingById.has(note.id)) existingById.set(note.id, note);
  }

  assert.deepEqual(plan.duplicateIds, ['note-1']);
  assert.equal(plan.skippedCount, 1);
  assert.equal(existingById.get('note-1')?.title, 'Keep this local version');
  assert.equal(existingById.size, notes.length);
});

test('skip-on-conflict imports nothing when any note ID already exists', () => {
  const plan = planBackupImport(notes, ['journal-1'], 'skip-backup-on-conflict');
  assert.deepEqual(plan.notesToImport, []);
  assert.deepEqual(plan.duplicateIds, ['journal-1']);
  assert.equal(plan.skippedCount, notes.length);
});

test('active markup is rejected rather than imported as note content', () => {
  const backup = createBackup([{ ...notes[0], content: '<img src=x onerror=alert(1)>' }], settings);
  assert.throws(() => parseBackupText(JSON.stringify(backup)), /invalid fields/i);
});

test('invalid task schedule values are rejected', () => {
  const invalidDueDate = createBackup([{ ...notes[1], dueDate: '2026-02-30' }], settings);
  assert.throws(() => parseBackupText(JSON.stringify(invalidDueDate)), /invalid fields/i);

  const invalidReminder = createBackup([{ ...notes[1], reminderAt: Number.NaN }], settings);
  assert.throws(() => parseBackupText(JSON.stringify(invalidReminder)), /invalid fields/i);

  const invalidTimezone = createBackup([{ ...notes[1], reminderTimezone: 'Not/A-Timezone' }], settings);
  assert.throws(() => parseBackupText(JSON.stringify(invalidTimezone)), /invalid fields/i);
});
