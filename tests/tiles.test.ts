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
    expect(index.hasCell("1:1")).toBe(true);
    expect(index.hasCell("7:7")).toBe(false);
  });
  it("exposes bounded spatial queries through the tile renderer", () => {
    const candidate = stroke("candidate", 0.24, 0.24);
    const query = vi.fn(() => [candidate]);
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { active: { index: { query } } });
    const bounds = { x: 200, y: 200, width: 100, height: 100 };
    expect(renderer.query(bounds)).toEqual([candidate]);
    expect(query).toHaveBeenCalledWith(bounds);
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
  it("acknowledges verified metadata without repainting but still detects unindexed local edits", () => {
    const index = new StrokeIndex(1000,1000), a = stroke("a",.1,.1);
    index.sync([a]); const revisions = [...index.revisions];
    a.updatedAt = 2; index.acknowledgeMetadata(a,1); index.sync([a]);
    expect([...index.revisions]).toEqual(revisions);
    a.points[0].pressure = .9; a.updatedAt = 3;
    a.updatedAt = 4; index.acknowledgeMetadata(a,3); index.sync([a]);
    expect([...index.revisions]).not.toEqual(revisions);
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
  it("pads registration by the index width so wide-page tiles cover the rendered ink", () => {
    // Rendered half-width at this index: 0.65 * 24 * (1960/980) = 31.2px, so
    // ink centered at y ≈ 487 reaches y ≈ 518 across the 512 cell boundary,
    // while the fixed 24*0.7+4 = 20.8 padding stopped at y ≈ 508 and left
    // cell 4:4 unregistered (a permanent paint gap on wide PDF panes).
    const index = new StrokeIndex(1960, 1960);
    const wide: InkStroke = { id: "wide", pageId: "page", tool: "pen", width: 24, opacity: 1, color: "#111",
      createdAt: 1, updatedAt: 1,
      points: [{ x: 0.3, y: 487 / 1960, pressure: 1, t: 0 }, { x: 0.7, y: 487 / 1960, pressure: 1, t: 8 }] };
    index.sync([wide]);
    expect(index.query({ x: 512, y: 512, width: 128, height: 128 })).toContain(wide);
  });
  it("keeps the reference-width registration identical for capped notebook pages", () => {
    const index = new StrokeIndex(980, 980);
    const wide: InkStroke = { id: "wide", pageId: "page", tool: "pen", width: 24, opacity: 1, color: "#111",
      createdAt: 1, updatedAt: 1,
      points: [{ x: 0.3, y: 487 / 1960, pressure: 1, t: 0 }, { x: 0.7, y: 487 / 1960, pressure: 1, t: 8 }] };
    index.sync([wide]);
    // notebook layout caps the index at STROKE_WIDTH_REFERENCE, where the
    // width-scaled padding reduces to the historical fixed padding: the
    // registered cells must not grow or shrink.
    const padding = 24 * 0.7 + 4;
    const expected = cellKeys({ x: 0.3 * 980 - padding, y: (487 / 1960) * 980 - padding,
      width: (0.7 - 0.3) * 980 + padding * 2, height: padding * 2 }, 980, 980);
    for (const cell of expected) expect(index.hasCell(cell)).toBe(true);
    expect(index.revisions.size).toBe(expected.length);
  });
});

describe("interactive tile commits", () => {
  it("submits the queued tile batch to the worker in one animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    const state = { id: 1, page: { id: "page" }, index: { width: 384, height: 128,
      revisions: new Map([["0:0", 1], ["1:0", 1], ["2:0", 1]]) } };
    const backend = { renderTile: vi.fn(() => new Promise(() => {})) };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { backend, disposed: false, inkCommitPaused: false, inkCommit: null, frame: null,
      active: state, renderGeneration: 1, pendingTiles: new Map(), cache: new Map(), jobs: ["0:0", "1:0", "2:0"]
        .map(cell => ({ state, cell, density: 1, priority: "visible" })), visible: new Set(["0:0", "1:0", "2:0"]),
      schedule: (TileRenderer.prototype as any).schedule, get: vi.fn(() => undefined), isHeld: vi.fn(() => false),
      key: (jobState: any, cell: string, density: number) => `${jobState.id}/${cell}/${density}` });

    renderer.schedule();
    frames.shift()!(0);

    expect(backend.renderTile).toHaveBeenCalledTimes(3);
    expect(renderer.jobs).toEqual([]);
    expect(frames).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("keeps main-thread tile painting limited to one tile per animation frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    const state = { id: 1 };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { backend: null, disposed: false, inkCommitPaused: false, inkCommit: null, frame: null,
      active: state, jobs: ["0:0", "1:0", "2:0"].map(cell => ({ state, cell, density: 1 })),
      visible: new Set(["0:0", "1:0", "2:0"]), schedule: (TileRenderer.prototype as any).schedule,
      get: vi.fn(() => undefined), isHeld: vi.fn(() => false), paint: vi.fn(job => job), attach: vi.fn(), evict: vi.fn() });

    renderer.schedule();
    frames.shift()!(0);

    expect(renderer.paint).toHaveBeenCalledOnce();
    expect(renderer.jobs).toHaveLength(2);
    expect(frames).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("preserves full 2x density for an iPad-sized viewport", () => {
    expect(tileDensity({ x: 0, y: 0, width: 1024, height: 1366 }, 2)).toBe(2);
  });

  it("does not undersample high-DPR tiles after zooming in", () => {
    expect(tileDensity({ x: 0, y: 0, width: 342, height: 455 }, 6)).toBe(6);
  });

  it("keeps tile bleed in logical pixels at high density", () => {
    const originalDocument = globalThis.document;
    const setCssStyles = function(this: { style: object }, styles: object) { Object.assign(this.style, styles); };
    const canvas: any = { width: 0, height: 0, style: {}, setCssStyles, getContext: vi.fn(() => ({ setTransform: vi.fn() })) };
    const node: any = { dataset: {} as Record<string, string>, style: {}, setCssStyles, appendChild: vi.fn() };
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

  it("keeps a complete visible tile frame mounted during scrolling within the same cells", () => {
    const host = { childElementCount: 1 };
    const node = { parentElement: host };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([ ["0:0", 0] ]) } };
    const tile = { node, revision: 0 };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 1, visible: new Set(["0:0"]),
      cache: new Map([["1/0:0/1", tile]]), jobs: [{ cell: "0:0" }], viewport: { x: 0, y: 0, width: 100, height: 100 },
      attach: vi.fn(), schedule: vi.fn(),
    });
    const queuedJobs = renderer.jobs;

    renderer.update({ x: 12, y: 18, width: 100, height: 100 }, 1, false);

    expect(renderer.viewport).toEqual({ x: 12, y: 18, width: 100, height: 100 });
    expect(renderer.attach).not.toHaveBeenCalled();
    expect(renderer.schedule).not.toHaveBeenCalled();
    expect(renderer.jobs).toBe(queuedJobs);
  });

  it("skips the per-frame refine rebuild once every visible cell holds its exact raster", () => {
    const host = { children: [] };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 3]]), hasCell: () => true } };
    const tile = { node: { parentElement: host }, revision: 3 };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 }, jobs: [{ cell: "9:9", priority: "prewarm" }],
      get: vi.fn(() => tile), attach: vi.fn(), schedule: vi.fn(),
    });
    const queuedJobs = renderer.jobs;

    renderer.update({ x: 0, y: 0, width: 100, height: 100 }, 2, true);

    expect(renderer.get).toHaveBeenCalledWith(state, "0:0", 2);
    expect(renderer.jobs).toBe(queuedJobs);
    expect(renderer.attach).not.toHaveBeenCalled();
    expect(renderer.schedule).not.toHaveBeenCalled();
  });

  it("rebuilds the refine queue when a visible cell lost its exact raster", () => {
    const host = { children: [] };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 4]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 }, jobs: [], heldCells: new Set(),
      cache: new Map(), get: vi.fn(() => undefined), schedule: vi.fn(),
    });

    renderer.update({ x: 0, y: 0, width: 100, height: 100 }, 2, true);

    expect(renderer.schedule).toHaveBeenCalledOnce();
    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "0:0", density: 2, priority: "visible" })]);
  });

  it("queues only visible cells that contain strokes", () => {
    const renderer = Object.create(TileRenderer.prototype) as any;
    const active = { id: 1, index: { width: 256, height: 128, revisions: new Map([["1:0", 1]]),
      hasCell: (cell: string) => cell === "1:0" } };
    Object.assign(renderer, { active, disposed: false, host: { children: [] }, density: 1,
      visible: new Set(), viewport: { x: 0, y: 0, width: 1, height: 1 }, jobs: [], heldCells: new Set(),
      cache: new Map(), get: vi.fn(() => undefined), fallback: vi.fn(() => undefined), schedule: vi.fn() });

    renderer.update({ x: 0, y: 0, width: 256, height: 128 }, 1, true);

    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "1:0", priority: "visible" })]);
    expect(renderer.jobs).toHaveLength(1);
  });

  it("removes an obsolete visible tile after its last stroke is deleted", () => {
    const children: any[] = [];
    const staleNode = { dataset: { cell: "0:0" }, remove: vi.fn(() => { children.splice(children.indexOf(staleNode), 1); }) };
    children.push(staleNode);
    const renderer = Object.create(TileRenderer.prototype) as any;
    const active = { id: 1, index: { width: 128, height: 128, revisions: new Map([["0:0", 2]]), hasCell: () => false } };
    Object.assign(renderer, { active, disposed: false, host: { children, querySelector: (selector: string) =>
      selector === '[data-cell="0:0"]' ? children.find(node => node.dataset.cell === "0:0") ?? null : null },
      density: 1, visible: new Set(["0:0"]), viewport: { x: 0, y: 0, width: 128, height: 128 }, jobs: [],
      heldCells: new Set(), cache: new Map(), get: vi.fn(() => undefined), fallback: vi.fn(() => undefined), schedule: vi.fn() });

    renderer.update({ x: 0, y: 0, width: 128, height: 128 }, 1, true);

    expect(staleNode.remove).toHaveBeenCalledOnce();
    expect(renderer.jobs).toEqual([]);
  });

  it("composes newly added ink over an exact stale tile without replaying history", () => {
    const addition = stroke("new", 0.1, 0.1);
    const state = { id: 3, index: {
      revisions: new Map([["0:0", 8]]),
      cellsFor: vi.fn(() => ["0:0"]), hasCell: (cell: string) => cell === "0:0",
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
    const active = { id: 1, index: { width: 400, height: 600, revisions: new Map(), hasCell: () => true } };
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
    const active = { id: 1, index: { width: 400, height: 600, revisions: new Map(), hasCell: () => true } };
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
    const active = { id: 1, index: { width: 512, height: 512, revisions: new Map([["0:0", 2], ["3:3", 2]]),
      hasCell: (cell: string) => cell === "0:0" } };
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

  it("keeps the current zoom raster when an older density completes late", async () => {
    const requests: Array<(value: any) => void> = [];
    const state = { id: 7, page: { id: "page" }, index: { revisions: new Map([["0:0", 1]]) } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      backend: { renderTile: vi.fn(() => new Promise(resolve => requests.push(resolve))) },
      active: state, density: 3, disposed: false, renderGeneration: 1, pendingTiles: new Map(),
      cache: new Map(), visible: new Set(["0:0"]),
      tileFromBitmap: vi.fn((job: any) => ({ ...job, revision: 1 })),
      cacheTile: vi.fn((tile: any) => renderer.cache.set(`7/0:0/${tile.density}`, tile)),
      attach: vi.fn(), evict: vi.fn(), schedule: vi.fn(), backendError: vi.fn(),
    });
    for (const density of [1, 3]) renderer.requestWorkerTile({ state, cell: "0:0", density });
    const result = (density: number) => ({ pageId: "page", cell: "0:0", density, revision: 1, renderGeneration: 1 });
    requests[1](result(3));
    await Promise.resolve();
    const current = renderer.cache.get("7/0:0/3");
    expect(renderer.attach).toHaveBeenLastCalledWith(current);
    requests[0](result(1));
    await Promise.resolve();
    expect(renderer.attach).toHaveBeenLastCalledWith(current);
    expect(renderer.backendError).not.toHaveBeenCalled();
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

  it("aborts an ink commit stranded by beginInput when its stale result returns", async () => {
    const proto = TileRenderer.prototype as any;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    const requests: Array<{ resolve: (value: any) => void }> = [];
    const backend = { renderTile: vi.fn(() => new Promise((resolve) => requests.push({ resolve }))), cancelGeneration: vi.fn() };
    const state = { id: 1, page: { id: "page" }, index: { width: 128, height: 128, revisions: new Map([["0:0", 1]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    const onComplete = vi.fn();
    Object.assign(renderer, { backend, disposed: false, inkCommitPaused: false, inkCommit: null, inkFrame: null,
      frame: null, active: state, renderGeneration: 0, pendingTiles: new Map(), cache: new Map(), jobs: [],
      heldCells: new Set(), droppedRefine: false, host: { children: [] },
      schedule: vi.fn(function(this: any) { proto.schedule.call(this); }) });
    const viewport = { x: 0, y: 0, width: 128, height: 128 };
    renderer.commitInteractive(viewport, 3, true, onComplete);
    frames.shift()!(0);

    // The worker cannot abort an in-flight render, so beginInput() leaves the
    // result to return later echoing its request-time generation.
    const staleBitmap = { close: vi.fn() };
    renderer.beginInput();
    requests[0].resolve({ pageId: "page", cell: "0:0", density: 3, revision: 1, renderGeneration: 1,
      x: 0, y: 0, width: 128, height: 128, canvasWidth: 264, canvasHeight: 264, bitmap: staleBitmap });
    await Promise.resolve();

    expect(staleBitmap.close).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(false);
    expect(renderer.inkCommit).toBeNull();
    expect(renderer.heldCells.has("1/0:0")).toBe(false);
    // Settling the stranded commit also compensates the refine work that
    // beginInput() dropped while the commit was live, so schedule() runs for
    // the rebuilt queue in addition to the settle's own unblock.
    expect(renderer.schedule).toHaveBeenCalled();
    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "0:0", density: 3, priority: "visible" })]);
    vi.unstubAllGlobals();
  });

  it("closes only the stale bitmap when an aborted commit's result returns after a replacement", async () => {
    const proto = TileRenderer.prototype as any;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
    const requests: Array<{ resolve: (value: any) => void }> = [];
    const backend = { renderTile: vi.fn(() => new Promise((resolve) => requests.push({ resolve }))), cancelGeneration: vi.fn() };
    const state = { id: 1, page: { id: "page" }, index: { width: 128, height: 128, revisions: new Map([["0:0", 1]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    const firstComplete = vi.fn(), secondComplete = vi.fn();
    Object.assign(renderer, { backend, disposed: false, inkCommitPaused: false, inkCommit: null, inkFrame: null,
      frame: null, active: state, renderGeneration: 0, pendingTiles: new Map(), cache: new Map(), jobs: [],
      heldCells: new Set(), droppedRefine: false, host: { children: [] },
      schedule: vi.fn(function(this: any) { proto.schedule.call(this); }) });
    const viewport = { x: 0, y: 0, width: 128, height: 128 };
    renderer.commitInteractive(viewport, 3, true, firstComplete);
    frames.shift()!(0);

    renderer.cancelInkCommit();
    expect(firstComplete).toHaveBeenCalledWith(false);
    renderer.commitInteractive(viewport, 3, true, secondComplete);
    frames.shift()!(0);
    const replacement = renderer.inkCommit;
    const staleBitmap = { close: vi.fn() };
    requests[0].resolve({ pageId: "page", cell: "0:0", density: 3, revision: 1, renderGeneration: 1,
      x: 0, y: 0, width: 128, height: 128, canvasWidth: 264, canvasHeight: 264, bitmap: staleBitmap });
    await Promise.resolve();

    expect(staleBitmap.close).toHaveBeenCalledOnce();
    expect(secondComplete).not.toHaveBeenCalled();
    expect(renderer.inkCommit).toBe(replacement);
    vi.unstubAllGlobals();
  });

  it("requeues a dropped full-density refine once the ink input ends", () => {
    const host = { children: [] };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 4]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 }, jobs: [], heldCells: new Set(),
      cache: new Map(), get: vi.fn(() => undefined), schedule: vi.fn(), scheduleInkCommit: vi.fn(),
      backend: null, renderGeneration: 0, frame: null, pendingTiles: new Map([["stale", 0]]),
      inkCommit: null, inkCommitPaused: false, droppedRefine: false,
    });

    renderer.update({ x: 0, y: 0, width: 100, height: 100 }, 2, true);
    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "0:0", density: 2, priority: "visible" })]);

    renderer.beginInput();
    expect(renderer.jobs).toEqual([]);

    renderer.resumeInkCommit();
    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "0:0", density: 2, priority: "visible" })]);
  });

  it("does not compensate when input began with no queued tile work", () => {
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 4]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host: { children: [] }, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 }, jobs: [], heldCells: new Set(), cache: new Map(),
      get: vi.fn(() => undefined), schedule: vi.fn(), scheduleInkCommit: vi.fn(),
      backend: null, renderGeneration: 0, frame: null, pendingTiles: new Map(),
      inkCommit: null, inkCommitPaused: false, droppedRefine: false,
    });

    renderer.beginInput();
    renderer.resumeInkCommit();

    expect(renderer.jobs).toEqual([]);
  });

  it("requeues refine work dropped with an aborted in-flight ink commit", () => {
    const host = { children: [] };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 4]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    // An interactive commit parks its tile jobs on the commit itself, not on
    // the ordinary queue, so beginInput() must consult the live commit too.
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 }, jobs: [], heldCells: new Set(),
      cache: new Map(), get: vi.fn(() => undefined), schedule: vi.fn(), scheduleInkCommit: vi.fn(),
      backend: null, renderGeneration: 0, frame: null, pendingTiles: new Map(),
      inkCommit: { state, strokes: [], cells: ["0:0"], clearCells: [],
        jobs: [{ state, cell: "0:0", density: 2, priority: "visible" }], tiles: [],
        onComplete: vi.fn(), invalid: false, generation: 0 },
      inkCommitPaused: false, droppedRefine: false,
    });

    renderer.beginInput();
    expect(renderer.droppedRefine).toBe(true);

    // pauseInkCommit() aborts the commit; resumeInkCommit() must settle the
    // orphaned cells instead of leaving stale rasters mounted.
    renderer.inkCommit = null;
    renderer.resumeInkCommit();
    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "0:0", density: 2, priority: "visible" })]);
  });

  it("keeps the dropped-refine flag when an interactive commit is still live at resume", () => {
    const host = { children: [] };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 4]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 }, jobs: [], heldCells: new Set(),
      cache: new Map(), pixels: 0, get: vi.fn(() => undefined), schedule: vi.fn(), scheduleInkCommit: vi.fn(),
      backend: null, renderGeneration: 0, frame: null, inkFrame: null, pendingTiles: new Map(),
      inkCommit: { state, strokes: [], cells: ["0:0"], clearCells: [],
        jobs: [{ state, cell: "0:0", density: 2, priority: "visible" }], tiles: [],
        onComplete: vi.fn(), invalid: false, generation: 0 },
      inkCommitPaused: false, droppedRefine: false,
    });

    renderer.beginInput();
    expect(renderer.droppedRefine).toBe(true);

    // An eraser gesture that erased nothing leaves the previous interactive
    // commit in flight: resume must keep the flag instead of swallowing it,
    // and finishInkCommit() compensates once the commit settles.
    renderer.resumeInkCommit();
    expect(renderer.droppedRefine).toBe(true);
    expect(renderer.jobs).toEqual([]);

    renderer.finishInkCommit(true);
    expect(renderer.droppedRefine).toBe(false);
    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "0:0", density: 2, priority: "visible" })]);
  });

  it("still rebuilds at resume when the dropped commit was aborted under pause", () => {
    const host = { children: [] };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 4]]), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 }, jobs: [], heldCells: new Set(),
      cache: new Map(), pixels: 0, get: vi.fn(() => undefined), schedule: vi.fn(), scheduleInkCommit: vi.fn(),
      backend: null, renderGeneration: 0, frame: null, inkFrame: null, pendingTiles: new Map(),
      inkCommit: { state, strokes: [], cells: ["0:0"], clearCells: [],
        jobs: [{ state, cell: "0:0", density: 2, priority: "visible" }], tiles: [],
        onComplete: vi.fn(), invalid: false, generation: 0 },
      inkCommitPaused: false, droppedRefine: false,
    });

    renderer.beginInput();
    // The pen path pauses before aborting: finishInkCommit() must leave the
    // flag for the gesture's own resume instead of consuming it mid-abort.
    renderer.inkCommitPaused = true;
    renderer.abortInkCommit(true);
    expect(renderer.droppedRefine).toBe(true);

    renderer.inkCommitPaused = false;
    renderer.inkCommit = null;
    renderer.resumeInkCommit();
    expect(renderer.jobs).toEqual([expect.objectContaining({ cell: "0:0", density: 2, priority: "visible" })]);
  });

  it("skips the compensation refine when every visible cell holds its exact raster", () => {
    const host = { children: [] };
    const state = { id: 1, index: { width: 256, height: 256, revisions: new Map([["0:0", 3]]), hasCell: () => true } };
    const tile = { node: { parentElement: host }, revision: 3 };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: state, disposed: false, host, density: 2, visible: new Set(["0:0"]),
      viewport: { x: 0, y: 0, width: 100, height: 100 },
      jobs: [{ cell: "9:9", priority: "prewarm" }], heldCells: new Set(), cache: new Map(),
      get: vi.fn(() => tile), attach: vi.fn(), schedule: vi.fn(), scheduleInkCommit: vi.fn(),
      backend: null, renderGeneration: 0, frame: null, pendingTiles: new Map([["stale", 0]]),
      inkCommit: null, inkCommitPaused: false, droppedRefine: false,
    });

    renderer.beginInput();
    expect(renderer.jobs).toEqual([]);

    renderer.resumeInkCommit();

    expect(renderer.jobs).toEqual([]);
    expect(renderer.attach).not.toHaveBeenCalled();
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

  it("does not queue a prewarm cell twice across repeated passes", () => {
    const page = { id: "neighbor", strokes: [] };
    const state = { id: 2, page, index: { width: 256, height: 256, revisions: new Map(), sync: vi.fn(), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, {
      active: { id: 1, page: { id: "active" }, index: { width: 256, height: 256, revisions: new Map() } },
      disposed: false, viewport: { x: 0, y: 0, width: 100, height: 100 }, density: 1,
      states: new Map([[page, state]]), get: vi.fn(() => undefined),
      jobs: [{ state, cell: "0:0", density: 1, priority: "prewarm" }],
      schedule: vi.fn(),
    });

    renderer.prewarm([page]);

    expect(renderer.jobs).toHaveLength(1);
    expect(renderer.jobs[0]).toMatchObject({ cell: "0:0", priority: "prewarm" });
  });

  it("passes the pending-stroke sync exclusion to worker tile requests", () => {
    const renderTile = vi.fn((_pageId: string, _cell: string, _density: number, _revision: number,
      _width: number, _height: number, _renderGeneration: number, _priority: "visible" | "prewarm",
      _excludedStrokeIds?: readonly string[]) => new Promise<never>(() => {}));
    const backend = { renderTile };
    const state = { id: 9, page: { id: "page" }, index: { width: 128, height: 128,
      revisions: new Map([["0:0", 1]]), sync: vi.fn() } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { backend, disposed: false, renderGeneration: 1, pendingTiles: new Map(),
      cache: new Map(), visible: new Set(["0:0"]), active: state, schedule: vi.fn(), backendError: vi.fn() });
    const pending = stroke("pending", 0.1, 0.1);
    renderer.sync([pending], new Set([pending.id]));

    renderer.requestWorkerTile({ state, cell: "0:0", density: 2, priority: "visible" });

    expect(renderTile).toHaveBeenCalledOnce();
    expect(renderTile.mock.calls[0][8]).toEqual(["pending"]);
  });

  it("drops the worker exclusion for strokes patched into the main index", () => {
    const renderTile = vi.fn((_pageId: string, _cell: string, _density: number, _revision: number,
      _width: number, _height: number, _renderGeneration: number, _priority: "visible" | "prewarm",
      _excludedStrokeIds?: readonly string[]) => new Promise<never>(() => {}));
    const backend = { renderTile };
    const state = { id: 9, page: { id: "page" }, index: { width: 128, height: 128,
      revisions: new Map([["0:0", 1]]), sync: vi.fn(), patch: vi.fn(() => []) } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { backend, disposed: false, renderGeneration: 1, pendingTiles: new Map(),
      cache: new Map(), visible: new Set(["0:0"]), active: state, schedule: vi.fn(), backendError: vi.fn() });
    const pending = stroke("pending", 0.1, 0.1);
    renderer.sync([pending], new Set([pending.id]));
    renderer.requestWorkerTile({ state, cell: "0:0", density: 2, priority: "visible" });
    expect(renderTile.mock.calls[0][8]).toEqual(["pending"]);

    // startPendingInkCommit patches the committing batch into the main index
    // before its tiles render; the exclusion must forget it or the committed
    // tiles would omit the very strokes they are committing.
    renderer.patchStrokes([pending], [], [pending]);
    renderer.renderGeneration = 2;
    renderer.pendingTiles.clear();
    renderer.requestWorkerTile({ state, cell: "0:0", density: 2, priority: "visible" });

    expect(renderTile).toHaveBeenCalledTimes(2);
    expect(renderTile.mock.calls[1][8]).toBeUndefined();
  });

  it("carries a setWorkerExclusion set into the commit's worker tile snapshot", () => {
    const active = { id: 1, index: { width: 400, height: 600, revisions: new Map(), hasCell: () => true } };
    const renderer = Object.create(TileRenderer.prototype) as any;
    Object.assign(renderer, { active, disposed: false, inkCommit: null, inkFrame: null, renderGeneration: 0,
      backend: null, host: { children: [] }, cache: new Map(), heldCells: new Set(), jobs: [],
      get: vi.fn(() => undefined), scheduleInkCommit: vi.fn() });

    // Lasso transitions refresh the exclusion without a sync; the commit that
    // follows must snapshot exactly that set or the worker redraws excluded
    // strokes into the replacement tiles.
    renderer.setWorkerExclusion(new Set(["sel-a", "sel-b"]));
    renderer.commitInteractive({ x: 0, y: 0, width: 400, height: 600 }, 3);

    expect([...renderer.inkCommit.excluded].sort()).toEqual(["sel-a", "sel-b"]);
  });
});
