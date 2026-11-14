import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DesktopWheelGesture, normalizeWheel, WheelPagePacer } from "../src/desktop-wheel";
import type { WheelDelta } from "../src/desktop-wheel";
import type { WheelEventData } from "wheel-gestures";

const recordings = [
  ["win-chrome-right-ptp", 1], ["win-chrome-fast-right-ptp", 1],
  ["double-swipe-right", 2], ["slow-drag-right", 1],
] as const;
const pane = { clientWidth: 800, clientHeight: 600 };
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function replay(name: string, axis: "x" | "y", direction: number, repeat = 1): number[] {
  const recording = JSON.parse(readFileSync(new URL(`./fixtures/wheel-gestures/${name}.json`, import.meta.url), "utf8")) as { wheelEvents: WheelEventData[] };
  const gesture = new DesktopWheelGesture();
  const flips: number[] = [];
  let clock = 0;
  for (let pass = 0; pass < repeat; pass++) {
    const first = recording.wheelEvents[0].timeStamp;
    const offset = clock;
    for (const raw of recording.wheelEvents) {
      const at = offset + raw.timeStamp - first;
      vi.advanceTimersByTime(at - clock);
      clock = at;
      const lift = raw.deltaX === 0 && raw.deltaY === 0 && Object.is(raw.deltaX, -0);
      const event = { ...raw,
        deltaX: lift ? -0 : direction * (axis === "x" ? raw.deltaX : raw.deltaY),
        deltaY: direction * (axis === "x" ? raw.deltaY : raw.deltaX) };
      const delta = normalizeWheel(event, pane);
      if (!delta) continue;
      const pages = gesture.pageDelta(gesture.begin(delta, false, at), false);
      if (pages) flips.push(pages);
    }
    vi.advanceTimersByTime(1100);
    clock += 1100;
  }
  gesture.reset();
  return flips;
}

describe("recorded trackpad navigation through wheel-gestures", () => {
  for (const axis of ["x", "y"] as const) {
    for (const direction of [-1, 1]) {
      it.each(recordings)(`${axis}, direction ${direction}: %s recognizes intentional pages without inertia repeats`, (name, count) => {
        const pages = replay(name, axis, direction);
        expect(pages).toHaveLength(count);
        expect(pages.every((page) => page === -direction)).toBe(true);
      });
      it.each(recordings)(`${axis}, direction ${direction}: %s rearms for three separate same-direction gestures`, (name, count) => {
        expect(replay(name, axis, direction, 3)).toHaveLength(count * 3);
      });
    }
  }
});

describe.each(["x", "y"] as const)("shared %s-axis navigation policy", (axis) => {
  const delta = (movement: number, momentum?: boolean): WheelDelta => ({
    x: axis === "x" ? movement : 0, y: axis === "y" ? movement : 0, mode: 0,
    ...(momentum === undefined ? {} : { momentum }),
  });

  it("uses the same 48px threshold and consumes movement inside the page before paging", () => {
    const gesture = new DesktopWheelGesture();
    expect(gesture.pageDelta(gesture.begin(delta(30), false, 0), true)).toBe(0);
    expect(gesture.pageDelta(gesture.begin(delta(24), false, 10), false)).toBe(0);
    expect(gesture.pageDelta(gesture.begin(delta(24), false, 20), false)).toBe(1);
    gesture.reset();
  });

  it("does not turn a page when native inertia reaches a boundary", () => {
    const gesture = new DesktopWheelGesture();
    expect(gesture.pageDelta(gesture.begin(delta(60, false), false, 0), true)).toBe(0);
    for (const [at, movement] of [[10, 60], [20, 160], [30, 8]]) {
      expect(gesture.pageDelta(gesture.begin(delta(movement, true), false, at), false)).toBe(0);
    }
    expect(gesture.pageDelta(gesture.begin(delta(60, false), false, 40), false)).toBe(1);
    gesture.reset();
  });

  it("rearms a small native intentional swipe during an inertia tail", () => {
    const gesture = new DesktopWheelGesture();
    expect(gesture.pageDelta(gesture.begin(delta(60, false), false, 0), false)).toBe(1);
    expect(gesture.pageDelta(gesture.begin(delta(30, true), false, 10), false)).toBe(0);
    const resumed = gesture.begin(delta(24, false), false, 20);
    expect(resumed.suppressed).toBe(false);
    expect(gesture.pageDelta(resumed, false)).toBe(0);
    expect(gesture.pageDelta(gesture.begin(delta(24, false), false, 30), false)).toBe(1);
    gesture.reset();
  });

  it("permits immediate reversal without waiting for a timeout", () => {
    const gesture = new DesktopWheelGesture();
    expect(gesture.pageDelta(gesture.begin(delta(60, false), false, 0), false)).toBe(1);
    expect(gesture.pageDelta(gesture.begin(delta(-60, false), false, 10), false)).toBe(-1);
    gesture.reset();
  });

  it("keeps one uninterrupted deliberate drag to one page", () => {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    for (let i = 0; i < 150; i++) {
      pages += gesture.pageDelta(gesture.begin(delta(20, false), false, i * 10), false);
    }
    expect(pages).toBe(1);
    gesture.reset();
  });

  it("releases gesture suppression when the library ends its stream", () => {
    const gesture = new DesktopWheelGesture();
    gesture.pageDelta(gesture.begin(delta(60, false), false, 0), false);
    expect(gesture.pagingTail).toBe(true);
    vi.advanceTimersByTime(1100);
    expect(gesture.pagingTail).toBe(false);
    expect(gesture.pageDelta(gesture.begin(delta(60, false), false, 1100), false)).toBe(1);
    gesture.reset();
  });
});

describe("wheel ownership and mouse compatibility", () => {
  it("keeps pane-relative line and page normalization", () => {
    expect(normalizeWheel({ deltaX: 2, deltaY: 3, deltaMode: 1 }, pane)).toEqual({ x: 32, y: 48, mode: 1 });
    expect(normalizeWheel({ deltaX: 1, deltaY: -1, deltaMode: 2 }, pane)).toEqual({ x: 800, y: -600, mode: 2 });
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite input %s before it reaches the library", (value) => {
    expect(normalizeWheel({ deltaX: value, deltaY: 1, deltaMode: 0 }, pane)).toBeNull();
  });

  it("preserves Windows negative-zero lift and native momentum on zero-delta events", () => {
    expect(Object.is(normalizeWheel({ deltaX: -0, deltaY: 0, deltaMode: 0 }, pane)?.x, -0)).toBe(true);
    expect(normalizeWheel({ deltaX: 0, deltaY: 0, deltaMode: 0, momentum: true }, pane)?.momentum).toBe(true);
    expect(normalizeWheel({ deltaX: 0, deltaY: 0, deltaMode: 0 }, pane)).toBeNull();
    expect(normalizeWheel({ deltaX: 1, deltaY: 0, deltaMode: 3 }, pane)).toBeNull();
  });

  it("reads a browser-provided inherited momentum getter", () => {
    const raw = Object.assign(Object.create({ get momentum() { return true; } }), { deltaX: 80, deltaY: 0, deltaMode: 0 });
    const gesture = new DesktopWheelGesture();
    expect(gesture.pageDelta(gesture.begin(normalizeWheel(raw, pane)!, false, 0), false)).toBe(0);
    gesture.reset();
  });

  it.each([1, 2])("never treats native momentum in deltaMode %s as a mouse notch", (mode) => {
    const gesture = new DesktopWheelGesture();
    const motion = gesture.begin({ x: 0, y: 120, mode, momentum: true }, false, 0);
    expect(motion.discrete).toBe(false);
    expect(gesture.pageDelta(motion, false)).toBe(0);
    gesture.reset();
  });

  it("preserves one page per separated mouse-wheel notch", () => {
    const gesture = new DesktopWheelGesture();
    const pages = [0, 200, 400, 600].map((at) =>
      gesture.pageDelta(gesture.begin({ x: 0, y: 100, mode: 0 }, false, at), false));
    expect(pages).toEqual([1, 1, 1, 1]);
    gesture.reset();
  });

  it("preserves the dampened fast mouse-wheel burst and merged line-notch cap", () => {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    for (const at of [0, 40, 80, 120, 160]) {
      pages += gesture.pageDelta(gesture.begin({ x: 0, y: 100, mode: 0 }, false, at), false);
    }
    expect(pages).toBe(2);
    gesture.reset();
    expect(gesture.pageDelta(gesture.begin({ x: 0, y: 960, mode: 1 }, false, 200), false)).toBe(2);
    expect(gesture.pageDelta(gesture.begin({ x: 0, y: 960, mode: 1 }, false, 210), false)).toBe(0);
    gesture.reset();
  });

  it("switches from trackpad to line-unit mouse input without swallowing the notch", () => {
    const gesture = new DesktopWheelGesture();
    gesture.pageDelta(gesture.begin({ x: 60, y: 0, mode: 0 }, false, 0), false);
    expect(gesture.pageDelta(gesture.begin({ x: 0, y: 48, mode: 1 }, false, 10), false)).toBe(1);
    gesture.reset();
  });

  it("accepts native non-inertial mouse notches after a trackpad gesture", () => {
    const gesture = new DesktopWheelGesture();
    gesture.pageDelta(gesture.begin({ x: 60, y: 0, mode: 0, momentum: false }, false, 0), false);
    let pages = 0;
    for (let at = 100; at < 900; at += 100) {
      pages += gesture.pageDelta(gesture.begin({ x: 0, y: 100, mode: 0, momentum: false }, false, at), false);
    }
    expect(pages).toBe(2);
    gesture.reset();
  });

  it("retains Shift-wheel axis mapping", () => {
    const gesture = new DesktopWheelGesture();
    expect(gesture.begin({ x: 0, y: 48, mode: 1 }, true, 0)).toMatchObject({ axis: "x", movement: 48, discrete: true });
    gesture.reset();
  });

  it("does not spend a newer gesture's page budget with a stale motion", () => {
    const gesture = new DesktopWheelGesture();
    const stale = gesture.begin({ x: 60, y: 0, mode: 0, momentum: false }, false, 0);
    gesture.reset();
    gesture.begin({ x: 24, y: 0, mode: 0, momentum: false }, false, 10);
    expect(gesture.pageDelta(stale, false)).toBe(0);
    gesture.reset();
    vi.advanceTimersByTime(1100);
    expect(gesture.pagingTail).toBe(false);
  });
});

describe.each(["x", "y"] as const)("shared %s-axis fast-paging preview", (axis) => {
  it("engages at three pages inside one second and expires after silence", () => {
    const pacer = new WheelPagePacer();
    expect(pacer.record(1, axis, 0)).toBe(false);
    expect(pacer.record(1, axis, 300)).toBe(false);
    expect(pacer.record(1, axis, 600)).toBe(true);
    expect(pacer.record(1, axis, 1800)).toBe(false);
    pacer.end();
    expect(pacer.engaged).toBe(false);
  });
});
