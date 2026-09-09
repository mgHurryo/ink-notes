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
    incoming.pageOrder = incoming.pages.map((candidate) => candidate.id);
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

  it("migrates schema one files into deterministic page order", () => {
    const migrated = normalizeNotebook({ schema: 1, pages: [
      { id: "late", title: "Late", strokes: [], createdAt: 20, updatedAt: 20 },
      { id: "early", title: "Early", strokes: [], createdAt: 10, updatedAt: 10 },
    ], updatedAt: 20 });
    expect(migrated.schema).toBe(2);
    expect(migrated.pageOrder).toEqual(["early", "late"]);
    expect(migrated.pages.map((page) => page.id)).toEqual(["early", "late"]);
    expect(migrated.deletedPages).toEqual({});
  });

  it("keeps deleted pages tombstoned during concurrent merges", () => {
    const base = createNotebook();
    const deletedId = base.pages[0].id;
    const stale = normalizeNotebook(base);
    const deleted = normalizeNotebook(base);
    deleted.pages = [createPage("Replacement")];
    deleted.pageOrder = deleted.pages.map((page) => page.id);
    deleted.deletedPages[deletedId] = Date.now();
    deleted.pageOrderUpdatedAt += 10;
    const merged = mergeNotebooks(stale, deleted);
    expect(merged.pages.some((page) => page.id === deletedId)).toBe(false);
    expect(merged.deletedPages[deletedId]).toBeDefined();
  });

  it("merges concurrent page additions into a deterministic order", () => {
    const original = createNotebook();
    const left = normalizeNotebook(original);
    const right = normalizeNotebook(original);
    const leftPage = createPage("Left", "blank", 10);
    const rightPage = createPage("Right", "blank", 20);
    left.pages.push(leftPage); left.pageOrder.push(leftPage.id);
    right.pages.push(rightPage); right.pageOrder.push(rightPage.id);
    left.pageOrderUpdatedAt = right.pageOrderUpdatedAt = original.pageOrderUpdatedAt + 1;

    const forward = mergeNotebooks(left, right).pageOrder;
    const reverse = mergeNotebooks(right, left).pageOrder;
    expect(forward).toEqual(reverse);
    expect(forward).toEqual(expect.arrayContaining([original.pages[0].id, leftPage.id, rightPage.id]));
  });

  it("uses the newest page order and inserts a concurrent addition by creation time", () => {
    const base = createNotebook();
    const second = createPage("Second", "blank", base.pages[0].createdAt + 10);
    const third = createPage("Third", "blank", base.pages[0].createdAt + 20);
    base.pages.push(second, third);
    base.pageOrder = base.pages.map((page) => page.id);
    const reordered = normalizeNotebook(base);
    reordered.pages = [third, base.pages[0], second];
    reordered.pageOrder = reordered.pages.map((page) => page.id);
    reordered.pageOrderUpdatedAt = base.pageOrderUpdatedAt + 10;
    const concurrent = normalizeNotebook(base);
    const added = createPage("Concurrent", "blank", base.pages[0].createdAt + 15);
    concurrent.pages.push(added); concurrent.pageOrder.push(added.id);

    concurrent.pageOrderUpdatedAt = base.pageOrderUpdatedAt;
    const merged = mergeNotebooks(reordered, concurrent);
    expect(merged.pageOrder).toEqual([third.id, added.id, base.pages[0].id, second.id]);
  });
});
