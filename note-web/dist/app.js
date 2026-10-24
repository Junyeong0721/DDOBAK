import { MIN_ZOOM, MAX_ZOOM, documentPoint, isWritablePoint, visibleBounds, cameraFromView, writingView, zoomView, eraseStrokes } from './geometry.js';
import { InputController } from './input.js';
import { NoteStorage } from './storage.js';
import { uid, newPage, newNotebook, migrateLegacy, validateLibrary, activePages, currentNotebook, currentPage, duplicatePage, movePage, trashPage, restorePage, createBackup, parseBackup, importBackup } from './library.js';
import { selectByLasso, selectionBounds, transformSelection, resizeFactor, shapePoints } from './editing.js';
import { paintInk, paintPreview } from './painting.js';

const $ = id => document.getElementById(id);
const paths = {
  leaf: '<path d="M5 20C5 8 11 4 20 4c0 10-5 15-12 14M4 21 16 8"/>',
  pen: '<path d="m14 4 6 6M4 20l4-1 12-12a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/>',
  eraser: '<path d="m13 4 7 7a2 2 0 0 1 0 3l-6 6H8l-5-5a2 2 0 0 1 0-3l7-8a2 2 0 0 1 3 0ZM7 9l10 9M14 20h7"/>',
  highlighter: '<path d="m14 3 7 7-9 9-7-7 9-9ZM5 12l-2 7 2 2 7-2M3 22h14"/>',
  lasso: '<ellipse cx="12" cy="9" rx="9" ry="6" stroke-dasharray="3 3"/><path d="M5 14c-4 9 9 9 8 3"/>',
  line: '<path d="m4 20 16-16"/><circle cx="4" cy="20" r="1"/><circle cx="20" cy="4" r="1"/>',
  star: '<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9L12 3Z"/>',
  undo: '<path d="m8 5-5 5 5 5M3 10h11a6 6 0 0 1 0 12" transform="translate(0 -2)"/>',
  redo: '<path d="m16 5 5 5-5 5M21 10H10a6 6 0 0 0 0 12" transform="translate(0 -2)"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M4 10h16M10 4v16"/>',
  finger: '<path d="M9 12V4a2 2 0 0 1 4 0v7l3-1a3 3 0 0 1 4 3l-1 5a4 4 0 0 1-4 3h-3a5 5 0 0 1-4-2l-4-5a2 2 0 0 1 3-3l2 1Z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V6a4 4 0 0 1 8 0M12 14v3"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-1 .5-1 1-1 2M12 17h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>', close: '<path d="m6 6 12 12M6 18 18 6"/>',
  fit: '<path d="M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  scribble: '<path d="M2 17c5-13 10-15 11-10S4 26 10 24 25 3 24 8 14 23 22 19s7-8 12-7 2 5 8 3 9-3 16-2"/>'
};
const icon = name => `<svg viewBox="${name === 'scribble' ? '0 0 62 30' : '0 0 24 24'}" aria-hidden="true">${paths[name]}</svg>`;
document.querySelectorAll('[data-icon]').forEach(element => { element.innerHTML = icon(element.dataset.icon); });

const canvas = $('paper'), context = canvas.getContext('2d'), workspace = $('workspace');
const editor = document.querySelector('.app-shell');
const toolNames = ['pen', 'eraser', 'highlighter', 'lasso', 'line', 'arrow'];
let library = migrateLegacy(), book = currentNotebook(library), note = currentPage(book);
let ready = false, tool = 'pen', view = { x: 0, y: 0, scale: 1 };
let viewport = { width: 0, height: 0 }, renderPending = false, drawing = null, beforeInk = null, lastErase = null;
let undoStack = [], redoStack = [], toastTimer;
let thumbnailDirty = true;
let viewSaveTimer = null, viewDirty = false;
let selected = [], lassoPath = null, selectionDrag = null, clipboard = [], pasteCount = 0;
let trashVisible = false, nameAction = null, pendingImport = null;
const histories = new Map();

function saveStatus(status) {
  $('save-status').dataset.state = status;
  $('save-status').lastElementChild.textContent = { saved: '이 기기에 저장됨', saving: '저장 중', fallback: '임시 저장됨', error: '저장하지 못함' }[status];
  if (status === 'error' || status === 'fallback') {
    $('notice').textContent = status === 'error' ? '저장 공간을 확인해 주세요. 현재 글씨는 상단의 내보내기로 보관할 수 있어요.' : '임시 저장소에 보관했어요. 중요한 글씨는 파일로 내보내 주세요.';
    $('notice').hidden = false;
  } else if (status === 'saved' && ready) $('notice').hidden = true;
}
const storage = new NoteStorage(saveStatus, {
  key: 'library-v2', journal: 'handwriting-library-v2-pending', validate: validateLibrary, create: migrateLegacy,
  migrate: async () => {
    const legacyStorage = new NoteStorage(() => {});
    try { return migrateLegacy(await legacyStorage.load()); } finally { legacyStorage.database?.close(); }
  }
});
function persist() {
  if (!ready) return;
  clearTimeout(viewSaveTimer); viewDirty = false;
  note.view = cameraFromView(view, viewport.width, viewport.height);
  library.revision++; library.updatedAt = note.updatedAt = book.updatedAt = new Date().toISOString();
  void storage.save(library);
}
function saveViewSoon() {
  if (!ready) return;
  viewDirty = true; clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(persist, 250);
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2200);
}
function redraw() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; render(); });
}

function paintContents(ctx, bounds, scale, includeActive = true, guides = true) {
  ctx.save();
  if (guides && note.settings.guide !== 'none') {
    // Draw only visible guides; zooming out must not allocate an enormous paper.
    const step = 64 * 2 ** Math.max(0, Math.ceil(Math.log2(8 / (64 * scale))));
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#dce4d9'; ctx.beginPath();
    for (let y = Math.ceil((bounds.top - 96) / step) * step + 96; y < bounds.top + bounds.height; y += step) { ctx.moveTo(bounds.left, y); ctx.lineTo(bounds.left + bounds.width, y); }
    if (note.settings.guide === 'grid') for (let x = Math.ceil(bounds.left / step) * step; x < bounds.left + bounds.width; x += step) { ctx.moveTo(x, bounds.top); ctx.lineTo(x, bounds.top + bounds.height); }
    ctx.stroke();
  }
  paintInk(ctx, note.strokes, includeActive ? drawing : null);
  ctx.restore();
}
function paintSelection() {
  if (tool !== 'lasso') return;
  context.save(); context.strokeStyle = '#3e6757'; context.lineWidth = 1.5 / view.scale; context.setLineDash([6 / view.scale, 4 / view.scale]);
  if (lassoPath?.length) {
    context.beginPath(); context.moveTo(lassoPath[0].x, lassoPath[0].y);
    for (const point of lassoPath.slice(1)) context.lineTo(point.x, point.y);
    context.closePath(); context.fillStyle = '#3e675710'; context.fill(); context.stroke();
  }
  const bounds = selectionBounds(note.strokes, selected);
  if (bounds) {
    const pad = 6 / view.scale;
    context.strokeRect(bounds.left - pad, bounds.top - pad, bounds.width + pad * 2, bounds.height + pad * 2);
    context.setLineDash([]); context.fillStyle = '#3e6757'; context.beginPath();
    context.arc(bounds.left + bounds.width + pad, bounds.top + bounds.height + pad, 6 / view.scale, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}
function render() {
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, viewport.width, viewport.height);
  context.save(); context.translate(view.x, view.y); context.scale(view.scale, view.scale);
  paintContents(context, visibleBounds(view, viewport.width, viewport.height), view.scale); paintSelection(); context.restore();
  $('zoom-value').textContent = `${Math.round(view.scale * 100)}%`;
  refreshZoomControls();
  $('empty-hint').hidden = note.strokes.length > 0 || !!drawing;
  $('empty-hint').style.left = `${viewport.width / 2}px`;
  $('empty-hint').style.top = `${viewport.height * .44}px`;
  $('undo').disabled = !ready || !undoStack.length;
  $('redo').disabled = !ready || !redoStack.length;
  refreshSelection();
  if (thumbnailDirty) {
    thumbnailDirty = false;
    if (!$('page-rail').hidden) renderPages();
  }
}
function resize() {
  const old = viewport, rect = workspace.getBoundingClientRect();
  viewport = { width: rect.width, height: rect.height };
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(viewport.width * ratio); canvas.height = Math.round(viewport.height * ratio);
  if (!old.width) view = writingView(viewport.width, viewport.height);
  else view = { ...view, x: view.x + (viewport.width - old.width) / 2, y: view.y + (viewport.height - old.height) / 2 };
  redraw();
}
new ResizeObserver(resize).observe(workspace);

function beginInk(event) {
  if (!ready) return;
  const point = documentPoint(event, view);
  if (!isWritablePoint(point)) return;
  if (tool === 'lasso') {
    const bounds = selectionBounds(note.strokes, selected), pad = 6 / view.scale;
    const resize = bounds && Math.hypot(point.x - bounds.left - bounds.width - pad, point.y - bounds.top - bounds.height - pad) < 15 / view.scale;
    const inside = bounds && point.x >= bounds.left - pad && point.x <= bounds.left + bounds.width + pad && point.y >= bounds.top - pad && point.y <= bounds.top + bounds.height + pad;
    if (resize || inside) {
      beforeInk = note.strokes; selectionDrag = { bounds, start: point, resize, changed: false };
    } else { selected = []; lassoPath = [point]; }
    redraw(); return;
  }
  selected = [];
  beforeInk = note.strokes;
  if (tool === 'eraser') {
    lastErase = point;
    note.strokes = eraseStrokes(note.strokes, point, point, note.settings.eraser / 2);
  } else drawing = { id: uid('stroke'), kind: tool, color: tool === 'highlighter' ? note.settings.markerColor || '#e9c95f' : note.settings.color, width: tool === 'highlighter' ? note.settings.markerWidth || 24 : note.settings.width, points: [inkPoint(point)] };
  redraw();
}
function inkPoint(point) { return { x: point.x, y: point.y, p: point.p, t: point.t }; }
function moveInk(event) {
  const point = documentPoint(event, view);
  if (lassoPath) { lassoPath.push(point); redraw(); return; }
  if (!beforeInk) return;
  if (selectionDrag) {
    if (Math.hypot(point.x - selectionDrag.start.x, point.y - selectionDrag.start.y) > .5 / view.scale) selectionDrag.changed = true;
    if (selectionDrag.changed) {
      const { bounds, start, resize } = selectionDrag;
      note.strokes = transformSelection(beforeInk, selected, resize ? { scale: resizeFactor(bounds, { x: point.x - 6 / view.scale, y: point.y - 6 / view.scale }), origin: { x: bounds.left, y: bounds.top } } : { dx: point.x - start.x, dy: point.y - start.y });
    }
    redraw(); return;
  }
  if (drawing) {
    if (['line', 'arrow'].includes(tool)) drawing.points = shapePoints(drawing.points[0], inkPoint(point), tool, drawing.width);
    else { const previous = drawing.points.at(-1); if (Math.hypot(previous.x - point.x, previous.y - point.y) >= .25) drawing.points.push(inkPoint(point)); }
  } else if (lastErase) {
    note.strokes = eraseStrokes(note.strokes, lastErase, point, note.settings.eraser / 2);
    lastErase = point;
  }
  redraw();
}
function endInk() {
  if (lassoPath) { selected = selectByLasso(note.strokes, lassoPath); lassoPath = null; redraw(); return; }
  if (!beforeInk) return;
  if (drawing) note.strokes = [...note.strokes, drawing];
  if (note.strokes !== beforeInk) {
    undoStack.push(beforeInk); if (undoStack.length > 100) undoStack.shift();
    redoStack = []; persist(); thumbnailDirty = true;
  }
  drawing = null; beforeInk = null; lastErase = null; selectionDrag = null; redraw();
}
function cancelInk() {
  if (beforeInk) note.strokes = beforeInk;
  drawing = null; beforeInk = null; lastErase = null; selectionDrag = null; lassoPath = null; redraw();
}
function pan(dx, dy) {
  if (note.settings.locked) return;
  view = { ...view, x: view.x + dx, y: view.y + dy }; saveViewSoon(); redraw();
}
function zoom(factor, anchor = { x: viewport.width / 2, y: viewport.height / 2 }, destination = anchor) {
  if (note.settings.locked) return;
  view = zoomView(view, factor, anchor, destination); saveViewSoon(); redraw();
}
const input = new InputController({ begin: beginInk, move: moveInk, end: endInk, cancel: cancelInk, pan, zoom }, () => note.settings);
function pointer(event) {
  const rect = canvas.getBoundingClientRect();
  return { id: event.pointerId, type: event.pointerType || 'mouse', x: event.clientX - rect.left, y: event.clientY - rect.top, p: event.pressure || .5, t: event.timeStamp, button: event.button, shift: event.shiftKey, width: event.width, height: event.height };
}
function cursor(event) {
  const point = pointer(event), marker = $('eraser-cursor');
  marker.hidden = tool !== 'eraser' || event.pointerType === 'touch';
  marker.style.left = `${point.x}px`; marker.style.top = `${point.y}px`;
  marker.style.width = marker.style.height = `${Math.max(4, note.settings.eraser * view.scale)}px`;
}
canvas.addEventListener('pointerdown', event => {
  if (!ready || (event.pointerType === 'mouse' && event.button !== 0)) return;
  event.preventDefault(); canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId); input.down(pointer(event)); cursor(event);
});
canvas.addEventListener('pointermove', event => {
  if (!ready) return;
  event.preventDefault();
  const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
  for (const sample of samples.length ? samples : [event]) input.move(pointer(sample));
  cursor(event);
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, event => {
  if (!ready) return;
  input.up(pointer(event), name !== 'pointerup');
  if (event.pointerType !== 'mouse') $('eraser-cursor').hidden = true;
});
canvas.addEventListener('pointerleave', () => { $('eraser-cursor').hidden = true; });
canvas.addEventListener('contextmenu', event => event.preventDefault());
canvas.addEventListener('wheel', event => {
  event.preventDefault();
  if (!ready || input.active || input.touches.size) return;
  zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * .002), pointer(event));
}, { passive: false });

function refreshZoomControls() {
  const blocked = note.settings.locked || !ready;
  $('zoom-in').disabled = blocked || view.scale >= MAX_ZOOM;
  $('zoom-out').disabled = blocked || view.scale <= MIN_ZOOM;
  $('fit').disabled = blocked;
}
function refreshSettings() {
  const s = note.settings;
  $('note-title').value = book.title;
  $('page-name').textContent = note.title;
  document.title = `손글씨 노트 · ${book.title || '이름 없는 노트'}`;
  $('guide').value = s.guide;
  $('paper-label').textContent = { none: '무지', lines: '줄노트', grid: '격자' }[s.guide];
  for (const id of toolNames) { $(id).classList.toggle('active', id === tool); $(id).setAttribute('aria-pressed', String(id === tool)); }
  const color = tool === 'highlighter' ? s.markerColor || '#e9c95f' : s.color;
  document.querySelectorAll('[data-color]').forEach(button => {
    button.classList.toggle('selected', button.dataset.color === color);
    button.setAttribute('aria-pressed', String(button.dataset.color === color));
    button.disabled = tool === 'eraser' || tool === 'lasso';
  });
  $('finger').setAttribute('aria-pressed', String(s.finger));
  $('finger').title = `손가락 필기 ${s.finger ? '끄기' : '켜기'}`;
  $('lock').setAttribute('aria-pressed', String(s.locked));
  $('lock').title = `화면 고정 ${s.locked ? '끄기' : '켜기'}`;
  $('lock-icon').innerHTML = icon(s.locked ? 'lock' : 'unlock');
  $('lock-label').textContent = s.locked ? '고정됨' : '화면 고정';
  refreshZoomControls();
  const coarse = matchMedia('(pointer: coarse)').matches;
  $('gesture-hint').innerHTML = s.locked ? '화면 고정됨 · 편하게 필기하세요' : coarse ? (s.finger ? '손가락으로 필기 · 두 손가락으로 이동' : '손가락으로 이동 · 두 손가락으로 확대') : '<kbd>Shift</kbd> + 드래그로 종이 이동';
  const erasing = tool === 'eraser', highlighting = tool === 'highlighter', size = erasing ? s.eraser : highlighting ? s.markerWidth || 24 : s.width;
  $('size-label').textContent = erasing ? '지우개 크기' : highlighting ? '형광펜 굵기' : '펜 굵기';
  $('size-toggle').setAttribute('aria-label', $('size-label').textContent);
  $('size-toggle').disabled = tool === 'lasso';
  $('size-slider').min = erasing || highlighting ? '8' : '2'; $('size-slider').max = erasing ? '80' : highlighting ? '60' : '14'; $('size-slider').value = String(size);
  $('size-value').textContent = String(size);
  $('size-dot').style.width = $('size-dot').style.height = `${erasing || highlighting ? 11 : Math.max(3, size * .8)}px`;
  $('size-dot').style.background = erasing ? '#9dad99' : color;
  $('size-preview-line').style.background = erasing ? '#9dad99' : color;
  $('size-preview-line').style.height = `${erasing || highlighting ? Math.min(18, size / 3) : size}px`;
  $('save-favorite').disabled = tool === 'eraser' || tool === 'lasso' || library.favorites.length >= 8;
  canvas.style.cursor = erasing ? 'none' : 'crosshair';
}
function setTool(next) { input.finish(); tool = next; selected = []; $('eraser-cursor').hidden = true; refreshSettings(); redraw(); }
function resetZoom() {
  if (note.settings.locked || !ready) return;
  input.finish();
  view = writingView(viewport.width, viewport.height, cameraFromView(view, viewport.width, viewport.height));
  saveViewSoon(); redraw();
}
function showPages(open) {
  if (open) input.finish();
  $('page-rail').hidden = !open;
  $('page-toggle').setAttribute('aria-expanded', String(open));
  if (open) renderPages();
}
function undo() {
  input.finish(); if (!undoStack.length) return;
  redoStack.push(note.strokes); note.strokes = undoStack.pop(); selected = []; thumbnailDirty = true; persist(); redraw();
}
function redo() {
  input.finish(); if (!redoStack.length) return;
  undoStack.push(note.strokes); note.strokes = redoStack.pop(); selected = []; thumbnailDirty = true; persist(); redraw();
}
for (const name of toolNames) $(name).onclick = () => setTool(name);
$('undo').onclick = undo; $('redo').onclick = redo;
$('zoom-in').onclick = () => { input.finish(); zoom(1.25); }; $('zoom-out').onclick = () => { input.finish(); zoom(.8); };
$('fit').onclick = resetZoom;
$('page-toggle').onclick = () => showPages($('page-rail').hidden);
$('close-pages').onclick = () => showPages(false);
$('guide').onchange = event => { input.finish(); note.settings.guide = event.target.value; thumbnailDirty = true; refreshSettings(); persist(); redraw(); };
document.querySelectorAll('[data-color]').forEach(button => { button.onclick = () => { input.finish(); note.settings[tool === 'highlighter' ? 'markerColor' : 'color'] = button.dataset.color; refreshSettings(); persist(); }; });
for (const key of ['finger', 'locked']) $(key === 'locked' ? 'lock' : key).onclick = () => {
  input.finish(); note.settings[key] = !note.settings[key]; refreshSettings(); persist();
  toast(key === 'locked' ? (note.settings.locked ? '화면을 고정했어요. 필기는 계속할 수 있어요.' : '종이를 이동하고 확대할 수 있어요.') : (note.settings.finger ? '손가락으로도 쓸 수 있어요.' : note.settings.locked ? '손가락 필기를 껐어요. 고정된 종이에 펜으로 쓸 수 있어요.' : '손가락은 종이를 이동해요. 펜은 계속 쓸 수 있어요.'));
};
$('size-toggle').onclick = () => { const open = $('size-panel').hidden; $('size-panel').hidden = !open; $('size-toggle').setAttribute('aria-expanded', String(open)); };
$('size-slider').oninput = event => { input.finish(); note.settings[tool === 'eraser' ? 'eraser' : tool === 'highlighter' ? 'markerWidth' : 'width'] = Number(event.target.value); refreshSettings(); persist(); };
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.popover-anchor')) closePopovers();
  if (!$('page-rail').hidden && !event.target.closest('#page-rail, #page-toggle')) showPages(false);
});
$('note-title').oninput = event => { book.title = event.target.value; document.title = `손글씨 노트 · ${book.title || '이름 없는 노트'}`; persist(); };
$('note-title').onblur = () => { if (!book.title.trim()) { book.title = '이름 없는 노트'; $('note-title').value = book.title; persist(); } };
$('help').onclick = () => { input.finish(); $('help-dialog').showModal(); };
for (const id of ['close-help', 'start-writing']) $(id).onclick = () => $('help-dialog').close();
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });

function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
}
function previewCanvas(strokes, width = 360, height = 200) {
  const preview = element('canvas'); preview.width = width; preview.height = height; preview.setAttribute('aria-hidden', 'true'); paintPreview(preview, strokes); return preview;
}
function closePopovers() {
  for (const name of ['size', 'favorites']) { $(`${name}-panel`).hidden = true; $(`${name}-toggle`).setAttribute('aria-expanded', 'false'); }
}
function leavePage() {
  input.finish(); note.view = cameraFromView(view, viewport.width, viewport.height);
  histories.set(note.id, { undo: undoStack, redo: redoStack });
  if (viewDirty) persist();
  selected = []; lassoPath = null; selectionDrag = null;
}
function openNotebook(nextBook, nextPage = currentPage(nextBook), closeRail = true) {
  leavePage();
  library.activeNotebookId = nextBook.id; book = nextBook; note = nextPage; book.activePageId = note.id;
  book.lastOpenedAt = new Date().toISOString();
  const history = histories.get(note.id); undoStack = history?.undo || []; redoStack = history?.redo || [];
  view = writingView(viewport.width, viewport.height, note.view);
  $('library-screen').hidden = true; editor.inert = false; editor.removeAttribute('aria-hidden');
  if (closeRail) showPages(false);
  closePopovers(); refreshSettings(); renderFavorites(); thumbnailDirty = true; persist(); redraw();
}
function showLibrary() {
  if (!ready) return;
  leavePage(); persist(); showPages(false); closePopovers();
  $('library-screen').hidden = false; editor.inert = true; editor.setAttribute('aria-hidden', 'true');
  renderLibrary(); $('note-search').focus();
}
function renderLibrary() {
  const list = $('notebook-list'), query = $('note-search').value.trim().toLocaleLowerCase(); list.replaceChildren();
  const books = [...library.notebooks].sort((a, b) => (b.lastOpenedAt || b.updatedAt || '').localeCompare(a.lastOpenedAt || a.updatedAt || ''));
  for (const item of books.filter(item => item.title.toLocaleLowerCase().includes(query))) {
    const card = element('article', 'notebook-card'), open = element('button', 'notebook-open');
    open.setAttribute('aria-label', `${item.title || '이름 없는 노트'} 열기`);
    open.append(previewCanvas(currentPage(item).strokes));
    const info = element('div', 'notebook-info'); info.append(element('h2', '', item.title || '이름 없는 노트'));
    const date = new Date(item.updatedAt), dateText = Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko', { month: 'long', day: 'numeric' }).format(date) : '방금';
    info.append(element('p', '', `${activePages(item).length} 페이지 · ${dateText} 수정`)); open.append(info); open.onclick = () => openNotebook(item);
    const rename = element('button', 'notebook-rename', '이름 변경'); rename.setAttribute('aria-label', `${item.title} 이름 변경`);
    rename.onclick = () => askName('노트 이름 변경', item.title, '저장', title => { item.title = title; item.updatedAt = new Date().toISOString(); persist(); renderLibrary(); refreshSettings(); });
    card.append(open, rename); list.append(card);
  }
  if (!list.children.length) list.append(element('p', 'empty-list', '일치하는 노트가 없어요. 다른 이름으로 찾아보세요.'));
  $('notebook-count').textContent = `${library.notebooks.length}권 · 최근 사용순`;
}
function askName(heading, value, actionLabel, action) {
  input.finish(); nameAction = action; $('name-heading').textContent = heading; $('name-input').value = value; $('name-submit').textContent = actionLabel;
  $('name-dialog').showModal(); $('name-input').focus(); $('name-input').select();
}
$('name-form').onsubmit = event => {
  event.preventDefault(); const title = $('name-input').value.trim(); if (!title) { $('name-input').focus(); return; }
  $('name-dialog').close(); nameAction?.(title); nameAction = null;
};
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
$('home').onclick = showLibrary; $('note-search').oninput = renderLibrary;
$('new-notebook').onclick = () => askName('새 노트', '', '만들기', title => { const item = newNotebook(title); library.notebooks.push(item); openNotebook(item); });

function renderPages() {
  const pages = activePages(book), removed = book.pages.filter(page => page.deletedAt), list = $('page-list'); list.replaceChildren();
  $('pages-tab').textContent = `페이지 ${pages.length}`; $('trash-tab').textContent = `휴지통 ${removed.length}`;
  $('pages-tab').setAttribute('aria-pressed', String(!trashVisible)); $('trash-tab').setAttribute('aria-pressed', String(trashVisible));
  $('add-page').hidden = trashVisible; $('page-editor').hidden = trashVisible;
  for (const [index, page] of (trashVisible ? removed : pages).entries()) {
    const item = element('div', 'page-item'), button = element('button', `page-card${page.id === note.id && !trashVisible ? ' current' : ''}`);
    button.append(previewCanvas(page.strokes, 240, 120), element('span', 'page-card-title', `${trashVisible ? '' : `${index + 1}. `}${page.title}`));
    button.setAttribute('aria-label', trashVisible ? `${page.title} 복구` : `${page.title} 페이지 열기`);
    if (page.id === note.id && !trashVisible) button.setAttribute('aria-current', 'page');
    button.onclick = () => {
      if (trashVisible) { restorePage(book, page.id); trashVisible = false; openNotebook(book, page, false); toast('페이지를 복구했어요.'); }
      else openNotebook(book, page);
    };
    if (trashVisible) button.append(element('span', 'restore-label', '복구하기'));
    item.append(button); list.append(item);
  }
  if (!list.children.length) list.append(element('p', 'empty-list', '휴지통이 비어 있어요.'));
  $('page-title').value = note.title;
  const index = pages.indexOf(note); $('page-up').disabled = index <= 0; $('page-down').disabled = index >= pages.length - 1;
}
$('pages-tab').onclick = () => { trashVisible = false; renderPages(); };
$('trash-tab').onclick = () => { trashVisible = true; renderPages(); };
$('add-page').onclick = () => askName('새 페이지', `페이지 ${activePages(book).length + 1}`, '추가', title => { const page = newPage(title, note.settings); book.pages.push(page); openNotebook(book, page, false); });
$('page-title').onchange = event => { note.title = event.target.value.trim() || '이름 없는 페이지'; persist(); refreshSettings(); renderPages(); };
for (const [id, direction] of [['page-up', -1], ['page-down', 1]]) $(id).onclick = () => { input.finish(); if (movePage(book, note.id, direction)) { persist(); renderPages(); } };
$('duplicate-page').onclick = () => { input.finish(); const page = duplicatePage(book, note); openNotebook(book, page, false); toast('페이지 사본을 만들었어요.'); };
$('delete-page').onclick = () => { input.finish(); trashPage(book, note.id); openNotebook(book, currentPage(book), false); toast('휴지통으로 옮겼어요. 언제든 복구할 수 있어요.'); };

function refreshSelection() {
  $('selection-bar').hidden = tool !== 'lasso';
  const valid = new Set(note.strokes.map(stroke => stroke.id)); selected = selected.filter(id => valid.has(id));
  $('selection-count').textContent = selected.length ? `${selected.length}개 선택 · 안쪽을 끌어 이동` : '글씨를 둘러싸 선택하세요';
  for (const id of ['copy-selection', 'shrink-selection', 'grow-selection', 'delete-selection', 'clear-selection']) $(id).disabled = !selected.length;
  $('select-all').disabled = !note.strokes.length; $('paste-selection').disabled = !clipboard.length;
}
function editStrokes(next) {
  if (next === note.strokes) return;
  undoStack.push(note.strokes); if (undoStack.length > 100) undoStack.shift();
  redoStack = []; note.strokes = next; thumbnailDirty = true; persist(); redraw();
}
function copySelection() {
  input.finish(); if (!selected.length) return;
  const ids = new Set(selected); clipboard = structuredClone(note.strokes.filter(stroke => ids.has(stroke.id))); pasteCount = 0;
  refreshSelection(); toast('복사했어요. 다른 페이지에도 붙여넣을 수 있어요.');
}
function pasteSelection() {
  input.finish(); if (!clipboard.length) return;
  const ids = clipboard.map(stroke => stroke.id), bounds = selectionBounds(clipboard, ids), center = documentPoint({ x: viewport.width / 2, y: viewport.height / 2 }, view);
  const offset = (++pasteCount * 20) / view.scale;
  const copies = transformSelection(clipboard, ids, { dx: center.x - bounds.left - bounds.width / 2 + offset, dy: center.y - bounds.top - bounds.height / 2 + offset }).map(stroke => ({ ...stroke, id: uid('stroke') }));
  tool = 'lasso'; selected = copies.map(stroke => stroke.id); editStrokes([...note.strokes, ...copies]); refreshSettings();
}
function scaleSelection(factor) {
  input.finish(); const bounds = selectionBounds(note.strokes, selected); if (!bounds) return;
  editStrokes(transformSelection(note.strokes, selected, { scale: factor, origin: { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } }));
}
function deleteSelection() { input.finish(); if (!selected.length) return; const ids = new Set(selected); editStrokes(note.strokes.filter(stroke => !ids.has(stroke.id))); selected = []; }
$('select-all').onclick = () => { input.finish(); selected = note.strokes.map(stroke => stroke.id); redraw(); };
$('copy-selection').onclick = copySelection; $('paste-selection').onclick = pasteSelection;
$('shrink-selection').onclick = () => scaleSelection(.9); $('grow-selection').onclick = () => scaleSelection(1.1);
$('delete-selection').onclick = deleteSelection; $('clear-selection').onclick = () => { input.finish(); selected = []; redraw(); };

function renderFavorites() {
  const list = $('favorites-list'); list.replaceChildren();
  for (const favorite of library.favorites) {
    const row = element('div', 'favorite-row'), button = element('button', 'favorite-choice'), swatch = element('span', 'favorite-swatch');
    swatch.style.background = favorite.color; swatch.style.height = `${Math.min(12, favorite.width)}px`;
    const label = `${favorite.tool === 'pen' ? '펜' : '형광펜'} · ${favorite.width}`;
    button.append(swatch, element('span', '', label)); button.setAttribute('aria-label', `${label} ${favorite.color} 사용`);
    button.onclick = () => { setTool(favorite.tool); note.settings[favorite.tool === 'pen' ? 'color' : 'markerColor'] = favorite.color; note.settings[favorite.tool === 'pen' ? 'width' : 'markerWidth'] = favorite.width; refreshSettings(); persist(); closePopovers(); };
    const remove = element('button', 'favorite-remove', '×'); remove.setAttribute('aria-label', `${label} 즐겨찾기 제거`);
    remove.onclick = () => { library.favorites = library.favorites.filter(item => item.id !== favorite.id); persist(); renderFavorites(); refreshSettings(); };
    row.append(button, remove); list.append(row);
  }
  if (!list.children.length) list.append(element('p', 'empty-list', '좋아하는 색과 굵기를 골라 추가해 보세요.'));
}
$('favorites-toggle').onclick = () => { const open = $('favorites-panel').hidden; closePopovers(); $('favorites-panel').hidden = !open; $('favorites-toggle').setAttribute('aria-expanded', String(open)); if (open) renderFavorites(); };
$('save-favorite').onclick = () => {
  const highlighting = tool === 'highlighter';
  if (['eraser', 'lasso'].includes(tool) || library.favorites.length >= 8) return;
  const favorite = { id: uid('favorite'), tool: highlighting ? 'highlighter' : 'pen', color: highlighting ? note.settings.markerColor || '#e9c95f' : note.settings.color, width: highlighting ? note.settings.markerWidth || 24 : note.settings.width };
  if (library.favorites.some(item => item.tool === favorite.tool && item.color === favorite.color && item.width === favorite.width)) { toast('이미 즐겨찾기에 있는 펜이에요.'); return; }
  library.favorites.push(favorite); persist(); renderFavorites(); refreshSettings(); toast('펜 즐겨찾기에 추가했어요.');
};

let importReadId = 0;
function openBackup() {
  input.finish(); closePopovers(); pendingImport = null; importReadId++;
  $('import-file').value = ''; $('import-preview').hidden = true; $('import-error').hidden = true; $('confirm-import').hidden = true;
  $('backup-scope').value = $('library-screen').hidden ? 'notebook' : 'all';
  $('backup-dialog').showModal();
}
$('export').onclick = openBackup; $('library-backup').onclick = openBackup;
$('download-backup').onclick = () => {
  input.finish(); if (viewDirty) persist();
  const scope = $('backup-scope').value, backup = createBackup(library, scope), blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'), url = URL.createObjectURL(blob);
  link.href = url; link.download = `${(scope === 'all' ? '모든 노트' : book.title || '손글씨 노트').replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('백업 파일 다운로드를 시작했어요.');
};
$('import-file').onchange = async event => {
  const file = event.target.files[0], requestId = ++importReadId; pendingImport = null;
  $('import-preview').hidden = true; $('import-error').hidden = true; $('confirm-import').hidden = true;
  if (!file) return;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('한 번에 25MB 이하의 백업 파일을 가져올 수 있어요. 노트별로 나누어 주세요.');
    const text = await file.text(); if (requestId !== importReadId) return;
    pendingImport = parseBackup(text);
    const pages = pendingImport.notebooks.reduce((sum, item) => sum + activePages(item).length, 0);
    $('import-preview').textContent = `${pendingImport.notebooks.length}권 · ${pages}페이지\n${pendingImport.notebooks.map(item => item.title).join(', ')}\n기존 내용을 덮어쓰지 않고 새 노트로 추가합니다.`;
    $('import-preview').hidden = false; $('confirm-import').hidden = false;
  } catch (error) {
    if (requestId !== importReadId) return;
    $('import-error').textContent = error.message; $('import-error').hidden = false;
  }
};
$('confirm-import').onclick = () => {
  if (!pendingImport) return;
  input.finish(); const imported = importBackup(library, pendingImport); pendingImport = null;
  $('backup-dialog').close(); openNotebook(imported[0]); toast(`${imported.length}권을 새 노트로 가져왔어요.`);
};

document.addEventListener('keydown', event => {
  if (event.target.matches('input,select,textarea') || document.querySelector('dialog[open]') || !$('library-screen').hidden || !ready) return;
  const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
  if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (mod && key === 'y') { event.preventDefault(); redo(); }
  else if (mod && tool === 'lasso' && key === 'a') { event.preventDefault(); selected = note.strokes.map(stroke => stroke.id); redraw(); }
  else if (mod && key === 'c' && selected.length) { event.preventDefault(); copySelection(); }
  else if (mod && key === 'v' && clipboard.length) { event.preventDefault(); pasteSelection(); }
  else if (!mod && !event.altKey) {
    if (key === 'p') setTool('pen');
    if (key === 'e') setTool('eraser');
    if (key === 'h') setTool('highlighter');
    if (key === 'l') setTool('lasso');
    if ((key === 'delete' || key === 'backspace') && tool === 'lasso') { event.preventDefault(); deleteSelection(); }
    if (key === '0') { event.preventDefault(); resetZoom(); }
    if (key === '+' || key === '=') { event.preventDefault(); input.finish(); zoom(1.25); }
    if (key === '-') { event.preventDefault(); input.finish(); zoom(.8); }
    if (key === 'escape') { closePopovers(); showPages(false); selected = []; redraw(); }
  }
});
function flushEdits() { input.finish(); if (viewDirty) persist(); }
window.addEventListener('blur', flushEdits);
window.addEventListener('pagehide', flushEdits);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushEdits(); });

// Prevent writes until the existing record has been read successfully.
document.querySelectorAll('button,input,select').forEach(element => { if (!['help', 'close-help', 'start-writing'].includes(element.id)) element.disabled = true; });
try {
  library = await storage.load(); book = currentNotebook(library); note = currentPage(book);
  resize();
  view = writingView(viewport.width, viewport.height, note.view);
  ready = true;
  document.querySelectorAll('button,input,select').forEach(element => { element.disabled = false; });
  refreshSettings(); renderFavorites(); thumbnailDirty = true; redraw();
  $('library-screen').hidden = false; editor.inert = true; editor.setAttribute('aria-hidden', 'true'); renderLibrary();
} catch (error) {
  saveStatus('error');
  $('notice').textContent = `${error.message} 기존 기록 보호를 위해 필기를 잠시 멈췄어요. 새로고침 후 다시 확인해 주세요.`;
  $('notice').hidden = false;
}
