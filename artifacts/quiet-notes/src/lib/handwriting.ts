export type HandwritingPoint = {
  x: number;
  y: number;
  pressure: number;
  time: number;
};

export type HandwritingStroke = {
  color: string;
  width: number;
  points: HandwritingPoint[];
};

export type HandwritingPage = {
  width: number;
  height: number;
  strokes: HandwritingStroke[];
};

export type HandwritingHistory = {
  undo: HandwritingPage[][];
  redo: HandwritingPage[][];
};

function copyHandwritingPages(pages: HandwritingPage[]): HandwritingPage[] {
  return pages.map(page => ({
    ...page,
    strokes: page.strokes.map(stroke => ({
      ...stroke,
      points: stroke.points.map(point => ({ ...point })),
    })),
  }));
}

export function createHandwritingHistory(): HandwritingHistory {
  return { undo: [], redo: [] };
}

export function recordHandwritingChange(
  history: HandwritingHistory,
  previous: HandwritingPage[],
): void {
  history.undo.push(copyHandwritingPages(previous));
  history.redo = [];
}

export function undoHandwritingChange(
  history: HandwritingHistory,
  current: HandwritingPage[],
): HandwritingPage[] | undefined {
  const previous = history.undo.pop();
  if (!previous) return undefined;
  history.redo.push(copyHandwritingPages(current));
  return previous;
}

export function redoHandwritingChange(
  history: HandwritingHistory,
  current: HandwritingPage[],
): HandwritingPage[] | undefined {
  const next = history.redo.pop();
  if (!next) return undefined;
  history.undo.push(copyHandwritingPages(current));
  return next;
}

export function createHandwritingPage(): HandwritingPage {
  return { width: 1000, height: 1400, strokes: [] };
}

export function normalizeHandwritingPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  pressure: number,
  time = Date.now(),
): HandwritingPoint {
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    pressure: Number.isFinite(pressure) && pressure > 0 ? Math.min(1, pressure) : 0.5,
    time,
  };
}

export function canDrawPointer(pointerType: string, allowTouch: boolean): boolean {
  return pointerType === 'pen' || pointerType === 'mouse' || (pointerType === 'touch' && allowTouch);
}

export function pointHitsStroke(
  x: number,
  y: number,
  stroke: HandwritingStroke,
  radius: number,
): boolean {
  const threshold = radius + stroke.width / 2000;
  if (stroke.points.length === 1) {
    return Math.hypot(stroke.points[0].x - x, stroke.points[0].y - y) <= threshold;
  }
  for (let index = 1; index < stroke.points.length; index += 1) {
    const from = stroke.points[index - 1];
    const to = stroke.points[index];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const projection = lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((x - from.x) * dx + (y - from.y) * dy) / lengthSquared));
    if (Math.hypot(x - (from.x + projection * dx), y - (from.y + projection * dy)) <= threshold) return true;
  }
  return false;
}

export function isValidHandwritingPages(value: unknown): value is HandwritingPage[] {
  if (!Array.isArray(value)) return false;
  return value.every(page => {
    if (typeof page !== 'object' || page === null || Array.isArray(page)) return false;
    const record = page as Record<string, unknown>;
    if (
      typeof record.width !== 'number' || !Number.isFinite(record.width) || record.width <= 0
      || typeof record.height !== 'number' || !Number.isFinite(record.height) || record.height <= 0
      || !Array.isArray(record.strokes)
    ) return false;
    return record.strokes.every(stroke => {
      if (typeof stroke !== 'object' || stroke === null || Array.isArray(stroke)) return false;
      const strokeRecord = stroke as Record<string, unknown>;
      if (
        typeof strokeRecord.color !== 'string'
        || typeof strokeRecord.width !== 'number' || !Number.isFinite(strokeRecord.width) || strokeRecord.width <= 0
        || !Array.isArray(strokeRecord.points) || strokeRecord.points.length === 0
      ) return false;
      return strokeRecord.points.every(point => {
        if (typeof point !== 'object' || point === null || Array.isArray(point)) return false;
        const pointRecord = point as Record<string, unknown>;
        return typeof pointRecord.x === 'number' && Number.isFinite(pointRecord.x) && pointRecord.x >= 0 && pointRecord.x <= 1
          && typeof pointRecord.y === 'number' && Number.isFinite(pointRecord.y) && pointRecord.y >= 0 && pointRecord.y <= 1
          && typeof pointRecord.pressure === 'number' && Number.isFinite(pointRecord.pressure) && pointRecord.pressure >= 0 && pointRecord.pressure <= 1
          && typeof pointRecord.time === 'number' && Number.isFinite(pointRecord.time) && pointRecord.time >= 0;
      });
    });
  });
}
