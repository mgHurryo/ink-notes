import { describe, expect, it } from "vitest";
import { canStraighten, shapePoints, SHAPES } from "../src/shapes";
import { createNotebook, normalizeNotebook } from "../src/model";
import { penOutlineRings } from "../src/rendering";

const p = (x: number, y: number) => ({ x, y, pressure: .5, t: 1 });

describe("shape stroke geometry", () => {
  it.each(SHAPES)("keeps %s compatible with persistence and ordinary pen outlines", (kind) => {
    const notebook = createNotebook("Shapes"), page = notebook.pages[0];
    const points = shapePoints(kind, p(.2, .2), p(.7, .6), 600, 1000);
    page.strokes.push({ id: kind, pageId: page.id, tool: "pen", points, color: "#123456", width: 4, opacity: .6,
      dynamics: { taper: 0, pressure: 0, speed: 0 }, createdAt: 1, updatedAt: 1 });
    const stroke = normalizeNotebook(JSON.parse(JSON.stringify(notebook))).pages[0].strokes[0];
    expect(stroke.points).toEqual(points);
    expect(penOutlineRings(stroke, 600, 1000).flat(2).every(Number.isFinite)).toBe(true);
  });
  it.each(["square", "circle"] as const)("constrains %s in page pixels, in every drag direction", kind => {
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const points = shapePoints(kind, p(.5, .5), p(.5 + .1 * sx, .5 + .1 * sy), 600, 1000);
      const w = (Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))) * 600;
      const h = (Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))) * 1000;
      expect(w).toBeCloseTo(h, 1);
    }
  });
  it("accepts slightly uneven straight strokes but rejects text-like or curved marks", () => {
    expect(canStraighten([p(.1,.1), p(.2,.201), p(.3,.299), p(.5,.5)], 1000, 1000)).toBe(true);
    for (const points of [
      [p(.1,.1), p(.12,.1)], [p(.1,.1), p(.3,.2), p(.5,.1)],
      [p(.1,.1), p(.3,.1), p(.2,.1), p(.5,.1)],
      [p(.1,.1), p(.1,.3), p(.3,.3)], [p(.1,.1), p(.3,.1), p(.1,.1)],
    ]) expect(canStraighten(points, 1000, 1000)).toBe(false);
  });
});
