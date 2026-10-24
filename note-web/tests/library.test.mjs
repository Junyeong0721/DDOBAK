import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultNote, chooseLatest } from '../dist/storage.js';
import { migrateLegacy, validateLibrary, newPage, newNotebook, activePages, currentPage, duplicatePage, movePage, trashPage, restorePage, createBackup, parseBackup, importBackup } from '../dist/library.js';
import { selectByLasso, transformSelection, selectionBounds, shapePoints } from '../dist/editing.js';
import { eraseStroke } from '../dist/geometry.js';

const p = (x, y) => ({ x, y, p: .7, t: 100 });
const stroke = (id = 'original', kind = 'pen') => ({ id, kind, width: 4, color: '#5278aa', points: [p(-50, 0), p(50, 0)] });
function sample() {
  const old = defaultNote(); old.strokes = [stroke()]; old.title = '전공 수업'; old.view = { centerX: -4000, centerY: 7000, scale: .05 };
  return { old, library: migrateLegacy(old) };
}
test('migration retains existing ink, title, settings and distant camera without modifying legacy data', () => {
  const { old, library } = sample(), page = library.notebooks[0].pages[0];
  assert.deepEqual(page.strokes, old.strokes); assert.deepEqual(page.view, old.view); assert.equal(library.notebooks[0].title, old.title);
  page.strokes[0].points[0].x = 900;
  assert.equal(old.strokes[0].points[0].x, -50);
  assert.equal(validateLibrary(library), library);
});
test('duplicated pages have independent ink and fresh IDs', () => {
  const { library } = sample(), book = library.notebooks[0], original = book.pages[0], copy = duplicatePage(book, original);
  assert.notEqual(copy.id, original.id); assert.notEqual(copy.strokes[0].id, original.strokes[0].id);
  assert.deepEqual(copy.strokes[0].points, original.strokes[0].points);
  copy.strokes[0].points[0].x += 100; assert.equal(original.strokes[0].points[0].x, -50);
  assert.equal(book.activePageId, copy.id); validateLibrary(library);
});
test('page reordering respects boundaries and ignores trashed pages', () => {
  const { library } = sample(), book = library.notebooks[0], first = book.pages[0], second = newPage('2'), third = newPage('3');
  book.pages.push(second, third); trashPage(book, second.id);
  assert.equal(movePage(book, first.id, -1), false);
  assert.equal(movePage(book, third.id, -1), true); assert.deepEqual(activePages(book).map(page => page.id), [third.id, first.id]);
  assert.ok(book.pages.find(page => page.id === second.id).deletedAt); validateLibrary(library);
});
test('deleting the last page preserves its ink in trash and creates a writable page; restore is lossless', () => {
  const { library } = sample(), book = library.notebooks[0], original = book.pages[0], before = structuredClone(original.strokes);
  trashPage(book, original.id); assert.equal(activePages(book).length, 1); assert.notEqual(currentPage(book).id, original.id);
  validateLibrary(library); restorePage(book, original.id);
  assert.equal(currentPage(book).id, original.id); assert.deepEqual(original.strokes, before); validateLibrary(library);
});
test('full backup round trip preserves all pages, trash, highlighters and favorites without overwriting', () => {
  const { library } = sample(), book = library.notebooks[0];
  const page = newPage('강조'); page.strokes = [stroke('marker', 'highlighter')]; book.pages.push(page); trashPage(book, page.id);
  library.notebooks.push(newNotebook('영어'));
  library.favorites.push({ id: 'favorite', tool: 'highlighter', color: '#e9c95f', width: 24 });
  const original = structuredClone(library), backup = parseBackup(JSON.stringify(createBackup(library, 'all')));
  const added = importBackup(library, backup);
  assert.equal(added.length, 2); assert.equal(library.notebooks.length, 4);
  assert.deepEqual(library.notebooks.slice(0, 2), original.notebooks);
  assert.deepEqual(added[0].pages[0].strokes[0].points, original.notebooks[0].pages[0].strokes[0].points);
  assert.ok(added[0].pages[1].deletedAt); assert.equal(added[0].pages[1].strokes[0].kind, 'highlighter');
  assert.equal(library.favorites.length, 1); validateLibrary(library);
  importBackup(library, backup); assert.equal(library.notebooks.length, 6); validateLibrary(library);
});
test('single-notebook backups exclude unrelated notes; legacy exports can be imported', () => {
  const { old, library } = sample(); library.notebooks.push(newNotebook('다른 과목'));
  assert.equal(createBackup(library).notebooks.length, 1);
  const imported = importBackup(library, parseBackup(JSON.stringify({ ...old, canvas: { type: 'unbounded' } })));
  assert.deepEqual(imported[0].pages[0].strokes[0].points, old.strokes[0].points); validateLibrary(library);
});
test('invalid backup content is rejected atomically including a corrupt later notebook', () => {
  const { library } = sample(), original = structuredClone(library), backup = createBackup(library, 'all');
  const corrupt = newNotebook('손상'); corrupt.pages[0].strokes = [{ ...stroke(), points: [{ x: 'invalid', y: 0, p: .5, t: 0 }] }];
  backup.notebooks.push(corrupt);
  assert.throws(() => importBackup(library, backup)); assert.deepEqual(library, original);
  assert.throws(() => parseBackup('{invalid}')); assert.throws(() => parseBackup('{"format":"ddobak-backup","version":99}'));
});
test('duplicate page IDs and unsupported tools cannot enter persisted library data', () => {
  const { library } = sample(), book = library.notebooks[0]; book.pages.push(structuredClone(book.pages[0]));
  assert.throws(() => validateLibrary(library)); book.pages.pop(); book.pages[0].strokes[0].kind = 'unknown';
  assert.throws(() => validateLibrary(library));
});
test('latest library journal recovers newer changes and rejects malformed library state', () => {
  const { library } = sample(), pending = structuredClone(library); pending.revision = 2; pending.notebooks[0].title = '수정한 제목';
  assert.equal(chooseLatest(library, pending, validateLibrary, migrateLegacy), pending);
  pending.notebooks[0].activePageId = 'missing'; assert.throws(() => chooseLatest(library, pending, validateLibrary, migrateLegacy));
});
test('freeform selection includes crossing sparse strokes and dots while excluding outside ink', () => {
  const polygon = [p(-10, -10), p(10, -10), p(10, 10), p(-10, 10)];
  const strokes = [stroke(), { ...stroke('dot'), points: [p(2, 2)] }, { ...stroke('outside'), points: [p(100, 100), p(200, 100)] }];
  assert.deepEqual(selectByLasso(strokes, polygon), ['original', 'dot']);
  assert.deepEqual(selectByLasso(strokes, [p(0, 0), p(1, 1)]), []);
});
test('concave lasso selects only its actual area rather than its rectangular bounds', () => {
  const polygon = [p(0, 0), p(100, 0), p(100, 20), p(20, 20), p(20, 100), p(0, 100)];
  const strokes = [{ ...stroke('inside'), points: [p(10, 80)] }, { ...stroke('cutout'), points: [p(80, 80)] }];
  assert.deepEqual(selectByLasso(strokes, polygon), ['inside']);
});
test('selection move/resize preserves pressure, time, style and unselected ink for undo', () => {
  const original = [stroke(), stroke('other', 'highlighter')], copy = structuredClone(original);
  const moved = transformSelection(original, ['original'], { dx: 20, dy: 30, scale: 2, origin: { x: 0, y: 0 } });
  assert.deepEqual(moved[0].points[0], { ...original[0].points[0], x: -80, y: 30 });
  assert.equal(moved[0].width, 8); assert.equal(moved[0].color, original[0].color); assert.equal(moved[1], original[1]); assert.deepEqual(original, copy);
  assert.ok(selectionBounds(moved, ['original']).width > selectionBounds(original, ['original']).width);
});
test('arrow strokes retain editable head geometry after serialization and partial erase', () => {
  const arrow = { ...stroke('arrow', 'arrow'), points: shapePoints(p(0, 0), p(100, 0), 'arrow', 4) };
  assert.equal(arrow.points.length, 5); assert.ok(arrow.points[2].y !== arrow.points[4].y);
  const pieces = eraseStroke(arrow, p(40, -30), p(40, 30), 5); assert.equal(pieces.length, 2);
  assert.ok(pieces.every(piece => piece.kind === 'arrow'));
  const library = migrateLegacy(); library.notebooks[0].pages[0].strokes = JSON.parse(JSON.stringify(pieces)); validateLibrary(library);
});
test('erasing again after reopening never reuses the ID of a surviving fragment', async () => {
  const firstSession = await import('../dist/geometry.js?erase-session-one');
  const secondSession = await import('../dist/geometry.js?erase-session-two');
  const original = { ...stroke('stroke-1234567890-abcdefghij-123'), points: [p(0, 0), p(100, 0)] };
  const saved = JSON.parse(JSON.stringify(firstSession.eraseStroke(original, p(50, -10), p(50, 10), 5)));
  const edited = secondSession.eraseStrokes(saved, p(20, -10), p(20, 10), 5);
  assert.equal(edited.length, 3); assert.equal(new Set(edited.map(item => item.id)).size, 3);
  const library = migrateLegacy(); library.notebooks[0].pages[0].strokes = edited; validateLibrary(library);
});
