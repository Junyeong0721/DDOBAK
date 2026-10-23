import { MIN_ZOOM, MAX_ZOOM, documentPoint, isWritablePoint, visibleBounds, cameraFromView, writingView, fitInkView, zoomView, eraseStrokes } from './geometry.js';
import { InputController } from './input.js';
import { NoteStorage, defaultNote } from './storage.js';

const $ = id => document.getElementById(id);
const paths = {
  leaf: '<path d="M5 20C5 8 11 4 20 4c0 10-5 15-12 14M4 21 16 8"/>',
  pen: '<path d="m14 4 6 6M4 20l4-1 12-12a2.1 2.1 0 0 0-3-3L5 16l-1 4Z"/>',
  eraser: '<path d="m13 4 7 7a2 2 0 0 1 0 3l-6 6H8l-5-5a2 2 0 0 1 0-3l7-8a2 2 0 0 1 3 0ZM7 9l10 9M14 20h7"/>',
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
const thumbnail = $('thumbnail'), thumbContext = thumbnail.getContext('2d');
let note = defaultNote(), ready = false, tool = 'pen', view = { x: 0, y: 0, scale: 1 };
let viewport = { width: 0, height: 0 }, renderPending = false, drawing = null, beforeInk = null, lastErase = null;
let undoStack = [], redoStack = [], toastTimer, penSequence = 0;
let thumbnailDirty = true;
let viewSaveTimer = null, viewDirty = false;

function saveStatus(status) {
  $('save-status').dataset.state = status;
  $('save-status').lastElementChild.textContent = { saved: '이 기기에 저장됨', saving: '저장 중', fallback: '임시 저장됨', error: '저장하지 못함' }[status];
  if (status === 'error' || status === 'fallback') {
    $('notice').textContent = status === 'error' ? '저장 공간을 확인해 주세요. 현재 글씨는 상단의 내보내기로 보관할 수 있어요.' : '임시 저장소에 보관했어요. 중요한 글씨는 파일로 내보내 주세요.';
    $('notice').hidden = false;
  } else if (status === 'saved' && ready) $('notice').hidden = true;
}
const storage = new NoteStorage(saveStatus);
function persist() {
  if (!ready) return;
  clearTimeout(viewSaveTimer); viewDirty = false;
  note.view = cameraFromView(view, viewport.width, viewport.height);
  note.revision++; note.updatedAt = new Date().toISOString();
  void storage.save(note);
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

function paintStroke(ctx, stroke) {
  const points = stroke.points;
  if (!points.length) return;
  ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (points.length === 1) { ctx.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2); ctx.fill(); return; }
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();
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
  for (const stroke of note.strokes) paintStroke(ctx, stroke);
  if (includeActive && drawing) paintStroke(ctx, drawing);
  ctx.restore();
}
function render() {
  const ratio = Math.min(window.devicePixelRatio || 1, 3);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, viewport.width, viewport.height);
  context.save(); context.translate(view.x, view.y); context.scale(view.scale, view.scale);
  paintContents(context, visibleBounds(view, viewport.width, viewport.height), view.scale); context.restore();
  $('zoom-value').textContent = `${Math.round(view.scale * 100)}%`;
  refreshZoomControls();
  $('empty-hint').hidden = note.strokes.length > 0 || !!drawing;
  $('empty-hint').style.left = `${viewport.width / 2}px`;
  $('empty-hint').style.top = `${viewport.height * .44}px`;
  $('undo').disabled = !ready || !undoStack.length;
  $('redo').disabled = !ready || !redoStack.length;
  if (thumbnailDirty) {
    thumbnailDirty = false;
    thumbContext.setTransform(1, 0, 0, 1, 0, 0); thumbContext.clearRect(0, 0, thumbnail.width, thumbnail.height);
    thumbContext.fillStyle = '#ffffff'; thumbContext.fillRect(0, 0, thumbnail.width, thumbnail.height);
    const preview = fitInkView(note.strokes, thumbnail.width, thumbnail.height, 12, .25);
    thumbContext.save(); thumbContext.translate(preview.x, preview.y); thumbContext.scale(preview.scale, preview.scale);
    paintContents(thumbContext, null, preview.scale, false, false); thumbContext.restore();
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
  beforeInk = note.strokes;
  if (tool === 'pen') {
    drawing = { id: `s-${Date.now()}-${++penSequence}`, color: note.settings.color, width: note.settings.width, points: [inkPoint(point)] };
  } else {
    lastErase = point;
    note.strokes = eraseStrokes(note.strokes, point, point, note.settings.eraser / 2);
  }
  redraw();
}
function inkPoint(point) { return { x: point.x, y: point.y, p: point.p, t: point.t }; }
function moveInk(event) {
  if (!beforeInk) return;
  const point = documentPoint(event, view);
  if (drawing) {
    const previous = drawing.points.at(-1);
    if (Math.hypot(previous.x - point.x, previous.y - point.y) >= .25) drawing.points.push(inkPoint(point));
  } else if (lastErase) {
    note.strokes = eraseStrokes(note.strokes, lastErase, point, note.settings.eraser / 2);
    lastErase = point;
  }
  redraw();
}
function endInk() {
  if (!beforeInk) return;
  if (drawing) note.strokes = [...note.strokes, drawing];
  if (note.strokes !== beforeInk) {
    undoStack.push(beforeInk); if (undoStack.length > 100) undoStack.shift();
    redoStack = []; persist(); thumbnailDirty = true;
  }
  drawing = null; beforeInk = null; lastErase = null; redraw();
}
function cancelInk() {
  if (beforeInk) note.strokes = beforeInk;
  drawing = null; beforeInk = null; lastErase = null; redraw();
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
  ['fit', 'page-fit'].forEach(id => { $(id).disabled = blocked; });
}
function refreshSettings() {
  const s = note.settings;
  $('note-title').value = note.title;
  document.title = `손글씨 노트 · ${note.title || '이름 없는 노트'}`;
  $('guide').value = s.guide;
  $('paper-label').textContent = { none: '무지', lines: '줄노트', grid: '격자' }[s.guide];
  for (const id of ['pen', 'eraser']) { $(id).classList.toggle('active', id === tool); $(id).setAttribute('aria-pressed', String(id === tool)); }
  document.querySelectorAll('[data-color]').forEach(button => {
    button.classList.toggle('selected', button.dataset.color === s.color);
    button.setAttribute('aria-pressed', String(button.dataset.color === s.color));
    button.disabled = tool === 'eraser';
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
  const erasing = tool === 'eraser', size = erasing ? s.eraser : s.width;
  $('size-label').textContent = erasing ? '지우개 크기' : '펜 굵기';
  $('size-toggle').setAttribute('aria-label', $('size-label').textContent);
  $('size-slider').min = erasing ? '8' : '2'; $('size-slider').max = erasing ? '80' : '14'; $('size-slider').value = String(size);
  $('size-value').textContent = String(size);
  $('size-dot').style.width = $('size-dot').style.height = `${erasing ? 11 : Math.max(3, size * .8)}px`;
  $('size-dot').style.background = erasing ? '#9dad99' : s.color;
  $('size-preview-line').style.background = erasing ? '#9dad99' : s.color;
  $('size-preview-line').style.height = `${erasing ? Math.min(18, size / 3) : size}px`;
  canvas.style.cursor = erasing ? 'none' : 'crosshair';
}
function setTool(next) { input.finish(); tool = next; $('eraser-cursor').hidden = true; refreshSettings(); }
function resetZoom() {
  if (note.settings.locked || !ready) return;
  input.finish();
  view = writingView(viewport.width, viewport.height, cameraFromView(view, viewport.width, viewport.height));
  saveViewSoon(); redraw();
}
function showPages(open) {
  $('page-rail').hidden = !open;
  $('page-toggle').setAttribute('aria-expanded', String(open));
}
function undo() {
  input.finish(); if (!undoStack.length) return;
  redoStack.push(note.strokes); note.strokes = undoStack.pop(); thumbnailDirty = true; persist(); redraw();
}
function redo() {
  input.finish(); if (!redoStack.length) return;
  undoStack.push(note.strokes); note.strokes = redoStack.pop(); thumbnailDirty = true; persist(); redraw();
}
$('pen').onclick = () => setTool('pen'); $('eraser').onclick = () => setTool('eraser');
$('undo').onclick = undo; $('redo').onclick = redo;
$('zoom-in').onclick = () => { input.finish(); zoom(1.25); }; $('zoom-out').onclick = () => { input.finish(); zoom(.8); };
$('fit').onclick = resetZoom;
$('page-fit').onclick = () => {
  if (note.settings.locked || !ready) return;
  resetZoom(); showPages(false);
};
$('page-toggle').onclick = () => showPages($('page-rail').hidden);
$('close-pages').onclick = () => showPages(false);
$('guide').onchange = event => { input.finish(); note.settings.guide = event.target.value; thumbnailDirty = true; refreshSettings(); persist(); redraw(); };
document.querySelectorAll('[data-color]').forEach(button => { button.onclick = () => { input.finish(); note.settings.color = button.dataset.color; refreshSettings(); persist(); }; });
for (const key of ['finger', 'locked']) $(key === 'locked' ? 'lock' : key).onclick = () => {
  input.finish(); note.settings[key] = !note.settings[key]; refreshSettings(); persist();
  toast(key === 'locked' ? (note.settings.locked ? '화면을 고정했어요. 필기는 계속할 수 있어요.' : '종이를 이동하고 확대할 수 있어요.') : (note.settings.finger ? '손가락으로도 쓸 수 있어요.' : note.settings.locked ? '손가락 필기를 껐어요. 고정된 종이에 펜으로 쓸 수 있어요.' : '손가락은 종이를 이동해요. 펜은 계속 쓸 수 있어요.'));
};
$('size-toggle').onclick = () => { const open = $('size-panel').hidden; $('size-panel').hidden = !open; $('size-toggle').setAttribute('aria-expanded', String(open)); };
$('size-slider').oninput = event => { input.finish(); note.settings[tool === 'eraser' ? 'eraser' : 'width'] = Number(event.target.value); refreshSettings(); persist(); };
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('.popover-anchor')) { $('size-panel').hidden = true; $('size-toggle').setAttribute('aria-expanded', 'false'); }
  if (!event.target.closest('#page-rail, #page-toggle')) showPages(false);
});
$('note-title').oninput = event => { note.title = event.target.value; document.title = `손글씨 노트 · ${note.title || '이름 없는 노트'}`; persist(); };
$('note-title').onblur = () => { if (!note.title.trim()) { note.title = '이름 없는 노트'; $('note-title').value = note.title; persist(); } };
$('help').onclick = () => { input.finish(); $('help-dialog').showModal(); };
for (const id of ['close-help', 'start-writing']) $(id).onclick = () => $('help-dialog').close();
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });
$('export').onclick = () => {
  input.finish();
  if (viewDirty) persist();
  const blob = new Blob([JSON.stringify({ ...note, canvas: { type: 'unbounded' } }, null, 2)], { type: 'application/json' });
  const link = document.createElement('a'), url = URL.createObjectURL(blob);
  link.href = url; link.download = `${(note.title || '손글씨 노트').replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  toast('필기 원본을 파일로 내보냈어요.');
};
document.addEventListener('keydown', event => {
  if (event.target.matches('input,select,textarea') || $('help-dialog').open || !ready) return;
  const key = event.key.toLowerCase(), mod = event.ctrlKey || event.metaKey;
  if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (mod && key === 'y') { event.preventDefault(); redo(); }
  else if (!mod && !event.altKey) {
    if (key === 'p') setTool('pen');
    if (key === 'e') setTool('eraser');
    if (key === '0') { event.preventDefault(); resetZoom(); }
    if (key === '+' || key === '=') { event.preventDefault(); input.finish(); zoom(1.25); }
    if (key === '-') { event.preventDefault(); input.finish(); zoom(.8); }
    if (key === 'escape') { $('size-panel').hidden = true; $('size-toggle').setAttribute('aria-expanded', 'false'); showPages(false); }
  }
});
function flushEdits() { input.finish(); if (viewDirty) persist(); }
window.addEventListener('blur', flushEdits);
window.addEventListener('pagehide', flushEdits);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushEdits(); });

// Prevent writes until the existing record has been read successfully.
document.querySelectorAll('button,input,select').forEach(element => { if (!['help', 'close-help', 'start-writing'].includes(element.id)) element.disabled = true; });
try {
  note = await storage.load();
  resize();
  view = writingView(viewport.width, viewport.height, note.view);
  ready = true;
  document.querySelectorAll('button,input,select').forEach(element => { element.disabled = false; });
  refreshSettings(); thumbnailDirty = true; redraw();
} catch (error) {
  saveStatus('error');
  $('notice').textContent = `${error.message} 기존 기록 보호를 위해 필기를 잠시 멈췄어요. 새로고침 후 다시 확인해 주세요.`;
  $('notice').hidden = false;
}
