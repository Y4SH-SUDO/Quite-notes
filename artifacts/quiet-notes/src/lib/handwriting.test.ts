import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canDrawPointer,
  createHandwritingHistory,
  createHandwritingPage,
  isValidHandwritingPages,
  normalizeHandwritingPoint,
  pointHitsStroke,
  recordHandwritingChange,
  redoHandwritingChange,
  undoHandwritingChange,
  type HandwritingStroke,
} from './handwriting.ts';

test('normalized handwriting points preserve coordinates and fall back when pressure is unavailable', () => {
  assert.deepEqual(
    normalizeHandwritingPoint(35, 60, { left: 10, top: 20, width: 100, height: 80 }, 0, 123),
    { x: 0.25, y: 0.5, pressure: 0.5, time: 123 },
  );
});

test('pen and mouse input are accepted while touch is opt-in', () => {
  assert.equal(canDrawPointer('pen', false), true);
  assert.equal(canDrawPointer('mouse', false), true);
  assert.equal(canDrawPointer('touch', false), false);
  assert.equal(canDrawPointer('touch', true), true);
});

test('vector pages validate and erasing geometry hits nearby stroke points', () => {
  const page = createHandwritingPage();
  const stroke: HandwritingStroke = {
    color: '#d8d0c3',
    width: 5,
    points: [{ x: 0.25, y: 0.5, pressure: 0.5, time: 1 }],
  };
  page.strokes.push(stroke);
  assert.equal(isValidHandwritingPages([page]), true);
  assert.equal(pointHitsStroke(0.26, 0.5, stroke, 0.02), true);
  assert.equal(pointHitsStroke(0.8, 0.5, stroke, 0.02), false);
  assert.equal(isValidHandwritingPages([{ ...page, strokes: [{ ...stroke, points: [{ ...stroke.points[0], pressure: 2 }] }] }]), false);
});

test('erasing a stroke can be undone and redone repeatedly', () => {
  const page = createHandwritingPage();
  page.strokes.push({
    color: '#d8d0c3',
    width: 5,
    points: [{ x: 0.25, y: 0.5, pressure: 0.5, time: 1 }],
  });
  const original = [page];
  const erased = [{ ...page, strokes: [] }];
  const history = createHandwritingHistory();

  recordHandwritingChange(history, original);
  let current = erased;
  for (let index = 0; index < 2; index += 1) {
    current = undoHandwritingChange(history, current)!;
    assert.equal(current[0].strokes.length, 1);
    current = redoHandwritingChange(history, current)!;
    assert.equal(current[0].strokes.length, 0);
  }
});
