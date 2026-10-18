import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { ChevronLeft, ChevronRight, Eraser, PenLine, Plus, Redo2, Undo2 } from 'lucide-react';
import {
  canDrawPointer,
  createHandwritingHistory,
  createHandwritingPage,
  normalizeHandwritingPoint,
  pointHitsStroke,
  recordHandwritingChange,
  redoHandwritingChange,
  undoHandwritingChange,
  type HandwritingPage,
  type HandwritingStroke,
} from '@/lib/handwriting';

type Tool = 'pen' | 'eraser';

function copyPages(pages: HandwritingPage[]): HandwritingPage[] {
  return pages.map(page => ({
    ...page,
    strokes: page.strokes.map(stroke => ({
      ...stroke,
      points: stroke.points.map(point => ({ ...point })),
    })),
  }));
}

function drawStroke(context: CanvasRenderingContext2D, page: HandwritingPage, stroke: HandwritingStroke) {
  if (stroke.points.length === 0) return;
  const aspect = page.height / page.width;
  context.strokeStyle = stroke.color;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    context.fillStyle = stroke.color;
    const radius = (stroke.width / page.width) * (0.35 + point.pressure * 1.3) / 2;
    context.beginPath();
    context.arc(point.x, point.y * aspect, radius, 0, Math.PI * 2);
    context.fill();
    return;
  }
  for (let index = 1; index < stroke.points.length; index += 1) {
    const from = stroke.points[index - 1];
    const to = stroke.points[index];
    context.lineWidth = (stroke.width / page.width) * (0.35 + ((from.pressure + to.pressure) / 2) * 1.3);
    context.beginPath();
    context.moveTo(from.x, from.y * aspect);
    const next = stroke.points[index + 1];
    if (next) {
      context.quadraticCurveTo(to.x, to.y * aspect, (to.x + next.x) / 2, ((to.y + next.y) / 2) * aspect);
    } else {
      context.lineTo(to.x, to.y * aspect);
    }
    context.stroke();
  }
}

export function HandwritingCanvas(props: {
  initialPages?: HandwritingPage[];
  onChange: (pages: HandwritingPage[]) => void;
}) {
  const [pages, setPages] = useState<HandwritingPage[]>(() => props.initialPages?.length ? copyPages(props.initialPages) : [createHandwritingPage()]);
  const [pageIndex, setPageIndex] = useState(0);
  const [tool, setTool] = useState<Tool>('pen');
  const [allowTouch, setAllowTouch] = useState(false);
  const [draft, setDraft] = useState<HandwritingStroke | null>(null);
  const draftRef = useRef<HandwritingStroke | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pagesRef = useRef(pages);
  const pageIndexRef = useRef(pageIndex);
  const onChangeRef = useRef(props.onChange);
  const activePointerRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const eraseBeforeRef = useRef<HandwritingPage[] | null>(null);
  const historyRef = useRef(createHandwritingHistory());
  const [historyRevision, setHistoryRevision] = useState(0);
  pagesRef.current = pages;
  pageIndexRef.current = pageIndex;
  onChangeRef.current = props.onChange;
  const updateDraft = (stroke: HandwritingStroke | null) => {
    draftRef.current = stroke;
    setDraft(stroke);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const page = pages[pageIndex];
    if (!canvas || !page) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(rect.width * ratio, 0, 0, rect.width * ratio, 0, 0);
    context.clearRect(0, 0, 1, page.height / page.width);
    context.fillStyle = '#0d0d0b';
    context.fillRect(0, 0, 1, page.height / page.width);
    for (const stroke of page.strokes) drawStroke(context, page, stroke);
    if (draft && tool === 'pen') drawStroke(context, page, draft);
  }, [pages, pageIndex, draft, tool, historyRevision]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const observer = canvas ? new ResizeObserver(() => setHistoryRevision(value => value + 1)) : null;
    if (canvas && observer) observer.observe(canvas);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => () => {
    const pendingStroke = draftRef.current;
    if (!pendingStroke && !dirtyRef.current) return;
    const next = copyPages(pagesRef.current);
    if (pendingStroke?.points.length) next[pageIndexRef.current].strokes.push(pendingStroke);
    onChangeRef.current(next);
  }, []);

  const commit = (next: HandwritingPage[], previous = pagesRef.current) => {
    recordHandwritingChange(historyRef.current, previous);
    pagesRef.current = next;
    setPages(next);
    props.onChange(copyPages(next));
    setHistoryRevision(value => value + 1);
  };

  const begin = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canDrawPointer(event.pointerType, allowTouch) || activePointerRef.current !== null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerRef.current = event.pointerId;
    const rect = event.currentTarget.getBoundingClientRect();
    const point = normalizeHandwritingPoint(event.clientX, event.clientY, rect, event.pressure);
    if (tool === 'eraser') {
      eraseBeforeRef.current = copyPages(pagesRef.current);
      dirtyRef.current = false;
      const next = copyPages(pagesRef.current);
      const page = next[pageIndexRef.current];
      const radius = 14 / Math.max(1, rect.width);
      page.strokes = page.strokes.filter(stroke => !pointHitsStroke(point.x, point.y, stroke, radius));
      dirtyRef.current = page.strokes.length !== pagesRef.current[pageIndexRef.current].strokes.length;
      pagesRef.current = next;
      setPages(next);
      return;
    }
    updateDraft({ color: '#d8d0c3', width: 5, points: [point] });
  };

  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const point = normalizeHandwritingPoint(event.clientX, event.clientY, rect, event.pressure);
    if (tool === 'eraser') {
      const next = copyPages(pagesRef.current);
      const page = next[pageIndexRef.current];
      const radius = 14 / Math.max(1, rect.width);
      const remaining = page.strokes.filter(stroke => !pointHitsStroke(point.x, point.y, stroke, radius));
      if (remaining.length !== page.strokes.length) {
        page.strokes = remaining;
        pagesRef.current = next;
        setPages(next);
        dirtyRef.current = true;
      }
      return;
    }
    const current = draftRef.current;
    if (current) updateDraft({ ...current, points: [...current.points, point] });
  };

  const finish = (event: PointerEvent<HTMLCanvasElement>) => {
    if (activePointerRef.current !== event.pointerId) return;
    activePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (tool === 'eraser') {
      if (dirtyRef.current) {
        dirtyRef.current = false;
        commit(copyPages(pagesRef.current), eraseBeforeRef.current ?? pagesRef.current);
      }
      eraseBeforeRef.current = null;
      return;
    }
    const current = draftRef.current;
    updateDraft(null);
    if (!current?.points.length) return;
    const next = copyPages(pagesRef.current);
    next[pageIndexRef.current].strokes.push(current);
    commit(next);
  };
  const undo = () => {
    const previous = undoHandwritingChange(historyRef.current, pagesRef.current);
    if (!previous) return;
    pagesRef.current = previous;
    setPages(previous);
    props.onChange(copyPages(previous));
    setHistoryRevision(value => value + 1);
  };
  const redo = () => {
    const next = redoHandwritingChange(historyRef.current, pagesRef.current);
    if (!next) return;
    pagesRef.current = next;
    setPages(next);
    props.onChange(copyPages(next));
    setHistoryRevision(value => value + 1);
  };
  const addPage = () => {
    const next = copyPages(pagesRef.current);
    next.push(createHandwritingPage());
    commit(next);
    setPageIndex(next.length - 1);
  };

  return (
    <section className="mt-7 rounded-xl border border-[#302e29] bg-[#10100e] p-3 sm:p-4" aria-label="Handwriting canvas" data-testid="handwriting-canvas">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setTool('pen')} aria-pressed={tool === 'pen'} className={`control-focus flex h-9 items-center gap-2 rounded-md px-3 text-xs ${tool === 'pen' ? 'bg-[#29261f] text-[#e2d8c6]' : 'text-[#8d887e]'}`} data-testid="button-handwriting-pen"><PenLine size={15} />Pen</button>
        <button onClick={() => setTool('eraser')} aria-pressed={tool === 'eraser'} className={`control-focus flex h-9 items-center gap-2 rounded-md px-3 text-xs ${tool === 'eraser' ? 'bg-[#29261f] text-[#e2d8c6]' : 'text-[#8d887e]'}`} data-testid="button-handwriting-eraser"><Eraser size={15} />Eraser</button>
        <button onClick={undo} disabled={!historyRef.current.undo.length} className="control-focus grid h-9 w-9 place-items-center rounded-md text-[#aaa398] disabled:opacity-35" aria-label="Undo handwriting" data-testid="button-handwriting-undo"><Undo2 size={16} /></button>
        <button onClick={redo} disabled={!historyRef.current.redo.length} className="control-focus grid h-9 w-9 place-items-center rounded-md text-[#aaa398] disabled:opacity-35" aria-label="Redo handwriting" data-testid="button-handwriting-redo"><Redo2 size={16} /></button>
        <button onClick={addPage} className="control-focus ml-auto flex h-9 items-center gap-2 rounded-md px-3 text-xs text-[#aaa398]" data-testid="button-handwriting-add-page"><Plus size={15} />Page</button>
        <button onClick={() => setPageIndex(index => Math.max(0, index - 1))} disabled={pageIndex === 0} className="control-focus grid h-9 w-9 place-items-center rounded-md text-[#aaa398] disabled:opacity-35" aria-label="Previous handwriting page"><ChevronLeft size={16} /></button>
        <span className="text-xs text-[#777168]">{pageIndex + 1} / {pages.length}</span>
        <button onClick={() => setPageIndex(index => Math.min(pages.length - 1, index + 1))} disabled={pageIndex >= pages.length - 1} className="control-focus grid h-9 w-9 place-items-center rounded-md text-[#aaa398] disabled:opacity-35" aria-label="Next handwriting page"><ChevronRight size={16} /></button>
        <label className="flex min-h-9 items-center gap-2 px-2 text-xs text-[#aaa398]">
          <input type="checkbox" checked={allowTouch} onChange={event => setAllowTouch(event.target.checked)} aria-label="Allow finger drawing" data-testid="toggle-handwriting-touch" />
          Finger input
        </label>
      </div>
      <div className="overflow-hidden rounded-lg border border-[#292723]">
        <canvas
          ref={canvasRef}
          className="block w-full select-none"
          style={{ aspectRatio: '1000 / 1400', touchAction: allowTouch ? 'none' : 'pan-y' }}
          aria-label={`Handwriting page ${pageIndex + 1}`}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={finish}
        />
      </div>
      <p className="mb-0 mt-2 text-[11px] leading-relaxed text-[#6f6a62]">Pen and mouse draw directly. Finger input is off by default to reduce accidental marks; palm rejection depends on what this WebView reports.</p>
    </section>
  );
}
