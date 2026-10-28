import { describe, expect, it } from "vitest";

import { DesktopWheelGesture, type WheelDelta } from "../src/desktop-wheel";

// Drive the pure gesture logic directly: one trackpad sample per 16ms frame,
// never natively scrolled, so accumulated page travel is what flips pages.
function flipCount(deltas: Array<number | readonly [number, number]>, axis: "x" | "y" = "x"): number {
  const gesture = new DesktopWheelGesture();
  let pages = 0;
  deltas.forEach((delta, i) => {
    const [x, y] = Array.isArray(delta)
      ? delta
      : axis === "x" ? [delta, 0] as const : [0, delta] as const;
    pages += gesture.pageDelta(gesture.begin({ x, y, mode: 0 }, false, i * 16), false);
  });
  return pages;
}

describe("DesktopWheelGesture blocked-window re-arm", () => {
  // Fast phase + decay tail, three times: the third flick lands while the
  // block from the second re-arm is still active and rises only ~2x over the
  // raw tail - the shape real repeat flicks produce.
  const TRIPLE_FLICK = [
    140, 90, 60,
    30, 20, 12, 25,
    50, 55, 60,
    30, 20, 12, 25,
    50, 55, 60,
  ];

  it("lets a constant-magnitude flick re-arm inside the blocked window", () => {
    expect(flipCount(TRIPLE_FLICK)).toBe(3);
  });

  it("re-arms the same way on the y axis", () => {
    expect(flipCount(TRIPLE_FLICK, "y")).toBe(3);
  });

  it("still unlocks on a single step of 2.2x or more over the tail", () => {
    expect(flipCount([
      140, 90, 60,
      30, 20, 12, 25,
      50, 55, 60,
      30, 20, 12,
      30, 55, 60, // 30 > 12 * 2.2: one big single step clears the block
    ])).toBe(3);
  });
});

describe("DesktopWheelGesture gesture boundaries", () => {
  it("keeps a decaying flick to a single page (no momentum continuation)", () => {
    expect(flipCount([140, 90, 60, 30, 20, 14, 10])).toBe(1);
  });

  it("splits two flicks separated by a 60ms quiet gap", () => {
    const gesture = new DesktopWheelGesture();
    const flick = [140, 90, 60, 30, 20, 12];
    // Last sample of flick 1 lands at t=80; flick 2 starts 60ms later.
    const feed = (startAt: number) => flick.reduce((pages, magnitude, i) => {
      const motion = gesture.begin({ x: magnitude, y: 0, mode: 0 }, false, startAt + i * 16);
      return pages + gesture.pageDelta(motion, false);
    }, 0);
    expect(feed(0) + feed(140)).toBe(2);
  });
});

describe("DesktopWheelGesture discrete notch budget", () => {
  // Wheel-emulation / quantized touchpads emit pixel deltas that pixelNotch
  // classifies as wheel notches; the discrete path must honor the same
  // single-gesture page budget as the continuous path.
  function notchStreamCount(stepMs: number, count: number, deltaY = 120): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    for (let i = 0; i < count; i++) {
      const motion = gesture.begin({ x: 0, y: deltaY, mode: 0 }, false, i * stepMs);
      pages += gesture.pageDelta(motion, false);
    }
    return pages;
  }

  it("caps a fast quantized pixel-notch stream at the per-gesture page budget", () => {
    // MAX_TRACKPAD_PAGES_PER_GESTURE: an unbounded stream flipped 16 pages before the budget.
    expect(notchStreamCount(8, 20)).toBeLessThanOrEqual(2);
  });

  it("caps a sparser quantized stream too (40ms steps still one gesture)", () => {
    expect(notchStreamCount(40, 20)).toBeLessThanOrEqual(2);
  });

  it("still flips every deliberate wheel notch spaced beyond the gesture gap", () => {
    // Each notch lands >=180ms after the previous one, so every step resets
    // the gesture: deliberate wheel-by-wheel scrolling stays one page per notch.
    expect(notchStreamCount(200, 6)).toBe(6);
  });

  it("caps the 40ms damped cadence the visual spec pins (deltaY=100)", () => {
    // deltaY=100 quantizes too (multiple of 100), and the 0.8 damping delays
    // the second page by one notch; the burst still stops at the budgeted two
    // pages, matching the "3 / 6" the desktop-input visual spec asserts.
    expect(notchStreamCount(40, 5, 100)).toBe(2);
  });

  it("caps the 100ms queued cadence the visual spec pins (deltaY=100)", () => {
    // 100ms gaps keep all eight notches in one gesture (idle boundary 180ms),
    // so only the budgeted two pages queue, matching the "5 / 8" the
    // desktop-input visual spec asserts.
    expect(notchStreamCount(100, 8, 100)).toBe(2);
  });
});

describe("DesktopWheelGesture diagonal zero-component samples", () => {
  // Diagonal trackpad streams contain samples whose held-axis component is
  // exactly 0; they pause the stream instead of switching the axis, so they
  // must not reset the travel the gesture already accumulated.
  it("keeps a slow diagonal scroll across a zero-axis sample to one page", () => {
    expect(flipCount([[8, 1], [10, 1], [0, 3], [9, 1], [9, 0], [9, 1], [9, 1], [8, 1]])).toBe(1);
  });

  it("stays at one page when the crossing sample keeps both components", () => {
    expect(flipCount([[8, 1], [10, 1], [3, 3], [9, 1], [9, 0], [9, 1], [9, 1], [8, 1]])).toBe(1);
  });

  it("budgets a genuine axis switch after a zero-axis sample from zero travel", () => {
    // 5x8px stays under the 48px horizontal threshold; the switch to y must
    // settle pages from zero y-travel, not inherit the x-axis travel (a leak
    // would flip twice across these samples).
    expect(flipCount([
      [8, 1], [8, 1], [8, 1], [8, 1], [8, 1],
      [0, 9],
      [1, 9], [1, 9], [1, 9], [1, 9], [1, 9], [1, 9],
      [1, 9], [1, 9], [1, 9], [1, 9], [1, 9], [1, 9],
    ])).toBe(1);
  });

  it("applies the same zero-component tolerance on the y axis", () => {
    expect(flipCount([[0, 30], [1, 40], [3, 0], [0, 40]])).toBe(1);
  });
});
