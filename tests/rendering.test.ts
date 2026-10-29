import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasResolution, drawInkStroke, drawInkStrokeTail, normalizePressureCurve, penOutline, smoothOutlineCenterline, smoothPenPressures } from "../src/rendering";
import { translatePoints } from "../src/ink-writing";
import type { InkStroke } from "../src/model";

function stroke(pressure = 0.5): InkStroke {
  return { id: "test", pageId: "page", tool: "pen", color: "#111111", width: 3, opacity: 0.5, createdAt: 1, updatedAt: 1,
    points: Array.from({ length: 100 }, (_, i) => ({ x: 0.1 + i * 0.008, y: 0.5, pressure, t: i })) };
}

function context(): CanvasRenderingContext2D {
  vi.stubGlobal("Path2D", class {
    moveTo = vi.fn();
    lineTo = vi.fn();
    quadraticCurveTo = vi.fn();
    closePath = vi.fn();
  });
  return { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    moveTo: vi.fn(), quadraticCurveTo: vi.fn(), lineTo: vi.fn() } as unknown as CanvasRenderingContext2D;
}

afterEach(() => vi.unstubAllGlobals());


describe("outline centerline smoothing", () => {
  const size = 12 * 0.925;

  function outlineOf(points: Array<[number, number]>): number[][] {
    return penOutline({
      ...stroke(), width: 12,
      points: points.map(([x, y], i) => ({ x: x / 100, y: y / 100, pressure: 0.5, t: i })),
    }, 100, 100,
    // These tests exercise the geometry engine at 1:1 nib scale in a 100px
    // canvas; pin the reference to the canvas so the canonical width
    // conversion stays out of the way.
    100);
  }

  it("keeps a deliberate long-segment corner sharp", () => {
    // 横折-style corner: long straight segments meeting at 90°.
    const outline = outlineOf([[10, 10], [30, 10], [50, 10], [50, 30], [50, 50]]);
    let minDistance = Infinity;
    for (const [x, y] of outline) minDistance = Math.min(minDistance, Math.hypot(x - 50, y - 10));
    // The outline must reach the corner vertex up to the stroke's half width;
    // a rounded corner would leave a much larger gap.
    expect(minDistance).toBeLessThan(size * 0.5 + 2);
  });

  it("rounds a sampled kink into a curve instead of a straight-line turn", () => {
    // A fast hook sampled a handful of times: short segments reversing
    // direction over ~15px. The kink vertices must move toward the local
    // chord (curve rendering), unlike a polyline render.
    // A flicked hook sampled at ~125Hz: ~5px segments turning ~60 degrees at
    // the reversal — what a writer perceives as a straight-line turn.
    const kink = [[0, 0], [5, 0.8], [10, 1.6], [14.4, 3.6], [17.2, 7.2], [18, 11.6], [17, 15.8], [14.2, 18.6], [10.4, 19.6], [6.4, 19]].map(([x, y]) => [x, y, 0.5]);
    const smoothed = smoothOutlineCenterline(kink, size);
    let maxShift = 0;
    for (let i = 1; i < kink.length - 1; i++) {
      maxShift = Math.max(maxShift, Math.hypot(smoothed[i][0] - kink[i][0], smoothed[i][1] - kink[i][1]));
    }
    expect(maxShift).toBeGreaterThan(1);
  });

  it("leaves long-segment corner vertices exactly in place", () => {
    const corner = [[10, 10], [30, 10], [50, 10], [50, 30], [50, 50]].map(([x, y]) => [x, y, 0.5]);
    const smoothed = smoothOutlineCenterline(corner, size);
    expect(smoothed).toEqual(corner);
  });

  it("never moves the stroke endpoints", () => {
    const points: Array<[number, number]> = [[10, 10], [14, 12], [18, 14], [21, 17], [23, 21]];
    const outline = outlineOf(points);
    const start = points[0], end = points[points.length - 1];
    const minStart = Math.min(...outline.map(([x, y]) => Math.hypot(x - start[0], y - start[1])));
    const minEnd = Math.min(...outline.map(([x, y]) => Math.hypot(x - end[0], y - end[1])));
    expect(minStart).toBeLessThan(size * 0.5 + 2);
    expect(minEnd).toBeLessThan(size * 0.5 + 2);
  });
});


describe("pen dynamics", () => {
  const size = 12 * 0.925;

  function dynamicsStroke(points: number[][], dynamics: { taper?: number; pressure?: number; speed?: number }): number[][] {
    return penOutline({
      ...stroke(), width: 12, points: points.map(([x, y, p, t]) => ({ x: x / 100, y: y / 100, pressure: p, t })),
      dynamics,
    }, 100, 100, 100);
  }

  function thicknessAt(outline: number[][], xLow: number, xHigh: number): number {
    const band = outline.filter(([x]) => x >= xLow && x <= xHigh).map(([, y]) => y);
    return Math.max(...band) - Math.min(...band);
  }

  it("taper 100 ends the stroke in a point instead of a round cap", () => {
    const line = [[10, 50, 0.6, 0], [40, 50, 0.6, 8], [70, 50, 0.6, 16], [90, 50, 0.6, 24]];
    const round = dynamicsStroke(line, {});
    const sharp = dynamicsStroke(line, { taper: 100 });
    const roundEnd = Math.min(...round.map(([x, y]) => Math.hypot(x - 90, y - 50)));
    const sharpEnd = Math.min(...sharp.map(([x, y]) => Math.hypot(x - 90, y - 50)));
    // The round cap reaches the endpoint at half-width; the tapered tip lands on it.
    expect(roundEnd).toBeLessThan(size * 0.5 + 2);
    expect(sharpEnd).toBeLessThan(1);
  });

  it("taper 0 keeps round caps", () => {
    const line = [[10, 50, 0.6, 0], [40, 50, 0.6, 8], [70, 50, 0.6, 16], [90, 50, 0.6, 24]];
    const round = dynamicsStroke(line, {});
    const roundEnd = Math.min(...round.map(([x, y]) => Math.hypot(x - 90, y - 50)));
    expect(roundEnd).toBeLessThan(size * 0.5 + 2);
    expect(roundEnd).toBeGreaterThan(size * 0.2);
  });

  it("pressure limiter 0 renders uniform width", () => {
    const varied = [[10, 50, 0.1, 0], [40, 50, 0.9, 8], [70, 50, 0.1, 16], [90, 50, 0.9, 24]];
    const uniform = dynamicsStroke(varied, { pressure: 0 });
    const thick = dynamicsStroke(varied, { pressure: 100 });
    const uniformSpread = thicknessAt(uniform, 20, 80);
    const thickSpread = thicknessAt(thick, 20, 80);
    // Uniform: every point at effective pressure 0.5 → 12 * (0.55 + 0.375).
    expect(uniformSpread).toBeCloseTo(12 * 0.925, 1);
    // Full dynamics: pressures 0.1/0.9 span the thinning range.
    expect(thickSpread).toBeCloseTo(12 * 1.225, 1);
    expect(thickSpread).toBeGreaterThan(uniformSpread);
  });

  it("speed compensation thins fast segments", () => {
    // Same geometry: slow tail samples vs a fast middle (timestamps compress).
    const fast = [[10, 50, 0.5, 0], [40, 50, 0.5, 4], [70, 50, 0.5, 8], [90, 50, 0.5, 11]];
    const off = dynamicsStroke(fast, { speed: 0 });
    const on = dynamicsStroke(fast, { speed: 100 });
    const offSpread = thicknessAt(off, 35, 65);
    const onSpread = thicknessAt(on, 35, 65);
    expect(onSpread).toBeLessThan(offSpread);
  });

  it("lasso translate keeps sample timestamps so the speed profile survives", () => {
    // A stroke written at an uneven pace: slow head, compressed fast tail.
    const line = [[10, 50, 0.5, 0], [40, 50, 0.5, 8], [70, 50, 0.5, 10], [90, 50, 0.5, 11]];
    const points = line.map(([x, y, p, t]) => ({ x: x / 100, y: y / 100, pressure: p, t }));
    const moved = translatePoints(points, 0.2, 0.1);
    // Translation is an isometry; sampled timing is metadata, not geometry.
    expect(moved.map((point) => point.t)).toEqual([0, 8, 10, 11]);
    // The moved stroke must render pixel-identical to the un-moved one;
    // resetting every t degenerates the speed profile into a distance
    // profile and fattens the thin fast tail.
    const before = penOutline({ ...stroke(), width: 12, points, dynamics: { speed: 100 } }, 100, 100, 100);
    const after = penOutline({ ...stroke(), width: 12, points: moved, dynamics: { speed: 100 } }, 100, 100, 100);
    expect(thicknessAt(after, 92, 112)).toBeCloseTo(thicknessAt(before, 72, 92), 6);
  });

  it("speed compensation still thins the fast tail after a lasso translate", () => {
    const line = [[10, 50, 0.5, 0], [40, 50, 0.5, 8], [70, 50, 0.5, 10], [90, 50, 0.5, 11]];
    const moved = translatePoints(line.map(([x, y, p, t]) => ({ x: x / 100, y: y / 100, pressure: p, t })), 0.2, 0.1);
    const tuples = moved.map(({ x, y, pressure, t }) => [x * 100, y * 100, pressure, t]);
    const off = dynamicsStroke(tuples, { speed: 0 });
    const on = dynamicsStroke(tuples, { speed: 100 });
    // Probe the discs at the stroke head (x=30 after the translate) and the
    // fast tail (x=110), each band fully containing one disc.
    const onFast = thicknessAt(on, 105, 115);
    expect(onFast).toBeLessThan(thicknessAt(off, 105, 115));
    // ...and ends up thinner than the slow head, not fatter.
    expect(onFast).toBeLessThan(thicknessAt(on, 25, 35));
  });

  it("defaults preserve the historical diameter", () => {
    const line = [[10, 50, 0.5, 0], [40, 50, 0.5, 8], [70, 50, 0.5, 16], [90, 50, 0.5, 24]];
    const outline = dynamicsStroke(line, {});
    expect(thicknessAt(outline, 20, 80)).toBeCloseTo(12 * (0.55 + 0.75 * 0.5), 1);
  });
});


describe("dynamics refinement", () => {
  function thicknessAt(outline: number[][], xLow: number, xHigh: number): number {
    const band = outline.filter(([x]) => x >= xLow && x <= xHigh).map(([, y]) => y);
    return Math.max(...band) - Math.min(...band);
  }

  function strokeWith(points: number[][], dynamics: { taper?: number; pressure?: number; speed?: number; pressureCurve?: number[][] }): number[][] {
    return penOutline({
      ...stroke(), width: 12, points: points.map(([x, y, p, t]) => ({ x: x / 100, y: y / 100, pressure: p, t })),
      dynamics,
    }, 100, 100, 100);
  }

  function endCapRadius(outline: number[][], endX: number, endY: number): number {
    return Math.min(...outline.map(([x, y]) => Math.hypot(x - endX, y - endY)));
  }


  it("lets pressure widen the tapered region instead of pinning it thin", () => {
    // Same geometry and taper; the light-press tail fades to 0.15, the
    // firm-press tail holds 0.8. The taper shapes both into cones, but the
    // firm cone must stay clearly fatter along the ramp.
    const tail = (pressure: number): number[][] => [
      [10, 50, pressure, 0], [40, 50, pressure, 8], [65, 50, pressure, 16],
      [82, 50, pressure, 22], [93, 50, pressure, 26],
    ];
    const light = strokeWith(tail(0.15), { taper: 100 });
    const firm = strokeWith(tail(0.8), { taper: 100 });
    // Sample the cone mid-ramp (the last quarter of the stroke length).
    const lightThickness = thicknessAt(light, 80, 90);
    const firmThickness = thicknessAt(firm, 80, 90);
    expect(firmThickness).toBeGreaterThan(lightThickness * 1.5);
  });

  it("keeps low taper values nearly round", () => {
    const line = [[10, 50, 0.6, 0], [40, 50, 0.6, 8], [70, 50, 0.6, 16], [90, 50, 0.6, 24]];
    const halfWidth = 12 * (0.55 + 0.75 * 0.6) / 2;
    const tiny = strokeWith(line, { taper: 1 });
    const gentle = strokeWith(line, { taper: 25 });
    const none = strokeWith(line, {});
    // 1% must be visually indistinguishable from a round cap...
    expect(endCapRadius(tiny, 90, 50)).toBeGreaterThan(halfWidth * 0.9);
    // 25% narrows the cap but nowhere near a point; taper 0 keeps the full
    // round cap at exactly half-width.
    expect(endCapRadius(gentle, 90, 50)).toBeGreaterThan(halfWidth * 0.5);
    expect(endCapRadius(none, 90, 50)).toBeGreaterThan(halfWidth * 0.9);
    expect(endCapRadius(none, 90, 50)).toBeLessThan(halfWidth * 1.1);
  });

  it("pressure curve remaps the response", () => {
    // A curve that boosts low pressures: at raw pressure 0.3 the width grows
    // versus the identity mapping.
    const line = [[10, 50, 0.3, 0], [40, 50, 0.3, 8], [70, 50, 0.3, 16], [90, 50, 0.3, 24]];
    const identity = strokeWith(line, {});
    const boosted = strokeWith(line, { pressureCurve: [[0, 0], [0.3, 0.7], [1, 1]] });
    // Mapped 0.3 → 0.7 widens the response by ~1.39x over the identity.
    expect(thicknessAt(boosted, 20, 80)).toBeGreaterThan(thicknessAt(identity, 20, 80) * 1.25);
  });

  it("speed and pressure stay visible together", () => {
    // Alternating pressure with a fast middle: the pressure variation must
    // remain measurable even with speed compensation at full gain.
    // Densified like real capture (the modeler resamples to 180Hz, raw
    // streams arrive at 125Hz). Same pressure everywhere; the middle
    // segment is written 3x faster.
    const line: number[][] = [];
    const plateaus = [[10, 35, 0, 40], [35, 65, 40, 55], [65, 90, 55, 95]];
    for (const [from, to, t0, t1] of plateaus) {
      const steps = Math.max(2, Math.round((to - from) / 3));
      for (let step = 0; step < steps; step++) {
        const k = step / steps;
        line.push([from + (to - from) * k, 50, 0.6, t0 + (t1 - t0) * k]);
      }
    }
    const combined = strokeWith(line, { pressure: 100, speed: 100 });
    // Sample well inside the slow and fast plateaus, away from transitions.
    const slowBand = thicknessAt(combined, 15, 30);
    const fastBand = thicknessAt(combined, 42, 58);
    expect(fastBand).toBeLessThan(slowBand);
    expect(slowBand).toBeGreaterThan(fastBand * 1.15);
  });
});


describe("pressure curve normalization", () => {
  it("flattens decreasing heights to a non-decreasing mapping", () => {
    const curve = normalizePressureCurve([[0, 0], [0.3, 0.8], [0.5, 0.3], [1, 0.9]]);
    expect(curve).toEqual([[0, 0], [0.3, 0.8], [0.5, 0.8], [1, 0.9]]);
  });

  it("rejects degenerate input", () => {
    expect(normalizePressureCurve(undefined)).toBeUndefined();
    expect(normalizePressureCurve([[0.2, 0.5]])).toBeUndefined();
    expect(normalizePressureCurve([[0, 0.2], [0, 0.8], [1, 0.9]])).toEqual([[0, 0.2], [1, 0.9]]);
  });

  it("strips identity curves", () => {
    expect(normalizePressureCurve([[0, 0], [1, 1]])).toBeUndefined();
    expect(normalizePressureCurve([[0, 0], [0.5, 0.5], [1, 1]])).toBeUndefined();
  });
});

describe("canvas density", () => {
  it.each([0.5, 0.75, 1, 1.25, 2, 3])("matches display pixels at zoom %s", (zoom) => {
    expect(canvasResolution(300, 450, 3, zoom)).toEqual({ width: Math.round(900 * zoom), height: Math.round(1350 * zoom) });
  });
  it("rounds fractional layout dimensions only at the backing bitmap", () => {
    expect(canvasResolution(399.75, 599.25, 1.25, 1.1)).toEqual({ width: 550, height: 824 });
  });
  it("bounds extreme bitmap allocations", () => {
    const size = canvasResolution(820, 1180, 4, 3);
    expect(size.width * size.height).toBeLessThan(16_010_000);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(8192);
  });
  it("keeps a full 2x backing bitmap for an iPad-sized writing overlay", () => {
    expect(canvasResolution(1024, 1366, 2, 1, 12_000_000)).toEqual({ width: 2048, height: 2732 });
  });
});

describe("continuous pen rendering", () => {
  it("keeps a sparsely sampled fast corner at its recorded position", () => {
    const ink = stroke();
    ink.points = [[0.1, 0.3], [0.5, 0.3], [0.5, 0.7]].map(([x, y], index) => ({ x, y, pressure: 0.5, t: index }));
    const outline = penOutline(ink, 800, 1000);
    const nearestCorner = Math.min(...outline.map(([x, y]) => Math.hypot(x - 400, y - 300)));
    expect(nearestCorner).toBeLessThan(ink.width);
  });

  it("rejects isolated Pencil pressure drops without flattening sustained pressure", () => {
    const points = [0.5, 0.5, 0.05, 0.5, 0.5, 0.2, 0.2, 0.2, 0.5].map((pressure, index) => ({
      x: index / 10, y: 0.5, pressure, t: index,
    }));
    expect(smoothPenPressures(points)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.2, 0.2, 0.2, 0.5]);
  });

  it("keeps an isolated pressure glitch out of the persisted stroke outline", () => {
    const stable = stroke(0.5);
    const glitched = stroke(0.5);
    glitched.points[50].pressure = 0.05;
    expect(penOutline(glitched, 800, 1000)).toEqual(penOutline(stable, 800, 1000));
  });

  it("composites the whole pen once and reuses unchanged geometry", () => {
    const ctx = context();
    const ink = stroke();
    drawInkStroke(ctx, ink, 800, 1000);
    const path = vi.mocked(ctx.fill).mock.calls[0][0];
    drawInkStroke(ctx, ink, 800, 1000);
    expect(ctx.fill).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.fill).mock.calls[1][0]).toBe(path);
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.globalAlpha).toBe(0.5);
  });
  it("renders the outline as a faithful polygon without cutting sparse corners", () => {
    const ctx = context();
    drawInkStroke(ctx, stroke(), 800, 1000);
    const path = vi.mocked(ctx.fill).mock.calls[0][0];
    expect(path.lineTo).toHaveBeenCalled();
    expect(path.quadraticCurveTo).not.toHaveBeenCalled();
  });
  it.each(["append", "translate", "resize", "width", "revision"])("invalidates cached geometry on %s", (change) => {
    const ctx = context();
    const ink = stroke();
    drawInkStroke(ctx, ink, 800, 1000);
    const path = vi.mocked(ctx.fill).mock.calls[0][0];
    if (change === "append") ink.points.push({ x: 0.95, y: 0.5, pressure: 0.5, t: 101 });
    if (change === "translate") ink.points = ink.points.map(p => ({ ...p, x: p.x + 0.01 }));
    if (change === "width") ink.width = 4;
    if (change === "revision") ink.updatedAt++;
    drawInkStroke(ctx, ink, change === "resize" ? 900 : 800, 1000);
    expect(vi.mocked(ctx.fill).mock.calls[1][0]).not.toBe(path);
  });
  it.each([0, 0.5, 1])("preserves pressure diameter at %s", (pressure) => {
    // 1:1 nib scale for this canvas, like the live editor reference width.
    const outline = penOutline(stroke(pressure), 800, 1000, 800);
    const middle = outline.filter(p => p[0] > 200 && p[0] < 600);
    const ys = middle.map(p => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(3 * (0.55 + pressure * 0.75), 2);
  });
  it("keeps dots and highlighter blending", () => {
    const ctx = context();
    const ink = stroke();
    ink.points = ink.points.slice(0, 1);
    drawInkStroke(ctx, ink, 800, 1000);
    expect(ctx.arc).toHaveBeenCalledOnce();
    const marker = { ...stroke(), tool: "highlighter" as const };
    drawInkStroke(ctx, marker, 800, 1000);
    expect(ctx.stroke).toHaveBeenCalledOnce();
    expect(ctx.globalCompositeOperation).toBe("multiply");
  });
  it("does not mutate saved points", () => {
    const ink = stroke();
    const before = JSON.stringify(ink);
    penOutline(ink, 800, 1000);
    expect(JSON.stringify(ink)).toBe(before);
  });
});

describe("live stroke tail rendering", () => {
  function fillCalls(ctx: CanvasRenderingContext2D): Array<[unknown, unknown]> {
    return vi.mocked(ctx.fill).mock.calls as Array<[unknown, unknown]>;
  }

  it("grows the settled path incrementally instead of restamping on every frame", () => {
    const ctx = context();
    const ink = stroke();
    drawInkStrokeTail(ctx, ink, 800, 1000, 0);
    // Per draw the settled path is filled first, then the tip path.
    const settled = fillCalls(ctx)[0][0] as { lineTo: ReturnType<typeof vi.fn> };
    const stampedLineTos = vi.mocked(settled.lineTo).mock.calls.length;
    expect(stampedLineTos).toBeGreaterThan(0);

    ink.points.push({ x: 0.95, y: 0.5, pressure: 0.5, t: 101 });
    drawInkStrokeTail(ctx, ink, 800, 1000, 0);
    expect(fillCalls(ctx)[2][0]).toBe(settled);
    const grownLineTos = vi.mocked(settled.lineTo).mock.calls.length;
    expect(grownLineTos).toBeGreaterThan(stampedLineTos);

    // A frame without new samples must not restamp a single ring.
    drawInkStrokeTail(ctx, ink, 800, 1000, 0);
    expect(fillCalls(ctx)[4][0]).toBe(settled);
    expect(vi.mocked(settled.lineTo).mock.calls.length).toBe(grownLineTos);
  });

  it("rebuilds the whole tail once when the confirmed start advances", () => {
    const ctx = context();
    const ink = stroke();
    drawInkStrokeTail(ctx, ink, 800, 1000, 0);
    const settled = fillCalls(ctx)[0][0];
    drawInkStrokeTail(ctx, ink, 800, 1000, 40);
    expect(fillCalls(ctx).length).toBe(4);
    expect(fillCalls(ctx)[2][0]).not.toBe(settled);
  });

  it("replaces the whole tail when the points array is replaced wholesale", () => {
    const ctx = context();
    const ink = stroke();
    drawInkStrokeTail(ctx, ink, 800, 1000, 0);
    const settled = fillCalls(ctx)[0][0];
    ink.points = ink.points.map((point) => ({ ...point, y: 0.6 }));
    drawInkStrokeTail(ctx, ink, 800, 1000, 0);
    expect(fillCalls(ctx)[2][0]).not.toBe(settled);
  });

  it("keeps the worker seam: the tail covers unconfirmed samples plus one context sample", () => {
    const ctx = context();
    const ink = stroke();
    drawInkStrokeTail(ctx, ink, 800, 1000, 41);
    drawInkStrokeTail(ctx, ink, 800, 1000, 41);
    // Same start on both frames: one settled path identity survives, matching
    // the drawInkStroke cache contract (identical Path2D across redraws).
    expect(fillCalls(ctx)[2][0]).toBe(fillCalls(ctx)[0][0]);
  });

  it("renders a one-sample live tail as the same dot drawInkStroke uses", () => {
    const ctx = context();
    const ink = stroke();
    ink.points = ink.points.slice(0, 1);
    drawInkStrokeTail(ctx, ink, 800, 1000, 0);
    expect(ctx.arc).toHaveBeenCalledOnce();
    expect(ctx.fill).toHaveBeenCalledOnce();
    expect(fillCalls(ctx)[0][0]).toBeUndefined();
  });

  it("strokes a highlighter tail as a smoothed path over the unconfirmed window", () => {
    const ctx = context();
    const ink = { ...stroke(), tool: "highlighter" as const };
    drawInkStrokeTail(ctx, ink, 800, 1000, 41);
    expect(ctx.stroke).toHaveBeenCalledOnce();
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.quadraticCurveTo).toHaveBeenCalled();
  });
});
