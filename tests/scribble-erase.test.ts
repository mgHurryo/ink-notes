import { describe, expect, it } from "vitest";
import { eraseStrokeSegmentsByScribble, isScribbleEraseGesture } from "../src/ink-writing";
import type { InkStroke } from "../src/model";
import { rotateScribble, scribbleLoops, scribbleWaves, type ScribblePosition } from "./scribble-fixtures";

function recognize(path: ScribblePosition[], sensitivity = 25, duration = 1_200, width = 100, height = 100): boolean {
  return isScribbleEraseGesture(path.map((point, index) => ({
    x: point.x / width, y: point.y / height, pressure: .5, t: 1_000 + duration * index / (path.length - 1),
  })), 24, width, height, sensitivity);
}

describe("deliberate scribble shapes", () => {
  it.each([0, 22.5, 45, 70, 90, 135, 180, 270])("recognizes dense loops and waves rotated by %s degrees", (angle) => {
    for (const path of [scribbleLoops(), scribbleLoops(4, 0), scribbleWaves()]) {
      expect(recognize(rotateScribble(path, angle))).toBe(true);
    }
  });

  it.each([16, 48, 120, 240])("recognizes smooth marks at %s samples per cycle with subpixel jitter", (samples) => {
    for (const path of [scribbleLoops(4, 6, samples), scribbleWaves(5, 30, samples)]) {
      expect(recognize(path)).toBe(true);
      expect(recognize(path.map((p, index) => ({ x: p.x + .2 * Math.sin(index), y: p.y + .2 * Math.cos(index) })))).toBe(true);
    }
  });

  it("recognizes repeated figure eights and irregular waves in a compact region", () => {
    const eight = Array.from({ length: 193 }, (_, i) => {
      const angle = i / 192 * 8 * Math.PI;
      return { x: 50 + 20 * Math.sin(2 * angle), y: 50 + 20 * Math.sin(angle) };
    });
    expect(recognize(eight)).toBe(true);
    const irregular = scribbleWaves().map((p, i) => ({ ...p, y: 50 + (p.y - 50) * (1 + .1 * Math.sin(i / 16)) }));
    expect(recognize(irregular)).toBe(true);
  });

  it("uses logical page geometry on rectangular pages", () => {
    for (const [width, height] of [[800, 1200], [1200, 800]]) {
      expect(recognize(scribbleLoops(), 25, 1200, width, height)).toBe(true);
      expect(recognize(rotateScribble(scribbleWaves(), 90), 25, 1200, width, height)).toBe(true);
    }
  });

  it("requires more smooth repetitions at low sensitivity", () => {
    const threeLoops = scribbleLoops(3, 0);
    expect(recognize(threeLoops, 0)).toBe(false);
    expect(recognize(threeLoops, 25)).toBe(false);
    expect(recognize(threeLoops, 100)).toBe(true);
    expect(recognize(scribbleLoops(4, 0), 0)).toBe(true);
  });

  it.each([
    { name: "single circle", path: scribbleLoops(1, 0) },
    { name: "two circles", path: scribbleLoops(2, 0) },
    { name: "single strike-through", path: [{ x: 20, y: 50 }, { x: 80, y: 50 }] },
    { name: "ordinary mathematical wave", path: scribbleWaves(5, 220) },
    { name: "cursive loops advancing along a line", path: scribbleLoops(4, 40) },
    { name: "cursive humps advancing along a line", path: scribbleWaves(4, 100) },
    { name: "small sensor oscillation", path: scribbleWaves().map((p) => ({ x: 50 + (p.x - 50) / 10, y: 50 + (p.y - 50) / 10 })) },
    { name: "two-turn outward spiral", path: Array.from({ length: 193 }, (_, i) => {
      const angle = i / 192 * 4 * Math.PI, radius = 2 + 18 * i / 192;
      return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
    }) },
    { name: "connected Chinese-style corners and hooks", path: [
      [20, 30], [45, 30], [30, 40], [55, 40], [40, 50], [65, 50], [50, 60], [75, 60],
    ].map(([x, y]) => ({ x, y })) },
  ])("preserves $name even at high sensitivity", ({ path }) => {
    for (const angle of [0, 45, 90]) expect(recognize(rotateScribble(path, angle), 100)).toBe(false);
  });

  it("preserves slow marks and rejects invalid timing", () => {
    expect(recognize(scribbleLoops(), 100, 2_500)).toBe(false);
    expect(recognize(scribbleWaves(), 100, -1)).toBe(false);
    expect(recognize([])).toBe(false);
  });
});

describe("local scribble clipping", () => {
  const line: InkStroke = { id: "long-line", pageId: "page", tool: "pen", color: "#000", width: 3, opacity: 1, createdAt: 1, updatedAt: 1,
    points: [{ x: .1, y: .5, pressure: .2, t: 100, tiltX: 10, tiltY: 20 }, { x: .9, y: .5, pressure: .8, t: 200, tiltX: 30, tiltY: 40 }] };
  const points = (path: ScribblePosition[]) => path.map((p, i) => ({ x: p.x / 100, y: p.y / 100, pressure: .5, t: i }));

  it("clips a sparse two-point stroke without connecting erased gaps or deleting either tail", () => {
    const original = structuredClone(line);
    const segments = eraseStrokeSegmentsByScribble(line, points(scribbleWaves(4, 50)), 2, 100, 100)!;
    expect(segments.length).toBeGreaterThan(2);
    expect(segments[0][0]).toEqual(line.points[0]);
    expect(segments.at(-1)!.at(-1)).toEqual(line.points[1]);
    for (let i = 1; i < segments.length; i++) expect(segments[i][0].x - segments[i - 1].at(-1)!.x).toBeGreaterThan(.02);
    for (const point of segments.flat()) {
      expect(point.pressure).toBeCloseTo(.2 + (point.x - .1) / .8 * .6);
      expect(point.t).toBeCloseTo(100 + (point.x - .1) / .8 * 100);
      expect(point.tiltX).toBeCloseTo(10 + (point.x - .1) / .8 * 20);
    }
    expect(line).toEqual(original);
  });

  it("leaves untouched points inside loop bounds and returns null for an unaffected stroke", () => {
    const dot = { ...line, points: [{ x: .35, y: .5, pressure: .5, t: 1 }] };
    expect(eraseStrokeSegmentsByScribble(dot, points(scribbleLoops(4, 0)), 2, 100, 100)).toBeNull();
    const nearby = { ...line, points: line.points.map((p) => ({ ...p, y: .74 })) };
    expect(eraseStrokeSegmentsByScribble(nearby, points(scribbleLoops(4, 0)), 2, 100, 100)).toBeNull();
  });

  it("deletes a dot that is actually covered, and respects hidden-layer exclusions", () => {
    const dot = { ...line, points: [{ x: .55, y: .5, pressure: .5, t: 1 }] };
    expect(eraseStrokeSegmentsByScribble(dot, points(scribbleLoops(4, 0)), 2, 100, 100)).toEqual([]);
    expect(eraseStrokeSegmentsByScribble(dot, points(scribbleLoops(4, 0)), 2, 100, 100, () => false)).toBeNull();
  });
});
