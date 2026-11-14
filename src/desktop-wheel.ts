import { WheelGestures, type WheelEventState } from "wheel-gestures";

/** Application policy; gesture phases and inertia belong to wheel-gestures. */
const PAGE_TRAVEL_PX = 48;
const NOTCH_IDLE_MS = 180;
const MAX_NOTCH_PAGES = 2;

export interface WheelDelta {
  x: number;
  y: number;
  mode: number;
  momentum?: boolean;
}

export function normalizeWheel(
  event: Pick<WheelEvent, "deltaX" | "deltaY" | "deltaMode"> & { momentum?: boolean },
  viewport: Pick<HTMLElement, "clientWidth" | "clientHeight">,
): WheelDelta | null {
  const { deltaX, deltaY, deltaMode } = event;
  if (![deltaX, deltaY].every(Number.isFinite) || ![0, 1, 2].includes(deltaMode)) return null;
  // Preserve pane-relative line/page units for the existing mouse-wheel contract.
  const x = deltaX * (deltaMode === 2 ? viewport.clientWidth : deltaMode === 1 ? 16 : 1);
  const y = deltaY * (deltaMode === 2 ? viewport.clientHeight : deltaMode === 1 ? 16 : 1);
  if (![x, y].every(Number.isFinite)) return null;
  // Zero can carry a native momentum transition or Windows' negative-zero lift.
  if (x === 0 && y === 0 && !Object.is(deltaX, -0) && typeof event.momentum !== "boolean") return null;
  return { x, y, mode: deltaMode,
    ...(typeof event.momentum === "boolean" ? { momentum: event.momentum } : {}) };
}

interface WheelMotion {
  axis: "x" | "y";
  movement: number;
  discrete: boolean;
  mode: number;
  gap: number;
  gestureId: number;
  suppressed: boolean;
  isMomentum: boolean;
}

/**
 * Thin bridge from the shared wheel recognizer to page navigation policy.
 * Both axes use the same phase, threshold and one-page-per-gesture rule.
 * No DOM listeners are installed by the library: the view keeps ownership of
 * nested scrolling, pointer guards, zoom and cancellation.
 */
export class DesktopWheelGesture {
  private recognizer: ReturnType<typeof WheelGestures> | null = null;
  private unsubscribe: (() => void) | null = null;
  private state: WheelEventState | null = null;
  private axis: "x" | "y" | null = null;
  private lastAt: number | null = null;
  private lastMovement = 0;
  private discrete = false;
  private gestureId = 0;
  private travel = 0;
  private flipped = false;
  private notchCredit = 0;
  private notchPages = 0;

  get pagingTail(): boolean {
    return !this.discrete && !this.state?.isEnding && (this.flipped || !!this.state?.isMomentum);
  }

  reset(): void {
    this.unsubscribe?.();
    this.recognizer?.disconnect();
    this.recognizer = null;
    this.unsubscribe = null;
    this.state = null;
    this.axis = null;
    this.lastAt = null;
    this.lastMovement = 0;
    this.discrete = false;
    this.newPageGesture();
  }

  private newPageGesture(): void {
    this.gestureId++;
    this.travel = this.notchCredit = this.notchPages = 0;
    this.flipped = false;
  }

  begin(delta: WheelDelta, shift: boolean, at: number): WheelMotion {
    const gap = this.lastAt === null ? 0 : Math.max(0, at - this.lastAt);
    const axis = shift ? "x" : Math.abs(delta.x) === Math.abs(delta.y) && this.axis
      ? this.axis : Math.abs(delta.x) >= Math.abs(delta.y) ? "x" : "y";
    const movement = axis === "x" ? (delta.x || (shift ? delta.y : 0)) : delta.y;
    const magnitude = Math.abs(movement);
    const reversed = axis === this.axis && movement * this.lastMovement < 0;
    const notch = delta.x === 0 && magnitude >= 80
      && (magnitude % 100 === 0 || magnitude % 120 === 0);
    // Retain the established mouse notch path. Once continuous input appears,
    // quantized samples inside that stream must not become fresh mouse notches.
    const discrete = delta.momentum !== true && (delta.mode !== 0 || (notch
      && (delta.momentum === false || this.lastAt === null || gap >= NOTCH_IDLE_MS || this.discrete)));
    if (discrete) {
      if (!this.discrete || gap >= NOTCH_IDLE_MS || reversed) this.newPageGesture();
      this.unsubscribe?.();
      this.recognizer?.disconnect();
      this.recognizer = null;
      this.unsubscribe = null;
      this.state = null;
    } else {
      if (!this.recognizer) {
        this.recognizer = WheelGestures({ preventWheelAction: false, reverseSign: false });
        this.unsubscribe = this.recognizer.on("wheel", (state) => {
          this.state = state;
          if (state.isStart) this.newPageGesture();
        });
      }
      this.recognizer.feedWheel({
        deltaX: shift ? movement : delta.x, deltaY: shift ? 0 : delta.y,
        deltaMode: 0, timeStamp: at,
        ...(delta.momentum === undefined ? {} : { momentum: delta.momentum }),
      });
      const state = this.state as WheelEventState | null;
      if (reversed && !state?.isMomentum) this.newPageGesture();
    }
    if (axis !== this.axis) this.travel = 0;
    this.axis = axis;
    this.lastAt = at;
    this.lastMovement = movement;
    this.discrete = discrete;
    return { axis, movement, discrete, mode: delta.mode, gap, gestureId: this.gestureId,
      suppressed: !discrete && this.flipped, isMomentum: !discrete && !!this.state?.isMomentum };
  }

  pageDelta(motion: WheelMotion, scrolled: boolean): number {
    if (scrolled) { this.travel = this.notchCredit = 0; return 0; }
    if (motion.gestureId !== this.gestureId || motion.movement === 0) return 0;
    if (motion.discrete) {
      const notches = motion.mode === 1 ? Math.max(1, Math.round(Math.abs(motion.movement) / 48)) : 1;
      this.notchCredit += notches * (motion.mode === 0 && motion.gap > 0 && motion.gap < 80 ? 0.8 : 1);
      const pages = Math.min(Math.floor(this.notchCredit + 1e-8), MAX_NOTCH_PAGES - this.notchPages);
      this.notchCredit -= pages;
      this.notchPages += pages;
      return Math.sign(motion.movement) * pages;
    }
    if (motion.suppressed || motion.isMomentum || this.flipped) return 0;
    this.travel += motion.movement;
    if (Math.abs(this.travel) < PAGE_TRAVEL_PX) return 0;
    this.flipped = true;
    this.travel = 0;
    return Math.sign(motion.movement);
  }
}

export const FAST_PAGING_WINDOW_MS = 1000;
export const FAST_PAGING_PAGES = 3;

/** One page-rate window for both axes. */
export class WheelPagePacer {
  private flips: number[] = [];
  private engagedState = false;

  record(pages: number, _axis: "x" | "y", at: number): boolean {
    for (let page = 0; page < pages; page++) this.flips.push(at);
    const cutoff = at - FAST_PAGING_WINDOW_MS;
    while (this.flips.length > 0 && this.flips[0] < cutoff) this.flips.shift();
    this.engagedState = this.flips.length >= FAST_PAGING_PAGES;
    return this.engagedState;
  }

  end(): void { this.flips = []; this.engagedState = false; }
  get engaged(): boolean { return this.engagedState; }
}
