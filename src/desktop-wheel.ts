/** WheelEvent exposes units and distance, but no portable device or gesture phase. */
const GESTURE_IDLE_MS = 180;
const RENEWED_FLICK_GAP_MS = 55;
const RENEWED_FLICK_RELEASE_PX = 4;
/** A renewed flick jumps clear of the decaying inertia tail; real fast-phase
 *  trackpad deltas then hold nearly constant, so a single jump over the decayed
 *  envelope marks a new gesture - compound acceleration never happens. */
const RENEWED_FLICK_JUMP_PX = 24;
const RENEWED_FLICK_JUMP_RATIO = 2.2;
/** Every renewal heuristic below compares speeds, not per-event amplitudes:
 *  each sample is normalized to this reference window, the reporting cadence
 *  the px floors were tuned at. A main-thread stall merges several hardware
 *  samples into one large event and a high report rate splits the same motion
 *  into small ones - raw-px comparison reads the merged sample as a new flick
 *  and starves the fast stream below the floors. Delivery gaps clamp to
 *  [1, 50]ms: below 1ms the speed estimate would explode on same-tick events,
 *  above 50ms a slow tail must not shrink below the release floor. */
const REF_DT_MS = 10;
/** A jump re-arm while the fast phase is still young is the same physical
 *  flick re-arming on its own undecayed envelope: a single accelerating swipe
 *  crosses the page boundary mid-rise, so its first samples after the flip
 *  satisfy the jump predicate without being a new intent. Demand this many
 *  flipped samples first - only a rise that persists past the flip, or lands
 *  after a re-arm's blocked window, may open a fresh page budget. */
const RENEW_MIN_FLIPPED = 3;
const PAGE_TRAVEL_PX = 100;
const HORIZONTAL_PAGE_TRAVEL_PX = 48;
const MAX_TRACKPAD_PAGES_PER_GESTURE = 2;
/** Horizontal swipes flip exactly one page per CONTACT (the span between
 *  hard resets: idle gap, reversal, axis or mode change). The per-gesture
 *  budget alone used to let a mid-tail renewal re-open it and flip a second
 *  page inside one physical contact - sideways motion is a deliberate
 *  single-page affordance, and that continuation read as accidental
 *  navigation, so the budget is now per contact. Vertical keeps the
 *  per-gesture budget: repeated vertical flicks are the fast-paging input. */
const X_PAGES_PER_CONTACT = 1;
const AXIS_RETENTION_RATIO = 0.65;
/** A zero held-axis component pauses a diagonal stream, but a sustained run
 *  of such samples is a genuine perpendicular stream (a mouse wheel emits
 *  deltaX=0 on every sample): past this many consecutive pauses the axis must
 *  re-classify, or the gesture locks onto the held axis with movement 0
 *  forever and the perpendicular stream never flips a page. */
const ZERO_AXIS_PAUSES_TO_SWITCH = 2;

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
   *  envelope), so a blocked renewal can demand one strictly ascending step:
   *  momentum continuation only decays, a fresh flick rises over the settled
   *  tail without needing an implausible single-step ratio. */
  private lastMagnitude = 0;
  private travel = 0;
  private flipped = false;
  private notchCredit = 0;
  private renewedTravel = 0;
  private renewedPeak = 0;
  private renewedIncreases = 0;
  private renewalBlocked = false;
  private trackpadPages = 0;
  /** Pages already flipped on the x axis during the current contact. Unlike
   *  trackpadPages it survives beginRenewedGesture: a mid-tail renewal is
   *  the same physical contact, and the horizontal contract grants it
   *  nothing further. */
  private contactXPages = 0;
  private zeroAxisPauses = 0;
  private gestureId = 0;
  /** Consecutive samples seen while the gesture is flipped, counted from the
   *  latest flip (pageDelta) or re-arm; guards the jump re-arm above. */
  private flippedRun = 0;
  /** this.flipped as of the end of the previous begin(), so a pageDelta flip
   *  that landed in between can restart flippedRun. */
  private flippedPreviously = false;

  private beginRenewedGesture(): void {
    this.gestureId += 1;
    this.trackpadPages = 0;
    this.flippedRun = 0;
  }

  reset(): void {
    this.gestureId += 1;
    this.axis = null;
    this.lastAt = null;
    this.lastDelta = this.lastMagnitude = this.travel = this.notchCredit = 0;
    this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
    this.renewalBlocked = false;
    this.trackpadPages = this.zeroAxisPauses = 0;
    this.contactXPages = 0;
    this.flippedRun = 0;
    this.flipped = this.discrete = false;
    this.mode = 0;
  }

  begin(delta: WheelDelta, shift: boolean, at: number): WheelMotion {
    let gap = this.lastAt === null ? 0 : at - this.lastAt;
    if (gap < 0 || gap >= GESTURE_IDLE_MS) { this.reset(); gap = 0; }
    const horizontal = Math.abs(delta.x), vertical = Math.abs(delta.y);
    // A zero component on the held axis pauses a diagonal stream instead of
    // switching the axis; without the tolerance the axis flips and the reset
    // below wipes the travel the gesture already accumulated. The pause is
    // bounded (ZERO_AXIS_PAUSES_TO_SWITCH): a sustained run is a perpendicular
    // stream, not a pause.
    const axis = shift ? "x"
      : this.axis === "x" && ((horizontal === 0 && this.zeroAxisPauses < ZERO_AXIS_PAUSES_TO_SWITCH)
        || horizontal >= vertical * AXIS_RETENTION_RATIO) ? "x"
        : this.axis === "y" && ((vertical === 0 && this.zeroAxisPauses < ZERO_AXIS_PAUSES_TO_SWITCH)
          || vertical >= horizontal * AXIS_RETENTION_RATIO) ? "y"
          : horizontal >= vertical ? "x" : "y";
    const movement = axis === "x" ? (delta.x || (shift ? delta.y : 0)) : delta.y;
    const magnitude = Math.abs(movement);
    // Computed from the arrival gap before any boundary reset zeroes it: the
    // delivery interval is what the speed estimate means. Only the flipped
    // continuous path below consumes it, so the zeroed-gap reset paths (which
    // clear flipped) never compare against it.
    const normalized = magnitude * (REF_DT_MS / Math.min(Math.max(gap, 1), REF_DT_MS * 5));
    // A large pixel delta alone is not a notch: fast touchpad flicks also
    // exceed 80px. Recognize conventional wheel steps conservatively; once
    // continuous motion appears, keep its inertia in the same gesture.
    const pixelNotch = delta.x === 0 && (axis === "y" || shift)
      && magnitude >= 80 && (magnitude % 100 === 0 || magnitude % 120 === 0);
    const discrete = delta.mode !== 0 || pixelNotch;
    // A zero-movement sample (paused held axis) and the sample right after it
    // (lastDelta decayed to 0) carry no direction; only two opposed real
    // movements reverse a gesture.
    const reversed = this.lastDelta !== 0 && movement !== 0
      && Math.sign(movement) !== Math.sign(this.lastDelta);
    // Some devices omit the inertia tail entirely, so a quiet interval is
    // itself a gesture boundary; whether the stream resumed as a new intent
    // is decided below from the resumed sample's normalized speed.
    const renewed = !this.discrete && this.flipped && gap >= RENEWED_FLICK_GAP_MS;
    // A continuous stream drifting across the axis retention boundary (or
    // re-targeted by Shift) is still the same physical flick: re-classify the
    // axis but keep the suppression state - flipped, page budget, gesture id -
    // or the momentum tail re-arms under the new axis threshold and pages
    // again. Only the per-axis travel and ramp state go; discrete streams
    // (deliberate notches) keep their hard reset and fresh budget.
    if (axis !== this.axis && this.flipped && !this.discrete && !discrete) {
      this.travel = 0;
      this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
    } else if (axis !== this.axis || delta.mode !== this.mode || reversed) {
      this.reset();
      gap = 0;
    } else if (renewed) {
      // A quiet interval marks a new intent only when the stream resumes
      // RISING over the settled envelope; resuming at or below it is the same
      // physical flick delivered late - keep the gesture, its suppression and
      // the page budget, and let the ramp detector below re-seed instead.
      if (normalized > Math.abs(this.lastDelta)) {
        this.reset();
        gap = 0;
      }
    }
    // Count retained samples that moved nothing: isolated ones are the
    // diagonal pauses above, a sustained run re-classifies on the next
    // sample. A boundary reset already cleared the count.
    this.zeroAxisPauses = movement === 0 && axis === this.axis ? this.zeroAxisPauses + 1 : 0;
    this.discrete = this.axis === null ? discrete : this.discrete && discrete;
    this.axis = axis;
    this.mode = delta.mode;
    this.lastAt = at;
    // A pageDelta flip lands between two begin() calls; the ascent guard
    // below counts flipped samples from that flip, not from the previous
    // re-arm.
    if (this.flipped && !this.flippedPreviously) this.flippedRun = 0;
    const priorFlippedRun = this.flippedRun;
    let renewedTravel: number | undefined;
    if (this.flipped && !this.discrete) {
      // A moderate re-swipe rising straight off a settled tail is a fresh
      // flick even below the absolute floor: with the previous raw sample at
      // the release level the 2.2x ratio already demands several times that
      // level, so noise cannot clear it, while the 24px floor swallowed real
      // sub-24px re-swipes whole (the envelope tracks the raw sample there:
      // the decayed lastDelta is its min chain). A stream that has already
      // risen past the release level is mid-ramp, not settled, and keeps the
      // original floor so a single ramp cannot re-arm twice per gesture.
      // Every comparison runs on normalized speeds (px per REF_DT_MS).
      const settledRise = this.lastMagnitude <= RENEWED_FLICK_RELEASE_PX && normalized > this.lastMagnitude
        && normalized >= Math.abs(this.lastDelta) * RENEWED_FLICK_JUMP_RATIO;
      const jump = normalized >= Math.max(settledRise ? RENEWED_FLICK_JUMP_PX / 2 : RENEWED_FLICK_JUMP_PX,
        Math.abs(this.lastDelta) * RENEWED_FLICK_JUMP_RATIO);
      if (this.renewalBlocked) {
        // Ignore the momentum continuation after a renewed gesture until its
        // tail settles: a tail only decays, so a re-arm inside the block must
        // be the envelope jump above plus one strictly ascending step - a
        // fresh flick rises over the settled raw level, momentum never does.
        // Demanding a fixed step ratio here would also reject real flicks
        // whose first sample rises only 1.5-3x over the settled level.
        if (normalized <= RENEWED_FLICK_RELEASE_PX) this.renewalBlocked = false;
        else if (jump && normalized > this.lastMagnitude && priorFlippedRun >= RENEW_MIN_FLIPPED) {
          this.beginRenewedGesture();
          this.flipped = false;
          this.travel = 0;
          this.renewalBlocked = true;
          this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
        }
      } else if (this.renewedPeak > 0 || gap >= RENEWED_FLICK_GAP_MS) {
        // Not the plain quiet-gap path (a pure continuous stream resets above
        // when its resumed sample rises): this seeds stalled-delivery
        // continuations and the mixed discrete->continuous flow, whose tails
        // still need a ramp detector. Both axes re-arm through it; the re-arm
        // travel threshold follows the axis.
        if (gap >= RENEWED_FLICK_GAP_MS) {
          this.renewedTravel = this.renewedPeak = normalized;
          this.renewedIncreases = 0;
        } else if (this.renewedPeak > 0) {
          if (normalized >= this.renewedPeak * 1.2) {
            this.renewedPeak = normalized;
            this.renewedTravel += normalized;
            this.renewedIncreases += 1;
            if (this.renewedIncreases >= 2 && this.renewedTravel
              >= (axis === "x" ? HORIZONTAL_PAGE_TRAVEL_PX : PAGE_TRAVEL_PX)) {
              renewedTravel = Math.sign(movement) * this.renewedTravel;
              this.beginRenewedGesture();
              this.flipped = false;
              this.travel = 0;
              this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
            }
          } else if (normalized < this.renewedPeak * 0.7) {
            this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
          }
        }
      } else if (jump && priorFlippedRun >= RENEW_MIN_FLIPPED) {
        this.beginRenewedGesture();
        this.flipped = false;
        this.travel = 0;
        this.renewalBlocked = true;
        this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
      }
    } else {
      this.renewedTravel = this.renewedPeak = this.renewedIncreases = 0;
    }
    this.flippedRun = this.flipped ? priorFlippedRun + 1 : 0;
    this.flippedPreviously = this.flipped;
    // A zero movement inside a flipped continuous stream is a diagonal stream
    // reporting a pause, not a settled tail: writing it through would zero the
    // envelope (sign(0) min-chain, magnitude 0), letting the very next sample
    // pose as a settledRise (lastMagnitude <= 4 with the ratio term trivially
    // true) and re-open the page budget mid-gesture. Keep the envelope across
    // the pause; a genuine settle still decays through non-zero samples to the
    // release level (or exits via the >= 55ms quiet gap), and a sustained zero
    // run still re-classifies through ZERO_AXIS_PAUSES_TO_SWITCH. The envelope
    // stores normalized speeds, so every comparison below shares one unit.
    const pausedTail = movement === 0 && this.flipped && !this.discrete;
    this.lastDelta = pausedTail ? this.lastDelta
      : this.flipped && !this.discrete
        ? Math.sign(movement) * Math.min(Math.abs(this.lastDelta), normalized)
        : Math.sign(movement) * normalized;
    if (!pausedTail) this.lastMagnitude = normalized;
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
      // Quantized pixel streams (>=80px multiples of 100/120) also land here,
      // so the discrete path shares the same single-gesture page budget as
      // the continuous path instead of flipping one page per notch forever.
      if (motion.axis === "x" && this.contactXPages >= X_PAGES_PER_CONTACT) return 0;
      if (this.trackpadPages >= MAX_TRACKPAD_PAGES_PER_GESTURE) return 0;
      const notches = motion.mode === 1 ? Math.max(1, Math.round(Math.abs(motion.movement) / 48)) : 1;
      const sensitivity = motion.mode === 0 && motion.gap > 0 && motion.gap < 80 ? 0.8 : 1;
      this.notchCredit += notches * sensitivity;
      // Line mode (deltaMode=1) merges several notches into one event, so the
      // budget caps pages per event, not events: a merged event can only spend
      // what remains of the per-gesture budget (leftover credit stays parked,
      // unreachable once the gate above sees the budget as spent).
      const pages = Math.min(Math.floor(this.notchCredit + 1e-8),
        MAX_TRACKPAD_PAGES_PER_GESTURE - this.trackpadPages);
      this.notchCredit -= pages;
      if (pages > 0) {
        this.flipped = true;
        this.trackpadPages += pages;
        if (motion.axis === "x") this.contactXPages += pages;
      }
      return Math.sign(motion.movement) * pages;
    }
    this.travel += motion.movement;
    const travelThreshold = motion.axis === "x" ? HORIZONTAL_PAGE_TRAVEL_PX : PAGE_TRAVEL_PX;
    if (Math.abs(this.travel) < travelThreshold) return 0;
    const budgetSpent = motion.axis === "x"
      ? this.contactXPages >= X_PAGES_PER_CONTACT
      : this.trackpadPages >= MAX_TRACKPAD_PAGES_PER_GESTURE;
    if (budgetSpent) {
      this.travel = 0;
      return 0;
    }
    this.flipped = true;
    this.trackpadPages += 1;
    if (motion.axis === "x") this.contactXPages += 1;
    this.travel = 0;
    return Math.sign(motion.movement);
  }
}

/** Fast-paging rail window: enough vertical page flips inside this trailing
 *  span count as fast paging. */
export const FAST_PAGING_WINDOW_MS = 1000;
export const FAST_PAGING_PAGES = 3;

/** Sliding-window page-rate detector behind the fast-paging rail. Vertical
 *  page flips land here with their real arrival time (the wheel event's
 *  timeStamp, the same clock the #320 normalization reads) and a merged
 *  burst pushes every page it actually flipped, so the rate reflects what
 *  the user saw. Horizontal flips never count: the horizontal contract is
 *  one page per contact, and a sideways stream must not pop the rail. */
export class WheelPagePacer {
  private flips: number[] = [];
  private engagedState = false;

  /** Records |pages| flips and returns whether enough of them fall inside
   *  the trailing window to keep the fast-paging rail engaged. */
  record(pages: number, axis: "x" | "y", at: number): boolean {
    if (axis === "y" && pages > 0) {
      for (let page = 0; page < pages; page += 1) this.flips.push(at);
      const cutoff = at - FAST_PAGING_WINDOW_MS;
      while (this.flips.length > 0 && this.flips[0] < cutoff) this.flips.shift();
    }
    this.engagedState = this.flips.length >= FAST_PAGING_PAGES;
    return this.engagedState;
  }

  /** Clears the window for teardown or a collapse, so a later slow flip
   *  cannot inherit a stale engagement. */
  end(): void {
    this.flips = [];
    this.engagedState = false;
  }

  get engaged(): boolean {
    return this.engagedState;
  }
}
