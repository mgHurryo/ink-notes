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

describe("DesktopWheelGesture blocked-window stamped stall merge", () => {
  // A blocked-window re-arm fires on a jump-shaped sample that a main-thread
  // stall merge stamped at delivery cadence produces too - the two are
  // indistinguishable at the single-sample level. The unblocked exit freezes
  // such a sample for one beat and lets the next sample's slope decide; the
  // blocked exit used to re-arm in-frame, so the same physical sweep's
  // inertial tail (the 12/10/9 continuation below) rode a fresh page budget
  // and flipped a third page.
  function pagesAcrossBlockedWindowStampedMerge(): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 0;
    const feed = (magnitudes: number[]) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += 10;
      }
    };
    feed([140, 30, 20, 12]); // fast phase: one page; the tail decays
    feed([50, 45, 170]); // re-sweep: the unblocked jump freezes, the held 45 confirms, the 170 flips the second page
    feed([20, 16, 13]); // the renewed gesture's tail: the block is active from here
    feed([45]); // stamped stall merge inside the block: 45 >= max(24, 2.2 * 13)
    feed([12, 10, 9, 12, 10, 9, 12, 10, 9, 12, 10, 9]); // the same sweep's tail continuation
    return pages;
  }

  it("keeps a blocked-window stamped stall merge from re-arming", () => {
    expect(pagesAcrossBlockedWindowStampedMerge()).toBe(2);
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

  // A deliberate re-swipe accelerates: the hand cannot step from the settled
  // tail straight to its fast phase, so the ramp crosses the (4, 12)px/10ms
  // band on the way up. Every ramp sample re-writes the raw magnitude with
  // its own speed, so the settled gate must read the envelope that only
  // decays - the raw-only gate died on the first mid-band sample and
  // swallowed the whole re-swipe.
  function pagesAcrossRampReswipe(quietGapMs: number, axis: "x" | "y" = "y"): number {
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
    at += quietGapMs;
    feed(Array.from({ length: 12 }, (_, i) => 1.25 * (i + 1)), 10); // 120ms linear ramp 0 -> 15px/10ms
    feed(Array.from({ length: 30 }, () => 15), 10); // fast phase holds 15px/10ms
    return pages;
  }

  it("rearms a vertical re-swipe that ramps up through the settled band", () => {
    expect(pagesAcrossRampReswipe(0)).toBe(2);
  });

  it("keeps the ramped horizontal re-swipe to the one page its contact already flipped", () => {
    expect(pagesAcrossRampReswipe(0, "x")).toBe(1);
  });

  it("rearms the same ramp after a 200ms silence delivered in integral deltas", () => {
    // A real trackpad resumes an integral stream: the first ramp sample
    // rounds to zero (a paused tail, frozen for one sample), the rest climbs
    // 2px per sample to the same 15px/10ms fast phase.
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 0;
    const feed = (magnitudes: number[]) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += 10;
      }
    };
    feed([140, 90, 60, 30, 20, 14]); // fast phase: one page
    feed([10, 8, 6, 4, 3, 3, 2]); // inertia tail settles at the release level
    at += 200; // a real pause past the idle boundary, not the 55ms quiet gap
    feed([0, 2, 4, 6, 8, 10, 12, 14, 15]); // integral ramp up to 15px/10ms
    feed(Array.from({ length: 30 }, () => 15)); // fast phase holds 15px/10ms
    expect(pages).toBe(2);
  });
});

describe("DesktopWheelGesture ramp reswipe travel across reporting cadences", () => {
  // #320 normalized the ramp accumulator to speeds (px per 10ms) but kept
  // comparing it against the raw-px page thresholds, so the real distance a
  // reswiping hand had to cover before the page flipped drifted with the
  // reporting cadence: an 8ms stream flipped near 80px while a 16ms stream
  // needed ~200px, and a merged sample was under-counted by gap/10. The
  // accumulator counts raw px again (the peak stays a normalized speed), so
  // the same physical acceleration must flip after ~100px of real travel at
  // every cadence. The exact crossing distance still varies within one
  // sample's raw delta - the flip fires on the sample that crosses the
  // threshold - which is the only cadence dependence left.
  function reswipeTravelAtFlip(cadenceMs: number): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 0;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += stepMs;
      }
    };
    feed([140, 90, 60, 30, 20, 14], 10); // fast phase: the contact's one page
    feed([11, 9.5, 8.5, 7, 6.2, 6], 10); // inertia tail converges at ~6px/10ms, still hot
    at += 200; // silence across the idle boundary: the resume lands at gap 200ms
    // The same physical acceleration at every cadence: speeds rise 1.3x per
    // sample (clear of the >= 1.2x float boundary), and each sample's raw
    // delta is speed * cadence / 10. The first resume sample is the frozen
    // boundary sample whose raw travel seeds the ramp accumulator.
    const speeds = [5, 6.5, 8.45, 10.985, 14.28, 18.56, 24.13, 31.37, 40.78, 53];
    let travel = 0;
    for (const speed of speeds) {
      const magnitude = speed * cadenceMs / 10;
      travel += magnitude;
      pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
      at += cadenceMs;
      if (pages > 1) return travel;
    }
    return Number.NaN;
  }

  it("flips a ramped reswipe after the same real travel at 8, 10 and 16ms cadences", () => {
    for (const cadenceMs of [8, 10, 16]) {
      const travel = reswipeTravelAtFlip(cadenceMs);
      // The flip fires once the raw accumulator crosses the 100px page
      // threshold; the overshoot is bounded by the crossing sample's raw.
      expect(travel).toBeGreaterThanOrEqual(100);
      expect(travel).toBeLessThan(100 + 53 * cadenceMs / 10);
    }
  });
});

describe("DesktopWheelGesture settled-tail stall continuation", () => {
  // Below the hot-tail band the [1,50]ms delivery clamp returns, so a
  // 55-180ms stall's merged sample is judged at gap/50 of its true speed:
  // it used to outrun the settled envelope, reset the gesture and hand the
  // remaining tail travel a fresh contact whose budget flipped a second page
  // inside one physical contact. A rise the clamp alone manufactures must
  // freeze for one sample; the next sample's slope decides.
  function pagesAcrossSettledTailStall(axis: "x" | "y", stallGapMs: number, stallStampMs = stallGapMs): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        const delta = axis === "x" ? { x: magnitude, y: 0, mode: 0 } : { x: 0, y: magnitude, mode: 0 };
        pages += gesture.pageDelta(gesture.begin(delta, false, at), false);
        at += stepMs;
      }
    };
    // tau=300ms inertia tail: a sample reports the pixels its decaying speed
    // sweeps across the 10ms reporting window (v * 30 * (1 - e^(-10/300))).
    const windowPx = 30 * (1 - Math.exp(-10 / 300));
    const tail = (v0: number, count: number, elapsedMs = 0): number[] =>
      Array.from({ length: count }, (_, i) => v0 * Math.exp(-(elapsedMs + (i + 1) * 10) / 300) * windowPx);
    feed(axis === "x" ? [140, 90, 60, 40] : [140, 90, 60], 10); // fast phase: the contact's one page
    feed(tail(axis === "x" ? 10 : 11, 32), 10); // decays to ~3.4px/10ms, inside the settled band
    const tailSpeed = (axis === "x" ? 10 : 11) * Math.exp(-320 / 300);
    if (stallGapMs > 0) {
      // One merged event sums the pixels the stalled tail swept across the
      // real gap. stallStampMs delivers it with a shorter stamp (the gap the
      // delivery cadence claims, AppKit-style), so the event lies about the
      // stall it merged while the tail itself still decays across the real
      // stall duration.
      at += stallStampMs - 10;
      const mergedPx = tailSpeed * 30 * (1 - Math.exp(-stallGapMs / 300));
      const delta = axis === "x" ? { x: mergedPx, y: 0, mode: 0 } : { x: 0, y: mergedPx, mode: 0 };
      const merged = gesture.begin(delta, false, at);
      // The merged event must land exactly stallStampMs after the last tail
      // sample; an off-by-10ms timestamp once read the wrong side of the
      // 180ms idle boundary.
      expect(merged.gap).toBe(stallStampMs);
      pages += gesture.pageDelta(merged, false);
      at += 10;
      feed(tail(tailSpeed, 70, stallGapMs), 10); // continuation to exhaustion
    } else {
      feed(tail(tailSpeed, 71), 10);
    }
    return pages;
  }

  it("keeps a horizontal settled-tail stall continuation to its contact's one page", () => {
    expect(pagesAcrossSettledTailStall("x", 100)).toBe(1);
  });

  it("keeps the vertical mirror of the settled-tail stall to one page", () => {
    expect(pagesAcrossSettledTailStall("y", 100)).toBe(1);
  });

  it("keeps the same tail delivered without a stall to one page", () => {
    expect(pagesAcrossSettledTailStall("x", 0)).toBe(1);
  });

  it("keeps a 40ms stall under the quiet-gap threshold to one page", () => {
    expect(pagesAcrossSettledTailStall("x", 40)).toBe(1);
  });

  it("pins a 178ms stall just under the idle boundary to one page", () => {
    expect(pagesAcrossSettledTailStall("y", 178)).toBe(1);
  });

  it("pins a 179ms stall to one page on the horizontal mirror", () => {
    expect(pagesAcrossSettledTailStall("x", 179)).toBe(1);
  });

  it("keeps a 180ms stall at the idle boundary to one page", () => {
    expect(pagesAcrossSettledTailStall("y", 180)).toBe(1);
  });

  it("keeps a 181ms stall past the idle boundary to one page", () => {
    expect(pagesAcrossSettledTailStall("x", 181)).toBe(1);
  });

  it("keeps a 189ms stall past the idle boundary to one page", () => {
    expect(pagesAcrossSettledTailStall("x", 189)).toBe(1);
  });

  it("keeps a 250ms stall to one page on the vertical mirror", () => {
    expect(pagesAcrossSettledTailStall("y", 250)).toBe(1);
  });

  // Stamped delivery (the merged event carries a delivery-cadence gap instead
  // of its real stall gap): the clamp then reads the merge at gap/50 of its
  // true speed, so a 100ms merge stamped at 0-10ms clears the settledRise
  // floor and re-arms through the jump exit, and stamped at 55ms it outruns
  // the settled envelope on "real-gap" speed alone and resets through the
  // quiet-gap exit. Both mint a fresh contact the resumed tail pages on. The
  // mid-band stamp stays blocked by the 12px settledRise floor (pinned), and
  // the horizontal contact keeps its single page across every stamp because
  // contactXPages survives a re-arm (its asymmetry with the y axis pinned).
  it("keeps a settled-tail stall merge stamped at delivery cadence to one page (0ms)", () => {
    expect(pagesAcrossSettledTailStall("y", 100, 0)).toBe(1);
  });

  it("keeps a settled-tail stall merge stamped at delivery cadence to one page (10ms)", () => {
    expect(pagesAcrossSettledTailStall("y", 100, 10)).toBe(1);
  });

  it("keeps a settled-tail stall merge stamped inside the mid band to one page (30ms)", () => {
    expect(pagesAcrossSettledTailStall("y", 100, 30)).toBe(1);
  });

  it("keeps a settled-tail stall merge stamped just past the quiet gap to one page (55ms)", () => {
    expect(pagesAcrossSettledTailStall("y", 100, 55)).toBe(1);
  });

  it("keeps every stamped delivery of a horizontal stall merge to one page", () => {
    for (const stamp of [0, 10, 30, 55]) expect(pagesAcrossSettledTailStall("x", 100, stamp)).toBe(1);
  });
});

describe("DesktopWheelGesture stamped tropical stall merge", () => {
  // A tail converging just above the release floor (~4.8px/10ms) is still hot
  // (unclamped): its merged samples are judged at their stamp's real gap, so
  // the settled-band clamp defense never applies. A 100ms merge (~41px)
  // stamped at 15ms lands in the jump band and stamped at 70ms rises over the
  // envelope through the quiet-gap exit - both re-armed and minted a fresh
  // budget the resumed tail pages on. Delivered at its real gap the merge
  // stays inside the envelope (anti-overfix control).
  function pagesAcrossTropicalStallMerge(stampGapMs: number): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += stepMs;
      }
    };
    const windowPx = 30 * (1 - Math.exp(-10 / 300));
    feed([140, 90, 60], 10); // fast phase: the contact's one page
    const tailSpeed = 14 * Math.exp(-320 / 300); // converges at ~4.8px/10ms, above the release floor
    feed(Array.from({ length: 32 }, (_, i) => 14 * Math.exp(-(i + 1) * 10 / 300) * windowPx), 10);
    at += stampGapMs - 10;
    const mergedPx = tailSpeed * 30 * (1 - Math.exp(-100 / 300));
    const merged = gesture.begin({ x: 0, y: mergedPx, mode: 0 }, false, at);
    expect(merged.gap).toBe(stampGapMs);
    pages += gesture.pageDelta(merged, false);
    at += 10;
    feed(Array.from({ length: 70 }, (_, i) => tailSpeed * Math.exp(-(100 + (i + 1) * 10) / 300) * windowPx), 10);
    return pages;
  }

  it("keeps a tropical stall merge stamped in the jump band to one page (15ms)", () => {
    expect(pagesAcrossTropicalStallMerge(15)).toBe(1);
  });

  it("keeps a tropical stall merge stamped past the quiet gap to one page (70ms)", () => {
    expect(pagesAcrossTropicalStallMerge(70)).toBe(1);
  });

  it("keeps the same merge delivered at its real gap to one page (100ms)", () => {
    expect(pagesAcrossTropicalStallMerge(100)).toBe(1);
  });
});

describe("DesktopWheelGesture hot-tail stall continuation", () => {
  // A tail whose envelope converged above the 4px release floor is still hot:
  // its >=180ms stall merge arrives at the true gap (unclamped), and the
  // merged amplitude itself (envelope * 30 * (1 - e^(-gap/300))) clears the
  // 100px page threshold in one sample. The idle-boundary reset used to arm
  // a fresh contact for it, so the remaining tail flipped a second page -
  // the "one swipe, many pages" family past the settled band.
  function pagesAcrossHotTailStall(stallGapMs: number): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += stepMs;
      }
    };
    feed([140, 90, 60, 30, 20, 14], 10); // fast phase: one page
    feed([11, 9.5, 8.5, 8.2, 8], 10); // tail converges at ~8px/10ms, above the release floor
    at += stallGapMs - 10;
    // The merged event sweeps envelope * 30 * (1 - e^(-gap/300)) pixels:
    // 116.8px at a 200ms stall, 135.7px at 250ms.
    const mergedPx = 8 * 30 * (1 - Math.exp(-stallGapMs / 300));
    const merged = gesture.begin({ x: 0, y: mergedPx, mode: 0 }, false, at);
    expect(merged.gap).toBe(stallGapMs);
    pages += gesture.pageDelta(merged, false);
    at += 10;
    feed(Array.from({ length: 40 }, (_, i) => 8 * Math.exp(-(stallGapMs + (i + 1) * 10) / 300)), 10);
    return pages;
  }

  it("keeps a 200ms stall of a still-hot tail to one page", () => {
    expect(pagesAcrossHotTailStall(200)).toBe(1);
  });

  it("keeps a 250ms stall of a still-hot tail to one page", () => {
    expect(pagesAcrossHotTailStall(250)).toBe(1);
  });
});

describe("DesktopWheelGesture hot-tail quiet-gap re-flick", () => {
  // A re-touch truncates the inertia tail while it is still hot (the envelope
  // sits above the 4px release floor), and the re-flick lands 55-179ms later.
  // The real delivery gap crushes that first sample under the envelope (the
  // hot tail divides by the true gap with no clamp), the ramp detector seeds
  // from it, and the constant fast phase forms exactly one >=1.2x rise - the
  // second rise the page flip demands never comes, so the page (and the
  // native scroll with it) was swallowed at any speed. The jump-shaped fast
  // phase must re-arm through the deferred exit instead.
  function pagesAcrossHotTailReflick(tail: number[], gapMs: number, fastPx: number): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs = 10) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += stepMs;
      }
    };
    feed(tail); // fast phase: the contact's one page; the tail is still hot
    at += gapMs - 10; // the re-flick's first sample lands gapMs after the tail
    feed(Array.from({ length: 10 }, () => fastPx)); // constant-velocity fast phase
    return pages;
  }

  it("rearms a 140px/10ms re-flick after a 120ms gap over a hot tail", () => {
    expect(pagesAcrossHotTailReflick([140, 90, 60, 30, 20, 15], 120, 140)).toBe(2);
  });

  it("rearms a 30px/10ms re-flick after a 120ms gap over a hot tail", () => {
    expect(pagesAcrossHotTailReflick([140, 90, 60, 30, 20], 120, 30)).toBe(2);
  });

  it("rearms a 40px/10ms re-flick after a 60ms reporting gap mid-tail", () => {
    expect(pagesAcrossHotTailReflick([140, 90, 60, 45, 40], 60, 40)).toBe(2);
  });

  it("rearms a 30px/10ms re-flick after a 200ms gap over a hot tail", () => {
    // The >=180ms boundary freeze demanded the 2.2x jump ratio of the same
    // medium constant-velocity re-sweep; the hot-envelope re-arm below the
    // jump ratio covers it - no reset and no fresh contact, the re-arm's
    // blocked window keeps guarding the budget against the tail continuation.
    expect(pagesAcrossHotTailReflick([140, 90, 60, 30, 20], 200, 30)).toBe(2);
  });
});

describe("DesktopWheelGesture plateau-tail stall merge", () => {
  // A plateau inertia tail (integer-quantized samples oscillating 11-13px at
  // delivery cadence) keeps the min-chain envelope parked at the tail speed,
  // so a real >=55ms stall merge normalized at its true gap lands at ~the
  // plateau speed: inside the stamping band, single-sample indistinguishable
  // from a re-swipe. The mirror arm's hold-0.6x confirmation then read the
  // plateau continuation (naturally flat at ~1.0x, ~1.08x at the ±1px jitter
  // ceiling) as the confirmation, reset() cast a fresh contact with a fresh
  // page budget and the residual tail flipped a phantom second page. The
  // reset flavor must demand a real rise instead.
  function pagesAcrossPlateauTailStall(axis: "x" | "y", stallGapMs: number, continuation?: number[]): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        const delta = axis === "x" ? { x: magnitude, y: 0, mode: 0 } : { x: 0, y: magnitude, mode: 0 };
        pages += gesture.pageDelta(gesture.begin(delta, false, at), false);
        at += stepMs;
      }
    };
    feed(Array.from({ length: 8 }, () => 20), 10); // fast phase: the contact's one page
    feed([12, 11, 12, 13, 11, 12, 12, 11, 12, 12], 10); // plateau tail parks the envelope at ~11px/10ms
    at += stallGapMs - 10;
    // One merged event sums the ~84px the stalled plateau swept across the
    // real gap; normalized at that real gap it sits at ~the plateau speed.
    const mergedDelta = axis === "x" ? { x: 84, y: 0, mode: 0 } : { x: 0, y: 84, mode: 0 };
    const merged = gesture.begin(mergedDelta, false, at);
    expect(merged.gap).toBe(stallGapMs);
    pages += gesture.pageDelta(merged, false);
    at += 10;
    feed(continuation ?? [12, 11, 12, 13, 11, 12, 12, 11, 12, 12, 12, 11, 12, 12], 10);
    return pages;
  }

  it.each([55, 70, 120, 179, 200, 300])("keeps a plateau-tail stall merge stamped at its real gap to one page (%sms)", (stallGapMs) => {
    expect(pagesAcrossPlateauTailStall("y", stallGapMs)).toBe(1);
  });

  it("keeps a plateau-tail stall merge on the x axis to its contact's one page", () => {
    expect(pagesAcrossPlateauTailStall("x", 70)).toBe(1);
  });

  it("keeps a single low-sample poisoning merge to one page", () => {
    // One 18px sample min-chains the fast phase's envelope down to 18; the
    // merged 140px sample normalized at its real 70ms gap (20px/10ms) then
    // sits inside the stamping band and the flat continuation confirmed the
    // forged reset exactly at the hold ratio (12 >= 20 * 0.6).
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += stepMs;
      }
    };
    feed([40, 40, 40, 40], 10); // fast phase: one page, envelope at 40
    feed([18], 10); // the single low sample poisons the envelope to 18
    at += 70 - 10;
    const merged = gesture.begin({ x: 0, y: 140, mode: 0 }, false, at);
    expect(merged.gap).toBe(70);
    pages += gesture.pageDelta(merged, false);
    at += 10;
    feed([12, 11, 12, 13, 11, 12, 12, 11, 12, 12, 12, 11, 12, 12], 10);
    expect(pages).toBe(1);
  });

  it("still flips a rising re-swipe after a plateau stall to its second page", () => {
    // Anti-overfix guard: the rejected merge sample has seeded the ramp
    // detector, so a genuinely rising re-swipe (>=1.2x steps) still re-arms
    // and flips the second page - two pages before and after the fix.
    expect(pagesAcrossPlateauTailStall("y", 70, [12, 20, 26, 32, 39])).toBe(2);
  });
});

describe("DesktopWheelGesture idle-boundary re-arm guard", () => {
  // Locks the freeze implementation of the >=180ms boundary: the boundary
  // first sample must go onto stall probation, never through to the ramp
  // detector - a boundary sample seeded into renewedPeak/renewedTravel makes
  // the deliberate re-sweep below crawl instead of re-arming on the next
  // sample's slope (an earlier revision of the boundary fix regressed these
  // to one page). Both tails stay at two pages: on y the slope judgment mints
  // a new contact whose budget flips the second page; on x the same reset
  // opens the second contact, which flips its own single page (the one-page-
  // per-contact contract).
  function pagesAcrossIdleBoundaryResweep(axis: "x" | "y", hot: boolean): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        const delta = axis === "x" ? { x: magnitude, y: 0, mode: 0 } : { x: 0, y: magnitude, mode: 0 };
        pages += gesture.pageDelta(gesture.begin(delta, false, at), false);
        at += stepMs;
      }
    };
    const windowPx = 30 * (1 - Math.exp(-10 / 300));
    feed(axis === "x" ? [140, 90, 60, 40] : [140, 90, 60], 10); // the contact's one page
    if (hot) {
      feed([11, 9.5, 8.5, 7, 6.2, 6], 10); // converges at ~6px/10ms, above the release floor
    } else {
      // tau=300ms tail decaying to just under the release floor (settled).
      const v0 = axis === "x" ? 10 : 11;
      feed(Array.from({ length: 32 }, (_, i) => v0 * Math.exp(-(i + 1) * 10 / 300) * windowPx), 10);
    }
    at += 200 - 10; // silence across the idle boundary: the re-sweep lands at gap 200ms
    feed(Array.from({ length: 30 }, (_, i) => 13 + (i % 5) * 2), 10);
    return pages;
  }

  it("rearms a deliberate re-sweep after 200ms over a settled tail (y)", () => {
    expect(pagesAcrossIdleBoundaryResweep("y", false)).toBe(2);
  });

  it("rearms a deliberate re-sweep after 200ms over a settled tail (x)", () => {
    expect(pagesAcrossIdleBoundaryResweep("x", false)).toBe(2);
  });

  it("rearms a deliberate re-sweep after 200ms over a hot tail (y)", () => {
    expect(pagesAcrossIdleBoundaryResweep("y", true)).toBe(2);
  });

  it("rearms a deliberate re-sweep after 200ms over a hot tail (x)", () => {
    expect(pagesAcrossIdleBoundaryResweep("x", true)).toBe(2);
  });
});

describe("DesktopWheelGesture idle-boundary reset for cadence-less envelopes", () => {
  // The >=180ms boundary freeze only protects a tail whose envelope was
  // earned at delivery cadence. When the frozen envelope was last written by
  // a same-tick flush or by a boundary delivery, it carries no tail-speed
  // evidence, and freezing behind it swallows whole re-swipes: a single-event
  // swipe has no follow-up sample to clear the probation, and each swallowed
  // swipe min-chains the envelope toward its own speed so identical repeats
  // freeze in an alternating pattern. These two shapes are the desktop-input
  // visual fixtures ("5 / 6" single-event bursts, "5 / 5" separate sync
  // flicks); both queue every destination across a save barrier.
  function bursts(count: number, gapMs = 320): number {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    for (let i = 0; i < count; i++) {
      pages += gesture.pageDelta(gesture.begin({ x: 150, y: 0, mode: 0 }, false, 10000 + i * gapMs), false);
    }
    return pages;
  }

  it("flips every single-event burst delivered past the idle boundary", () => {
    expect(bursts(4)).toBe(4);
  });

  it("flips every separate sync-dispatched flick past the idle boundary", () => {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    // One synchronous task hands a flick's six samples colliding timestamps;
    // the flicks themselves land ~200ms apart (real awaited gaps).
    for (const start of [10000, 10200, 10400]) {
      for (const magnitude of [140, 90, 60, 30, 10, 4]) {
        pages += gesture.pageDelta(gesture.begin({ x: magnitude, y: 0, mode: 0 }, false, start), false);
      }
    }
    expect(pages).toBe(3);
  });

  it("still freezes a cadence-earned tail merge at the boundary (stall contract)", () => {
    // Control: the same single-event gap, but the envelope behind it was
    // written by 10ms-cadence tail samples - the freeze must stay.
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], stepMs: number) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += stepMs;
      }
    };
    feed([140, 90, 60, 30, 20, 14], 10); // fast phase: one page
    feed([11, 9.5, 8.5, 8.2, 8], 10); // tail converges at ~8px/10ms
    at += 190;
    const merged = gesture.begin({ x: 0, y: 8 * 30 * (1 - Math.exp(-200 / 300)), mode: 0 }, false, at);
    expect(merged.gap).toBe(200);
    pages += gesture.pageDelta(merged, false);
    expect(pages).toBe(1);
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
    expect(flipCount([[0, 140], [0, 90], [10, 60], [15, 30], [25, 18], [30, 10], [40, 6], [45, 3]])).toBe(1);
  });

  it("keeps a diagonal arc to one page when its axis re-classifies mid-tail", () => {
    // Constant total speed, only the axis share shifts: the re-classification
    // must re-seed the surviving envelope to the new axis's own speed, or the
    // old axis's decayed envelope lets the y samples cross the jump threshold
    // and re-arm a second page out of the same physical flick.
    expect(flipCount([[140, 20], [90, 40], [60, 90], [30, 130], [20, 140], [14, 150], [10, 160]])).toBe(1);
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

  // A pause merged into a settled tail freezes the envelope in plain stall
  // probation (stallDeferral null). When the next sample re-classifies the
  // axis, the re-seed used to overwrite that frozen envelope with the
  // recovery sample's own speed, so the following sample cleared the
  // frozenSettled rise ratio, reset() minted a fresh page budget mid-tail
  // and the same flick's continuation flipped a ghost second page.
  function pagesAfterPausedDiagonalReseed(tail: number[], pauseMs: number, mergeY: number,
    diagonal: Array<[number, number]>, continuation: Array<[number, number]>): {
      pages: number;
      mergedProbation: boolean;
    } {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (x: number, y: number, stepMs: number) => {
      const motion = gesture.begin({ x, y, mode: 0 }, false, at);
      pages += gesture.pageDelta(motion, false);
      at += stepMs;
      return motion;
    };
    for (const magnitude of tail) feed(0, magnitude, 10);
    at += pauseMs;
    const merged = feed(0, mergeY, 10);
    for (const [x, y] of diagonal) feed(x, y, 10);
    for (const [x, y] of continuation) feed(x, y, 10);
    return { pages, mergedProbation: merged.probation === true };
  }

  it("keeps a stall-frozen settled tail at one page when a diagonal re-classifies the axis", () => {
    // The tail settles at 3px, the merged y=20 sample enters plain probation
    // and the frozen envelope must stay there: the (4,2) re-seed used to
    // overwrite it with 4, letting (5,2) clear the settled 1.2x rise ratio
    // and reset() into a fresh budget the 5px/10ms continuation spent.
    const { pages, mergedProbation } = pagesAfterPausedDiagonalReseed(
      [140, 90, 60, 30, 20, 14, 10, 8, 6, 5, 4, 3], 100, 20,
      [[4, 2], [5, 2]], Array.from({ length: 12 }, () => [5, 2] as [number, number]));
    expect(mergedProbation).toBe(true);
    expect(pages).toBe(1);
  });

  it("keeps a stall-frozen hot tail at one page when a diagonal re-classifies the axis", () => {
    // Hot envelope (8px, frozenSettled false): without the re-seed the (5,2)
    // judgment cannot even rise past it (5 > 8 is false), so a second page
    // here pins the ghost page on the re-seed alone.
    const { pages, mergedProbation } = pagesAfterPausedDiagonalReseed(
      [140, 90, 60, 30, 20, 14, 11, 9.5, 8.5, 8.2, 8], 200, 40,
      [[4, 2], [5, 2]], Array.from({ length: 12 }, () => [5, 2] as [number, number]));
    expect(mergedProbation).toBe(true);
    expect(pages).toBe(1);
  });

  it("still keeps a flat diagonal arc after the re-seed to one page", () => {
    // Control: the same hot envelope but a non-rising (4,2) arc - the
    // re-seed's original protection (a constant-rate arc must not re-arm
    // under the new axis) holds with and without the probation consumption.
    const { pages } = pagesAfterPausedDiagonalReseed(
      [140, 90, 60, 30, 20, 14, 11, 9.5, 8.5, 8.2, 8], 200, 40,
      Array.from({ length: 3 }, () => [4, 2] as [number, number]),
      Array.from({ length: 12 }, () => [4, 2] as [number, number]));
    expect(pages).toBe(1);
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

describe("DesktopWheelGesture swallowed slow scroll after a flick", () => {
  // The idle-boundary exemption keeps a flipped continuous gesture alive
  // across a >=180ms gap, and every escape hatch below it carries an absolute
  // floor (12px settledRise, 24px jump, the probation rise ratio), so a
  // same-direction slow continuation under 12px/10ms is swallowed forever:
  // no page and no native scroll (the caller preventDefaults on suppressed).
  // A steady slow scroll must eventually read as a new intent, while a
  // natural tau=300ms tail (which dwells below the 12px floor for at most
  // 300ms * ln(500 / 12) ~= 1119ms) must never trip the release.
  function pagesAcrossFlickTailThenSlowScroll(idleMs: number, steadyPx: number, steadyCount: number,
    steadyAt?: (index: number) => number): { pages: number; slowFlipAt: number | null } {
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    let slowFlipAt: number | null = null;
    const feed = (magnitudes: number[], stepMs = 10) => {
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        if (pages > 1 && slowFlipAt === null) slowFlipAt = at;
        at += stepMs;
      }
    };
    feed([140, 90, 60, 40, 25, 16, 10, 7, 5, 4, 3, 3]); // flick + tail settling at 3px/10ms
    at += idleMs;
    feed(Array.from({ length: steadyCount }, (_, i) => steadyAt ? steadyAt(i) : steadyPx));
    return { pages, slowFlipAt };
  }
  const slowStartAt = (idleMs: number): number => 100 + 12 * 10 + idleMs; // after the 12 tail samples

  it("flips a second page when a slow scroll follows a flick tail across an idle gap", () => {
    // The reviewer's real-device probe: tail stops at 3px, 500ms idle, then a
    // steady 3px/10ms scroll - beta.13 flipped the page, the latch swallows it.
    expect(pagesAcrossFlickTailThenSlowScroll(500, 3, 1000).pages).toBe(2);
  });

  it("flips a second page when the slow scroll never idles", () => {
    // 5px/10ms for 4500px with no gap at all: the latch used to hold for the
    // whole stream because no exit has a time-based bound.
    expect(pagesAcrossFlickTailThenSlowScroll(0, 5, 900).pages).toBe(2);
  });

  it("releases the latch no earlier than a second into the slow scroll", () => {
    // A no-idle 3px/10ms stream: the release must not fire on the tail's own
    // dwell (the tail here counts ~60ms below the floor) - the second page
    // lands only after a full second of continuous slow samples.
    const { pages, slowFlipAt } = pagesAcrossFlickTailThenSlowScroll(0, 3, 130);
    expect(pages).toBeGreaterThanOrEqual(2);
    expect(slowFlipAt).not.toBeNull();
    expect(slowFlipAt! - slowStartAt(0)).toBeGreaterThanOrEqual(1000);
  });

  it("restarts the latch clock across a quiet gap inside the slow scroll", () => {
    // The same stream with a >=55ms pause at 600ms: the pause is a gesture
    // boundary for the latch, so the remaining slow samples must not flip
    // early.
    const gesture = new DesktopWheelGesture();
    let pages = 0;
    let at = 100;
    const feed = (magnitudes: number[], extraGapBefore = 0) => {
      at += extraGapBefore;
      for (const magnitude of magnitudes) {
        pages += gesture.pageDelta(gesture.begin({ x: 0, y: magnitude, mode: 0 }, false, at), false);
        at += 10;
      }
    };
    feed([140, 90, 60, 40, 25, 16, 10, 7, 5, 4, 3, 3]); // flick + tail settling at 3px/10ms
    feed(Array.from({ length: 60 }, () => 3)); // 600ms of slow scroll
    feed([3], 70); // a 70ms quiet gap restarts the latch clock
    feed(Array.from({ length: 69 }, () => 3)); // 690ms more - under the bound
    expect(pages).toBe(1);
  });

  it("keeps a decaying continuation after an idle gap to one page", () => {
    // Momentum shape across the boundary: resumes at the envelope and decays
    // to ~0.8x over a finite tail - no rise for the boundary judgment and no
    // 1200ms of dwell for the latch (the guard pins #345/#346/#352).
    expect(pagesAcrossFlickTailThenSlowScroll(500, 3, 70, (i) => 3 - i * 0.01).pages).toBe(1);
  });

  it("releases a settled tail's 1.2x slow rise across the idle boundary", () => {
    // Tail stops at 3px, 500ms idle, then a steady 4px/10ms scroll: the
    // boundary freeze's one-shot judgment used to demand 2.2x (6.6px), so the
    // 4px continuation - momentum only in name, past the release floor - was
    // swallowed whole. A settled envelope has no tail speed left to protect.
    expect(pagesAcrossFlickTailThenSlowScroll(500, 4, 60).pages).toBe(2);
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

  it("does not let horizontal flips keep stale engagement alive", () => {
    const pacer = new WheelPagePacer();
    pacer.record(1, "y", 0);
    pacer.record(1, "y", 100);
    expect(pacer.record(1, "y", 200)).toBe(true);
    // A sideways stream must not pop the rail: every horizontal flip prunes
    // the window by its own arrival time, so aged-out vertical flips cannot
    // keep reporting engagement to the collapse timer.
    expect(pacer.record(1, "x", FAST_PAGING_WINDOW_MS + 100)).toBe(false);
    expect(pacer.record(1, "x", 2 * FAST_PAGING_WINDOW_MS + 100)).toBe(false);
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
