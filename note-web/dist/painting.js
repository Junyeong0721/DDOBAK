import { fitInkView } from './geometry.js';

export function paintStroke(ctx, stroke) {
  const points = stroke.points;
  if (!points.length) return;
  ctx.save();
  ctx.globalAlpha = stroke.kind === 'highlighter' ? .3 : 1;
  ctx.strokeStyle = stroke.color; ctx.fillStyle = stroke.color;
  ctx.lineWidth = stroke.width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.beginPath();
  if (points.length === 1) { ctx.arc(points[0].x, points[0].y, stroke.width / 2, 0, Math.PI * 2); ctx.fill(); }
  else { ctx.moveTo(points[0].x, points[0].y); for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y); ctx.stroke(); }
  ctx.restore();
}
export function paintInk(ctx, strokes, drawing = null) {
  // Keep ink legible even when a highlight is added afterwards.
  for (const stroke of strokes) if (stroke.kind === 'highlighter') paintStroke(ctx, stroke);
  if (drawing?.kind === 'highlighter') paintStroke(ctx, drawing);
  for (const stroke of strokes) if (stroke.kind !== 'highlighter') paintStroke(ctx, stroke);
  if (drawing && drawing.kind !== 'highlighter') paintStroke(ctx, drawing);
}
export function paintPreview(canvas, strokes) {
  const ctx = canvas.getContext('2d'), view = fitInkView(strokes, canvas.width, canvas.height, 18, .35);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.save(); ctx.translate(view.x, view.y); ctx.scale(view.scale, view.scale); paintInk(ctx, strokes); ctx.restore();
}
