import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasResolution, drawInkStroke, penOutline, smoothOutlineCenterline, smoothPenPressures } from "../src/rendering";
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
    }, 100, 100);
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
    const outline = penOutline(stroke(pressure), 800, 1000);
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
