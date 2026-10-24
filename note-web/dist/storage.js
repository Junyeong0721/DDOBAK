export const DATABASE = 'handwriting-note-v1';
export const JOURNAL = 'handwriting-note-v1-pending';
export const defaultNote = () => ({
  schema: 1, revision: 0, title: '첫 번째 노트', updatedAt: null, strokes: [],
  settings: { guide: 'none', color: '#293e3b', width: 5, eraser: 28, finger: false, locked: false }
});

export function validateNote(note) {
  const finite = Number.isFinite;
  if (!note || note.schema !== 1 || !Number.isSafeInteger(note.revision) || note.revision < 0 || typeof note.title !== 'string' || !Array.isArray(note.strokes)) throw new Error('저장 형식을 확인할 수 없습니다.');
  if (note.view !== undefined && (![note.view?.centerX, note.view?.centerY, note.view?.scale].every(finite) || note.view.scale < 1e-6 || note.view.scale > 4)) throw new Error('저장된 보기 위치를 확인할 수 없습니다.');
  const s = note.settings;
  if (!s || !['none', 'lines', 'grid'].includes(s.guide) || !/^#[0-9a-f]{6}$/i.test(s.color) || !finite(s.width) || s.width < 2 || s.width > 14 || !finite(s.eraser) || s.eraser < 8 || s.eraser > 80 || typeof s.finger !== 'boolean' || typeof s.locked !== 'boolean') throw new Error('저장된 설정을 확인할 수 없습니다.');
  for (const stroke of note.strokes) {
    if (typeof stroke.id !== 'string' || !/^#[0-9a-f]{6}$/i.test(stroke.color) || !finite(stroke.width) || stroke.width <= 0 || !Array.isArray(stroke.points) || !stroke.points.length) throw new Error('저장된 획을 확인할 수 없습니다.');
    for (const point of stroke.points) if (![point.x, point.y, point.p, point.t].every(finite)) throw new Error('저장된 좌표를 확인할 수 없습니다.');
  }
  return note;
}
export function chooseLatest(saved, pending, validate = validateNote, create = defaultNote) {
  if (saved) validate(saved);
  if (pending) validate(pending);
  return pending && (!saved || pending.revision > saved.revision) ? pending : saved || create();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('notes');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('다른 탭을 닫은 뒤 다시 열어 주세요.'));
  });
}
function transaction(database, mode, value, key = 'page-1') {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('notes', mode);
    const store = tx.objectStore('notes');
    const request = mode === 'readwrite' ? store.put(value, key) : store.get(key);
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('저장이 중단되었습니다.'));
  });
}

export class NoteStorage {
  constructor(onStatus, options = {}) {
    this.onStatus = onStatus; this.database = null; this.queue = Promise.resolve(); this.latestRevision = -1;
    this.key = options.key || 'page-1'; this.journal = options.journal || JOURNAL;
    this.validate = options.validate || validateNote; this.create = options.create || defaultNote; this.migrate = options.migrate;
  }
  async load() {
    let saved = null, pending = null, storageAvailable = false;
    try {
      const text = localStorage.getItem(this.journal);
      if (text) pending = this.validate(JSON.parse(text));
      storageAvailable = true;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
    }
    try {
      this.database = await openDatabase();
      saved = await transaction(this.database, 'readonly', undefined, this.key);
    } catch (error) {
      this.database = null;
      // Do not create a blank replacement if an existing database cannot be read.
      if (!pending) throw new Error('저장 공간을 열 수 없습니다. 다른 탭을 닫거나 브라우저 저장 권한을 확인한 뒤 다시 열어 주세요.');
    }
    const migrating = !saved && !pending && this.migrate;
    const note = migrating ? this.validate(await this.migrate()) : chooseLatest(saved, pending, this.validate, this.create);
    this.latestRevision = note.revision;
    if (!this.database && !storageAvailable) throw new Error('저장 공간을 사용할 수 없습니다.');
    if ((pending || migrating) && this.database) await this.save(note);
    else this.onStatus(this.database ? 'saved' : 'fallback');
    return note;
  }
  save(note) {
    const snapshot = structuredClone(note);
    this.latestRevision = snapshot.revision;
    this.onStatus('saving');
    let journaled = false;
    try { localStorage.setItem(this.journal, JSON.stringify(snapshot)); journaled = true; } catch { /* IDB may still succeed. */ }
    this.queue = this.queue.catch(() => {}).then(async () => {
      try {
        if (!this.database) throw new Error('IndexedDB is unavailable');
        await transaction(this.database, 'readwrite', snapshot, this.key);
        if (snapshot.revision === this.latestRevision) {
          try { localStorage.removeItem(this.journal); } catch { /* Saved in IDB. */ }
          this.onStatus('saved');
        }
        return true;
      } catch {
        if (snapshot.revision === this.latestRevision) this.onStatus(journaled ? 'fallback' : 'error');
        return journaled;
      }
    });
    return this.queue;
  }
}
