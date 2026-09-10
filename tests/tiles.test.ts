import { describe, expect, it, vi } from "vitest";
import { cellKeys, StrokeIndex, tileDensity, TileRenderer } from "../src/tiles";
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
  it.each(["pen", "highlighter"] as const)("excludes the live %s until committed", (tool) => {
    const index = new StrokeIndex(1000, 1000), a = { ...stroke("a", 0.1, 0.1), tool };
    index.sync([a], a);
    expect(index.query({ x: 0, y: 0, width: 1000, height: 1000 })).toEqual([]);
    index.sync([a]);
    expect(index.query({ x: 0, y: 0, width: 1000, height: 1000 })).toEqual([a]);
  });
  it("does not invalidate unrelated later tiles after deleting an early stroke", () => {
    const index = new StrokeIndex(1000, 1000);
    const early = stroke("early", 0.1, 0.1), later = stroke("later", 0.8, 0.8);
    index.sync([early, later]);
    const laterRevision = index.revisions.get("6:6");
    index.sync([later]);
    expect(index.revisions.get("6:6")).toBe(laterRevision);
    expect(index.queryNear({ x: 0.81, y: 0.81, pressure: 1, t: 1 }, 30)).toEqual([later]);
  });
});

describe("interactive tile commits", () => {
  it("preserves full 2x density for an iPad-sized viewport", () => {
    expect(tileDensity({ x: 0, y: 0, width: 1024, height: 1366 }, 2)).toBe(2);
  });

  it("does not undersample high-DPR tiles after zooming in", () => {
    expect(tileDensity({ x: 0, y: 0, width: 342, height: 455 }, 6)).toBe(6);
  });

  it("keeps tile bleed in logical pixels at high density", () => {
    const originalDocument = globalThis.document;
    const canvas: any = { width: 0, height: 0, style: {}, getContext: vi.fn(() => ({ setTransform: vi.fn() })) };
    const node: any = { dataset: {} as Record<string, string>, style: {}, appendChild: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn((tag: string) => tag === "canvas" ? canvas : node) });
    const renderer = Object.create(TileRenderer.prototype) as any;
    const state = {
      index: { width: 128, height: 128, query: vi.fn(() => []), revisions: new Map() },
    };
    const tile = renderer.createTile({ state, cell: "0:0", density: 4 });
    expect(canvas.width).toBe(128 * 4 + 32);
    expect(canvas.style.left).toBe("-4px");
    expect(canvas.style.top).toBe("-4px");
    expect(canvas.getContext).toHaveBeenCalled();
    vi.stubGlobal("document", originalDocument);
  });

  it("scales mounted tile geometry without changing its raster density", () => {
    const renderer = Object.create(TileRenderer.prototype) as any;
    renderer.displayScale = 2;
    const tile = {
      cell: "1:0", density: 4,
      state: { index: { width: 300, height: 200 } },
      canvas: { width: 544, height: 544, style: {} },
      node: { style: {} },
    };
    renderer.sizeTile(tile);
    expect(tile.node.style).toMatchObject({ left: "256px", top: "0px", width: "256px", height: "256px" });
    expect(tile.canvas.style).toMatchObject({ left: "-8px", top: "-8px", width: "272px", height: "272px" });
  });

  it("composes newly added ink over an exact stale tile without replaying history", () => {
    const addition = stroke("new", 0.1, 0.1);
    const state = { id: 3, index: {
      revisions: new Map([["0:0", 8]]),
      cellsFor: vi.fn(() => ["0:0"]),
    } };
    const base = { revision: 7 };
    const renderer = Object.create(TileRenderer.prototype) as any;
    renderer.cache = new Map([["3/0:0/2", base]]);
    renderer.createTileFrom = vi.fn(() => ({ revision: 8 }));

    renderer.createInkTile({ state, cell: "0:0", density: 2 }, [addition]);

    expect(renderer.createTileFrom).toHaveBeenCalledWith(
      { state, cell: "0:0", density: 2 }, base, [addition],
    );
  });

  it("replays a tile when revisions include more than the added ink", () => {
    const addition = stroke("new", 0.1, 0.1);
    const state = { id: 3, index: {
      revisions: new Map([["0:0", 9]]),
      cellsFor: vi.fn(() => ["0:0"]),
    } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    renderer.cache = new Map([["3/0:0/2", { revision: 7 }]]);
    renderer.createTileFrom = vi.fn(() => ({ revision: 9 }));

    renderer.createInkTile({ state, cell: "0:0", density: 2 }, [addition]);

    expect(renderer.createTileFrom).toHaveBeenCalledWith(
      { state, cell: "0:0", density: 2 }, undefined, [addition],
    );
  });

  it("defers finished-ink painting to an animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return 1; }));
    const state = { id: 1, index: { width: 800, height: 1000, cellsFor: () => ["0:0"], revisions: new Map([["0:0", 1]]) } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, inkCommit: null, inkCommitPaused: false, inkFrame: null,
      heldCells: new Set(), jobs: [], visible: new Set(), cache: new Map(), density: 1,
      get: vi.fn(() => undefined), createInkTile: vi.fn(() => ({ state, cell: "0:0", revision: 1 })),
      finishInkCommit: vi.fn(),
    });
    const complete = vi.fn();
    renderer.commitInk([stroke("ink", 0.1, 0.1)], { x: 0, y: 0, width: 800, height: 1000 }, 2, complete);
    expect(renderer.createInkTile).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    frames[0](0);
    expect(renderer.createInkTile).toHaveBeenCalledOnce();
    expect(renderer.finishInkCommit).toHaveBeenCalledWith(true);
    vi.unstubAllGlobals();
  });

  it("keeps the old frame mounted while preparing a coherent replacement batch", () => {
    const renderer = Object.create(TileRenderer.prototype) as any;
    const active = { id: 1, index: { width: 400, height: 600, revisions: new Map() } };
    const cancelGeneration = vi.fn();
    Object.assign(renderer, { active, disposed: false, inkCommit: null, inkFrame: null, renderGeneration: 4,
      backend: { cancelGeneration }, host: { children: [] }, cache: new Map(), heldCells: new Set(), jobs: [],
      get: vi.fn(() => undefined), scheduleInkCommit: vi.fn() });
    const viewport = { x: 0, y: 0, width: 400, height: 600 };
    renderer.commitInteractive(viewport, 3);
    expect(cancelGeneration).toHaveBeenCalledWith(5);
    expect(renderer.inkCommit.density).toBeUndefined();
    expect(renderer.inkCommit.jobs.length).toBeGreaterThan(1);
    expect(renderer.inkCommit.jobs.every((job: any) => job.density === 3)).toBe(true);
    expect(renderer.host.children).toEqual([]);
    expect(renderer.scheduleInkCommit).toHaveBeenCalledOnce();
  });

  it("does not spend work on density refinement during an active gesture", () => {
    const renderer = Object.create(TileRenderer.prototype) as any;
    const active = { id: 1, index: { width: 400, height: 600, revisions: new Map() } };
    Object.assign(renderer, { active, disposed: false, inkCommit: null, inkFrame: null, renderGeneration: 0,
      backend: null, host: { children: [] }, cache: new Map(), heldCells: new Set(), jobs: [],
      get: vi.fn(() => undefined), scheduleInkCommit: vi.fn() });
    const viewport = { x: 0, y: 0, width: 400, height: 600 };
    renderer.commitInteractive(viewport, 3, false);
    expect(renderer.inkCommit.jobs.every((job: any) => job.density === 1)).toBe(true);
    expect(renderer.scheduleInkCommit).toHaveBeenCalledOnce();
  });

  it("repaints only visible cells changed by an active eraser", () => {
    const renderer = Object.create(TileRenderer.prototype) as any;
    const active = { id: 1, index: { width: 512, height: 512, revisions: new Map([["0:0", 2], ["3:3", 2]]) } };
    const visibleTile = { cell: "0:0" };
    Object.assign(renderer, {
      active, disposed: false, cache: new Map(), pixels: 0, density: 1,
      get: vi.fn(() => undefined), paint: vi.fn(() => visibleTile), attach: vi.fn(), evict: vi.fn(),
    });

    renderer.previewInteractiveCells(["0:0", "3:3"], { x: 0, y: 0, width: 128, height: 128 }, 3);

    expect(renderer.paint).toHaveBeenCalledOnce();
    expect(renderer.paint).toHaveBeenCalledWith(expect.objectContaining({ cell: "0:0", density: 3 }));
    expect(renderer.attach).toHaveBeenCalledWith(visibleTile);
  });

  it("does not let an obsolete tile completion clear a newer pending request", async () => {
    const requests: Array<{ resolve: (value: any) => void }> = [];
    const backend = { renderTile: vi.fn(() => new Promise((resolve) => requests.push({ resolve }))) };
    const state = { id: 7, page: { id: "page" }, index: { width: 128, height: 128, revisions: new Map([["0:0", 1]]) } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { backend, disposed: false, renderGeneration: 1, pendingTiles: new Map(),
      cache: new Map(), sequence: 0, pixels: 0, visible: new Set(["0:0"]), active: state,
      schedule: vi.fn(), backendError: vi.fn() });
    const job = { state, cell: "0:0", density: 2, priority: "visible" };
    renderer.requestWorkerTile(job);
    renderer.renderGeneration = 2;
    renderer.requestWorkerTile(job);
    const key = "7/0:0/2";
    const oldBitmap = { close: vi.fn() };
    requests[0].resolve({ pageId: "page", cell: "0:0", density: 2, revision: 1, renderGeneration: 1,
      x: 0, y: 0, width: 128, height: 128, canvasWidth: 264, canvasHeight: 264, bitmap: oldBitmap });
    await Promise.resolve();
    expect(oldBitmap.close).toHaveBeenCalledOnce();
    expect(renderer.pendingTiles.get(key)).toBe(2);

    renderer.disposed = true;
    const currentBitmap = { close: vi.fn() };
    requests[1].resolve({ pageId: "page", cell: "0:0", density: 2, revision: 1, renderGeneration: 2,
      x: 0, y: 0, width: 128, height: 128, canvasWidth: 264, canvasHeight: 264, bitmap: currentBitmap });
    await Promise.resolve();
    expect(currentBitmap.close).toHaveBeenCalledOnce();
    expect(renderer.pendingTiles.has(key)).toBe(false);
  });

  it("cancels the previous backend when switching render backends", () => {
    const oldBackend = { renderTile: vi.fn(), cancelGeneration: vi.fn() };
    const nextBackend = { renderTile: vi.fn(), cancelGeneration: vi.fn() };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { backend: oldBackend, renderGeneration: 3, jobs: [], pendingTiles: new Map() });
    renderer.setBackend(nextBackend);
    expect(oldBackend.cancelGeneration).toHaveBeenCalledWith(4);
    expect(nextBackend.cancelGeneration).not.toHaveBeenCalled();
  });

  it("advances and cancels a render generation only once per ink pointerdown", () => {
    const cancelGeneration = vi.fn();
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      backend: { cancelGeneration }, renderGeneration: 3, frame: null, inkFrame: null,
      jobs: [{ cell: "0:0" }], pendingTiles: new Map([["tile", 3]]), inkCommit: null,
    });
    renderer.beginInput();
    renderer.pauseInkCommit();
    expect(renderer.renderGeneration).toBe(4);
    expect(cancelGeneration).toHaveBeenCalledOnce();
    expect(cancelGeneration).toHaveBeenCalledWith(4);
    expect(renderer.jobs).toEqual([]);
    expect(renderer.inkCommitPaused).toBe(true);
  });

  it("evicts least-recently-used tile canvases beyond the pixel budget", () => {
    const renderer = Object.create(TileRenderer.prototype) as any;
    const firstCanvas = { width: 4_000, height: 2_500 };
    const secondCanvas = { width: 3_000, height: 2_500 };
    const first = { used: 1, pixels: 10_000_000, node: { parentElement: null, remove: vi.fn() }, canvas: firstCanvas };
    const second = { used: 2, pixels: 7_500_000, node: { parentElement: null, remove: vi.fn() }, canvas: secondCanvas };
    Object.assign(renderer, { cache: new Map([["first", first], ["second", second]]), pixels: 17_500_000, host: {} });
    renderer.evict();
    expect(first.node.remove).toHaveBeenCalledOnce();
    expect(firstCanvas).toEqual({ width: 1, height: 1 });
    expect(renderer.cache.has("first")).toBe(false);
    expect(renderer.pixels).toBe(7_500_000);
  });
});
