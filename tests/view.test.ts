import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { InkNotebook, InkStroke, createNotebook, createPage } from "../src/model";
import { NotebookStore } from "../src/storage";
import type { InkWorkerResponse, NotebookOperation } from "../src/worker-protocol";
import { InkView } from "../src/view";

interface ViewInternals {
  notebook: InkNotebook;
  canvas: HTMLCanvasElement;
  previewCanvas: HTMLCanvasElement;
  confirmedPreviewCanvas: HTMLCanvasElement;
  confirmedPreviewCtx: CanvasRenderingContext2D;
  activeStroke: InkStroke | null;
  activePointerId: number | null;
  confirmedStrokeOutlines: Map<string, { points: Float32Array; sampleCount: number; mode: "pen" | "highlighter" }>;
  pageIndex: number;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onPointerCancel(event: PointerEvent): void;
  onLostPointerCapture(event: PointerEvent): void;
  onDocumentPointerEnd(event: PointerEvent): void;
  onUnloadFile(file: TFile): Promise<void>;
  drawStrokes(strokes: InkStroke[]): void;
  renderAll: () => void;
  renderPageRail: () => void;
  renderPage: () => void;
  updateHistoryButtons: () => void;
  save(file?: TFile): Promise<void>;
  addPage(): void;
  duplicateCurrentPage(): void;
  deleteCurrentPage(): void;
  moveCurrentPage(delta: number): void;
  navigateToPage(pageId: string): void;
  undo(): void;
  redo(): void;
  dirtyRevision: number;
  savedRevision: number;
  activeSave: Promise<void> | null;
  workerRevision: number;
  eraseAt(point: { x: number; y: number; pressure: number; t: number }, page?: InkNotebook["pages"][number], mode?: "stroke" | "circle" | "square", size?: number): boolean;
  finishLasso(page: InkNotebook["pages"][number]): void;
  queueWorkerOperation(operation: NotebookOperation, transfer?: Transferable[], onApplied?: (response: InkWorkerResponse) => void): void;
  state: {
    tool: string;
    pen: { color: string; width: number; opacity: number };
    highlighter: { color: string; width: number; opacity: number };
    eraserMode: "stroke" | "circle" | "square";
    eraserSize: number;
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pointer(x: number, options: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerId: 7, pointerType: "pen", clientX: x, clientY: 20,
    pressure: 0.5, tiltX: 0, tiltY: 0, preventDefault: vi.fn(),
    ...options,
  } as PointerEvent;
}

function setup() {
  const store = { read: vi.fn(), save: vi.fn() };
  const view = new InkView({} as WorkspaceLeaf, store as unknown as NotebookStore);
  const internal = view as unknown as ViewInternals;
  view.file = {} as TFile;
  internal.notebook = createNotebook();
  const captured = new Set<number>();
  internal.canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); },
  } as HTMLCanvasElement;
  internal.drawStrokes = vi.fn();
  Object.assign(internal, { ctx: { clearRect: vi.fn() }, drawSelection: vi.fn() });
  Object.assign(internal, {
    pageElement: internal.canvas,
    updateViewport: vi.fn(),
    resizePreview: vi.fn(),
    drawPreview: vi.fn(),
    commitPreview: vi.fn(),
    requestRender: vi.fn(),
    tiles: { sync: vi.fn(), patchStrokes: vi.fn(), commitInteractive: vi.fn(),
      commitInk: vi.fn((_strokes: unknown, _viewport: unknown, _density: number, complete: (committed: boolean) => void) => complete(true)),
      removeStrokes: vi.fn(), previewInteractiveCells: vi.fn(), beginInput: vi.fn(), pauseInkCommit: vi.fn(), resumeInkCommit: vi.fn(), cancelInkCommit: vi.fn() },
    canvasLogicalWidth: 100,
    canvasLogicalHeight: 100,
  });
  internal.renderAll = vi.fn();
  Object.assign(internal, { renderPageRail: vi.fn(), renderPage: vi.fn() });
  internal.updateHistoryButtons = vi.fn();
  return { store, view, internal, captured };
}

describe("consecutive handwriting input", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a new stroke alive when an old capture-loss event arrives for the same pen", () => {
    const { internal } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    internal.onPointerDown(pointer(30));
    internal.onLostPointerCapture(pointer(20));
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));

    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4, 0.5]]);
    expect(internal.activePointerId).toBeNull();
  });

  it("ignores stale capture loss dispatched while recapturing a reused Pencil pointer", () => {
    const { internal, captured } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));

    internal.canvas.setPointerCapture = (id: number) => {
      captured.delete(id);
      internal.onLostPointerCapture(pointer(20, { pointerId: id }));
      captured.add(id);
    };
    internal.onPointerDown(pointer(30));
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));

    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4, 0.5]]);
    expect(internal.activePointerId).toBeNull();
  });

  it.each(["InvalidStateError", "NotFoundError"])("accepts a reused Pencil pointer when recapture fails with %s", (name) => {
    const { internal } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    internal.canvas.setPointerCapture = () => { throw new DOMException("inactive pointer", name); };

    expect(() => internal.onPointerDown(pointer(30))).not.toThrow();
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));

    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4, 0.5]]);
    expect(internal.activePointerId).toBeNull();
  });

  it("keeps a reused Pencil pointer alive when the previous capture loss arrives late", () => {
    const { internal, captured } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));

    internal.canvas.setPointerCapture = () => { captured.clear(); };
    internal.onPointerDown(pointer(30));
    internal.onLostPointerCapture(pointer(20, { pressure: 0, buttons: 0 }));
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));

    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4, 0.5]]);
    expect(internal.activePointerId).toBeNull();
  });

  it("releases DOM pointer capture before completed-preview work", () => {
    const { internal, captured } = setup();
    const order: string[] = [];
    internal.canvas.releasePointerCapture = (id: number) => {
      captured.delete(id);
      order.push("release");
    };
    Object.assign(internal, {
      retainActivePreview: () => {
        order.push("preview");
      },
    });
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    expect(order).toEqual(["release", "preview"]);
    expect(internal.activePointerId).toBeNull();
    internal.onPointerDown(pointer(30));
    expect(internal.activePointerId).toBe(7);
    expect(internal.activeStroke?.points[0].x).toBeCloseTo(0.3);
  });

  it("does not treat capture loss as contact loss", () => {
    const { internal, captured } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    captured.clear();
    internal.onLostPointerCapture(pointer(0));
    expect(internal.activePointerId).toBe(7);
    internal.onPointerMove(pointer(30));
    internal.onPointerUp(pointer(40));
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("finishes an uncaptured Pencil stroke when it is released outside the page", () => {
    const { internal, captured } = setup();
    internal.canvas.setPointerCapture = () => { throw new DOMException("inactive pointer", "InvalidStateError"); };
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    captured.clear();
    internal.onLostPointerCapture(pointer(20));
    internal.onDocumentPointerEnd(pointer(90));

    expect(internal.activePointerId).toBeNull();
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2]);
  });

  it("does not sample pointercancel coordinates", () => {
    const { internal } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    internal.onPointerCancel(pointer(90));
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2]);
  });

  it("preserves short moves and pressure exactly as captured", () => {
    const { internal } = setup();
    internal.onPointerDown(pointer(10, { clientY: 20, pressure: 0.2 }));
    internal.onPointerMove(pointer(10.25, { clientY: 20, pressure: 0.8 }));
    internal.onPointerMove(pointer(12, { clientY: 20, pressure: 0.4 }));
    internal.onPointerUp(pointer(12, { clientY: 22, pressure: 0.6 }));
    const points = internal.notebook.pages[0].strokes[0].points;
    expect(points.map(({ x, y, pressure }) => [x, y, pressure])).toEqual([
      [0.1, 0.2, 0.2], [0.1025, 0.2, 0.8], [0.12, 0.2, 0.4], [0.12, 0.22, 0.6],
    ]);
  });

  it("reads layout once for all coalesced samples in one pointer event", () => {
    const { internal } = setup();
    const rect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100, x: 0, y: 0, right: 100, bottom: 100, toJSON: () => ({}) }));
    internal.canvas.getBoundingClientRect = rect;
    internal.onPointerDown(pointer(10));
    rect.mockClear();
    internal.onPointerMove(pointer(40, { getCoalescedEvents: () => [pointer(20), pointer(30)] }));
    expect(rect).toHaveBeenCalledOnce();
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("reads layout once when a Pencil stroke starts", () => {
    const { internal } = setup();
    const rect = vi.fn(() => ({ left: 0, top: 0, width: 100, height: 100, x: 0, y: 0, right: 100, bottom: 100, toJSON: () => ({}) }));
    internal.canvas.getBoundingClientRect = rect;
    internal.onPointerDown(pointer(10));
    expect(rect).toHaveBeenCalledOnce();
  });

  it("keeps an eraser reference hidden after pointer capture moves outside the page", () => {
    const { internal } = setup();
    const cursor = { toggleClass: vi.fn(), style: {} };
    Object.assign(internal, { eraserCursor: cursor });
    internal.state.tool = "eraser";
    internal.onPointerDown(pointer(50, { clientY: 50 }));
    internal.onPointerMove(pointer(120, { clientY: 50 }));
    expect(cursor.toggleClass).toHaveBeenLastCalledWith("is-stroke", true);
    expect(cursor.toggleClass).toHaveBeenCalledWith("is-visible", false);
  });

  it("uses a fixed hit radius for whole-stroke erasing regardless of eraser size", () => {
    const run = (size: number) => {
      const { internal } = setup();
      const page = internal.notebook.pages[0];
      page.strokes.push({
        id: `stroke-${size}`, pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
        points: [{ x: 0.5, y: 0.59, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
      });
      return internal.eraseAt({ x: 0.5, y: 0.5, pressure: 0.5, t: 2 }, page, "stroke", size);
    };
    expect(run(8)).toBe(true);
    expect(run(160)).toBe(true);
  });

  it("commits a cross-tile stroke erasure as one coherent visible update", () => {
    const { internal } = setup();
    const page = internal.notebook.pages[0];
    page.strokes.push({
      id: "cross-tile", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.05, y: 0.5, pressure: 0.5, t: 1 }, { x: 0.95, y: 0.5, pressure: 0.5, t: 2 }], createdAt: 1, updatedAt: 1,
    });
    internal.state.tool = "eraser";
    internal.state.eraserMode = "stroke";
    internal.onPointerDown(pointer(50, { clientY: 50 }));
    internal.onPointerUp(pointer(50, { clientY: 50 }));
    const tiles = (internal as unknown as { tiles: { commitInteractive: ReturnType<typeof vi.fn> } }).tiles;
    expect(page.strokes).toHaveLength(0);
    expect(tiles.commitInteractive).toHaveBeenCalledWith(expect.any(Object), 1, true);
  });

  it("splits a stroke around a circular local eraser", () => {
    const { internal } = setup();
    const page = internal.notebook.pages[0];
    page.strokes.push({
      id: "line", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.2, y: 0.5, pressure: 0.5, t: 1 }, { x: 0.8, y: 0.5, pressure: 0.5, t: 2 }], createdAt: 1, updatedAt: 1,
    });
    expect(internal.eraseAt({ x: 0.5, y: 0.5, pressure: 0.5, t: 3 }, page, "circle", 20)).toBe(true);
    expect(page.strokes).toHaveLength(2);
    expect(page.strokes.every((stroke) => stroke.id !== "line")).toBe(true);
    expect(page.strokes.flatMap((stroke) => stroke.points).every((point) => Math.hypot((point.x - 0.5) * 100, (point.y - 0.5) * 100) > 10)).toBe(true);
  });

  it("uses rectangular hit testing for the square local eraser", () => {
    const createPointStroke = () => {
      const { internal } = setup();
      const page = internal.notebook.pages[0];
      page.strokes.push({
        id: "corner", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
        points: [{ x: 0.58, y: 0.58, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
      });
      return { internal, page };
    };
    const circle = createPointStroke();
    expect(circle.internal.eraseAt({ x: 0.5, y: 0.5, pressure: 0.5, t: 2 }, circle.page, "circle", 20)).toBe(false);
    const square = createPointStroke();
    expect(square.internal.eraseAt({ x: 0.5, y: 0.5, pressure: 0.5, t: 2 }, square.page, "square", 20)).toBe(true);
  });

  it("tests eraser geometry only for spatial-index candidates", () => {
    const { internal } = setup();
    const page = internal.notebook.pages[0];
    const candidate = {
      id: "candidate", pageId: page.id, tool: "pen" as const, color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.5, y: 0.5, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    };
    const unrelated = { ...candidate, id: "unrelated", points: [{ x: 0.9, y: 0.9, pressure: 0.5, t: 1 }] };
    page.strokes.push(candidate, unrelated);
    const tiles = (internal as unknown as { tiles: { queryNear: ReturnType<typeof vi.fn> } }).tiles;
    tiles.queryNear = vi.fn(() => [candidate]);
    expect(internal.eraseAt({ x: 0.5, y: 0.5, pressure: 0.5, t: 2 }, page, "stroke", 160)).toBe(true);
    expect(tiles.queryNear).toHaveBeenCalledOnce();
    expect(page.strokes).toEqual([unrelated]);
  });

  it("commits cached lasso movement once and preserves undo and redo", () => {
    const { internal } = setup();
    const page = internal.notebook.pages[0];
    const stroke = {
      id: "selected", pageId: page.id, tool: "pen" as const, color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.2, y: 0.2, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    };
    page.strokes.push(stroke);
    Object.assign(internal, {
      lassoDrag: {
        start: { x: 0.2, y: 0.2 }, pageId: page.id,
        bounds: { minX: 0.2, minY: 0.2, maxX: 0.2, maxY: 0.2 }, strokes: [stroke],
        before: new Map([[stroke.id, structuredClone(stroke.points)]]), dx: 0.1, dy: 0.05,
      },
      commitLassoPreview: vi.fn(),
    });
    internal.finishLasso(page);
    expect(stroke.points[0].x).toBeCloseTo(0.3);
    expect(stroke.points[0].y).toBeCloseTo(0.25);
    internal.undo();
    expect(stroke.points[0]).toMatchObject({ x: 0.2, y: 0.2 });
    internal.redo();
    expect(stroke.points[0].x).toBeCloseTo(0.3);
    expect(stroke.points[0].y).toBeCloseTo(0.25);
  });

  it("locks the page and tool selected at pointerdown", () => {
    const { internal } = setup();
    internal.notebook.pages.push(createPage("Second"));
    internal.onPointerDown(pointer(10));
    (internal as unknown as { state: { tool: string } }).state.tool = "eraser";
    internal.pageIndex = 1;
    internal.onPointerUp(pointer(20));
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2]);
    expect(internal.notebook.pages[1].strokes).toEqual([]);
  });

  it("accepts many consecutive strokes without waiting for autosave", () => {
    const { internal, store } = setup();
    for (let i = 0; i < 40; i++) {
      internal.onPointerDown(pointer(10));
      internal.onPointerMove(pointer(20));
      internal.onPointerUp(pointer(30));
      internal.onLostPointerCapture(pointer(0));
    }
    expect(internal.notebook.pages[0].strokes).toHaveLength(40);
    expect(internal.notebook.pages[0].strokes.every((stroke) => stroke.points.length === 3)).toBe(true);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("keeps rapid Pencil strokes on the overlay until input becomes idle", async () => {
    const { internal } = setup();
    (internal as any).commitPreview = (InkView.prototype as any).commitPreview.bind(internal);
    const callbacks: Array<(committed: boolean) => void> = [];
    const tiles = (internal as any).tiles;
    tiles.commitInk.mockImplementation((_strokes: unknown, _viewport: unknown, _density: number,
      complete: (committed: boolean) => void) => { callbacks.push(complete); });

    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    expect(callbacks).toHaveLength(0);
    expect(tiles.commitInteractive).not.toHaveBeenCalled();
    expect(internal.activePointerId).toBeNull();

    internal.onPointerDown(pointer(30));
    expect(internal.activePointerId).toBe(7);
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));
    expect(internal.notebook.pages[0].strokes).toHaveLength(2);
    expect(callbacks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(179);
    expect(callbacks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks).toHaveLength(1);
    callbacks[0](true);
    expect((internal as any).pendingInkStrokes).toEqual([]);
    expect(tiles.pauseInkCommit).toHaveBeenCalledTimes(2);
  });

  it("materializes pending ink before an immediate switch to the eraser", () => {
    const { internal } = setup();
    (internal as any).commitPreview = (InkView.prototype as any).commitPreview.bind(internal);
    const tiles = (internal as any).tiles;
    tiles.patchStrokes.mockReturnValue(["0:0"]);

    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    const completed = internal.notebook.pages[0].strokes[0];
    internal.state.tool = "eraser";
    internal.onPointerDown(pointer(15));

    expect(tiles.patchStrokes.mock.calls[0][0]).toEqual([completed]);
    expect(tiles.patchStrokes.mock.calls[0][1]).toEqual([]);
    expect(tiles.previewInteractiveCells).toHaveBeenCalledWith(["0:0"], expect.any(Object), 1);
  });

  it("accepts the next Pencil stroke while a 500ms background tile task is pending", async () => {
    const { internal } = setup();
    (internal as any).commitPreview = (InkView.prototype as any).commitPreview.bind(internal);
    const tiles = (internal as any).tiles;
    tiles.commitInk.mockImplementation((_strokes: unknown, _viewport: unknown, _density: number,
      complete: (committed: boolean) => void) => window.setTimeout(() => complete(true), 500));

    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    internal.onPointerUp(pointer(30));
    (internal as any).startPendingInkCommit(internal.notebook.pages[0]);
    internal.onPointerDown(pointer(40));
    internal.onPointerMove(pointer(50));

    expect(internal.activePointerId).toBe(7);
    expect(internal.notebook.pages[0].strokes).toHaveLength(2);
    expect((internal as any).requestRender).toHaveBeenCalled();
    expect(tiles.beginInput).toHaveBeenCalledTimes(2);
    internal.onPointerUp(pointer(60));
    await vi.advanceTimersByTimeAsync(500);
  });

  it("accepts Pencil input while a 500ms Worker save preparation is pending", async () => {
    const { internal, store } = setup();
    const worker = {
      barrier: vi.fn(async () => 1),
      prepareSave: vi.fn(async () => {
        if (worker.prepareSave.mock.calls.length === 1) await new Promise((resolve) => window.setTimeout(resolve, 500));
        return { token: "slow-save", content: "worker-json", revision: 1 };
      }),
      commitSave: vi.fn(async () => ({ revision: 1 })),
      abortSave: vi.fn(),
      apply: vi.fn(async (revision: number) => ({ type: "operation-applied", revision })),
    };
    Object.assign(internal, { workerSession: worker, workerRevision: 1, dirtyRevision: 1 });
    Object.assign(store, { readRaw: vi.fn(async () => "disk-json"), writeIfUnchanged: vi.fn(async () => true) });

    const saving = internal.save();
    await Promise.resolve();
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    expect(internal.activePointerId).toBe(7);
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2]);
    internal.onPointerUp(pointer(30));
    await vi.advanceTimersByTimeAsync(500);
    await saving;
    expect(worker.prepareSave).toHaveBeenCalledTimes(2);
    expect(internal.savedRevision).toBe(internal.dirtyRevision);
  });

  it("finalizes and flushes the current page before navigation", async () => {
    const { internal, store, view } = setup();
    const second = createPage("Second");
    internal.notebook.pages.push(second);
    internal.notebook.pageOrder.push(second.id);
    Object.assign(internal, { viewReady: true });
    const write = deferred<InkNotebook>();
    store.save.mockReturnValue(write.promise);

    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    internal.navigateToPage(second.id);
    await Promise.resolve();

    expect(internal.activePointerId).toBeNull();
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2]);
    expect(store.save).toHaveBeenCalledOnce();
    expect(internal.pageIndex).toBe(0);

    write.resolve(structuredClone(internal.notebook));
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(internal.pageIndex).toBe(1);
    expect(internal.renderPage).toHaveBeenCalledOnce();
    expect(view.file).toBeDefined();
  });

  it("waits for the Worker operation barrier before a clean page navigation", async () => {
    const { internal } = setup();
    const second = createPage("Second");
    internal.notebook.pages.push(second);
    internal.notebook.pageOrder.push(second.id);
    const barrier = deferred<number>();
    const worker = { barrier: vi.fn(() => barrier.promise) };
    Object.assign(internal, { viewReady: true, workerSession: worker, workerRevision: 7 });

    internal.navigateToPage(second.id);
    await Promise.resolve();
    expect(worker.barrier).toHaveBeenCalledWith(7);
    expect(internal.pageIndex).toBe(0);

    barrier.resolve(7);
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(internal.pageIndex).toBe(1);
  });

  it("waits for a full writing idle interval before autosave work", async () => {
    const { internal, store } = setup();
    store.save.mockImplementation(async (_file, notebook) => notebook);
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    await vi.advanceTimersByTimeAsync(1499);
    expect(store.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(store.save).toHaveBeenCalledOnce();
  });

  it("checkpoints completed strokes after ten seconds of continuous writing", async () => {
    const { internal, store } = setup();
    store.save.mockImplementation(async (_file, notebook) => notebook);
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    for (let second = 1; second < 10; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      internal.onPointerDown(pointer(20 + second));
      internal.onPointerUp(pointer(21 + second));
    }
    expect(store.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.save).toHaveBeenCalledOnce();
  });

  it("defers a due checkpoint only until the active stroke finishes", async () => {
    const { internal, store } = setup();
    store.save.mockImplementation(async (_file, notebook) => notebook);
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    for (let second = 1; second < 9; second++) {
      await vi.advanceTimersByTimeAsync(1_000);
      internal.onPointerDown(pointer(20 + second));
      internal.onPointerUp(pointer(21 + second));
    }
    await vi.advanceTimersByTimeAsync(1_000);
    internal.onPointerDown(pointer(30));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.save).not.toHaveBeenCalled();
    internal.onPointerUp(pointer(40));
    await Promise.resolve();
    expect(store.save).toHaveBeenCalledOnce();
  });

  it("keeps Worker-mode save preparation off the main-thread JSON path", async () => {
    const { internal, store, view } = setup();
    const worker = {
      barrier: vi.fn(async () => 4),
      prepareSave: vi.fn(async () => ({ token: "save-1", content: "worker-json", revision: 4 })),
      commitSave: vi.fn(async () => ({ revision: 4 })),
      abortSave: vi.fn(),
    };
    Object.assign(internal, { workerSession: worker, workerRevision: 4, dirtyRevision: 1 });
    const writeIfUnchanged = vi.fn(async () => true);
    Object.assign(store, { readRaw: vi.fn(async () => "disk-json"), writeIfUnchanged });
    const parse = vi.spyOn(JSON, "parse");
    const stringify = vi.spyOn(JSON, "stringify");

    await internal.save();

    expect(worker.barrier).toHaveBeenCalledWith(4);
    expect(worker.prepareSave).toHaveBeenCalledWith("disk-json", 1);
    expect(writeIfUnchanged).toHaveBeenCalledWith(view.file, "disk-json", "worker-json");
    expect(store.save).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect((internal as unknown as { saveRevisionWithWorker: Function }).saveRevisionWithWorker.toString())
      .not.toMatch(/cloneNotebook|mergeNotebooks|JSON\.(?:parse|stringify)/);
    parse.mockRestore();
    stringify.mockRestore();
  });

  it("bounds Worker CAS conflicts at three attempts and preserves dirty state", async () => {
    const { internal, store } = setup();
    const worker = {
      barrier: vi.fn(async () => 2),
      prepareSave: vi.fn(async (_raw: string, _revision: number) => ({ token: `save-${worker.prepareSave.mock.calls.length}`, content: "next", revision: 2 })),
      commitSave: vi.fn(),
      abortSave: vi.fn(async () => undefined),
    };
    Object.assign(internal, { workerSession: worker, workerRevision: 2, dirtyRevision: 1 });
    const readRaw = vi.fn(async () => `disk-${readRaw.mock.calls.length}`);
    const writeIfUnchanged = vi.fn(async () => false);
    Object.assign(store, { readRaw, writeIfUnchanged });

    await expect(internal.save()).resolves.toBeUndefined();

    expect(worker.prepareSave).toHaveBeenCalledTimes(3);
    expect(writeIfUnchanged).toHaveBeenCalledTimes(3);
    expect(worker.abortSave).toHaveBeenCalledTimes(3);
    expect(worker.commitSave).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(internal.savedRevision).toBe(0);
    expect(internal.dirtyRevision).toBe(1);
  });

  it("does not rebuild any UI when a self-save returns equivalent notebook data", async () => {
    const { internal, store } = setup();
    const notebook = internal.notebook;
    const page = notebook.pages[0];
    const strokes = page.strokes;
    store.save.mockImplementation(async (_file, snapshot) => structuredClone(snapshot));

    await internal.save();

    expect(internal.notebook).toBe(notebook);
    expect(internal.notebook.pages[0]).toBe(page);
    expect(internal.notebook.pages[0].strokes).toBe(strokes);
    expect(internal.renderAll).not.toHaveBeenCalled();
    expect(internal.renderPageRail).not.toHaveBeenCalled();
    expect(internal.renderPage).not.toHaveBeenCalled();
    expect(internal.drawStrokes).not.toHaveBeenCalled();
  });

  it("updates current-page remote ink without rebuilding or resizing the page", async () => {
    const { internal, view, store } = setup();
    const remote = structuredClone(internal.notebook);
    const page = remote.pages[0];
    page.strokes.push({
      id: "remote-stroke", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.25, y: 0.25, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    });
    page.updatedAt += 1_000;
    remote.updatedAt += 1_000;
    store.read.mockResolvedValue(remote);

    await view.reloadFromDisk();

    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.id)).toContain("remote-stroke");
    expect(internal.drawStrokes).toHaveBeenCalledOnce();
    expect(internal.renderPage).not.toHaveBeenCalled();
    expect(internal.renderAll).not.toHaveBeenCalled();
  });

  it("does not redraw the current canvas for a remote update on another page", async () => {
    const { internal, view, store } = setup();
    const other = createPage("Other");
    internal.notebook.pages.push(other);
    internal.notebook.pageOrder.push(other.id);
    const remote = structuredClone(internal.notebook);
    remote.pages[1].strokes.push({
      id: "other-remote-stroke", pageId: other.id, tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.75, y: 0.75, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    });
    remote.pages[1].updatedAt += 1_000;
    remote.updatedAt += 1_000;
    store.read.mockResolvedValue(remote);

    await view.reloadFromDisk();

    expect(internal.notebook.pages[1]).toBe(other);
    expect(other.strokes.map((stroke) => stroke.id)).toContain("other-remote-stroke");
    expect(internal.drawStrokes).not.toHaveBeenCalled();
    expect(internal.renderPage).not.toHaveBeenCalled();
    expect(internal.renderPageRail).not.toHaveBeenCalled();
  });

  it("updates the page rail for remote ordering and additions while preserving selection", async () => {
    const { internal, view, store } = setup();
    const selectedId = internal.notebook.pages[0].id;
    const remote = structuredClone(internal.notebook);
    const added = createPage("Remote first");
    remote.pages.unshift(added);
    remote.pageOrder = [added.id, selectedId];
    remote.pageOrderUpdatedAt += 1_000;
    remote.updatedAt += 1_000;
    store.read.mockResolvedValue(remote);

    await view.reloadFromDisk();

    expect(internal.notebook.pages.map((page) => page.id)).toEqual([added.id, selectedId]);
    expect(internal.pageIndex).toBe(1);
    expect(internal.renderPageRail).toHaveBeenCalledOnce();
    expect(internal.renderPage).not.toHaveBeenCalled();
    expect(internal.drawStrokes).not.toHaveBeenCalled();
  });

  it("switches pages only when a remote tombstone deletes the selected page", async () => {
    const { internal, view, store } = setup();
    const selectedId = internal.notebook.pages[0].id;
    const remaining = createPage("Remaining");
    internal.notebook.pages.push(remaining);
    internal.notebook.pageOrder.push(remaining.id);
    const remote = structuredClone(internal.notebook);
    remote.deletedPages[selectedId] = remote.updatedAt + 1_000;
    remote.pages = [remote.pages[1]];
    remote.pageOrder = [remaining.id];
    remote.pageOrderUpdatedAt += 1_000;
    remote.updatedAt += 1_000;
    store.read.mockResolvedValue(remote);

    await view.reloadFromDisk();

    expect(internal.notebook.pages.map((page) => page.id)).toEqual([remaining.id]);
    expect(internal.pageIndex).toBe(0);
    expect(internal.renderPageRail).toHaveBeenCalledOnce();
    expect(internal.renderPage).toHaveBeenCalledOnce();
    expect(internal.renderAll).not.toHaveBeenCalled();
  });

  it("defers a disk read that completes after the next stroke has started", async () => {
    const { internal, view, store } = setup();
    const disk = structuredClone(internal.notebook);
    disk.pages[0].title = "Remote page title";
    disk.pages[0].updatedAt += 1000;
    const read = deferred<InkNotebook>();
    store.read.mockReturnValue(read.promise);
    const refresh = view.reloadFromDisk();
    internal.onPointerDown(pointer(10));
    const activeNotebook = internal.notebook;
    read.resolve(disk);
    await refresh;

    expect(internal.notebook).toBe(activeNotebook);
    expect(internal.renderAll).not.toHaveBeenCalled();
    internal.onPointerMove(pointer(20));
    internal.onPointerUp(pointer(30));
    expect(internal.notebook.pages[0].title).toBe("Remote page title");
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2, 0.3]);
  });

  it("does not apply a disk read to a different file after navigation", async () => {
    const { internal, view, store } = setup();
    const read = deferred<InkNotebook>();
    store.read.mockReturnValue(read.promise);
    const refresh = view.reloadFromDisk();
    view.file = {} as TFile;
    const nextNotebook = createNotebook("Next notebook");
    internal.notebook = nextNotebook;
    read.resolve(createNotebook("Previous notebook"));
    await refresh;
    expect(internal.notebook).toBe(nextNotebook);
    expect(internal.renderAll).not.toHaveBeenCalled();
  });

  it("preserves both completed and active strokes when saving overlaps the next stroke", async () => {
    const { internal, store } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    const snapshot = structuredClone(internal.notebook);
    const saved = deferred<InkNotebook>();
    store.save.mockReturnValue(saved.promise);
    const saving = internal.save();
    internal.onPointerDown(pointer(30));
    saved.resolve(snapshot);
    await saving;
    expect(internal.renderAll).not.toHaveBeenCalled();
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));
    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4, 0.5]]);
  });

  it("serializes a revision added while a save is in flight", async () => {
    const { internal, store } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    const first = deferred<InkNotebook>();
    store.save.mockReturnValueOnce(first.promise).mockImplementation(async (_file, notebook) => notebook);
    const initialSave = internal.save();
    internal.onPointerDown(pointer(30));
    internal.onPointerUp(pointer(40));
    const concurrentWaiter = internal.save();
    first.resolve(structuredClone(internal.notebook));
    await Promise.all([initialSave, concurrentWaiter]);
    expect(store.save).toHaveBeenCalledTimes(2);
    expect(internal.savedRevision).toBe(internal.dirtyRevision);
    expect((store.save.mock.calls[1][1] as InkNotebook).pages[0].strokes).toHaveLength(2);
  });

  it("keeps dirty revision retryable after a handled save failure", async () => {
    const { internal, store } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    store.save.mockRejectedValueOnce(new Error("disk full"));
    await expect(internal.save()).resolves.toBeUndefined();
    expect(internal.savedRevision).toBeLessThan(internal.dirtyRevision);
    store.save.mockImplementation(async (_file, notebook) => notebook);
    await expect(internal.save()).resolves.toBeUndefined();
    expect(internal.savedRevision).toBe(internal.dirtyRevision);
  });

  it("settles a concurrent lifecycle flush when the active save rejects unexpectedly", async () => {
    const { internal, view } = setup();
    const failure = Promise.reject(new Error("unexpected writer failure"));
    internal.activeSave = failure;
    await expect(internal.save(view.file!)).resolves.toBeUndefined();
    internal.activeSave = null;
  });

  it("commits an active stroke before unloading and includes it in the save snapshot", async () => {
    const { internal, store, view } = setup();
    store.save.mockImplementation(async (_file, notebook) => notebook);
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    await internal.onUnloadFile(view.file!);
    expect(store.save).toHaveBeenCalledOnce();
    const saved = store.save.mock.calls[0][1] as InkNotebook;
    expect(saved.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2]);
    expect(internal.activePointerId).toBeNull();
    expect(internal.savedRevision).toBe(internal.dirtyRevision);
  });

  it("accumulates disk and save results that both arrive during a stroke", async () => {
    const { internal, view, store } = setup();
    const disk = structuredClone(internal.notebook);
    const remotePage = createPage("Remote page");
    disk.pages.push(remotePage);
    const snapshot = structuredClone(internal.notebook);
    const read = deferred<InkNotebook>();
    const saved = deferred<InkNotebook>();
    store.read.mockReturnValue(read.promise);
    store.save.mockReturnValue(saved.promise);
    const refresh = view.reloadFromDisk();
    const saving = internal.save();
    internal.onPointerDown(pointer(10));
    read.resolve(disk);
    await refresh;
    saved.resolve(snapshot);
    await saving;
    expect(internal.renderAll).not.toHaveBeenCalled();
    internal.onPointerUp(pointer(20));
    expect(internal.notebook.pages.map((page) => page.id)).toContain(remotePage.id);
    expect(internal.notebook.pages[internal.pageIndex].strokes[0].points).toHaveLength(2);
  });

  it("keeps the writing page selected when a background merge inserts an earlier page", async () => {
    const { internal, view, store } = setup();
    const pageId = internal.notebook.pages[0].id;
    const disk = structuredClone(internal.notebook);
    disk.pages.push(createPage("Earlier remote page", "blank", disk.pages[0].createdAt - 1000));
    store.read.mockResolvedValue(disk);
    await view.reloadFromDisk();
    expect(internal.pageIndex).toBe(1);
    expect(internal.notebook.pages[internal.pageIndex].id).toBe(pageId);
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    expect(internal.notebook.pages[0].strokes).toHaveLength(0);
    expect(internal.notebook.pages[1].strokes).toHaveLength(1);
  });

  it("duplicates, moves, deletes and restores pages through history", () => {
    const { internal } = setup();
    internal.addPage();
    internal.notebook.pages[1].strokes.push({
      id: "source", pageId: internal.notebook.pages[1].id, tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [], createdAt: 1, updatedAt: 1,
    });
    internal.duplicateCurrentPage();
    expect(internal.notebook.pages).toHaveLength(3);
    expect(internal.notebook.pages[2].strokes[0].id).not.toBe("source");
    expect(internal.notebook.pages[2].strokes[0].pageId).toBe(internal.notebook.pages[2].id);
    const duplicateId = internal.notebook.pages[2].id;
    internal.moveCurrentPage(-1);
    expect(internal.notebook.pageOrder[1]).toBe(duplicateId);
    internal.undo();
    expect(internal.notebook.pageOrder[2]).toBe(duplicateId);
    internal.deleteCurrentPage();
    expect(internal.notebook.deletedPages[duplicateId]).toBeDefined();
    internal.undo();
    expect(internal.notebook.pages).toHaveLength(3);
    expect(internal.notebook.pages.some((page) => page.id === duplicateId)).toBe(false);
  });

  it("protects the last editable page from deletion", () => {
    const { internal } = setup();
    const pageId = internal.notebook.pages[0].id;
    internal.deleteCurrentPage();
    expect(internal.notebook.pages).toHaveLength(1);
    expect(internal.notebook.pages[0].id).toBe(pageId);
    expect(internal.notebook.deletedPages).toEqual({});
  });
});

describe("stroke finalization", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function lastStroke(internal: ViewInternals): InkStroke {
    const strokes = internal.notebook.pages[0].strokes;
    return strokes[strokes.length - 1];
  }

  function queuedOperations(internal: ViewInternals): NotebookOperation[] {
    return (internal.queueWorkerOperation as unknown as { mock: { calls: Array<[NotebookOperation]> } })
      .mock.calls.map((call) => call[0]);
  }

  it("keeps the captured geometry byte-exact", () => {
    const { internal } = setup();
    internal.queueWorkerOperation = vi.fn();
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(30));
    internal.onPointerUp(pointer(50));

    expect(queuedOperations(internal).some((operation) => operation.type === "patch-strokes")).toBe(false);
    expect(lastStroke(internal).points.map((point) => point.x)).toEqual([0.1, 0.3, 0.5]);
  });

  it("inherits tail pressure from the previous sample when the lift reports zero", () => {
    const { internal } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(30, { pressure: 0.2 }));
    internal.onPointerUp(pointer(50, { pressure: 0 }));

    const stroke = lastStroke(internal);
    const last = stroke.points[stroke.points.length - 1];
    // A 0.5 pressure spike at the tail renders as a thin line with a
    // full-width round cap dot; the tail must keep the writing pressure.
    expect(last.pressure).toBeCloseTo(0.2, 5);
  });

  it("records every stroke during rapid consecutive input", () => {
    const { internal } = setup();
    internal.queueWorkerOperation = vi.fn();
    for (let index = 0; index < 25; index++) {
      const base = 5 + index * 3;
      internal.onPointerDown(pointer(base));
      internal.onPointerMove(pointer(base + 1));
      internal.onPointerUp(pointer(base + 2));
    }

    const strokes = internal.notebook.pages[0].strokes;
    expect(strokes).toHaveLength(25);
    for (const stroke of strokes) {
      expect(stroke.points.length).toBeGreaterThanOrEqual(3);
      expect(stroke.points[0].x).toBeLessThan(stroke.points[stroke.points.length - 1].x);
    }
    const operations = queuedOperations(internal);
    expect(operations.filter((operation) => operation.type === "complete-stroke")).toHaveLength(25);
  });
});
