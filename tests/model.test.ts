import { describe, expect, it } from "vitest";
import { createNotebook, createPage, mergeNotebooks, normalizeNotebook } from "../src/model";
import { normalizePressureCurve } from "../src/rendering";
import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";

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

  it("revives the last-deleted page when complementary deletions would wipe the notebook", () => {
    const base = createNotebook();
    const p1 = base.pages[0];
    const p2 = createPage("Page 2");
    base.pages.push(p2);
    base.pageOrder = base.pages.map((page) => page.id);
    p1.strokes.push({ id: "s1", pageId: p1.id, tool: "pen", color: "#000", width: 3, opacity: 1, points: [], createdAt: 1, updatedAt: 1 });
    p2.strokes.push({ id: "s2", pageId: p2.id, tool: "pen", color: "#000", width: 3, opacity: 1, points: [], createdAt: 2, updatedAt: 2 });

    // Mirror the view.ts:1050 / worker-core.ts:246 shapes: each device merged
    // from disk carries its own deletion, and normalizeNotebook has already
    // dropped tombstoned pages, so each side's pages only hold its own view.
    const a = normalizeNotebook(structuredClone(base));
    const d1 = a.pages.shift()!;
    a.deletedPages[d1.id] = Date.now();
    const b = normalizeNotebook(structuredClone(base));
    const d2 = b.pages.pop()!;
    b.deletedPages[d2.id] = Date.now() + 1;

    const merged = mergeNotebooks(b, a);
    expect(merged.pages).toHaveLength(1);
    const survivor = merged.pages[0];
    expect([p1.id, p2.id]).toContain(survivor.id);
    expect(survivor.strokes).toHaveLength(1);
    expect(["s1", "s2"]).toContain(survivor.strokes[0].id);
    expect(merged.deletedPages[survivor.id]).toBeUndefined();

    // The next save re-merges the disk copy with the merged result
    // (storage.ts:72); the survivor must survive that pass too.
    const resaved = mergeNotebooks(normalizeNotebook(JSON.parse(JSON.stringify(b))), merged);
    expect(resaved.pages).toHaveLength(1);
    expect(resaved.pages[0].id).toBe(survivor.id);
    expect(resaved.pages[0].strokes).toHaveLength(1);
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

  it("merges duplicate page ids instead of silently dropping one copy", () => {
    const raw = {
      pages: [
        { id: "dup", title: "A", strokes: [{ id: "s1", pageId: "dup", points: [], createdAt: 1, updatedAt: 1 }], createdAt: 1, updatedAt: 100 },
        { id: "dup", title: "B", strokes: [{ id: "s2", pageId: "dup", points: [], createdAt: 2, updatedAt: 2 }], createdAt: 1, updatedAt: 200 },
      ],
      pageOrder: ["dup"],
    };
    const notebook = normalizeNotebook(raw);
    expect(notebook.pages).toHaveLength(1);
    expect(notebook.pages[0].strokes.map((stroke) => stroke.id)).toEqual(["s1", "s2"]);
    expect(notebook.pages[0].title).toBe("B");
    expect(notebook.pageOrder).toEqual(["dup"]);
    expect(notebook.deletedPages).toEqual({});

    // The next save (NotebookStore.save) re-merges the in-memory result with a
    // fresh normalize of the still-duplicated file; both copies' strokes must
    // survive that round-trip.
    expect(mergeNotebooks(normalizeNotebook(raw), notebook).pages[0].strokes.map((stroke) => stroke.id)).toEqual(["s1", "s2"]);
  });

  it("drops malformed pressureCurve points when loading", () => {
    const stroke = (pressureCurve: unknown) => ({
      id: "s1", pageId: "p1", tool: "pen" as const, color: "#000", width: 3, opacity: 1, points: [], createdAt: 1, updatedAt: 1,
      dynamics: { taper: 0, pressure: 100, speed: 0, pressureCurve },
    });
    // Filtering leaves a single point, so the whole curve is treated as absent.
    const dropped = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes: [stroke([[0.1, 0.2], [1], "oops"])] }] });
    expect(dropped.pages[0].strokes[0].dynamics?.pressureCurve).toBeUndefined();

    // Invalid points are dropped while valid ones survive.
    const mixed = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes: [stroke([[0, 0], [0.5, "oops"], [1, 1]])] }] });
    const kept = mixed.pages[0].strokes[0].dynamics?.pressureCurve;
    expect(kept).toEqual([[0, 0], [1, 1]]);
    expect(kept?.every((point) => point.every((value) => Number.isFinite(value)))).toBe(true);
  });

  it("reuses canonical points only when normalizing an owned parsed notebook", () => {
    const parsed = JSON.parse(JSON.stringify({ pages: [{ id: "p1", title: "Page", strokes: [{
      id: "s1", pageId: "p1", tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.5, y: 0.25, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    }] }] }));
    const parsedPoint = parsed.pages[0].strokes[0].points[0];
    const reused = normalizeNotebook(parsed, { reuseCanonicalPoints: true });
    expect(reused.pages[0].strokes[0].points[0]).toBe(parsedPoint);

    const shared = { pages: [{ id: "p1", title: "Page", strokes: [{
      id: "s1", pageId: "p1", tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.5, y: 0.25, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    }] }] };
    const independent = normalizeNotebook(shared);
    expect(independent.pages[0].strokes[0].points[0]).not.toBe(shared.pages[0].strokes[0].points[0]);

    const malformed = JSON.parse(JSON.stringify(shared));
    malformed.pages[0].strokes[0].points[0].x = 2;
    malformed.pages[0].strokes[0].points[0].unknown = true;
    const sanitized = normalizeNotebook(malformed, { reuseCanonicalPoints: true }).pages[0].strokes[0].points[0];
    expect(sanitized.x).toBe(1);
    expect(sanitized).not.toHaveProperty("unknown");
    expect(sanitized).not.toBe(malformed.pages[0].strokes[0].points[0]);
  });

  it("keeps the pressureCurve stable across a storage round-trip", () => {
    const strokes = [
      { id: "s1", pageId: "p1", tool: "pen" as const, color: "#000", width: 3, opacity: 1, points: [], createdAt: 1, updatedAt: 1,
        dynamics: { taper: 0, pressure: 100, speed: 0, pressureCurve: [[0.1, 0.2], [1], "oops"] } },
      // A valid non-identity curve must survive the same round-trip unchanged.
      { id: "s2", pageId: "p1", tool: "pen" as const, color: "#000", width: 3, opacity: 1, points: [], createdAt: 1, updatedAt: 1,
        dynamics: { taper: 10, pressure: 100, speed: 0, pressureCurve: [[0, 0], [0.5, 0.9], [1, 1]] } },
    ];
    const first = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes }] });
    expect(first.pages[0].strokes[0].dynamics?.pressureCurve).toBeUndefined();
    const kept = first.pages[0].strokes[1].dynamics?.pressureCurve;
    expect(kept).toEqual([[0, 0], [0.5, 0.9], [1, 1]]);
    expect(kept?.every((point) => point.every((value) => Number.isFinite(value)))).toBe(true);

    const second = normalizeNotebook(parseStoredJson(serializeStoredJson(first)));
    expect(second.pages[0].strokes.map((stroke) => stroke.dynamics?.pressureCurve))
      .toEqual(first.pages[0].strokes.map((stroke) => stroke.dynamics?.pressureCurve));
    expect(second.pages[0].strokes.map((stroke) => normalizePressureCurve(stroke.dynamics?.pressureCurve)))
      .toEqual(first.pages[0].strokes.map((stroke) => normalizePressureCurve(stroke.dynamics?.pressureCurve)));
  });
});
