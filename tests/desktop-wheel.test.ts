import { describe, expect, it } from "vitest";

import { DesktopWheelGesture, FAST_PAGING_PAGES, FAST_PAGING_WINDOW_MS, WheelPagePacer, type WheelDelta } from "../src/desktop-wheel";

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
  // raw tail - the shape real repeat flicks produce. On the vertical axis
  // each re-arm re-opens the page budget (three pages); the horizontal
  // contract is stricter: one page per contact, renewals included.
  const TRIPLE_FLICK = [
    140, 90, 60,
    30, 20, 12, 25,
    50, 55, 60,
    30, 20, 12, 25,
    50, 55, 60,
  ];

  it("keeps one horizontal contact to a single page across blocked-window re-arms", () => {
    expect(flipCount(TRIPLE_FLICK)).toBe(1);
  });

  it("lets a constant-magnitude flick re-arm inside the blocked window on the y axis", () => {
    expect(flipCount(TRIPLE_FLICK, "y")).toBe(3);
  });

  it("still unlocks on a single step of 2.2x or more over the tail on the y axis", () => {
    expect(flipCount([
      140, 90, 60,
      30, 20, 12, 25,
      50, 55, 60,
      30, 20, 12,
      30, 55, 60, // 30 > 12 * 2.2: one big single step clears the block
    ], "y")).toBe(3);
  });
});

describe("DesktopWheelGesture moderate re-swipe over a settled tail", () => {
  // A Windows precision trackpad inertia tail keeps every gap under the 55ms
  // quiet-gap threshold, so a mid-stream re-swipe can only re-arm through the
  // jump predicate. A moderate re-swipe rises 4-6x off the settled (<=4px)
  // tail yet stays under the 24px absolute floor in every sample: the floor
  // must not swallow it, while a stream that already rose past the release
  // level keeps the original floor so one ramp cannot re-arm twice.
  function pagesAcrossModerateReswipe(quietGapMs: number, axis: "x" | "y" = "y"): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 0;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        const delta = axis === "x" ? { x: magnitude, y: 0, mode: 0 } : { x: 0, y: magnitude, mode: 0 };
        pages += gesture.pageDelta(gesture.begin(delta, false, at), false);
        at += stepMs;
      }
    };
    feed([140, 90, 60, 30, 20, 14], 10); // fast phase: one page
    feed([10, 8, 6, 4, 3, 3, 2], 10); // inertia tail settles at the release level
    at += quietGapMs; // >= 55ms exits through the quiet-gap path (control)
    feed(Array.from({ length: 30 }, (_, i) => 13 + (i % 5) * 2), 10);
    return pages;
  }

  it("keeps the horizontal re-swipe to the one page its contact already flipped", () => {
    expect(pagesAcrossModerateReswipe(0, "x")).toBe(1);
  });

  it("rearms a moderate vertical re-swipe rising straight off the settled tail", () => {
    expect(pagesAcrossModerateReswipe(0)).toBe(2);
  });

  it("keeps the identical vertical re-swipe with a 60ms quiet gap at two pages", () => {
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
    // Two pages from two horizontal contacts (the flick and the quiet-gap
    // resumption that resets into a fresh contact) plus the budgeted two
    // notch pages from the re-armed burst.
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

describe("DesktopWheelGesture zero-component pause in the momentum tail", () => {
  // A transient zero held-axis sample inside a flipped diagonal stream used
  // to zero the envelope (lastDelta/lastMagnitude), so the next sample posed
  // as a settledRise (lastMagnitude <= 4 with the ratio term trivially true)
  // and any >= 12px recovery re-opened the page budget mid-contact: one
  // physical gesture flipped three pages. The envelope must survive pauses.
  it("keeps a diagonal flick across zero-component pauses to its contact's one page", () => {
    // The 60px recovery stays under the preserved 30px envelope's 2.2x
    // guardrail and rides out as inertia; the later 90px rise is 3x over that
    // still-preserved envelope, a genuine re-flick under the rise-means-new-
    // intent rule - but the horizontal contact has spent its single page, so
    // the re-arm may not flip another (three before the strict-1 contract,
    // with two zero-sample re-arms).
    expect(flipCount([[140, 8], [90, 8], [60, 8], [30, 8], [0, 8], [60, 8], [90, 8], [0, 8], [60, 8], [90, 8]])).toBe(1);
  });

  it("holds a sub-guardrail recovery after a zero pause as inertia (one page)", () => {
    // Every recovery sample stays far under 2.2x the preserved envelope, so
    // no re-arm happens at all (two pages before the pause guard).
    expect(flipCount([[140, 8], [90, 8], [60, 8], [30, 8], [0, 8], [18, 8], [16, 8], [0, 8], [14, 8], [13, 8], [12, 8], [12, 8], [13, 8], [12, 8]])).toBe(1);
  });

  it("mirrors the two-page budget across zero pauses onto the y axis", () => {
    expect(flipCount([[8, 140], [8, 90], [8, 60], [8, 30], [8, 0], [8, 60], [8, 90], [8, 0], [8, 60], [8, 90]], "y")).toBe(2);
  });

  it("mirrors the sub-guardrail inertia recovery onto the y axis", () => {
    expect(flipCount([[8, 140], [8, 90], [8, 60], [8, 30], [8, 0], [8, 18], [8, 16], [8, 0], [8, 14], [8, 13], [8, 12], [8, 12], [8, 13], [8, 12]], "y")).toBe(1);
  });
});

describe("WheelPagePacer fast-paging window", () => {
  it("engages once three vertical pages land inside the window", () => {
    const pacer = new WheelPagePacer();
    expect(pacer.record(1, "y", 0)).toBe(false);
    expect(pacer.record(1, "y", 300)).toBe(false);
    expect(pacer.record(1, "y", 600)).toBe(true);
    expect(pacer.engaged).toBe(true);
  });

  it("keeps slow paging disengaged", () => {
    const pacer = new WheelPagePacer();
    // Two deliberate notches just inside the window are not fast paging...
    expect(pacer.record(1, "y", 0)).toBe(false);
    expect(pacer.record(1, "y", FAST_PAGING_WINDOW_MS - 1)).toBe(false);
    // ...and once the first flip leaves the window only one page remains.
    expect(pacer.record(1, "y", 2 * FAST_PAGING_WINDOW_MS)).toBe(false);
    expect(pacer.engaged).toBe(false);
  });

  it("expires pages out of the trailing window by their arrival time", () => {
    const pacer = new WheelPagePacer();
    pacer.record(FAST_PAGING_PAGES, "y", 0);
    expect(pacer.engaged).toBe(true);
    // Every page of the burst is now older than the window.
    expect(pacer.record(1, "y", FAST_PAGING_WINDOW_MS + 1)).toBe(false);
    expect(pacer.engaged).toBe(false);
  });

  it("never engages on horizontal flips", () => {
    const pacer = new WheelPagePacer();
    for (let index = 0; index < 6; index += 1) {
      expect(pacer.record(1, "x", index * 100)).toBe(false);
    }
    expect(pacer.engaged).toBe(false);
  });

  it("counts every page of a merged burst, not just the event", () => {
    const pacer = new WheelPagePacer();
    expect(pacer.record(2, "y", 0)).toBe(false);
    expect(pacer.record(1, "y", 100)).toBe(true);
  });

  it("drops stale engagement when the view collapses the rail", () => {
    const pacer = new WheelPagePacer();
    pacer.record(FAST_PAGING_PAGES, "y", 0);
    pacer.end();
    expect(pacer.record(1, "y", 50)).toBe(false);
    expect(pacer.engaged).toBe(false);
  });
});
