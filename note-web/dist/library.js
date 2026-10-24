import { defaultNote, validateNote } from './storage.js';

export const uid = (prefix = 'id') => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
const now = () => new Date().toISOString();
export function newPage(title = '새 페이지', settings) {
  const base = defaultNote();
  return { id: uid('page'), title, strokes: [], settings: { ...base.settings, markerWidth: 24, markerColor: '#e9c95f', ...settings }, updatedAt: now(), deletedAt: null };
}
export function newNotebook(title = '새 노트') {
  const page = newPage('첫 번째 페이지');
  return { id: uid('note'), title, updatedAt: now(), lastOpenedAt: now(), activePageId: page.id, pages: [page] };
}
export function migrateLegacy(legacy = defaultNote()) {
  validateNote(legacy);
  const notebook = newNotebook(legacy.title);
  const page = notebook.pages[0];
  page.strokes = structuredClone(legacy.strokes);
  page.settings = { ...page.settings, ...legacy.settings };
  if (legacy.view) page.view = structuredClone(legacy.view);
  page.updatedAt = legacy.updatedAt || now(); notebook.updatedAt = page.updatedAt;
  return { schema: 2, revision: 0, updatedAt: now(), activeNotebookId: notebook.id, notebooks: [notebook], favorites: [] };
}
export const activePages = notebook => notebook.pages.filter(page => !page.deletedAt);
export const currentNotebook = library => library.notebooks.find(book => book.id === library.activeNotebookId) || library.notebooks[0];
export const currentPage = notebook => activePages(notebook).find(page => page.id === notebook.activePageId) || activePages(notebook)[0];

function requireValue(condition, message) { if (!condition) throw new Error(message); }
function uniqueIds(items) {
  const ids = new Set();
  for (const item of items) { requireValue(typeof item.id === 'string' && item.id.length > 0 && item.id.length < 200 && !ids.has(item.id), '중복되거나 잘못된 식별자가 있어요.'); ids.add(item.id); }
}
function validDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
export function validateNotebook(book) {
  requireValue(book && typeof book.title === 'string' && book.title.length <= 200 && Array.isArray(book.pages) && book.pages.length > 0, '노트 형식을 확인할 수 없어요.');
  uniqueIds(book.pages);
  for (const page of book.pages) {
    requireValue(typeof page.title === 'string' && page.title.length <= 200 && (page.deletedAt == null || validDate(page.deletedAt)), '페이지 형식을 확인할 수 없어요.');
    validateNote({ ...page, schema: 1, revision: 0 });
    uniqueIds(page.strokes);
    const s = page.settings;
    requireValue(s.markerWidth === undefined || (Number.isFinite(s.markerWidth) && s.markerWidth >= 8 && s.markerWidth <= 60), '형광펜 굵기를 확인할 수 없어요.');
    requireValue(s.markerColor === undefined || /^#[0-9a-f]{6}$/i.test(s.markerColor), '형광펜 색상을 확인할 수 없어요.');
    for (const stroke of page.strokes) requireValue(stroke.kind === undefined || ['pen', 'highlighter', 'line', 'arrow'].includes(stroke.kind), '지원하지 않는 필기 도구가 있어요.');
  }
  requireValue(activePages(book).length > 0 && activePages(book).some(page => page.id === book.activePageId), '노트의 현재 페이지를 확인할 수 없어요.');
  return book;
}
export function validateFavorites(favorites) {
  requireValue(Array.isArray(favorites) && favorites.length <= 8, '펜 즐겨찾기를 확인할 수 없어요.'); uniqueIds(favorites);
  for (const item of favorites) requireValue(['pen', 'highlighter'].includes(item.tool) && /^#[0-9a-f]{6}$/i.test(item.color) && Number.isFinite(item.width) && item.width >= (item.tool === 'pen' ? 2 : 8) && item.width <= (item.tool === 'pen' ? 14 : 60), '펜 즐겨찾기 설정이 올바르지 않아요.');
}
export function validateLibrary(library) {
  requireValue(library?.schema === 2 && Number.isSafeInteger(library.revision) && library.revision >= 0 && Array.isArray(library.notebooks) && library.notebooks.length > 0, '노트 목록을 확인할 수 없어요.');
  uniqueIds(library.notebooks);
  for (const book of library.notebooks) validateNotebook(book);
  requireValue(library.notebooks.some(book => book.id === library.activeNotebookId), '현재 노트를 확인할 수 없어요.');
  // Page IDs are also used for per-page undo histories.
  uniqueIds(library.notebooks.flatMap(book => book.pages));
  validateFavorites(library.favorites);
  return library;
}
export function duplicatePage(book, page) {
  const copy = structuredClone(page);
  copy.id = uid('page'); copy.title = `${page.title.slice(0, 190)} 사본`; copy.updatedAt = now(); copy.deletedAt = null;
  copy.strokes = copy.strokes.map(stroke => ({ ...stroke, id: uid('stroke') }));
  book.pages.splice(book.pages.indexOf(page) + 1, 0, copy); book.activePageId = copy.id;
  return copy;
}
export function movePage(book, pageId, direction) {
  const pages = activePages(book), index = pages.findIndex(page => page.id === pageId), target = pages[index + direction];
  if (index < 0 || !target) return false;
  const from = book.pages.indexOf(pages[index]), to = book.pages.indexOf(target);
  book.pages.splice(from, 1); book.pages.splice(to, 0, pages[index]); return true;
}
export function trashPage(book, pageId) {
  const page = activePages(book).find(item => item.id === pageId);
  if (!page) return;
  const index = activePages(book).indexOf(page); page.deletedAt = now();
  if (!activePages(book).length) book.pages.push(newPage('새 페이지', page.settings));
  if (book.activePageId === pageId) book.activePageId = activePages(book)[Math.min(index, activePages(book).length - 1)].id;
}
export function restorePage(book, pageId) {
  const page = book.pages.find(item => item.id === pageId && item.deletedAt);
  if (page) { page.deletedAt = null; book.activePageId = page.id; }
  return page;
}

export function createBackup(library, scope = 'notebook') {
  validateLibrary(library);
  return structuredClone({ format: 'ddobak-backup', version: 1, createdAt: now(), notebooks: scope === 'all' ? library.notebooks : [currentNotebook(library)], favorites: library.favorites });
}
export function parseBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('JSON 백업 파일을 읽을 수 없어요.'); }
  if (data?.schema === 1) {
    const migrated = migrateLegacy(data);
    return { notebooks: migrated.notebooks, favorites: [] };
  }
  requireValue(data?.format === 'ddobak-backup' && data.version === 1 && Array.isArray(data.notebooks) && data.notebooks.length > 0, '지원하는 노트 백업 파일이 아니에요.');
  for (const book of data.notebooks) validateNotebook(book);
  uniqueIds(data.notebooks); validateFavorites(data.favorites || []);
  return { notebooks: data.notebooks, favorites: data.favorites || [] };
}
export function importBackup(library, backup) {
  // Validate every record before changing the destination; imports never overwrite existing notes.
  const checked = parseBackup(JSON.stringify({ ...backup, format: 'ddobak-backup', version: 1 }));
  const books = checked.notebooks.map(source => {
    const book = structuredClone(source), ids = new Map(book.pages.map(page => [page.id, uid('page')]));
    book.id = uid('note'); book.title = `${book.title.slice(0, 190)} (가져옴)`; book.lastOpenedAt = now();
    book.activePageId = ids.get(book.activePageId);
    book.pages = book.pages.map(page => ({ ...page, id: ids.get(page.id), strokes: page.strokes.map(stroke => ({ ...stroke, id: uid('stroke') })) }));
    return book;
  });
  library.notebooks.push(...books); library.activeNotebookId = books[0].id;
  for (const favorite of checked.favorites) {
    if (library.favorites.length === 8) break;
    if (!library.favorites.some(item => item.tool === favorite.tool && item.color === favorite.color && item.width === favorite.width)) library.favorites.push({ ...favorite, id: uid('favorite') });
  }
  return books;
}
