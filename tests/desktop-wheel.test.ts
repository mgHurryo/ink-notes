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

describe("DesktopWheelGesture moderate re-swipe over a settled tail", () => {
  // A Windows precision trackpad inertia tail keeps every gap under the 55ms
  // quiet-gap threshold, so a mid-stream re-swipe can only re-arm through the
  // jump predicate. A moderate re-swipe rises 4-6x off the settled (<=4px)
  // tail yet stays under the 24px absolute floor in every sample: the floor
  // must not swallow it, while a stream that already rose past the release
  // level keeps the original floor so one ramp cannot re-arm twice.
  function pagesAcrossModerateReswipe(quietGapMs: number): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 0;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: magnitude, y: 0, mode: 0 }, false, at), false);
        at += stepMs;
      }
    };
    feed([140, 90, 60, 30, 20, 14], 10); // fast phase: one page
    feed([10, 8, 6, 4, 3, 3, 2], 10); // inertia tail settles at the release level
    at += quietGapMs; // >= 55ms exits through the quiet-gap path (control)
    feed(Array.from({ length: 30 }, (_, i) => 13 + (i % 5) * 2), 10);
    return pages;
  }

  it("rearms a moderate re-swipe rising straight off the settled tail", () => {
    expect(pagesAcrossModerateReswipe(0)).toBe(2);
  });

  it("keeps the identical re-swipe with a 60ms quiet gap at two pages", () => {
    expect(pagesAcrossModerateReswipe(60)).toBe(2);
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

describe("DesktopWheelGesture axis switch on the momentum tail", () => {
  // An axis re-classification mid-tail is still the same physical flick: the
  // tail must stay suppressed instead of re-arming under the new (smaller)
  // axis threshold and spending a fresh page budget.
  it("keeps the tail suppressed across a natural drift past the retention ratio", () => {
    expect(flipCount([[0, 140], [0, 90], [10, 60], [15, 30], [25, 18], [30, 10], [40, 6]])).toBe(1);
  });

  it("keeps the tail suppressed when Shift re-targets the axis mid-flight", () => {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    // Vertical flick flips one page (movement is negative, so the page is -1);
    // the tail is still hot when Shift is pressed 10ms into it.
    [140, 90, 60].forEach((magnitude, i) => {
      pages += gesture.pageDelta(gesture.begin({ x: 0, y: -magnitude, mode: 0 }, false, 100 + i * 10), false);
    });
    // Shift-held wheel events keep reporting deltaY: the gesture re-classifies
    // onto x while the same stream continues decaying, so suppression and the
    // page budget must survive the switch.
    for (let i = 0; i < 8; i++) {
      pages += gesture.pageDelta(gesture.begin({ x: 0, y: -30, mode: 0 }, true, 130 + i * 10), false);
    }
    expect(pages).toBe(-1);
  });
});

describe("DesktopWheelGesture discrete notch budget", () => {
  // Wheel-emulation / quantized touchpads emit pixel deltas that pixelNotch
  // classifies as wheel notches; the discrete path must honor the same
  // single-gesture page budget as the continuous path.
  function notchStreamCount(stepMs: number, count: number, deltaY = 120, mode = 0): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    for (let i = 0; i < count; i++) {
      const motion = gesture.begin({ x: 0, y: deltaY, mode }, false, i * stepMs);
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

  it("caps a line-mode merged-notch stream (deltaMode=1) at the page budget", () => {
    // Firefox line mode merges several notches into one event: 96 lines round
    // to 2 notches, so counting events instead of pages let the first two
    // events flip 2 pages each (4 total) inside a single gesture.
    expect(notchStreamCount(60, 4, 96, 1)).toBeLessThanOrEqual(2);
  });

  it("still flips one page per line-mode notch (deltaY=3 -> 48px)", () => {
    // Anti-over-clamp control: each 3-line event is a single notch worth one
    // page, so the stream still queues exactly the budgeted two pages.
    expect(notchStreamCount(60, 6, 3, 1)).toBe(2);
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

  it("still keeps a diagonal scroll across two consecutive zero-axis samples to one page", () => {
    // Two paused samples stay inside the diagonal tolerance; only a sustained
    // run may re-classify the axis.
    expect(flipCount([[8, 1], [10, 1], [0, 3], [0, 3], [9, 1], [9, 1], [9, 1], [9, 1], [8, 1]])).toBe(1);
  });
});

describe("DesktopWheelGesture sustained perpendicular stream", () => {
  // A mouse wheel emits deltaX=0 on every sample, so a vertical burst that
  // follows a horizontal gesture inside the idle window must re-classify onto
  // the y axis; unconditional zero-component retention pins movement to 0
  // forever and the burst never flips a page (the desktop-input visual spec
  // queues two more pages there, "5 / 8").
  function pagesAcrossPerpendicularBurst(): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    const flick = [140, 90, 60, 30, 10, 4];
    flick.forEach((magnitude, i) => {
      pages += gesture.pageDelta(gesture.begin({ x: magnitude, y: 0, mode: 0 }, false, 110 + i * 10), false);
    });
    pages += gesture.pageDelta(gesture.begin({ x: 140, y: 0, mode: 0 }, false, 220), false);
    for (let i = 0; i < 8; i++) {
      pages += gesture.pageDelta(gesture.begin({ x: 0, y: 100, mode: 0 }, false, 300 + i * 100), false);
    }
    return pages;
  }

  it("re-arms a sustained vertical wheel burst after a horizontal gesture", () => {
    // Two pages from the horizontal flick plus the budgeted two notch pages
    // from the re-armed burst.
    expect(pagesAcrossPerpendicularBurst()).toBe(4);
  });

  it("re-arms the same way after a vertical gesture", () => {
    const gesture = new DesktopWheelGesture();
    const flick = [140, 90, 60, 30, 10, 4];
    flick.forEach((magnitude, i) => {
      gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, 110 + i * 10), false);
    });
    gesture.pageDelta(gesture.begin({ x: 0, y: 140, mode: 0 }, false, 220), false);
    // Sustained horizontal samples (deltaY exactly 0) must re-classify onto x.
    const axes: Array<"x" | "y"> = [];
    for (let i = 0; i < 5; i++) axes.push(gesture.begin({ x: 100, y: 0, mode: 0 }, false, 300 + i * 100).axis);
    expect(axes).toContain("x");
  });
});
