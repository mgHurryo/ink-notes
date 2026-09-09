import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasResolution, drawInkStroke, penOutline } from "../src/rendering";
import type { InkStroke } from "../src/model";

function stroke(pressure = 0.5): InkStroke {
  return { id: "test", pageId: "page", tool: "pen", color: "#111111", width: 3, opacity: 0.5, createdAt: 1, updatedAt: 1,
    points: Array.from({ length: 100 }, (_, i) => ({ x: 0.1 + i * 0.008, y: 0.5, pressure, t: i })) };
}

function context(): CanvasRenderingContext2D {
  vi.stubGlobal("Path2D", class {
    moveTo = vi.fn();
    quadraticCurveTo = vi.fn();
    closePath = vi.fn();
  });
  return { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(),
    moveTo: vi.fn(), quadraticCurveTo: vi.fn(), lineTo: vi.fn() } as unknown as CanvasRenderingContext2D;
}

afterEach(() => vi.unstubAllGlobals());

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
