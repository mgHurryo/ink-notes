import { describe, expect, it } from "vitest";
import { cellKeys, StrokeIndex } from "../src/tiles";
import type { InkStroke } from "../src/model";

function stroke(id: string, x: number, y: number): InkStroke {
  return { id, pageId: "page", tool: "pen", width: 4, opacity: 1, color: "#111", createdAt: 1, updatedAt: 1,
    points: [{ x, y, pressure: 0.5, t: 1 }, { x: x + 0.02, y: y + 0.02, pressure: 0.5, t: 2 }] };
}
describe("tile spatial index", () => {
  it("selects visible cells and clips out-of-page regions", () => {
    expect(cellKeys({ x: 250, y: 250, width: 30, height: 30 }, 1000, 1000)).toEqual(["1:1", "2:1", "1:2", "2:2"]);
    expect(cellKeys({ x: -100, y: -100, width: 150, height: 150 }, 1000, 1000)).toEqual(["0:0"]);
    expect(cellKeys({ x: 1001, y: 0, width: 2, height: 2 }, 1000, 1000)).toEqual([]);
  });
  it("queries local strokes in compositing order, without duplicates", () => {
    const index = new StrokeIndex(1000, 1000);
    const a = stroke("a", 0.24, 0.24), b = stroke("b", 0.25, 0.25), c = stroke("c", 0.8, 0.8);
    index.sync([b, a, c]);
    expect(index.query({ x: 200, y: 200, width: 100, height: 100 })).toEqual([b, a]);
  });
  it("invalidates both old and new cells after movement, and cells after deletion", () => {
    const index = new StrokeIndex(1000, 1000), a = stroke("a", 0.1, 0.1);
    index.sync([a]);
    const revision = index.revisions.get("0:0")!;
    a.points = a.points.map(p => ({ ...p, x: p.x + 0.6 }));
    index.sync([a]);
    expect(index.revisions.get("0:0")).toBeGreaterThan(revision);
    expect(index.query({ x: 0, y: 0, width: 200, height: 200 })).toEqual([]);
    expect(index.query({ x: 600, y: 0, width: 200, height: 200 })).toEqual([a]);
    index.sync([]);
    expect(index.query({ x: 0, y: 0, width: 1000, height: 1000 })).toEqual([]);
  });
  it("does not invalidate unchanged geometry but detects styling and pressure revisions", () => {
    const index = new StrokeIndex(1000, 1000), a = stroke("a", 0.1, 0.1);
    index.sync([a]);
    const revisions = [...index.revisions];
    index.sync([a]);
    expect([...index.revisions]).toEqual(revisions);
    a.opacity = 0.5; index.sync([a]);
    expect(index.revisions.get("0:0")).toBeGreaterThan(revisions[0][1]);
    const revision = index.revisions.get("0:0")!;
    a.updatedAt++; index.sync([a]);
    expect(index.revisions.get("0:0")).toBeGreaterThan(revision);
  });
  it("excludes the live pen until committed", () => {
    const index = new StrokeIndex(1000, 1000), a = stroke("a", 0.1, 0.1);
    index.sync([a], a);
    expect(index.query({ x: 0, y: 0, width: 1000, height: 1000 })).toEqual([]);
    index.sync([a]);
    expect(index.query({ x: 0, y: 0, width: 1000, height: 1000 })).toEqual([a]);
  });
});
