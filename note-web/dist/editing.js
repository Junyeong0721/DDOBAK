import { inkBounds, clamp } from './geometry.js';

const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function onSegment(p, a, b) {
  return Math.abs(cross(a, b, p)) < 1e-7 && p.x >= Math.min(a.x, b.x) - 1e-7 && p.x <= Math.max(a.x, b.x) + 1e-7 && p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7;
}
export function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if (onSegment(point, a, b)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function intersects(a, b, c, d) {
  if (onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b)) return true;
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}
export function selectByLasso(strokes, polygon) {
  if (polygon.length < 3) return [];
  return strokes.filter(stroke => stroke.points.some(point => insidePolygon(point, polygon)) || stroke.points.some((point, i) => i > 0 && polygon.some((edge, j) => intersects(stroke.points[i - 1], point, edge, polygon[(j + 1) % polygon.length])))).map(stroke => stroke.id);
}
export function transformSelection(strokes, ids, { dx = 0, dy = 0, scale = 1, origin = { x: 0, y: 0 } }) {
  const selected = new Set(ids);
  return strokes.map(stroke => !selected.has(stroke.id) ? stroke : ({ ...stroke, width: stroke.width * scale, points: stroke.points.map(point => ({ ...point, x: origin.x + (point.x - origin.x) * scale + dx, y: origin.y + (point.y - origin.y) * scale + dy })) }));
}
export function selectionBounds(strokes, ids) { const selected = new Set(ids); return inkBounds(strokes.filter(stroke => selected.has(stroke.id))); }
export function resizeFactor(bounds, point) {
  const dx = point.x - bounds.left, dy = point.y - bounds.top;
  return clamp((dx * bounds.width + dy * bounds.height) / (bounds.width ** 2 + bounds.height ** 2), .1, 10);
}
export function shapePoints(start, end, kind, width) {
  if (kind !== 'arrow') return [start, end];
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 1) return [start, end];
  const size = Math.min(length * .4, Math.max(12, width * 4)), angle = Math.atan2(end.y - start.y, end.x - start.x);
  const wing = delta => ({ ...end, x: end.x - size * Math.cos(angle + delta), y: end.y - size * Math.sin(angle + delta) });
  return [start, end, wing(.5), end, wing(-.5)];
}
