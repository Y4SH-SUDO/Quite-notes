export type ReaderFormat = 'pdf' | 'epub' | 'txt' | 'md';

export type ReadingBookmark = {
  id: string;
  label: string;
  position: string;
  createdAt: number;
};

export type ReadingHighlight = {
  id: string;
  position: string;
  text: string;
  note: string;
  createdAt: number;
  updatedAt: number;
};

export type LibraryDocument = {
  id: string;
  title: string;
  format: ReaderFormat;
  mimeType: string;
  size: number;
  createdAt: number;
  updatedAt: number;
  lastPosition: string;
  bookmarks: ReadingBookmark[];
  highlights: ReadingHighlight[];
  requiresReimport?: boolean;
  sourcePath?: string;
  fileData?: Blob;
};

export type LibraryDocumentBackup = Omit<LibraryDocument, 'sourcePath' | 'fileData' | 'requiresReimport'>;

export async function importAndRefreshLibrary<T>(
  importBackup: () => Promise<T>,
  listDocuments: () => Promise<LibraryDocument[]>,
  updateDocuments: (documents: LibraryDocument[]) => void,
): Promise<T> {
  const result = await importBackup();
  updateDocuments(await listDocuments());
  return result;
}

const formatByExtension: Record<string, ReaderFormat> = {
  pdf: 'pdf',
  epub: 'epub',
  txt: 'txt',
  md: 'md',
  markdown: 'md',
};

export function readerFormatForFile(name: string, mimeType = ''): ReaderFormat | undefined {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (formatByExtension[extension]) return formatByExtension[extension];
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/epub+zip') return 'epub';
  if (['text/plain', 'text/markdown', 'text/x-markdown', 'application/x-markdown'].includes(mimeType)) {
    return mimeType.includes('markdown') ? 'md' : 'txt';
  }
  return undefined;
}

export function createLibraryDocument(input: {
  id: string;
  title: string;
  format: ReaderFormat;
  mimeType: string;
  size: number;
  now?: number;
  sourcePath?: string;
  fileData?: Blob;
}): LibraryDocument {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    title: input.title,
    format: input.format,
    mimeType: input.mimeType,
    size: input.size,
    createdAt: now,
    updatedAt: now,
    lastPosition: '',
    bookmarks: [],
    highlights: [],
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.fileData ? { fileData: input.fileData } : {}),
  };
}

export function toLibraryDocumentBackup(document: LibraryDocument): LibraryDocumentBackup {
  return {
    id: document.id,
    title: document.title,
    format: document.format,
    mimeType: document.mimeType,
    size: document.size,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    lastPosition: document.lastPosition,
    bookmarks: document.bookmarks.map(bookmark => ({ ...bookmark })),
    highlights: document.highlights.map(highlight => ({ ...highlight })),
  };
}

export function restoreLibraryDocument(record: LibraryDocumentBackup): LibraryDocument {
  return { ...record, bookmarks: record.bookmarks.map(item => ({ ...item })), highlights: record.highlights.map(item => ({ ...item })), requiresReimport: true };
}
