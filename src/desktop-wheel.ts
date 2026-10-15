/** WheelEvent exposes units and distance, but no portable device or gesture phase. */
const GESTURE_IDLE_MS = 180;
const RENEWED_FLICK_GAP_MS = 55;
const PAGE_TRAVEL_PX = 100;
const AXIS_RETENTION_RATIO = 0.65;

export interface WheelDelta {
  x: number;
  y: number;
  mode: number;
}

export function normalizeWheel(event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode">,
  viewport: Pick<HTMLElement, "clientWidth" | "clientHeight">): WheelDelta | null {
  const { deltaX, deltaY, deltaMode } = event;
  if (![deltaX, deltaY].every(Number.isFinite) || ![0, 1, 2].includes(deltaMode)) return null;
  const x = deltaX * (deltaMode === 2 ? viewport.clientWidth : deltaMode === 1 ? 16 : 1);
  const y = deltaY * (deltaMode === 2 ? viewport.clientHeight : deltaMode === 1 ? 16 : 1);
  return Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0) ? { x, y, mode: deltaMode } : null;
}

interface WheelMotion {
  axis: "x" | "y";
  movement: number;
  discrete: boolean;
  mode: number;
  gap: number;
  suppressed: boolean;
}

/** One short-lived input stream; neither device identity nor page state is stored. */
export class DesktopWheelGesture {
  private axis: "x" | "y" | null = null;
  private discrete = false;
  private mode = 0;
  private lastAt: number | null = null;
  private lastDelta = 0;
  private travel = 0;
  private flipped = false;
  private notchCredit = 0;

  reset(): void {
    this.axis = null;
    this.lastAt = null;
    this.lastDelta = this.travel = this.notchCredit = 0;
    this.flipped = this.discrete = false;
    this.mode = 0;
  }

  begin(delta: WheelDelta, shift: boolean, at: number): WheelMotion {
    let gap = this.lastAt === null ? 0 : at - this.lastAt;
    if (gap < 0 || gap >= GESTURE_IDLE_MS) { this.reset(); gap = 0; }
    const horizontal = Math.abs(delta.x), vertical = Math.abs(delta.y);
    const axis = shift ? "x"
      : this.axis === "x" && horizontal >= vertical * AXIS_RETENTION_RATIO ? "x"
        : this.axis === "y" && vertical >= horizontal * AXIS_RETENTION_RATIO ? "y"
          : horizontal >= vertical ? "x" : "y";
    const movement = axis === "x" ? (delta.x || (shift ? delta.y : 0)) : delta.y;
    const magnitude = Math.abs(movement);
    // A large pixel delta alone is not a notch: fast touchpad flicks also
    // exceed 80px. Recognize conventional wheel steps conservatively; once
    // continuous motion appears, keep its inertia in the same gesture.
    const pixelNotch = delta.x === 0 && (axis === "y" || shift)
      && magnitude >= 80 && (magnitude % 100 === 0 || magnitude % 120 === 0);
    const discrete = delta.mode !== 0 || pixelNotch;
    const reversed = this.lastDelta !== 0 && Math.sign(movement) !== Math.sign(this.lastDelta);
    const renewed = !this.discrete && this.flipped && gap >= RENEWED_FLICK_GAP_MS
      && magnitude >= 48 && magnitude > Math.abs(this.lastDelta) * 1.8;
    if (axis !== this.axis || delta.mode !== this.mode || reversed || renewed) { this.reset(); gap = 0; }
    this.discrete = this.axis === null ? discrete : this.discrete && discrete;
    this.axis = axis;
    this.mode = delta.mode;
    this.lastAt = at;
    this.lastDelta = this.flipped && !this.discrete
      ? Math.sign(movement) * Math.min(Math.abs(this.lastDelta), magnitude) : movement;
    return { axis, movement, discrete: this.discrete, mode: delta.mode, gap,
      suppressed: !this.discrete && this.flipped };
  }

  pageDelta(motion: WheelMotion, scrolled: boolean): number {
    if (scrolled) { this.travel = this.notchCredit = 0; return 0; }
    if (motion.suppressed) return 0;
    if (motion.discrete) {
      const notches = motion.mode === 1 ? Math.max(1, Math.round(Math.abs(motion.movement) / 48)) : 1;
      const sensitivity = motion.mode === 0 && motion.gap > 0 && motion.gap < 80 ? 0.8 : 1;
      this.notchCredit += notches * sensitivity;
      const pages = Math.floor(this.notchCredit + 1e-8);
      this.notchCredit -= pages;
      if (pages > 0) this.flipped = true;
      return Math.sign(motion.movement) * pages;
    }
    this.travel += motion.movement;
    if (Math.abs(this.travel) < PAGE_TRAVEL_PX) return 0;
    this.flipped = true;
    this.travel = 0;
    return Math.sign(motion.movement);
  }
}
