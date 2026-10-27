/** WheelEvent exposes units and distance, but no portable device or gesture phase. */
const GESTURE_IDLE_MS = 180;
const RENEWED_FLICK_GAP_MS = 55;
const RENEWED_FLICK_RELEASE_PX = 4;
/** A renewed flick jumps clear of the decaying inertia tail; real fast-phase
 *  trackpad deltas then hold nearly constant, so a single jump over the decayed
 *  envelope marks a new gesture - compound acceleration never happens. */
const RENEWED_FLICK_JUMP_PX = 24;
const RENEWED_FLICK_JUMP_RATIO = 2.2;
const PAGE_TRAVEL_PX = 100;
const HORIZONTAL_PAGE_TRAVEL_PX = 48;
const MAX_TRACKPAD_PAGES_PER_GESTURE = 2;
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
  gestureId: number;
  suppressed: boolean;
  renewedTravel?: number;
}

/** One short-lived input stream; neither device identity nor page state is stored. */
export class DesktopWheelGesture {
  private axis: "x" | "y" | null = null;
  private discrete = false;
  private mode = 0;
  private lastAt: number | null = null;
  private lastDelta = 0;
  /** Raw magnitude of the previous sample (unlike the decayed lastDelta
   *  envelope), so a blocked renewal can demand a single-step jump: momentum
   *  continuation ramps up sample over sample, a fresh flick does not. */
  private lastMagnitude = 0;
  private travel = 0;
  private flipped = false;
  private notchCredit = 0;
  private renewedTravel = 0;
  private renewedPeak = 0;
  private renewedIncreases = 0;
  private renewalBlocked = false;
  private trackpadPages = 0;
  private gestureId = 0;

  private beginRenewedGesture(): void {
    this.gestureId += 1;
    this.trackpadPages = 0;
  }

  reset(): void {
    this.gestureId += 1;
    this.axis = null;
    this.lastAt = null;
    this.lastDelta = this.lastMagnitude = this.travel = this.notchCredit = 0;
    this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
    this.renewalBlocked = false;
    this.trackpadPages = 0;
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
    // Some devices omit the inertia tail entirely, so a quiet interval is
    // itself a gesture boundary; do not infer it from the next delta's size.
    const renewed = !this.discrete && this.flipped && gap >= RENEWED_FLICK_GAP_MS;
    if (axis !== this.axis || delta.mode !== this.mode || reversed) { this.reset(); gap = 0; }
    else if (renewed) {
      this.reset();
      gap = 0;
    }
    this.discrete = this.axis === null ? discrete : this.discrete && discrete;
    this.axis = axis;
    this.mode = delta.mode;
    this.lastAt = at;
    let renewedTravel: number | undefined;
    if (this.flipped && !this.discrete) {
      const jump = magnitude >= Math.max(RENEWED_FLICK_JUMP_PX, Math.abs(this.lastDelta) * RENEWED_FLICK_JUMP_RATIO);
      if (this.renewalBlocked) {
        // Ignore the momentum continuation after a renewed gesture until its
        // tail settles; momentum ramps up sample over sample, so a re-arm
        // inside the block must be a single-step jump from a low level.
        if (magnitude <= RENEWED_FLICK_RELEASE_PX) this.renewalBlocked = false;
        else if (jump && magnitude > this.lastMagnitude * RENEWED_FLICK_JUMP_RATIO) {
          this.beginRenewedGesture();
          this.flipped = false;
          this.travel = 0;
          this.renewalBlocked = true;
          this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
        }
      } else if (jump) {
        this.beginRenewedGesture();
        this.flipped = false;
        this.travel = 0;
        this.renewalBlocked = true;
        this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
      } else if (axis === "y") {
        // Not the quiet-gap path: in a pure trackpad stream a >=55ms gap
        // resets above before reaching this block. This seeds only the mixed
        // discrete->continuous flow (mouse notch -> silent gap -> trackpad
        // tail), where the stale discrete flag blocks that reset and the
        // tail still needs a ramp detector.
        if (gap >= RENEWED_FLICK_GAP_MS) {
          this.renewedTravel = magnitude;
          this.renewedPeak = magnitude;
          this.renewedIncreases = 0;
        } else if (this.renewedPeak > 0) {
          if (magnitude >= this.renewedPeak * 1.2) {
            this.renewedPeak = magnitude;
            this.renewedTravel += magnitude;
            this.renewedIncreases += 1;
            if (this.renewedIncreases >= 2 && this.renewedTravel >= PAGE_TRAVEL_PX) {
              renewedTravel = Math.sign(movement) * this.renewedTravel;
              this.beginRenewedGesture();
              this.flipped = false;
              this.travel = 0;
              this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
            }
          } else if (magnitude < this.renewedPeak * 0.7) {
            this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
          }
        }
      }
    } else {
      this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
    }
    this.lastDelta = this.flipped && !this.discrete
      ? Math.sign(movement) * Math.min(Math.abs(this.lastDelta), magnitude) : movement;
    this.lastMagnitude = magnitude;
    return { axis, movement, discrete: this.discrete, mode: delta.mode, gap, gestureId: this.gestureId,
      suppressed: !this.discrete && this.flipped, renewedTravel };
  }

  pageDelta(motion: WheelMotion, scrolled: boolean): number {
    if (scrolled) {
      this.travel = this.notchCredit = 0;
      this.renewalBlocked = false;
      return 0;
    }
    if (motion.suppressed) return 0;
    if (motion.renewedTravel !== undefined) this.travel = motion.renewedTravel;
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
    const travelThreshold = motion.axis === "x" ? HORIZONTAL_PAGE_TRAVEL_PX : PAGE_TRAVEL_PX;
    if (Math.abs(this.travel) < travelThreshold) return 0;
    if (this.trackpadPages >= MAX_TRACKPAD_PAGES_PER_GESTURE) {
      this.travel = 0;
      return 0;
    }
    this.flipped = true;
    this.trackpadPages += 1;
    this.travel = 0;
    return Math.sign(motion.movement);
  }
}
