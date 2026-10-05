import { describe, expect, it } from "vitest";
import type { InkPoint } from "../src/model";
import { optimizeStrokePoints } from "../src/stroke-geometry";

const SCALE = { scaleX: 1600, scaleY: 2200 };

function point(x: number, y: number, pressure = 0.5, tiltX?: number): InkPoint {
  return { x, y, pressure, tiltX, t: 0 };
}

function path(samples: Array<[number, number]>, pressure = 0.5): InkPoint[] {
  return samples.map(([x, y], index) => ({ ...point(x, y, pressure), t: index + 1 }));
}

/** Distance between two normalized points in page units. */
function spacing(a: InkPoint, b: InkPoint): number {
  return Math.hypot((a.x - b.x) * SCALE.scaleX, (a.y - b.y) * SCALE.scaleY);
}

/** Sum of absolute second differences in page units: a roughness proxy. */
function roughness(points: InkPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1];
    const point = points[index];
    const after = points[index + 1];
    total += Math.hypot(
      (before.x - 2 * point.x + after.x) * SCALE.scaleX,
      (before.y - 2 * point.y + after.y) * SCALE.scaleY,
    );
  }
  return total;
}

/** Largest deflection across interior vertices, in degrees (0 = straight, 180 = reversal). */
function sharpestTurn(points: InkPoint[]): number {
  let turn = 0;
  for (let index = 1; index < points.length - 1; index++) {
    const incomingX = (points[index].x - points[index - 1].x) * SCALE.scaleX;
    const incomingY = (points[index].y - points[index - 1].y) * SCALE.scaleY;
    const outgoingX = (points[index + 1].x - points[index].x) * SCALE.scaleX;
    const outgoingY = (points[index + 1].y - points[index].y) * SCALE.scaleY;
    const incomingLength = Math.hypot(incomingX, incomingY);
    const outgoingLength = Math.hypot(outgoingX, outgoingY);
    if (incomingLength === 0 || outgoingLength === 0) continue;
    const angle = Math.acos(Math.max(-1, Math.min(1,
      (incomingX * outgoingX + incomingY * outgoingY) / (incomingLength * outgoingLength))));
    turn = Math.max(turn, angle * 180 / Math.PI);
  }
  return turn;
}

describe("optimizeStrokePoints", () => {
  it("returns the input untouched when smoothing is disabled", () => {
    const points = path([[0.1, 0.1], [0.2, 0.2], [0.3, 0.1], [0.4, 0.2]]);
    const optimized = optimizeStrokePoints(points, { strength: 0, ...SCALE });
    expect(optimized).toEqual(points);
    expect(optimized).toBe(points);
  });

  it("leaves dots and two-point ticks byte-exact", () => {
    const dot = path([[0.5, 0.5]]);
    const tick = path([[0.5, 0.5], [0.52, 0.52]]);
    expect(optimizeStrokePoints(dot, { strength: 0.25, ...SCALE })).toEqual(dot);
    expect(optimizeStrokePoints(tick, { strength: 0.9, ...SCALE })).toEqual(tick);
  });

  it("keeps pen-down and pen-up samples exact on a noisy arc", () => {
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 40; index++) {
      const x = 0.2 + index * 0.015;
      const y = 0.3 + Math.sin(index / 4) * 0.004 + Math.sin(index * 7.3) * 0.0002;
      samples.push([x, y]);
    }
    const points = path(samples);
    const optimized = optimizeStrokePoints(points, { strength: 0.25, ...SCALE });
    expect(optimized[0]).toEqual(points[0]);
    expect(optimized[optimized.length - 1]).toEqual(points[points.length - 1]);
  });

  it("drops sub-threshold jitter while keeping the pen-up sample", () => {
    const samples: Array<[number, number]> = [];
    for (let index = 0; index < 40; index++) {
      // ~0.32 page-unit horizontal spacing with ~0.9 unit transversal noise.
      samples.push([0.2 + index * 0.0002, 0.4 + (index % 2 === 0 ? 0.0002 : -0.0002)]);
    }
    const points = path(samples);
    const optimized = optimizeStrokePoints(points, { strength: 0.25, ...SCALE });
    // Sub-threshold samples collapse to roughly one per 1.25 page units.
    expect(optimized.length).toBeLessThan(points.length / 2);
    expect(optimized[0]).toEqual(points[0]);
    expect(optimized[optimized.length - 1]).toEqual(points[points.length - 1]);
  });

  it("protects a right-angle corner that naive smoothing would round away", () => {
    const corner: [number, number] = [0.5, 0.3];
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 10; index++) {
      samples.push([0.5 - (10 - index) * 0.0125, 0.3 + Math.sin(index * 3.1) * 0.0006]);
    }
    for (let index = 1; index <= 10; index++) {
      samples.push([0.5 + Math.sin(index * 3.1) * 0.0006, 0.3 + index * 0.0125]);
    }
    const points = path(samples);
    const optimized = optimizeStrokePoints(points, { strength: 0.55, ...SCALE });

    const nearest = optimized.reduce((best, point) => {
      const distance = Math.hypot((point.x - corner[0]) * SCALE.scaleX, (point.y - corner[1]) * SCALE.scaleY);
      return distance < best.distance ? { distance, point } : best;
    }, { distance: Number.POSITIVE_INFINITY, point: optimized[0] });
    expect(nearest.distance).toBeLessThan(1.5);
    expect(sharpestTurn(optimized)).toBeGreaterThan(80);
    // Smoothing still happened elsewhere on the stroke.
    expect(optimized.some((point, index) => spacing(point, points[index]) > 0.01)).toBe(true);
  });

  it("keeps a hook tip and its sharp exit intact", () => {
    // Vertical stroke ending in the upward flick of a 竖勾.
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 12; index++) samples.push([0.5, 0.2 + index * 0.02]);
    samples.push([0.499, 0.436]);
    samples.push([0.495, 0.428]);
    const points = path(samples);
    const optimized = optimizeStrokePoints(points, { strength: 0.25, ...SCALE });

    const last = optimized[optimized.length - 1];
    expect(last).toEqual(points[points.length - 1]);
    const tailTurn = sharpestTurn(optimized.slice(-4));
    expect(tailTurn).toBeGreaterThan(120);
  });

  it("reduces roughness of gentle curves more than raw capture", () => {
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 40; index++) {
      const x = 0.2 + index * 0.015;
      const y = 0.3 + Math.sin(index / 4) * 0.004 + Math.sin(index * 7.3) * 0.0002;
      samples.push([x, y]);
    }
    const points = path(samples);
    const optimized = optimizeStrokePoints(points, { strength: 0.25, ...SCALE });
    expect(roughness(optimized)).toBeLessThan(roughness(points));
  });

  it("smooths harder as the configured strength rises", () => {
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 40; index++) {
      samples.push([0.2 + index * 0.015, 0.3 + Math.sin(index / 4) * 0.004 + Math.sin(index * 7.3) * 0.0002]);
    }
    const points = path(samples);
    const gentle = optimizeStrokePoints(points, { strength: 0.25, ...SCALE });
    const strong = optimizeStrokePoints(points, { strength: 0.9, ...SCALE });
    expect(roughness(strong)).toBeLessThan(roughness(gentle));
  });

  it("protects deliberate corners even at maximum strength", () => {
    const corner: [number, number] = [0.5, 0.3];
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 10; index++) {
      samples.push([0.5 - (10 - index) * 0.0125, 0.3 + Math.sin(index * 3.1) * 0.0006]);
    }
    for (let index = 1; index <= 10; index++) {
      samples.push([0.5 + Math.sin(index * 3.1) * 0.0006, 0.3 + index * 0.0125]);
    }
    const points = path(samples);
    const optimized = optimizeStrokePoints(points, { strength: 1, ...SCALE });

    const nearest = optimized.reduce((best, point) => {
      const distance = Math.hypot((point.x - corner[0]) * SCALE.scaleX, (point.y - corner[1]) * SCALE.scaleY);
      return distance < best.distance ? { distance, point } : best;
    }, { distance: Number.POSITIVE_INFINITY, point: optimized[0] });
    expect(nearest.distance).toBeLessThan(1.5);
    expect(sharpestTurn(optimized)).toBeGreaterThan(80);
  });

  it("preserves per-sample pressure, tilt and timestamps by position", () => {
    const points = path([[0.3, 0.3], [0.4, 0.3], [0.5, 0.3], [0.6, 0.3], [0.7, 0.3]]);
    points[2].pressure = 0.9;
    points[1].tiltX = 0.25;
    points[3].tiltY = -0.4;
    const optimized = optimizeStrokePoints(points, { strength: 0.25, ...SCALE });
    expect(optimized.map((point) => point.t)).toEqual(points.map((point) => point.t));
    expect(optimized[0].tiltX).toBeUndefined();
    expect(optimized[1].tiltX).toBe(0.25);
    expect(optimized[3].tiltY).toBe(-0.4);
    expect(optimized.every((point) => point.pressure >= 0.05 && point.pressure <= 1)).toBe(true);
  });

  it("scales sample spacing with the nib width", () => {
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 30; index++) {
      // ~4.8 page-unit spacing: real detail for a hairline, redundancy for a highlighter.
      samples.push([0.2 + index * 0.003, 0.3 + Math.sin(index) * 0.001]);
    }
    const points = path(samples);
    const hairline = optimizeStrokePoints(points, { strength: 0.5, ...SCALE, nibWidth: 1 });
    const wide = optimizeStrokePoints(points, { strength: 0.5, ...SCALE, nibWidth: 18 });
    expect(hairline.length).toBe(points.length);
    expect(wide.length).toBeLessThan(points.length);
  });

  it("protects the same hook at small and large handwriting sizes", () => {
    const buildHook = (scale: number): InkPoint[] => {
      const samples: Array<[number, number]> = [];
      const step = 0.02 * scale;
      for (let index = 0; index <= 6; index++) samples.push([0.5, 0.3 + index * step]);
      samples.push([0.5 - 0.003 * scale, 0.3 + 6 * step - 0.004 * scale]);
      samples.push([0.5 - 0.007 * scale, 0.3 + 6 * step - 0.012 * scale]);
      return path(samples);
    };
    for (const scale of [0.5, 3]) {
      const optimized = optimizeStrokePoints(buildHook(scale), { strength: 0.25, ...SCALE });
      expect(sharpestTurn(optimized)).toBeGreaterThan(100);
    }
  });

  it("is deterministic for identical input", () => {
    const samples: Array<[number, number]> = [];
    for (let index = 0; index <= 20; index++) samples.push([0.2 + index * 0.02, 0.3 + Math.sin(index) * 0.003]);
    const points = path(samples);
    expect(optimizeStrokePoints(points, { strength: 0.25, ...SCALE }))
      .toEqual(optimizeStrokePoints(points, { strength: 0.25, ...SCALE }));
  });
});
