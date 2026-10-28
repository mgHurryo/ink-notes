import { describe, expect, it } from "vitest";

import { DesktopWheelGesture, type WheelDelta } from "../src/desktop-wheel";

// Drive the pure gesture logic directly: one trackpad sample per 16ms frame,
// never natively scrolled, so accumulated page travel is what flips pages.
function flipCount(deltas: number[], axis: "x" | "y" = "x"): number {
  const gesture = new DesktopWheelGesture();
  let pages = 0;
  deltas.forEach((magnitude, i) => {
    const delta: WheelDelta = axis === "x"
      ? { x: magnitude, y: 0, mode: 0 }
      : { x: 0, y: magnitude, mode: 0 };
    pages += gesture.pageDelta(gesture.begin(delta, false, i * 16), false);
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
