import test from 'node:test';
import assert from 'node:assert/strict';
import { isWritablePoint, visibleBounds, writingView, fitInkView, cameraFromView, viewFromCamera, inkBounds, eraseStroke, eraseStrokes, documentPoint, zoomView, capsuleInterval } from '../dist/geometry.js';
import { InputController } from '../dist/input.js';
import { chooseLatest, defaultNote, validateNote } from '../dist/storage.js';

const p = (x, y = 0) => ({ x, y, p: .5, t: x });
const stroke = points => ({ id: 'original', color: '#293e3b', width: 2, points });

test('white workspace accepts ink far beyond the former page in every direction', () => {
  for (const point of [p(-100000, -100000), p(100000, 100000), p(-100000, 100000), p(100000, -100000)]) assert.ok(isWritablePoint(point));
  assert.equal(isWritablePoint(p(NaN)), false);
  assert.equal(isWritablePoint(p(0, Infinity)), false);
});
test('visible guide bounds follow the viewport without page-edge clipping', () => {
  const view = { x: 20000, y: -30000, scale: .5 }, bounds = visibleBounds(view, 1000, 600);
  assert.deepEqual(bounds, { left: -40000, top: 60000, width: 2000, height: 1200 });
  assert.ok(isWritablePoint(documentPoint(p(1, 1), view)));
  assert.ok(isWritablePoint(documentPoint(p(999, 599), view)));
});
test('all-ink view contains distant positive and negative ink without changing it', () => {
  const strokes = [stroke([p(-100000, -20000), p(-99000, -19000)]), stroke([p(100000, 20000)])];
  const original = structuredClone(strokes), bounds = inkBounds(strokes), view = fitInkView(strokes, 1000, 600);
  const left = bounds.left * view.scale + view.x, top = bounds.top * view.scale + view.y;
  assert.ok(left >= 47.99 && top >= 47.99);
  assert.ok(left + bounds.width * view.scale <= 952.01 && top + bounds.height * view.scale <= 552.01);
  assert.deepEqual(strokes, original);
  assert.deepEqual(fitInkView([], 1000, 600), writingView(1000, 600));
});
test('distant ink and viewing position survive save and reopening at another screen size', () => {
  const note = defaultNote();
  note.strokes = [stroke([p(-100000, 20000), p(-99900, 20100)])];
  note.view = cameraFromView({ x: 50000, y: -10000, scale: .5 }, 1000, 600);
  const saved = validateNote(JSON.parse(JSON.stringify(note)));
  const reopened = viewFromCamera(saved.view, 768, 900);
  const center = documentPoint(p(384, 450), reopened);
  assert.equal(center.x, note.view.centerX); assert.equal(center.y, note.view.centerY);
  assert.deepEqual(saved.strokes, note.strokes);
});
test('invalid saved view cannot hide or overwrite existing ink', () => {
  assert.throws(() => validateNote({ ...defaultNote(), view: { centerX: 0, centerY: 0, scale: 0 } }));
  assert.throws(() => validateNote({ ...defaultNote(), view: { centerX: Infinity, centerY: 0, scale: 1 } }));
  assert.doesNotThrow(() => validateNote(defaultNote()));
});
test('pages open at 100% on desktop, tablet and phone, preserving legacy camera centers', () => {
  for (const [width, height] of [[1254, 726], [768, 900], [390, 600]]) {
    assert.equal(writingView(width, height).scale, 1);
    for (const scale of [.000001, .05, .5, 4]) {
      const camera = { centerX: -100000, centerY: 25000, scale };
      const saved = validateNote({ ...defaultNote(), view: camera });
      const reopened = writingView(width, height, saved.view);
      assert.deepEqual(cameraFromView(reopened, width, height), { ...camera, scale: 1 });
      assert.deepEqual(saved.view, camera);
    }
  }
});
test('repeated zoom gestures stop at 10% and 100% while retaining their anchor', () => {
  let view = writingView(1000, 600);
  const anchor = { x: 230, y: 180 }, original = documentPoint(anchor, view);
  for (const [factor, limit] of [[.8, .1], [1.25, 1]]) {
    for (let i = 0; i < 30; i++) {
      view = zoomView(view, factor, anchor);
      assert.ok(view.scale >= .1 && view.scale <= 1);
      const point = documentPoint(anchor, view);
      assert.ok(Math.abs(point.x - original.x) < 1e-8 && Math.abs(point.y - original.y) < 1e-8);
    }
    assert.equal(view.scale, limit);
  }
});
test('pinch translation still pans when zoom reaches either limit', () => {
  const anchor = { x: 200, y: 200 }, destination = { x: 240, y: 260 };
  for (const [scale, factor] of [[.1, .2], [1, 5]]) {
    const view = { x: -120, y: 20, scale }, after = zoomView(view, factor, anchor, destination);
    assert.equal(after.scale, scale);
    assert.deepEqual(documentPoint(destination, after), documentPoint(anchor, view));
  }
});

test('partial eraser splits a sparse stroke without deleting the whole line', () => {
  const original = stroke([p(0), p(100)]);
  const pieces = eraseStroke(original, p(50), p(50), 9);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces.map(s => s.points.map(point => point.x)), [[0, 40], [60, 100]]);
  assert.equal(original.points[1].x, 100);
});
test('fast eraser movement cuts ink between event samples', () => {
  const pieces = eraseStroke(stroke([p(0), p(100)]), p(50, -100), p(50, 100), 9);
  assert.deepEqual(pieces.map(s => s.points.map(point => point.x)), [[0, 40], [60, 100]]);
});
test('dots can be erased by both stationary and moving erasers', () => {
  const dot = stroke([p(50)]);
  assert.equal(eraseStroke(dot, p(50), p(50), 9).length, 0);
  assert.equal(eraseStroke(dot, p(50, -100), p(50, 100), 9).length, 0);
});
test('eraser misses preserve the original object and undo history identity', () => {
  const original = [stroke([p(0), p(100)])];
  assert.equal(eraseStrokes(original, p(50, 100), p(70, 100), 9), original);
});
test('a diagonal capsule clips a segment even when both endpoints are outside', () => {
  const hit = capsuleInterval(p(0), p(100), p(20, -30), p(80, 30), 5);
  assert.ok(hit[0] < .5 && hit[1] > .5);
  assert.ok(hit[0] > 0 && hit[1] < 1);
});
test('zoom and pinch translation preserve the document point under the fingers', () => {
  const view = { x: -120, y: 20, scale: .5 }, anchor = p(200, 300), destination = p(250, 320);
  const original = documentPoint(anchor, view);
  const after = documentPoint(destination, zoomView(view, 1.6, anchor, destination));
  assert.ok(Math.abs(after.x - original.x) < 1e-8);
  assert.ok(Math.abs(after.y - original.y) < 1e-8);
});

function rig(settings = {}) {
  const calls = [], config = { finger: false, locked: false, ...settings };
  let time = 1000;
  const callbacks = Object.fromEntries(['begin', 'move', 'end', 'cancel', 'pan', 'zoom'].map(key => [key, (...args) => calls.push([key, ...args])]));
  return { calls, config, controller: new InputController(callbacks, () => config, () => time), advance: ms => { time += ms; } };
}
const e = (id, type, x = 20, y = 20, extra = {}) => ({ id, type, x, y, button: 0, width: 8, height: 8, ...extra });
test('mouse draws; Shift drag pans instead of drawing', () => {
  const r = rig();
  r.controller.down(e(1, 'mouse')); r.controller.up(e(1, 'mouse', 30));
  assert.deepEqual(r.calls.map(c => c[0]), ['begin', 'move', 'end']);
  r.calls.length = 0;
  r.controller.down(e(1, 'mouse', 20, 20, { shift: true })); r.controller.move(e(1, 'mouse', 40)); r.controller.up(e(1, 'mouse', 40));
  assert.deepEqual(r.calls, [['pan', 20, 0]]);
});
test('locked page blocks Shift panning while pen still writes', () => {
  const r = rig({ locked: true });
  r.controller.down(e(1, 'mouse', 20, 20, { shift: true })); r.controller.move(e(1, 'mouse', 40)); r.controller.up(e(1, 'mouse'));
  assert.equal(r.calls.length, 0);
  r.controller.down(e(2, 'pen')); r.controller.up(e(2, 'pen', 30));
  assert.deepEqual(r.calls.map(c => c[0]), ['begin', 'move', 'end']);
});
test('finger-writing setting takes precedence over one-finger pan', () => {
  for (const locked of [false, true]) {
    const r = rig({ finger: true, locked });
    r.controller.down(e(1, 'touch')); r.controller.move(e(1, 'touch', 40)); r.controller.up(e(1, 'touch', 40));
    assert.equal(r.calls[0][0], 'begin');
    assert.equal(r.calls.at(-1)[0], 'end');
    assert.equal(r.calls.filter(c => c[0] === 'pan').length, 0);
  }
});
test('one finger pans only when finger-writing and lock are both off', () => {
  for (const locked of [false, true]) {
    const r = rig({ locked });
    r.controller.down(e(1, 'touch')); r.controller.move(e(1, 'touch', 40)); r.controller.up(e(1, 'touch'));
    assert.deepEqual(r.calls, locked ? [] : [['pan', 20, 0]]);
  }
});
test('two fingers cancel provisional finger ink and never resume ink on one-finger lift', () => {
  const r = rig({ finger: true });
  r.controller.down(e(1, 'touch')); r.controller.move(e(1, 'touch', 25));
  r.controller.down(e(2, 'touch', 60)); r.controller.move(e(2, 'touch', 80));
  r.controller.up(e(2, 'touch', 80)); r.controller.move(e(1, 'touch', 90)); r.controller.up(e(1, 'touch', 90));
  assert.deepEqual(r.calls.map(c => c[0]), ['begin', 'move', 'cancel', 'zoom']);
});
test('screen lock blocks two-finger zoom', () => {
  const r = rig({ locked: true });
  r.controller.down(e(1, 'touch')); r.controller.down(e(2, 'touch', 60)); r.controller.move(e(2, 'touch', 100));
  assert.equal(r.calls.length, 0);
});
test('pen cancels accidental finger ink and ignores palm until it lifts', () => {
  const r = rig({ finger: true });
  r.controller.down(e(1, 'touch')); r.controller.down(e(2, 'pen')); r.controller.move(e(1, 'touch', 40));
  r.controller.down(e(3, 'touch', 80)); r.controller.move(e(3, 'touch', 90));
  r.controller.up(e(2, 'pen')); r.advance(500); r.controller.move(e(3, 'touch', 100));
  assert.deepEqual(r.calls.map(c => c[0]), ['begin', 'cancel', 'begin', 'move', 'end']);
  r.controller.up(e(1, 'touch')); r.controller.up(e(3, 'touch'));
  r.controller.down(e(4, 'touch')); assert.equal(r.calls.at(-1)[0], 'begin');
});
test('large palm contact does not start drawing or movement', () => {
  const r = rig({ finger: true });
  r.controller.down(e(1, 'touch', 10, 10, { width: 70, height: 70 })); r.controller.move(e(1, 'touch', 40));
  assert.equal(r.calls.length, 0);
});

test('newest pending save recovers edits not yet committed to the database', () => {
  const saved = { ...defaultNote(), revision: 3 }, pending = { ...defaultNote(), revision: 4, strokes: [stroke([p(5)])] };
  assert.equal(chooseLatest(saved, pending), pending);
  assert.equal(chooseLatest(pending, saved), pending);
  assert.equal(chooseLatest(null, pending), pending);
});
test('malformed saved ink is rejected rather than silently replaced', () => {
  assert.throws(() => validateNote({ ...defaultNote(), strokes: [stroke([{ x: NaN, y: 0, p: .5, t: 0 }])] }));
  assert.throws(() => chooseLatest({ schema: 2 }, defaultNote()));
});
test('saved erase fragments retain pressure/time and survive serialization', () => {
  const note = defaultNote(); note.strokes = eraseStroke(stroke([p(0), p(100)]), p(50), p(50), 9);
  const copy = JSON.parse(JSON.stringify(note));
  assert.deepEqual(validateNote(copy), note);
  assert.equal(copy.strokes[0].points.at(-1).t, 40);
});
