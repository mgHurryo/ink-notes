import { describe, expect, it } from "vitest";
import { splitStickyStroke, stickyBounds, stickyStrokeFromPage, stickyStrokeOnPage } from "../src/sticky-ink";
import { StickyNote, stickyLink } from "../src/sticky-model";
import { InkStroke } from "../src/model";
const note: StickyNote = { id: "note", pageId: "page", x: .2, y: .2, width: .4, height: .4, boardPageWidth: 600,
  scrollX: 0, scrollY: 0, title: "", text: "", keywords: "", textUpdatedAt: 1, color: "#fff1a8", collapsed: false, preview: true,
  strokes: [], deletedStrokeIds: [], createdAt: 1, updatedAt: 1 };
const g = { width: 600, height: 800 };
const stroke = (x1: number, x2: number): InkStroke => ({ id: "ink", pageId: "page", tool: "pen", color: "#000000", width: 3, opacity: 1,
  createdAt: 1, updatedAt: 1, points: [{ x: x1, y: .4, pressure: .3, t: 1 }, { x: x2, y: .4, pressure: .7, t: 11 }] });
describe("inline sticky layer geometry", () => {
  it("splits a sparse crossing at both exact edges without losing the outside ink", () => {
    const result = splitStickyStroke(stroke(.1, .8), [note], g);
    expect(result.page).toHaveLength(2); expect(result.notes.get(note.id)).toHaveLength(1);
    expect(result.page[0].points.at(-1)!.x).toBeCloseTo(.2); expect(result.page[1].points[0].x).toBeCloseTo(.6);
    const projected = stickyStrokeOnPage(result.notes.get(note.id)![0], note, g);
    expect(projected.points[0].x).toBeCloseTo(.2); expect(projected.points.at(-1)!.x).toBeCloseTo(.6);
    expect(projected.width).toBe(3); expect(projected.points[0].pressure).toBeGreaterThan(.3);
  });
  it("routes a dot to the topmost expanded board and ignores folded notes and headers", () => {
    const dot = { ...stroke(.3, .3), points: [stroke(.3, .3).points[0]] };
    expect(splitStickyStroke(dot, [note, { ...note, id: "top" }], g).notes.has("top")).toBe(true);
    expect(splitStickyStroke(dot, [{ ...note, collapsed: true }], g).page).toHaveLength(1);
    dot.points[0].y = note.y + .001;
    expect(splitStickyStroke(dot, [note], g).page).toHaveLength(1);
  });
  it("keeps fixed board ink beyond a resized viewport and roundtrips scroll and zoom", () => {
    const n = { ...note, width: .1, height: .1, scrollX: 2000, scrollY: 3000 };
    const boardInk = { ...stroke(.4, .7), pageId: n.id, points: [{ x: 2.1, y: 3.2, pressure: .5, t: 1 }] };
    const enlarged = { width: 1200, height: 1600 };
    const projection = stickyStrokeOnPage(boardInk, n, enlarged), restored = stickyStrokeFromPage(projection, n, enlarged);
    expect(restored.points[0].x).toBeCloseTo(2.1); expect(restored.points[0].y).toBeCloseTo(3.2);
    expect(restored.width).toBe(3); expect(stickyBounds(n, enlarged).top).toBeCloseTo(.28);
    const moved = stickyStrokeOnPage(boardInk, { ...n, x: .3 }, enlarged);
    expect(moved.points[0].x - projection.points[0].x).toBeCloseTo(.1);
  });
  it("encodes stable paragraph references alongside note and page ids", () => {
    const url = new URL(stickyLink("Course.ink", "page", "note", "Vault", "definition-1"));
    expect(url.searchParams.get("block")).toBe("definition-1"); expect(url.searchParams.get("sticky")).toBe("note");
  });
});
