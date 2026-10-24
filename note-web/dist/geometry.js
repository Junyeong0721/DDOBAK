export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const MIN_ZOOM = .1;
export const MAX_ZOOM = 1;
export const documentPoint = (point, view) => ({ ...point, x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale });
// The white workspace is one continuous writing surface, with no page-edge hit test.
export const isWritablePoint = point => Number.isFinite(point.x) && Number.isFinite(point.y);
export const visibleBounds = (view, width, height) => ({ left: -view.x / view.scale, top: -view.y / view.scale, width: width / view.scale, height: height / view.scale });
export const cameraFromView = (view, width, height) => ({ centerX: (width / 2 - view.x) / view.scale, centerY: (height / 2 - view.y) / view.scale, scale: view.scale });
export const viewFromCamera = (camera, width, height) => ({ scale: camera.scale, x: width / 2 - camera.centerX * camera.scale, y: height / 2 - camera.centerY * camera.scale });

export function writingView(width, height, camera = { centerX: 800, centerY: 1100 }) {
  // Open at 100%, preserving the saved location and all original ink coordinates.
  return viewFromCamera({ centerX: camera.centerX, centerY: camera.centerY, scale: MAX_ZOOM }, width, height);
}

export function inkBounds(strokes) {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const stroke of strokes) {
    const radius = stroke.width / 2;
    for (const point of stroke.points) {
      left = Math.min(left, point.x - radius); right = Math.max(right, point.x + radius);
      top = Math.min(top, point.y - radius); bottom = Math.max(bottom, point.y + radius);
    }
  }
  return Number.isFinite(left) ? { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) } : null;
}
export function fitInkView(strokes, width, height, padding = 48, maxScale = 1) {
  const bounds = inkBounds(strokes);
  if (!bounds) return writingView(width, height);
  const scale = clamp(Math.min(Math.max(1, width - padding * 2) / bounds.width, Math.max(1, height - padding * 2) / bounds.height), 1e-6, maxScale);
  return viewFromCamera({ centerX: bounds.left + bounds.width / 2, centerY: bounds.top + bounds.height / 2, scale }, width, height);
}
export function zoomView(view, factor, anchor, destination = anchor) {
  const scale = clamp(view.scale * factor, MIN_ZOOM, MAX_ZOOM);
  const point = documentPoint(anchor, view);
  return { scale, x: destination.x - point.x * scale, y: destination.y - point.y * scale };
}

const EPS = 1e-8;
const interpolate = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: (a.p ?? .5) + ((b.p ?? .5) - (a.p ?? .5)) * t, t: (a.t ?? 0) + ((b.t ?? 0) - (a.t ?? 0)) * t });
const equal = (a, b) => a && b && Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
function circleInterval(a, b, center, radius) {
  const dx = b.x - a.x, dy = b.y - a.y, ox = a.x - center.x, oy = a.y - center.y;
  const aa = dx * dx + dy * dy;
  if (aa < EPS) return ox * ox + oy * oy <= radius * radius ? [0, 1] : null;
  const bb = 2 * (ox * dx + oy * dy), cc = ox * ox + oy * oy - radius * radius;
  const discriminant = bb * bb - 4 * aa * cc;
  if (discriminant < 0) return null;
  const lo = Math.max(0, (-bb - Math.sqrt(discriminant)) / (2 * aa));
  const hi = Math.min(1, (-bb + Math.sqrt(discriminant)) / (2 * aa));
  return hi - lo > EPS ? [lo, hi] : null;
}
function slab(interval, origin, delta, low, high) {
  if (Math.abs(delta) < EPS) return origin >= low && origin <= high ? interval : null;
  const a = (low - origin) / delta, b = (high - origin) / delta;
  const result = [Math.max(interval[0], Math.min(a, b)), Math.min(interval[1], Math.max(a, b))];
  return result[1] - result[0] > EPS ? result : null;
}

// Intersection with the swept eraser capsule, including gaps between pointer events.
export function capsuleInterval(a, b, from, to, radius) {
  const hits = [circleInterval(a, b, from, radius), circleInterval(a, b, to, radius)].filter(Boolean);
  const ex = to.x - from.x, ey = to.y - from.y, length = Math.hypot(ex, ey);
  if (length > EPS) {
    const ux = ex / length, uy = ey / length, ox = a.x - from.x, oy = a.y - from.y, dx = b.x - a.x, dy = b.y - a.y;
    const along = slab([0, 1], ox * ux + oy * uy, dx * ux + dy * uy, 0, length);
    const across = along && slab(along, -ox * uy + oy * ux, -dx * uy + dy * ux, -radius, radius);
    if (across) hits.push(across);
  }
  return hits.length ? [Math.min(...hits.map(hit => hit[0])), Math.max(...hits.map(hit => hit[1]))] : null;
}

let fragmentId = 0;
export function eraseStroke(stroke, from, to, radius) {
  const points = stroke.points, effective = radius + stroke.width / 2;
  if (points.length === 1) return capsuleInterval(points[0], points[0], from, to, effective) ? [] : [stroke];
  const pieces = [];
  let run = [points[0]], changed = false;
  const flush = () => { if (run.length > 1) pieces.push(run); run = []; };
  const add = point => { if (!equal(run.at(-1), point)) run.push(point); };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], cut = capsuleInterval(a, b, from, to, effective);
    if (!cut) { add(a); add(b); continue; }
    changed = true;
    if (cut[0] > EPS) { add(a); add(interpolate(a, b, cut[0])); }
    flush();
    if (cut[1] < 1 - EPS) { add(interpolate(a, b, cut[1])); add(b); }
  }
  flush();
  return changed ? pieces.map(piece => ({ ...stroke, id: globalThis.crypto?.randomUUID?.() || `fragment-${Date.now().toString(36)}-${++fragmentId}-${Math.random().toString(36).slice(2)}`, points: piece })) : [stroke];
}

export function eraseStrokes(strokes, from, to, radius) {
  let changed = false;
  const result = strokes.flatMap(stroke => {
    const fragments = eraseStroke(stroke, from, to, radius);
    if (fragments.length !== 1 || fragments[0] !== stroke) changed = true;
    return fragments;
  });
  return changed ? result : strokes;
}
