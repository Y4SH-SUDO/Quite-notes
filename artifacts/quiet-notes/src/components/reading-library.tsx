import { useCallback, useEffect, useRef, useState } from 'react';
import type EpubFactory from 'epubjs';
import type { PDFDocumentProxy, PDFPageProxy, TextLayer as PdfTextLayer } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ArrowLeft, BookOpen, BookmarkPlus, ChevronLeft, ChevronRight, FilePlus2, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import type { LibraryDocument, ReadingBookmark, ReadingHighlight } from '@/lib/reading-library';

type EpubBook = ReturnType<typeof EpubFactory>;
type EpubRendition = EpubBook['rendition'];

type Selection = { position: string; text: string };

function selectionText(): string {
  return window.getSelection()?.toString().trim() ?? '';
}

function textOffset(root: HTMLElement, target: Node, offset: number): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    if (current === target) return total + offset;
    total += current.textContent?.length ?? 0;
  }
  return total;
}

function rangeFromTextOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const length = current.textContent?.length ?? 0;
    if (!startNode && start <= total + length) {
      startNode = current;
      startOffset = Math.max(0, start - total);
    }
    if (end <= total + length) {
      endNode = current;
      endOffset = Math.max(0, end - total);
      break;
    }
    total += length;
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, Math.min(startOffset, startNode.textContent?.length ?? 0));
  range.setEnd(endNode, Math.min(endOffset, endNode.textContent?.length ?? 0));
  return range;
}

function wrapReadingHighlight(layer: HTMLElement, highlight: ReadingHighlight) {
  const location = /^pdf:\d+:(\d+):(\d+)$/.exec(highlight.position);
  const normalizedQuote = highlight.text.replace(/\s+/g, ' ').trim();
  let range = location ? rangeFromTextOffsets(layer, Number(location[1]), Number(location[2])) : null;
  if (range?.toString().replace(/\s+/g, ' ').trim() !== normalizedQuote) range = null;
  if (!range && normalizedQuote) {
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
    let text = '';
    let node: Node | null;
    while ((node = walker.nextNode())) {
      text += node.textContent ?? '';
    }
    const start = text.replace(/\s+/g, ' ').indexOf(normalizedQuote);
    if (start >= 0) range = rangeFromTextOffsets(layer, start, start + normalizedQuote.length);
  }
  if (!range || range.collapsed) return;
  const marker = document.createElement('mark');
  marker.className = 'reading-highlight';
  marker.append(range.extractContents());
  range.insertNode(marker);
}

function ReadingLibraryView(props: {
  documents: LibraryDocument[];
  status: string;
  nativePicker: boolean;
  onImport: (file?: File) => void;
  onOpen: (document: LibraryDocument) => void;
  onDelete: (document: LibraryDocument) => void;
  onBack: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-[850px] px-6 pb-24 pt-10 sm:px-10">
      <header className="mb-8 flex items-center gap-3">
        <button onClick={props.onBack} className="control-focus grid h-10 w-10 place-items-center rounded-full text-[#aaa398]" aria-label="Back to notes">
          <ArrowLeft size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 font-serif text-3xl font-normal text-[#ded8cd]">Reading room</h1>
          <p className="mb-0 mt-1 text-sm text-[#777168]">PDF, EPUB, plain text, and Markdown</p>
        </div>
        <button onClick={() => props.nativePicker ? props.onImport() : inputRef.current?.click()} className="control-focus flex h-10 items-center gap-2 rounded-full border border-[#37332c] px-4 text-sm text-[#d8d0c3]" data-testid="button-import-reading-document">
          <FilePlus2 size={16} /> Import
        </button>
      </header>
      <input
        ref={inputRef}
        type="file"
        accept=".pdf,.epub,.txt,.md,.markdown,application/pdf,application/epub+zip,text/plain,text/markdown"
        className="sr-only"
        aria-label="Choose a document to import"
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          if (file) props.onImport(file);
          event.currentTarget.value = '';
        }}
      />
      <p className="mb-5 text-sm text-[#817b70]" aria-live="polite">{props.status || 'Imported document files stay in this app. Their annotation metadata is backed up; the original files are not.'}</p>
      {props.documents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[#302e29] p-8 text-center text-sm text-[#777168]">
          <BookOpen className="mx-auto mb-3" size={22} />
          No documents yet. Import a PDF, EPUB, TXT, or Markdown file.
        </div>
      ) : (
        <ul className="m-0 list-none divide-y divide-[#211f1a] p-0">
          {props.documents.map(document => (
            <li key={document.id} className="flex items-center gap-3 py-4">
              <button onClick={() => props.onOpen(document)} className="control-focus min-w-0 flex-1 text-left" data-testid={`button-open-reading-document-${document.id}`}>
                <span className="block truncate font-serif text-lg text-[#d6d0c5]">{document.title}</span>
                <span className="mt-1 block text-xs uppercase tracking-wider text-[#6f6a62]">
                  {document.format} · {document.bookmarks.length} bookmarks · {document.highlights.length} highlights
                  {document.requiresReimport ? ' · source file not included in backup' : ''}
                </span>
              </button>
              <button onClick={() => props.onDelete(document)} className="control-focus grid h-9 w-9 place-items-center rounded-full text-[#88766e]" aria-label={`Remove ${document.title}`} data-testid={`button-delete-reading-document-${document.id}`}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PdfPage(props: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  zoom: number;
  highlights: ReadingHighlight[];
  onSelect: (selection: Selection) => void;
  scrollRoot: { current: HTMLDivElement | null };
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(false);
  const [textLayerRevision, setTextLayerRevision] = useState(0);

  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => {
      setVisible(entries.some(entry => entry.isIntersecting));
    }, { root: props.scrollRoot.current, rootMargin: '1000px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.scrollRoot]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let textLayer: PdfTextLayer | undefined;
    let pageProxy: PDFPageProxy | undefined;
    const render = async () => {
      const container = pageRef.current;
      if (!container) return;
      try {
        const pdfjs = await import('pdfjs-dist');
        await import('pdfjs-dist/web/pdf_viewer.css');
        pageProxy = await props.pdf.getPage(props.pageNumber);
        if (cancelled) return;
        const baseViewport = pageProxy.getViewport({ scale: 1 });
        const scale = Math.min(3, Math.max(0.5, (container.parentElement?.clientWidth ?? 700) / baseViewport.width * props.zoom));
        const viewport = pageProxy.getViewport({ scale });
        const canvas = container.querySelector('canvas');
        const textLayerContainer = container.querySelector<HTMLElement>('.textLayer');
        if (!canvas || !textLayerContainer) return;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('This device cannot render a PDF page.');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
        container.style.aspectRatio = 'auto';
        textLayerContainer.style.width = `${viewport.width}px`;
        textLayerContainer.style.height = `${viewport.height}px`;
        await pageProxy.render({ canvasContext: context, viewport }).promise;
        if (cancelled) return;
        const textContent = await pageProxy.getTextContent();
        textLayer = new pdfjs.TextLayer({ textContentSource: textContent, container: textLayerContainer, viewport });
        await textLayer.render();
        if (cancelled) return;
        setTextLayerRevision(value => value + 1);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'This PDF page could not be rendered.');
      }
    };
    void render();
    return () => {
      cancelled = true;
      textLayer?.cancel();
      pageProxy?.cleanup();
      const canvas = pageRef.current?.querySelector('canvas');
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
      }
      const container = pageRef.current;
      if (container) {
        container.style.width = '100%';
        container.style.height = '';
        container.style.aspectRatio = '0.72';
      }
    };
  }, [props.pdf, props.pageNumber, props.zoom, visible]);

  useEffect(() => {
    if (!visible) return;
    const textLayer = pageRef.current?.querySelector<HTMLElement>('.textLayer');
    if (!textLayer) return;
    for (const highlight of props.highlights) {
      if (highlight.position.startsWith(`pdf:${props.pageNumber}:`)) {
        wrapReadingHighlight(textLayer, highlight);
      }
    }
  }, [props.highlights, props.pageNumber, visible, textLayerRevision]);

  return (
    <div
      ref={pageRef}
      className="relative mx-auto mb-5 w-full overflow-hidden bg-[#f3efe6] text-black shadow-lg"
      style={{ aspectRatio: '0.72' }}
      data-pdf-page={props.pageNumber}
      onMouseUp={() => {
        const selected = selectionText();
        const layer = pageRef.current?.querySelector<HTMLElement>('.textLayer');
        const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
        if (selected && layer && range && layer.contains(range.startContainer) && layer.contains(range.endContainer)) {
          const start = textOffset(layer, range.startContainer, range.startOffset);
          const end = textOffset(layer, range.endContainer, range.endOffset);
          props.onSelect({ position: `pdf:${props.pageNumber}:${start}:${end}`, text: selected });
        }
      }}
      onTouchEnd={event => {
        const target = event.currentTarget.querySelector('.textLayer');
        const selected = selectionText();
        const range = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null;
        if (selected && target && range && target.contains(range.startContainer) && target.contains(range.endContainer)) {
          const start = textOffset(target as HTMLElement, range.startContainer, range.startOffset);
          const end = textOffset(target as HTMLElement, range.endContainer, range.endOffset);
          props.onSelect({ position: `pdf:${props.pageNumber}:${start}:${end}`, text: selected });
        }
      }}
    >
      <canvas className="block" aria-label={`PDF page ${props.pageNumber}`} />
      <div className="textLayer absolute left-0 top-0" />
      {error && <p className="absolute inset-x-2 bottom-2 bg-black/80 p-2 text-xs text-white">{error}</p>}
    </div>
  );
}

function PdfReader(props: {
  document: LibraryDocument;
  onPosition: (position: string) => void;
  onSelection: (selection: Selection) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined;
    let loadedPdf: PDFDocumentProxy | undefined;
    setPdf(null);
    const load = async () => {
      try {
        if (!props.document.fileData) throw new Error('This document is not stored on this device. Import the original file again.');
        const bytes = new Uint8Array(await props.document.fileData.arrayBuffer());
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({ data: bytes });
        const loaded = await loadingTask.promise;
        loadedPdf = loaded;
        if (cancelled) {
          await loaded.destroy();
          return;
        }
        setPdf(loaded);
        const savedPage = Number(props.document.lastPosition.replace(/^pdf:/, ''));
        const target = Number.isInteger(savedPage) && savedPage > 0 ? savedPage : 1;
        setPage(Math.min(target, loaded.numPages));
        requestAnimationFrame(() => scrollRef.current?.querySelector(`[data-pdf-page="${Math.min(target, loaded.numPages)}"]`)?.scrollIntoView());
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'This PDF could not be opened.');
      }
    };
    void load();
    return () => {
      cancelled = true;
      void loadingTask?.destroy();
      void loadedPdf?.destroy();
    };
  }, [props.document.id, props.document.fileData]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const nextPage = Number((visible?.target as HTMLElement | undefined)?.dataset.pdfPage);
      if (Number.isInteger(nextPage) && nextPage > 0) {
        setPage(nextPage);
        props.onPosition(`pdf:${nextPage}`);
      }
    }, { root, threshold: [0.25, 0.6] });
    root.querySelectorAll('[data-pdf-page]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [pdf, props.onPosition]);

  return (
    <>
      {pdf && (
        <div className="mb-2 flex items-center justify-center gap-3 text-xs text-[#aaa398]">
          <button className="control-focus grid h-9 w-9 place-items-center rounded-full" disabled={page <= 1} aria-label="Previous PDF page" onClick={() => scrollRef.current?.querySelector(`[data-pdf-page="${page - 1}"]`)?.scrollIntoView({ behavior: 'smooth' })}><ChevronLeft size={17} /></button>
          <span>{page} / {pdf.numPages}</span>
          <button className="control-focus grid h-9 w-9 place-items-center rounded-full" disabled={page >= pdf.numPages} aria-label="Next PDF page" onClick={() => scrollRef.current?.querySelector(`[data-pdf-page="${page + 1}"]`)?.scrollIntoView({ behavior: 'smooth' })}><ChevronRight size={17} /></button>
          <button className="control-focus grid h-9 w-9 place-items-center rounded-full" aria-label="Zoom out" onClick={() => setZoom(value => Math.max(0.6, value - 0.2))}><ZoomOut size={16} /></button>
          <button className="control-focus grid h-9 w-9 place-items-center rounded-full" aria-label="Zoom in" onClick={() => setZoom(value => Math.min(2.5, value + 0.2))}><ZoomIn size={16} /></button>
        </div>
      )}
      <div ref={scrollRef} className="h-[calc(100dvh-170px)] overflow-auto px-2 py-4">
        {error && <p role="alert" className="mx-auto max-w-lg rounded-lg bg-[#21110e] p-4 text-sm text-[#e7c5b8]">{error}</p>}
        {pdf && Array.from({ length: pdf.numPages }, (_, index) => (
            <PdfPage key={index + 1} pdf={pdf} pageNumber={index + 1} zoom={zoom} highlights={props.document.highlights} onSelect={props.onSelection} scrollRoot={scrollRef} />
        ))}
      </div>
    </>
  );
}

function EpubReader(props: {
  document: LibraryDocument;
  onPosition: (position: string) => void;
  onSelection: (selection: Selection) => void;
  renditionRef: { current: EpubRendition | null };
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [renditionReady, setRenditionReady] = useState(false);
  const appliedHighlightIdsRef = useRef(new Set<string>());
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let book: EpubBook | undefined;
    setRenditionReady(false);
    appliedHighlightIdsRef.current.clear();
    const load = async () => {
      try {
        if (!props.document.fileData) throw new Error('This document is not stored on this device. Import the original file again.');
        const module = await import('epubjs');
        book = module.default(await props.document.fileData.arrayBuffer());
        await book.ready;
        if (cancelled || !hostRef.current) return;
        const rendition = book.renderTo(hostRef.current, { width: '100%', height: '100%', flow: 'scrolled' });
        props.renditionRef.current = rendition;
        await rendition.display(props.document.lastPosition || undefined);
        setRenditionReady(true);
        rendition.on('relocated', (location: { start?: { cfi?: string } }) => {
          if (location.start?.cfi) props.onPosition(location.start.cfi);
        });
        rendition.on('selected', (cfi: string) => {
          const text = rendition.getRange(cfi).toString().trim();
          if (text) props.onSelection({ position: cfi, text });
        });
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'This EPUB could not be opened.');
      }
    };
    void load();
    return () => {
      cancelled = true;
      props.renditionRef.current?.destroy();
      props.renditionRef.current = null;
      book?.destroy();
    };
  }, [props.document.id, props.document.fileData]);

  useEffect(() => {
    const rendition = props.renditionRef.current;
    if (!rendition || !renditionReady) return;
    for (const highlight of props.document.highlights) {
      if (appliedHighlightIdsRef.current.has(highlight.id)) continue;
      rendition.annotations.highlight(highlight.position, {}, undefined, 'saved-reading-highlight', {
        fill: 'rgba(201,185,153,.45)',
        'fill-opacity': '0.5',
        'mix-blend-mode': 'multiply',
      });
      appliedHighlightIdsRef.current.add(highlight.id);
    }
  }, [props.document.highlights, props.renditionRef, renditionReady]);

  return (
    <div className="h-[calc(100dvh-130px)] overflow-hidden rounded-xl border border-[#302e29] bg-[#f3efe6]">
      {error && <p role="alert" className="p-4 text-sm text-[#a33]">{error}</p>}
      <div ref={hostRef} className="h-full w-full text-black" />
    </div>
  );
}

function TextReader(props: {
  document: LibraryDocument;
  onPosition: (position: string) => void;
  onSelection: (selection: Selection) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const readerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    if (!props.document.fileData) {
      setError('This document is not stored on this device. Import the original file again.');
      return;
    }
    void props.document.fileData.text().then(value => {
      if (!cancelled) setText(value.replace(/\r\n?/g, '\n'));
    }).catch(caught => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : 'This text document could not be opened.');
    });
    return () => { cancelled = true; };
  }, [props.document.id, props.document.fileData]);
  useEffect(() => {
    const element = readerRef.current;
    if (!element) return;
    const savedOffset = Number(props.document.lastPosition.replace(/^text:/, ''));
    if (Number.isFinite(savedOffset) && savedOffset > 0) element.scrollTop = savedOffset;
  }, [text]);
  return (
    <div
      ref={readerRef}
      className="text-reader-scroll h-[calc(100dvh-130px)] overflow-y-auto rounded-xl border border-[#302e29] bg-[#090908] p-5 font-serif text-[17px] leading-8 text-[#d8d2c7] selection:bg-[#706047]"
      onScroll={event => props.onPosition(`text:${event.currentTarget.scrollTop}`)}
      onMouseUp={() => {
        const selected = selectionText();
        if (selected) props.onSelection({ position: `text:${readerRef.current?.scrollTop ?? 0}`, text: selected });
      }}
    >
      {error ? <p role="alert" className="text-[#e7c5b8]">{error}</p> :       <pre className="m-0 whitespace-pre-wrap font-[inherit]">{text}</pre>}
    </div>
  );
}

export function ReadingLibraryScreen(props: Parameters<typeof ReadingLibraryView>[0]) {
  return <ReadingLibraryView {...props} />;
}

export function DocumentReader(props: {
  document: LibraryDocument;
  onBack: () => void;
  onDelete: () => void;
  onChange: (document: LibraryDocument) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [highlightNote, setHighlightNote] = useState('');
  const [currentPosition, setCurrentPosition] = useState(props.document.lastPosition);
  const epubRenditionRef = useRef<EpubRendition | null>(null);
  const documentRef = useRef(props.document);
  documentRef.current = props.document;
  const positionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPositionRef = useRef<string | null>(null);
  const updatePosition = useCallback((position: string) => {
    setCurrentPosition(position);
    pendingPositionRef.current = position;
    if (positionTimerRef.current) clearTimeout(positionTimerRef.current);
    positionTimerRef.current = setTimeout(() => {
      positionTimerRef.current = null;
      const nextPosition = pendingPositionRef.current;
      pendingPositionRef.current = null;
      const current = documentRef.current;
      if (nextPosition && current.lastPosition !== nextPosition) {
        props.onChange({ ...current, lastPosition: nextPosition, updatedAt: Date.now() });
      }
    }, 500);
  }, [props.onChange]);
  useEffect(() => () => {
    if (positionTimerRef.current) clearTimeout(positionTimerRef.current);
    const nextPosition = pendingPositionRef.current;
    const current = documentRef.current;
    if (nextPosition && current.lastPosition !== nextPosition) {
      props.onChange({ ...current, lastPosition: nextPosition, updatedAt: Date.now() });
    }
  }, [props.onChange]);
  const addBookmark = () => {
    if (!currentPosition) return;
    const bookmark: ReadingBookmark = {
      id: crypto.randomUUID(),
      label: props.document.format === 'pdf' ? `Page ${currentPosition.replace(/^pdf:/, '')}` : `Position ${props.document.bookmarks.length + 1}`,
      position: currentPosition,
      createdAt: Date.now(),
    };
    props.onChange({ ...documentRef.current, bookmarks: [...documentRef.current.bookmarks, bookmark], updatedAt: Date.now() });
  };
  const addHighlight = () => {
    if (!selection) return;
    const now = Date.now();
    const highlight: ReadingHighlight = {
      id: crypto.randomUUID(),
      position: selection.position,
      text: selection.text,
      note: highlightNote.trim(),
      createdAt: now,
      updatedAt: now,
    };
    props.onChange({ ...documentRef.current, highlights: [...documentRef.current.highlights, highlight], updatedAt: now });
    setSelection(null);
    setHighlightNote('');
    window.getSelection()?.removeAllRanges();
  };
  const jumpTo = (position: string) => {
    if (props.document.format === 'pdf') {
      document.querySelector(`[data-pdf-page="${Number(position.replace(/^pdf:/, ''))}"]`)?.scrollIntoView({ behavior: 'smooth' });
    } else if (props.document.format === 'epub') {
      if (epubRenditionRef.current) void epubRenditionRef.current.display(position);
    } else if (position.startsWith('text:')) {
      const reader = document.querySelector<HTMLElement>('.text-reader-scroll');
      if (reader) reader.scrollTop = Number(position.slice(5));
    }
  };

  return (
    <section className="mx-auto min-h-[100dvh] w-full max-w-[1000px] px-4 pb-8 pt-4 sm:px-8">
      <header className="mb-4 flex items-center gap-3">
        <button onClick={props.onBack} className="control-focus grid h-10 w-10 shrink-0 place-items-center rounded-full text-[#aaa398]" aria-label="Back to reading library"><ArrowLeft size={18} /></button>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate font-serif text-xl font-normal text-[#ded8cd]">{props.document.title}</h1>
          <p className="m-0 text-xs uppercase tracking-wider text-[#777168]">{props.document.format}</p>
        </div>
        <button onClick={addBookmark} className="control-focus grid h-10 w-10 place-items-center rounded-full text-[#aaa398]" aria-label="Bookmark this position" data-testid="button-add-reading-bookmark"><BookmarkPlus size={18} /></button>
        {props.document.format === 'epub' && (
          <>
            <button onClick={() => void epubRenditionRef.current?.prev()} className="control-focus grid h-9 w-9 place-items-center rounded-full text-[#aaa398]" aria-label="Previous EPUB section"><ChevronLeft size={16} /></button>
            <button onClick={() => void epubRenditionRef.current?.next()} className="control-focus grid h-9 w-9 place-items-center rounded-full text-[#aaa398]" aria-label="Next EPUB section"><ChevronRight size={16} /></button>
          </>
        )}
        <button onClick={props.onDelete} className="control-focus grid h-10 w-10 place-items-center rounded-full text-[#88766e]" aria-label="Remove document" data-testid="button-remove-reading-document"><Trash2 size={17} /></button>
      </header>
      {props.document.format === 'pdf' ? (
        <PdfReader document={props.document} onPosition={updatePosition} onSelection={setSelection} />
      ) : props.document.format === 'epub' ? (
        <EpubReader document={props.document} onPosition={updatePosition} onSelection={setSelection} renditionRef={epubRenditionRef} />
      ) : (
        <TextReader document={props.document} onPosition={updatePosition} onSelection={setSelection} />
      )}
      {selection && (
        <div className="fixed inset-x-3 bottom-4 z-20 mx-auto flex max-w-2xl flex-wrap items-center gap-2 rounded-xl border border-[#39342b] bg-[#11110f] p-3 shadow-xl">
          <p className="m-0 max-h-10 min-w-0 flex-1 overflow-hidden text-xs text-[#c6bba8]">{selection.text}</p>
          <input value={highlightNote} onChange={event => setHighlightNote(event.target.value)} className="min-w-32 flex-1 rounded border border-[#36332d] bg-black px-2 py-1 text-sm text-[#ddd5c8]" aria-label="Thought about this passage" placeholder="Add a thought" />
          <button onClick={addHighlight} className="control-focus rounded border border-[#514a3d] px-3 py-1.5 text-sm text-[#ddd5c8]" data-testid="button-save-reading-highlight">Save highlight</button>
        </div>
      )}
      {props.document.bookmarks.length > 0 && (
        <details className="mt-4 rounded-lg border border-[#282621] p-3 text-sm text-[#bfb7a9]">
          <summary className="cursor-pointer">Bookmarks ({props.document.bookmarks.length})</summary>
          {props.document.bookmarks.map(bookmark => (
            <button key={bookmark.id} className="control-focus mr-2 mt-2 rounded border border-[#39342b] px-2 py-1 text-xs" onClick={() => jumpTo(bookmark.position)}>{bookmark.label}</button>
          ))}
        </details>
      )}
      {props.document.highlights.length > 0 && (
        <details className="mt-3 rounded-lg border border-[#282621] p-3 text-sm text-[#bfb7a9]">
          <summary className="cursor-pointer">Highlights and thoughts ({props.document.highlights.length})</summary>
          {props.document.highlights.map(highlight => (
            <div key={highlight.id} className="mt-3 border-l-2 border-[#8c7958] pl-3">
              <button className="control-focus text-left text-xs text-[#d8d0c3]" onClick={() => jumpTo(highlight.position)}>{highlight.text}</button>
              {highlight.note && <p className="mb-0 mt-1 text-xs text-[#817b70]">{highlight.note}</p>}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
