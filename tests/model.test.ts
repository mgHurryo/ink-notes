import { describe, expect, it } from "vitest";
import { createNotebook, createPage, mergeNotebooks, normalizeNotebook } from "../src/model";

describe("Ink notebook model", () => {
  it("normalizes malformed notebook data without losing valid strokes", () => {
    const notebook = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes: [{ id: "s1", pageId: "p1", points: [{ x: 0.5, y: 2, pressure: 2 }] }] }] });
    expect(notebook.pages[0].strokes[0].points[0]).toMatchObject({ x: 0.5, y: 1, pressure: 1 });
  });

  it("unions independently-created pages and strokes", () => {
    const base = createNotebook();
    const page = base.pages[0];
    page.strokes.push({ id: "a", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1, points: [], createdAt: 1, updatedAt: 1 });
    const incoming = { ...base, pages: [...base.pages, createPage("Page 2")], updatedAt: base.updatedAt + 1 };
    incoming.pages[0] = { ...incoming.pages[0], strokes: [...incoming.pages[0].strokes, { id: "b", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1, points: [], createdAt: 2, updatedAt: 2 }] };
    const merged = mergeNotebooks(base, incoming);
    expect(merged.pages).toHaveLength(2);
    expect(merged.pages[0].strokes.map((stroke) => stroke.id)).toEqual(["a", "b"]);
  });

  it("keeps a deleted stroke tombstoned when an older device sends it again", () => {
    const base = createNotebook();
    const page = base.pages[0];
    const stroke = { id: "deleted", pageId: page.id, tool: "pen" as const, color: "#000", width: 3, opacity: 1, points: [], createdAt: 1, updatedAt: 1 };
    page.strokes.push(stroke);

    const deleted = normalizeNotebook(base);
    deleted.pages[0].strokes = [];
    deleted.pages[0].deletedStrokeIds = [stroke.id];
    deleted.pages[0].updatedAt += 1;
    deleted.updatedAt += 1;

    const merged = mergeNotebooks(deleted, base);
    expect(merged.pages[0].strokes).toEqual([]);
    expect(merged.pages[0].deletedStrokeIds).toContain(stroke.id);
  });

  it("defaults tombstones for legacy files and filters inconsistent deleted strokes", () => {
    const legacy = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes: [] }] });
    expect(legacy.pages[0].deletedStrokeIds).toEqual([]);

    const inconsistent = normalizeNotebook({
      pages: [{
        id: "p1",
        title: "Page",
        deletedStrokeIds: ["s1"],
        strokes: [{ id: "s1", pageId: "p1", points: [] }],
      }],
    });
    expect(inconsistent.pages[0].strokes).toEqual([]);
  });

  it("keeps the most recently moved version of the same stroke", () => {
    const base = createNotebook();
    const page = base.pages[0];
    page.strokes.push({ id: "s1", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1, points: [{ x: 0.1, y: 0.1, pressure: 1, t: 1 }], createdAt: 1, updatedAt: 1 });
    const moved = normalizeNotebook(base);
    moved.pages[0].strokes[0].points[0].x = 0.5;
    moved.pages[0].strokes[0].updatedAt = 2;

    const merged = mergeNotebooks(base, moved);
    expect(merged.pages[0].strokes[0].points[0].x).toBe(0.5);
  });
});
