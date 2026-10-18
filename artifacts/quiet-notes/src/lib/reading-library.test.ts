import assert from 'node:assert/strict';
import test from 'node:test';
import { createBackup, parseBackupText } from './backup.ts';
import {
  createLibraryDocument,
  importAndRefreshLibrary,
  readerFormatForFile,
  renameReadingBookmark,
  restoreLibraryDocument,
  toLibraryDocumentBackup,
} from './reading-library.ts';
import { defaultSettings } from '../quiet-storage.ts';

test('supported document types are recognized by extension and MIME type', () => {
  assert.equal(readerFormatForFile('book.PDF'), 'pdf');
  assert.equal(readerFormatForFile('novel.epub', 'application/octet-stream'), 'epub');
  assert.equal(readerFormatForFile('notes.md'), 'md');
  assert.equal(readerFormatForFile('plain', 'text/plain'), 'txt');
  assert.equal(readerFormatForFile('archive.zip', 'application/zip'), undefined);
});

test('version 2 backups preserve reading metadata without embedding source files', () => {
  const document = createLibraryDocument({
    id: 'book-1',
    title: 'Quiet Book',
    format: 'epub',
    mimeType: 'application/epub+zip',
    size: 12,
    now: 100,
    sourcePath: 'private/book.epub',
    fileData: new Blob(['not included in backup']),
  });
  document.lastPosition = 'epubcfi(/6/4[itemref]!/4/2:0)';
  document.bookmarks.push({ id: 'mark-1', label: 'Chapter one', position: document.lastPosition, createdAt: 110 });
  document.highlights.push({
    id: 'highlight-1',
    position: 'epubcfi(/6/4[itemref]!/4/2:3)',
    text: 'A saved passage',
    note: 'Remember this',
    createdAt: 120,
    updatedAt: 130,
  });

  const backup = createBackup([], defaultSettings, 140, [toLibraryDocumentBackup(document)]);
  const serialized = JSON.stringify(backup);
  const restored = parseBackupText(serialized);
  assert.equal(restored.schemaVersion, 2);
  assert.deepEqual(restored.library, [toLibraryDocumentBackup(document)]);
  assert.equal(serialized.includes('not included in backup'), false);
  assert.equal(serialized.includes('private/book.epub'), false);

  const imported = restoreLibraryDocument(restored.library![0]);
  assert.equal(imported.requiresReimport, true);
  assert.equal(imported.fileData, undefined);
  assert.deepEqual(imported.bookmarks, document.bookmarks);
  assert.deepEqual(imported.highlights, document.highlights);
});

test('metadata backups reject repeated document IDs and invalid anchors', () => {
  const document = createLibraryDocument({
    id: 'same-id',
    title: 'Document',
    format: 'pdf',
    mimeType: 'application/pdf',
    size: 10,
    now: 100,
  });

  test('bookmark renaming keeps its reading location and rejects empty or duplicate names', () => {
    const document = createLibraryDocument({
      id: 'bookmark-document',
      title: 'A book',
      format: 'pdf',
      mimeType: 'application/pdf',
      size: 100,
      now: 100,
    });
    document.bookmarks = [
      { id: 'first', label: 'Page 1', position: 'pdf:1', createdAt: 110 },
      { id: 'second', label: 'Page 2', position: 'pdf:2', createdAt: 120 },
    ];

    const renamed = renameReadingBookmark(document, 'first', '  Opening  ', 130);
    assert.equal(renamed.bookmarks[0].label, 'Opening');
    assert.equal(renamed.bookmarks[0].position, 'pdf:1');
    assert.equal(renamed.bookmarks[0].createdAt, 110);
    assert.equal(renamed.bookmarks[1].position, 'pdf:2');
    assert.equal(renamed.updatedAt, 130);
    assert.equal(document.bookmarks[0].label, 'Page 1');
    assert.throws(() => renameReadingBookmark(document, 'first', '  '), /Enter a name/);
    assert.throws(() => renameReadingBookmark(document, 'first', 'page 2'), /already uses that name/);
  });

  test('PDF page offsets and EPUB CFI highlights survive metadata backup and restore', () => {
    for (const [format, position] of [
      ['pdf', 'pdf:3:120:148'],
      ['epub', 'epubcfi(/6/8[itemref]!/4/2:15)'],
    ] as const) {
      const document = createLibraryDocument({
        id: `highlight-${format}`,
        title: 'Highlighted document',
        format,
        mimeType: format === 'pdf' ? 'application/pdf' : 'application/epub+zip',
        size: 200,
        now: 100,
      });
      document.highlights.push({
        id: `saved-${format}`,
        position,
        text: 'A selected passage',
        note: 'Keep this thought',
        createdAt: 110,
        updatedAt: 120,
      });

      const serialized = JSON.stringify(createBackup([], defaultSettings, 130, [toLibraryDocumentBackup(document)]));
      const restored = parseBackupText(serialized).library![0];
      assert.equal(restored.highlights[0].position, position);
      assert.equal(restored.highlights[0].text, 'A selected passage');
      assert.equal(restored.highlights[0].note, 'Keep this thought');
    }
  });
  const backup = createBackup([], defaultSettings, 120, [
    toLibraryDocumentBackup(document),
    toLibraryDocumentBackup(document),
  ]);
  assert.throws(() => parseBackupText(JSON.stringify(backup)), /reading-library ID/);

  document.bookmarks.push({ id: 'bad', label: 'Invalid', position: '', createdAt: 1 });
  const invalid = createBackup([], defaultSettings, 120, [toLibraryDocumentBackup(document)]);
  const invalidInput = JSON.parse(JSON.stringify(invalid)) as {
    library: Array<{ bookmarks: Array<{ position: string | number }> }>;
  };
  invalidInput.library[0].bookmarks[0].position = 12;
  assert.throws(() => parseBackupText(JSON.stringify(invalidInput)), /invalid reading-library metadata/i);
});

test('imported reading entries refresh immediately and remain available after reopening', async () => {
  const document = restoreLibraryDocument(toLibraryDocumentBackup(createLibraryDocument({
    id: 'restored-book',
    title: 'Restored Book',
    format: 'pdf',
    mimeType: 'application/pdf',
    size: 128,
    now: 100,
  })));
  const persisted = new Map<string, typeof document>();
  let visibleDocuments = [] as typeof document[];
  const listDocuments = async () => Array.from(persisted.values());

  await importAndRefreshLibrary(
    async () => {
      persisted.set(document.id, document);
      return { readingDocumentsImportedCount: 1 };
    },
    listDocuments,
    documents => { visibleDocuments = documents; },
  );

  assert.deepEqual(visibleDocuments.map(item => item.id), ['restored-book']);
  assert.deepEqual((await listDocuments()).map(item => item.id), ['restored-book']);
  assert.equal(visibleDocuments[0].requiresReimport, true);
});
