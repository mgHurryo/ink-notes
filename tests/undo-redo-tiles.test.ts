import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { InkNotebook, InkStroke, createNotebook } from "../src/model";
import { NotebookStore } from "../src/storage";
import { StrokeIndex, TileRenderer } from "../src/tiles";
import { InkView } from "../src/view";

// Undo/redo rebuilds only the cells an edit touched (cell-granular revision
// invalidation) and, for history steps, mounts each replacement tile as soon
// as its render settles instead of holding the frame until the whole batch
// lands. The worker renders a batch cell by cell, so the atomic hold turned
// every multi-cell undo/redo into one frozen frame of serialized renders.

let frames: Array<() => void> = [];
function drainFrames(): void {
  const pending = frames;
  frames = [];
  for (const frame of pending) frame();
}

async function flushRenders(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function stroke(id: string, x: number, y: number): InkStroke {
  const points = Array.from({ length: 8 }, (_, index) => ({
    x: x + index * 0.002, y: y + (index % 2) * 0.001, pressure: 0.5, t: index * 8,
  }));
  return { id, pageId: "page", tool: "pen", width: 3, opacity: 1, color: "#111", createdAt: 1, updatedAt: 1, points };
}

interface FakeTileNode {
  dataset: Record<string, string>;
  parentElement: unknown;
  remove(): void;
}

function buildRenderer(cellsAcross: number, page: InkNotebook["pages"][number], cellsDown = cellsAcross) {
  const index = new StrokeIndex(cellsAcross * 128, cellsDown * 128);
  const active = { page, index, id: 1, syncedStrokes: null, syncedPageRevision: -1 };
  const hostChildren: FakeTileNode[] = [];
  const host = {
    children: hostChildren,
    childElementCount: 0,
    appendChild(node: FakeTileNode) {
      node.parentElement = host;
      if (!hostChildren.includes(node)) hostChildren.push(node);
      host.childElementCount = hostChildren.length;
    },
    querySelector(selector: string) {
      const cell = selector.split('"')[1];
      return hostChildren.find((node) => node.dataset.cell === cell) ?? null;
    },
    replaceChildren() { hostChildren.length = 0; host.childElementCount = 0; },
    ownerDocument: { createElement: () => ({ className: "", style: {}, appendChild() {}, childElementCount: 0 }) },
  };
  // renderTile promises settle only when the test resolves a cell's gate, so
  // per-tile mounting is observable independently of the batch's other cells.
  const gates = new Map<string, (result: unknown) => void>();
  const settled: string[] = [];
  const backend = {
    renderTile: vi.fn((pageId: string, cell: string, density: number, revision: number, _w: number, _h: number,
      generation: number) => new Promise((resolve) => {
      gates.set(cell, () => {
        settled.push(cell);
        resolve({ pageId, cell, density, revision, renderGeneration: generation, x: 0, y: 0, width: 128, height: 128,
          canvasWidth: 8, canvasHeight: 8, bitmap: { close() {} } });
      });
    })),
    cancelGeneration: vi.fn(),
  };
  const renderer = Object.create(TileRenderer.prototype) as unknown as Record<string, any>;
  Object.assign(renderer, {
    disposed: false, inkCommitPaused: false, gestureActive: false, droppedRefine: false,
    inkCommit: null, inkFrame: null, frame: null, ghost: null, ghostBaseWidth: 128,
    backend, renderGeneration: 1, sequence: 0, pixels: 0,
    cache: new Map(), heldCells: new Set(), pendingTiles: new Map(), jobs: [],
    visible: new Set(), density: 1,
    viewport: { x: 0, y: 0, width: cellsAcross * 128, height: cellsAcross * 128 },
    active, states: new Map([[page, active]]), host,
  });
  // Tile fabrication needs document/canvas, unavailable in the node
  // environment; the measured contract (invalidation locality, mounting
  // order) runs before and after fabrication.
  const makeNode = (cell: string): FakeTileNode => ({
    dataset: { cell }, parentElement: null,
    remove() { this.parentElement = null; const at = hostChildren.indexOf(this); if (at >= 0) { hostChildren.splice(at, 1); host.childElementCount = hostChildren.length; } },
  });
  renderer.tileFromBitmap = (job: { state: unknown; cell: string; density: number }, result: { revision: number }) => {
    const node = makeNode(job.cell);
    return { node, canvas: { width: 8, height: 8 }, revision: result.revision, pixels: 64, used: ++renderer.sequence,
      state: job.state, cell: job.cell, density: job.density };
  };
  renderer.paint = (job: { state: unknown; cell: string; density: number }) => {
    const node = makeNode(job.cell);
    const tile = { node, canvas: { width: 8, height: 8 }, revision: renderer.active.index.revisions.get(job.cell) ?? 0,
      pixels: 64, used: ++renderer.sequence, state: job.state, cell: job.cell, density: job.density };
    renderer.cacheTile(tile);
    return tile;
  };
  renderer.sizeTile = () => undefined;
  const populatedCells = (): void => {
    for (const cell of renderer.visible) renderer.paint({ state: renderer.active, cell, density: 1 });
  };
  return { renderer, index, backend, hostChildren, gates, settled, populatedCells };
}

describe("undo/redo tile commit", () => {
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: () => void) => { frames.push(callback); return frames.length; }));
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllGlobals();
  });

  it("invalidates only the cells an undone stroke occupies, reusing the rest of the cache", () => {
    const page = createNotebook().pages[0];
    const { renderer, index, backend, populatedCells } = buildRenderer(8, page);
    const strokes = Array.from({ length: 300 }, (_, i) =>
      stroke("s" + i, (i % 8) * 0.125 + 0.01, Math.floor((i % 64) / 8) * 0.125 + 0.01));
    index.sync(strokes);
    renderer.visible = new Set(index.revisions.keys());
    populatedCells();
    const cachedBefore = renderer.cache.size;
    expect(cachedBefore).toBe(64);

    // undo of one drawn stroke = removal from the index (addedStrokeCommand)
    const affected = index.cellsFor([strokes[150]]);
    index.patch([], [strokes[150].id], strokes.filter((s) => s.id !== strokes[150].id));
    renderer.patchStrokes([], [strokes[150].id], strokes.filter((s) => s.id !== strokes[150].id));

    renderer.commitInteractive(renderer.viewport, 1, true);
    drainFrames();
    const requested = backend.renderTile.mock.calls.map((call) => call[1] as string);
    expect(requested.length).toBeGreaterThan(0);
    for (const cell of requested) expect(affected).toContain(cell);
    // Cache hit rate does not collapse: the other visible cells keep serving
    // their rasters instead of re-rasterizing with the edit.
    expect(requested.length).toBeLessThan(renderer.visible.size);
    expect(requested.length).toBeLessThanOrEqual(affected.length);
    renderer.dispose?.();
  });

  it("keeps cell content identical across an erase undo/redo round trip", () => {
    const page = createNotebook().pages[0];
    const { renderer, index } = buildRenderer(8, page);
    const strokes = Array.from({ length: 120 }, (_, i) =>
      stroke("s" + i, (i % 8) * 0.125 + 0.01, Math.floor((i % 64) / 8) * 0.125 + 0.01));
    index.sync(strokes);
    const fragments = Array.from({ length: 10 }, (_, i) =>
      ({ ...stroke("frag" + i, 0.1 + i * 0.01, 0.5), createdAt: 0 }));
    // Erase commits fragments; the mirror order array is the page's stroke list.
    index.patch(fragments, [], strokes);
    const erasedRegion = index.query({ x: 0.09 * 1024, y: 0.4 * 1024, width: 0.2 * 1024, height: 0.2 * 1024 });

    // undo: originals return with fresh ids, fragments leave
    const restored = fragments.map((fragment) => ({ ...stroke("undo-" + fragment.id, fragment.points[0].x, fragment.points[0].y) }));
    index.patch(restored, fragments.map((fragment) => fragment.id), strokes);
    // redo: fragments return with fresh ids, the restored copies leave
    const redone = restored.map((original) => ({ ...stroke("redo-" + original.id, original.points[0].x, original.points[0].y) }));
    index.patch(redone, restored.map((original) => original.id), strokes);
    // undo again: the eraser's originals are restored once more
    const restoredAgain = redone.map((fragment) => ({ ...stroke("undo2-" + fragment.id, fragment.points[0].x, fragment.points[0].y) }));
    index.patch(restoredAgain, redone.map((fragment) => fragment.id), strokes);

    const region = index.query({ x: 0.09 * 1024, y: 0.4 * 1024, width: 0.2 * 1024, height: 0.2 * 1024 });
    expect(region.map((s) => s.points)).toEqual(erasedRegion.map((s) => s.points));
    expect(region.some((s) => s.id.startsWith("frag-") || s.id.startsWith("redo-"))).toBe(false);
    renderer.dispose?.();
  });

  it("mounts each settled history tile without waiting for the rest of the batch", async () => {
    const page = createNotebook().pages[0];
    const { renderer, index, backend, hostChildren, gates, populatedCells } = buildRenderer(8, page);
    // Background strokes keep the edited cells non-empty: an undo that empties
    // a cell removes its node instead of re-rendering it (hasCell gate).
    const bgA = stroke("bg-a", 0.06, 0.02);
    const bgB = stroke("bg-b", 0.56, 0.02);
    const a = stroke("a", 0.02, 0.02);
    const b = stroke("b", 0.52, 0.02);
    index.sync([bgA, bgB, a, b]);
    renderer.visible = new Set(index.revisions.keys());
    populatedCells();

    // One undo removing strokes from two cells (an erased pair restored).
    const affected = [...new Set([...index.cellsFor([a]), ...index.cellsFor([b])])];
    index.patch([], [a.id, b.id], [bgA, bgB]);
    renderer.patchStrokes([], [a.id, b.id], [bgA, bgB]);

    renderer.commitInteractive(renderer.viewport, 1, true, () => undefined, true);
    drainFrames();
    // The whole affected batch dispatches in the same frame.
    const requested = backend.renderTile.mock.calls.map((call) => call[1] as string);
    expect(requested.sort()).toEqual([...affected].sort());
    expect(requested.length).toBe(2);

    // The first settled tile mounts before the second render settles.
    gates.get(requested[0])!(undefined);
    await flushRenders();
    const mountedIds = hostChildren.map((node) => node.dataset.cell);
    expect(mountedIds).toContain(requested[0]);
    expect(renderer.cache.get("1/" + requested[0] + "/1")).toBeDefined();

    // The last settle finishes the commit and releases the holds.
    gates.get(requested[1])!(undefined);
    await flushRenders();
    expect([...renderer.heldCells]).toEqual([]);
    expect(renderer.inkCommit).toBeNull();
    expect(hostChildren.map((node) => node.dataset.cell).sort()).toEqual([...affected].sort());
    renderer.dispose?.();
  });

  it("keeps gesture commits atomic: no tile mounts before the whole batch settles", async () => {
    const page = createNotebook().pages[0];
    const { renderer, index, backend, hostChildren, gates, populatedCells } = buildRenderer(8, page);
    const bgA = stroke("bg-a", 0.06, 0.02);
    const bgB = stroke("bg-b", 0.56, 0.02);
    const a = stroke("a", 0.02, 0.02);
    const b = stroke("b", 0.52, 0.02);
    index.sync([bgA, bgB, a, b]);
    renderer.visible = new Set(index.revisions.keys());
    populatedCells();
    index.patch([], [a.id, b.id], [bgA, bgB]);
    renderer.patchStrokes([], [a.id, b.id], [bgA, bgB]);

    // Default (no progressive flag): the eraser/lasso atomic swap contract.
    renderer.commitInteractive(renderer.viewport, 1, true);
    drainFrames();
    const requested = backend.renderTile.mock.calls.map((call) => call[1] as string);
    expect(requested.length).toBe(2);
    gates.get(requested[0])!(undefined);
    await flushRenders();
    expect(hostChildren.map((node) => node.dataset.cell)).toEqual([]);
    gates.get(requested[1])!(undefined);
    await flushRenders();
    expect(hostChildren.map((node) => node.dataset.cell).sort()).toEqual(requested.sort());
    renderer.dispose?.();
  });
});

describe("undo/redo progressive tile mount through the view", () => {
  beforeEach(() => {
    frames = [];
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: () => void) => { frames.push(callback); return frames.length; }));
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function pointer(x: number, options: Partial<PointerEvent> = {}): PointerEvent {
    return {
      pointerId: 7, pointerType: "pen", clientX: x, clientY: 20,
      pressure: 0.5, tiltX: 0, tiltY: 0, preventDefault: vi.fn(),
      timeStamp: 1000, ...options,
    } as PointerEvent;
  }

  it("mounts settled tiles progressively when a real undo commits", async () => {
    const store = { read: vi.fn(), save: vi.fn() };
    const view = new InkView({} as WorkspaceLeaf, store as unknown as NotebookStore);
    const internal = view as unknown as Record<string, any>;
    view.file = {} as TFile;
    internal.notebook = createNotebook();
    const page = internal.notebook.pages[0];
    const captured = new Set<number>();
    internal.canvas = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
      setPointerCapture: (id: number) => { captured.add(id); },
      hasPointerCapture: (id: number) => captured.has(id),
      releasePointerCapture: (id: number) => { captured.delete(id); },
    } as HTMLCanvasElement;
    Object.assign(internal, { ctx: { clearRect: vi.fn() }, drawSelection: vi.fn() });
    Object.assign(internal, {
      pageElement: internal.canvas,
      drawPreview: vi.fn(), requestRender: vi.fn(),
      refreshCurrentPageThumbnail: vi.fn(), resizePreview: vi.fn(),
      canvasLogicalWidth: 896, canvasLogicalHeight: 128,
      viewport: { x: 0, y: 0, width: 896, height: 128 },
    });
    // The real pen-up flow routes strokes through the pending-ink preview and
    // its deferred tile commit; mocking commitPreview would leave the index empty.
    internal.commitPreview = (InkView.prototype as unknown as { commitPreview: (page?: never) => void }).commitPreview.bind(internal);
    internal.renderAll = vi.fn();
    internal.updateHistoryButtons = vi.fn();
    internal.state.pen.smooth = 0;

    // A real TileRenderer prototype instance over the live page object, so
    // undo walks the production patch → commit chain against real revisions.
    const { renderer, index, backend, hostChildren, gates } = buildRenderer(7, page, 1);
    Object.assign(internal, { tiles: renderer });
    index.sync([]);

    // Two one-cell strokes far apart (896 logical px / 128 px cells). The
    // deferred pen-up commit indexes them; its render gates settle below.
    internal.onPointerDown(pointer(5));
    internal.onPointerUp(pointer(12));
    internal.onPointerDown(pointer(30));
    internal.onPointerUp(pointer(37));
    expect(page.strokes).toHaveLength(2);
    vi.advanceTimersByTime(180);
    drainFrames();
    const strokeCells = page.strokes.map((stroke: InkStroke) => index.cellsFor([stroke]));
    expect(new Set(strokeCells.flat())).toHaveLength(2);
    for (const cell of backend.renderTile.mock.calls.map((call) => call[1] as string)) gates.get(cell)!(undefined);
    await flushRenders();
    backend.renderTile.mockClear();
    // Populate every visible cell's cache so the undo re-renders exactly the
    // two edited cells instead of the whole viewport.
    renderer.visible = new Set(index.revisions.keys());
    for (const cell of renderer.visible) renderer.paint({ state: renderer.active, cell, density: 1 });

    // Select both and delete through the production path: the delete's own
    // commit clears the emptied cells without render jobs, and the undo then
    // restores both strokes in one erasedStrokesCommand (a two-cell batch).
    internal.selectedStrokeIds = new Set(page.strokes.map((stroke: InkStroke) => stroke.id));
    internal.deleteSelection();
    expect(page.strokes).toHaveLength(0);
    drainFrames();
    expect(backend.renderTile).not.toHaveBeenCalled();

    internal.undo();
    expect(page.strokes).toHaveLength(2);
    drainFrames();
    const requested = backend.renderTile.mock.calls.map((call) => call[1] as string);
    expect(requested.sort()).toEqual([...new Set(strokeCells.flat())].sort());

    // The first settled tile mounts without waiting for the second render.
    gates.get(requested[0])!(undefined);
    await flushRenders();
    expect(hostChildren.map((node) => node.dataset.cell)).toContain(requested[0]);
    gates.get(requested[1])!(undefined);
    await flushRenders();
    expect(hostChildren.map((node) => node.dataset.cell).sort()).toEqual(requested);
    renderer.dispose?.();
  });
});
