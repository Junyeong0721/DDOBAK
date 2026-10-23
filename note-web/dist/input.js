const midpoint = points => ({ x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 });
const distance = points => Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));

// Device-independent input state. Tests exercise the same controller used by the UI.
export class InputController {
  constructor(callbacks, settings, clock = () => performance.now()) {
    this.cb = callbacks; this.settings = settings; this.clock = clock;
    this.touches = new Map(); this.ignored = new Set(); this.active = null; this.mode = null;
    this.blockTouchUntil = 0; this.gesture = null; this.waitForLift = false;
  }
  down(event) {
    const s = this.settings();
    if (event.type === 'pen') {
      if (this.active?.type === 'touch') this.cb.cancel();
      for (const id of this.touches.keys()) this.ignored.add(id);
      this.touches.clear(); this.gesture = null; this.waitForLift = false;
      if (this.active && this.active.type !== 'touch') this.cb.end();
      this.active = event; this.mode = 'ink'; this.blockTouchUntil = Infinity;
      this.cb.begin(event); return;
    }
    if (event.type === 'touch') {
      const palm = event.width > 48 && event.height > 48;
      if (this.clock() < this.blockTouchUntil || palm || this.active?.type === 'mouse') { this.ignored.add(event.id); return; }
      this.touches.set(event.id, event);
      if (this.touches.size > 1) {
        if (this.active && this.mode === 'ink') this.cb.cancel();
        this.active = null; this.mode = null;
        this.waitForLift = true;
        const points = [...this.touches.values()].slice(0, 2);
        this.gesture = s.locked ? null : { center: midpoint(points), distance: distance(points) };
        return;
      }
      if (this.waitForLift) return;
      this.active = event;
      this.mode = s.finger ? 'ink' : s.locked ? null : 'pan';
      if (this.mode === 'ink') this.cb.begin(event);
      return;
    }
    if (event.type === 'mouse' && event.button === 0 && !this.active && !this.touches.size) {
      this.active = event;
      this.mode = event.shift ? (s.locked ? null : 'pan') : 'ink';
      if (this.mode === 'ink') this.cb.begin(event);
    }
  }
  move(event) {
    if (this.ignored.has(event.id)) return;
    if (event.type === 'touch') {
      if (!this.touches.has(event.id)) return;
      this.touches.set(event.id, event);
      if (this.touches.size > 1) {
        if (this.gesture && !this.settings().locked) {
          const points = [...this.touches.values()].slice(0, 2), center = midpoint(points), nextDistance = distance(points);
          this.cb.zoom(nextDistance / this.gesture.distance, this.gesture.center, center);
          this.gesture = { center, distance: nextDistance };
        }
        return;
      }
      if (this.waitForLift) return;
    }
    if (this.active?.id !== event.id) return;
    if (this.mode === 'ink') this.cb.move(event);
    if (this.mode === 'pan' && !this.settings().locked) this.cb.pan(event.x - this.active.x, event.y - this.active.y);
    this.active = event;
  }
  up(event, cancelled = false) {
    this.ignored.delete(event.id);
    this.touches.delete(event.id);
    if (this.active?.id === event.id) {
      if (this.mode === 'ink') {
        // OS interruptions preserve visible ink; two-finger transitions cancel explicitly.
        if (!cancelled) this.cb.move(event);
        this.cb.end();
      }
      if (event.type === 'pen') this.blockTouchUntil = this.clock() + 400;
      this.active = null; this.mode = null;
    }
    if (this.touches.size < 2) this.gesture = null;
    if (!this.touches.size) this.waitForLift = false;
  }
  finish() {
    if (this.mode === 'ink' && this.active) this.cb.end();
    if (this.active?.type === 'pen') this.blockTouchUntil = this.clock() + 400;
    this.active = null; this.mode = null; this.gesture = null;
    for (const id of this.touches.keys()) this.ignored.add(id);
    this.touches.clear(); this.waitForLift = false;
  }
}
