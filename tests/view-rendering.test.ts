import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Modal: class {}, FileView: class {}, Scope: class {}, TFile: class {} }));
vi.mock("../src/rendering", () => ({ canvasResolution: vi.fn(), drawInkStroke: vi.fn(), drawInkStrokeTail: vi.fn(), STROKE_WIDTH_REFERENCE: 980 }));
import { InkView } from "../src/view";
import { canvasResolution, drawInkStroke, drawInkStrokeTail } from "../src/rendering";

// Exercise rendering coordination without needing an Obsidian workspace.
function view(): any {
  const v = Object.create(InkView.prototype);
  const page = { id: "page", strokes: [] };
  Object.assign(v, {
    root: { querySelector: vi.fn(() => null) },
    ctx: {}, previewCtx: { clearRect: vi.fn() }, previewCanvas: {
      width: 800, height: 1000, classList: { toggle: vi.fn(), remove: vi.fn() },
    },
    pendingInkStrokes: [], committingInkStrokes: null, pendingInkPageId: null,
    activePointerId: null, pendingMergedNotebook: null, externalRefreshPending: false, viewReady: true,
    canvasLogicalWidth: 800, canvasLogicalHeight: 1000, renderFrame: null, resizeRequested: false,
    confirmedOutlinePaths: new WeakMap(),
    currentPage: () => page,
    viewport: { x: 0, y: 0, width: 800, height: 1000 }, zoom: 1,
    tiles: { sync: vi.fn(), patchStrokes: vi.fn(), update: vi.fn(), flushVisible: vi.fn(), commitInteractive: vi.fn(), commitInk: vi.fn(),
      removeStrokes: vi.fn(), previewInteractiveCells: vi.fn(), pauseInkCommit: vi.fn(), resumeInkCommit: vi.fn(), cancelInkCommit: vi.fn(),
      setDisplayScale: vi.fn(), setWorkerExclusion: vi.fn() },
  });
  return v;
}

function drawingContext() {
  return { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), arc: vi.fn(),
    drawImage: vi.fn() };
}

function setCssStyles(this: { style: object }, styles: object): void {
  Object.assign(this.style, styles);
}

// Path2D stubs record outline construction: confirmed outlines now trace into
// a cached path object instead of the live context, so assertions follow it.
const pathInstances: any[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  pathInstances.length = 0;
  vi.stubGlobal("Path2D", class {
    moveTo = vi.fn();
    lineTo = vi.fn();
    quadraticCurveTo = vi.fn();
    closePath = vi.fn();
    constructor() { pathInstances.push(this); }
  });
  vi.stubGlobal("window", { requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn(),
    setTimeout: vi.fn(() => 2), clearTimeout: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

it("coalesces samples into one preview draw without repainting completed strokes", () => {
  const v = view();
  v.activeStroke = { tool: "pen" };
  v.drawStrokes = vi.fn();
  v.requestRender(); v.requestRender(); v.requestRender();
  expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  vi.mocked(window.requestAnimationFrame).mock.calls[0][0](0);
  expect(v.drawStrokes).not.toHaveBeenCalled();
  expect(drawInkStroke).toHaveBeenCalledOnce();
  expect(drawInkStroke).toHaveBeenCalledWith(v.previewCtx, v.activeStroke, 800, 1000);
});

it("keeps a finished pen visible while tiles commit asynchronously", () => {
  const v = view();
  const stroke = { id: "pen", tool: "pen" };
  v.activeStroke = stroke;
  v.commitPreview();
  expect(v.pendingInkStrokes).toEqual([stroke]);
  expect(v.tiles.commitInteractive).not.toHaveBeenCalled();
  expect(v.previewCanvas.width).toBe(800);
  let complete!: (committed: boolean) => void;
  v.activeStroke = null;
  v.tiles.commitInk.mockImplementation((_strokes: unknown, _viewport: unknown, _density: unknown, callback: typeof complete) => { complete = callback; });
  v.startPendingInkCommit(v.currentPage());
  expect(v.tiles.commitInk).toHaveBeenCalledWith([stroke], v.viewport, 1, expect.any(Function));
  expect(v.pendingInkStrokes).toEqual([stroke]);
  complete(true);
  expect(v.pendingInkStrokes).toEqual([]);
  expect(v.previewCtx.clearRect).toHaveBeenCalled();
});

it("keeps completed overlay ink when a new pointer cancels its tile commit", () => {
  const v = view();
  const stroke = { id: "pending", tool: "pen" };
  v.pendingInkStrokes = [stroke];
  v.pendingInkPageId = "page";
  v.drawPreview = vi.fn();
  v.drawStrokes = vi.fn();
  let complete!: (committed: boolean) => void;
  v.tiles.commitInk.mockImplementation((_strokes: unknown, _viewport: unknown, _density: unknown, callback: typeof complete) => { complete = callback; });
  v.startPendingInkCommit(v.currentPage());
  v.activePointerId = 7;
  complete(false);
  expect(v.pendingInkStrokes).toEqual([stroke]);
  expect(v.drawPreview).toHaveBeenCalledOnce();
  expect(v.drawStrokes).not.toHaveBeenCalled();
  expect(window.setTimeout).not.toHaveBeenCalled();
});

it("keeps a long highlighter stroke on the immediate preview layer", () => {
  const v = view();
  v.activeStroke = { tool: "highlighter" };
  v.drawStrokes = vi.fn();
  v.requestRender(); v.requestRender(); v.requestRender();
  expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  vi.mocked(window.requestAnimationFrame).mock.calls[0][0](0);
  expect(v.drawStrokes).not.toHaveBeenCalled();
  expect(v.tiles.update).not.toHaveBeenCalled();
  expect(drawInkStroke).toHaveBeenCalledWith(v.previewCtx, v.activeStroke, 800, 1000);
  expect(v.previewCanvas.classList.toggle).toHaveBeenCalledWith("is-highlighter-preview", true);
});

it("keeps a finished highlighter in the pending preview", () => {
  const v = view();
  const stroke = { id: "marker", tool: "highlighter", points: [] };
  const confirmedCtx = { clearRect: vi.fn() };
  const confirmedCanvas = { classList: { toggle: vi.fn() } };
  v.confirmedPreviewCtx = confirmedCtx;
  v.confirmedPreviewCanvas = confirmedCanvas;
  v.activeStroke = stroke;
  v.commitPreview();
  v.activeStroke = null;
  v.redrawConfirmedPreview();
  expect(v.pendingInkStrokes).toEqual([stroke]);
  expect(drawInkStroke).toHaveBeenCalledWith(confirmedCtx, stroke, 800, 1000);
  expect(confirmedCanvas.classList.toggle).toHaveBeenCalledWith("is-highlighter-preview", true);
  expect(v.tiles.commitInteractive).not.toHaveBeenCalled();
});

it("retains a complete Worker-lagged stroke without copying the high-density overlay", () => {
  const v = view();
  const confirmed = drawingContext();
  const stroke = {
    id: "complete-fallback", pageId: "page", tool: "pen", color: "#000", opacity: 1, width: 4,
    points: Array.from({ length: 1_024 }, (_, index) => ({ x: 0.1 + index / 2_000, y: 0.2, pressure: 0.5, t: index })),
  };
  Object.assign(v, {
    confirmedPreviewCtx: confirmed,
    confirmedPreviewCanvas: { classList: { toggle: vi.fn() } },
    activeStroke: stroke,
    confirmedStrokeOutlines: new Map([[stroke.id, {
      points: new Float32Array([0.1, 0.2, 0.2, 0.2, 0.2, 0.21, 0.1, 0.21]), sampleCount: 2, mode: "pen",
    }]]),
  });

  v.commitPreview();
  v.retainActivePreview();

  expect(confirmed.drawImage).not.toHaveBeenCalled();
  expect(confirmed.fill).not.toHaveBeenCalled();
  expect(drawInkStroke).toHaveBeenCalledWith(confirmed, expect.objectContaining({ id: stroke.id }), 800, 1000);
  const retained = vi.mocked(drawInkStroke).mock.calls.at(-1)?.[1];
  expect(retained?.points).toHaveLength(256);
  expect(retained?.points[0]).toBe(stroke.points[0]);
  expect(retained?.points.at(-1)).toBe(stroke.points.at(-1));
});

it("keeps completed ink visible across a late Worker outline and rebuilds it after resize", () => {
  const v = view();
  const confirmed = drawingContext();
  const stroke = {
    id: "late-worker", pageId: "page", tool: "pen", color: "#000", opacity: 1, width: 4,
    updatedAt: 2,
    points: [
      { x: 0.1, y: 0.1, pressure: 0.4, t: 1 },
      { x: 0.2, y: 0.2, pressure: 0.5, t: 2 },
    ],
  };
  let onApplied: ((response: any) => void) | undefined;
  Object.assign(v, {
    confirmedPreviewCtx: confirmed,
    confirmedPreviewCanvas: { classList: { toggle: vi.fn() } },
    activeStroke: stroke,
    interaction: { tool: "pen", pointerId: 7, pageId: "page" },
    workerStrokePointIndex: 1,
    notebook: { updatedAt: 2 },
    confirmedStrokeOutlines: new Map(),
    queueWorkerOperation: (_operation: unknown, _transfer: unknown, callback: typeof onApplied) => { onApplied = callback; },
  });
  v.flushWorkerStrokePoints();
  v.commitPreview();
  v.retainActivePreview();
  v.activeStroke = null;
  v.interaction = null;
  vi.clearAllMocks();

  onApplied?.({
    type: "operation-applied", revision: 1, strokeId: stroke.id, sampleCount: 2, outlineMode: "pen",
    outline: new Float32Array([0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2]),
  });
  expect(confirmed.clearRect).not.toHaveBeenCalled();
  vi.mocked(window.requestAnimationFrame).mock.calls[0][0](0);
  expect(confirmed.clearRect).not.toHaveBeenCalled();

  v.redrawConfirmedPreview();
  expect(confirmed.clearRect).toHaveBeenCalledOnce();
  expect(confirmed.fill).toHaveBeenCalledOnce();
});

it("redraws Worker-confirmed geometry separately from the incremental input tail", () => {
  const v = view();
  const tail = drawingContext();
  const confirmed = drawingContext();
  const stroke = {
    id: "split-preview", pageId: "page", tool: "pen", color: "#000", opacity: 1, width: 4,
    points: [
      { x: 0.1, y: 0.1, pressure: 0.4, t: 1 },
      { x: 0.2, y: 0.2, pressure: 0.5, t: 2 },
      { x: 0.3, y: 0.25, pressure: 0.6, t: 3 },
    ],
  };
  Object.assign(v, {
    previewCtx: tail,
    confirmedPreviewCtx: confirmed,
    confirmedPreviewCanvas: { classList: { toggle: vi.fn() } },
    notebook: { pageWidth: 800, pageHeight: 1000 },
    activeStroke: stroke,
    confirmedStrokeOutlines: new Map([[stroke.id, {
      points: new Float32Array([80, 100, 120, 120, 160, 180, 100, 160]), sampleCount: 2, mode: "pen",
    }]]),
  });

  v.drawPreview();
  expect(drawInkStrokeTail).toHaveBeenCalledWith(tail, expect.objectContaining({
    id: stroke.id,
  }), 800, 1000, 1);
  // The tail view shares the live points array; the unconfirmed window is
  // carried by the start sample (worker outline owns [0, 2), tail redraws
  // sample 1 as seam context plus sample 2).
  const tailView = vi.mocked(drawInkStrokeTail).mock.calls.at(-1)?.[1] as typeof stroke;
  expect(tailView.points).toBe(stroke.points);
  expect(tailView.points.slice(1)).toEqual(stroke.points.slice(1));
  expect(drawInkStroke).not.toHaveBeenCalled();
  expect(confirmed.fill).not.toHaveBeenCalled();

  v.commitPreview();
  v.activeStroke = null;
  v.redrawConfirmedPreview();
  expect(confirmed.fill).toHaveBeenCalledOnce();
  expect(confirmed.clearRect).toHaveBeenCalledOnce();
});

it.each([0, 8, 72, 96])("keeps every unconfirmed live sample when the Worker has confirmed %s of 96", (sampleCount) => {
  const v = view();
  const stroke = {
    id: "rapid-preview", pageId: "page", tool: "pen", color: "#000", opacity: 1, width: 4,
    points: Array.from({ length: 96 }, (_, index) => ({
      x: 0.1 + index / 160, y: 0.2 + Math.sin(index / 10) / 20, pressure: 0.5, t: index,
    })),
  };
  Object.assign(v, {
    previewCtx: drawingContext(),
    activeStroke: stroke,
    confirmedStrokeOutlines: new Map(sampleCount === 0 ? [] : [[stroke.id, {
      points: new Float32Array([0.1, 0.2, 0.2, 0.2, 0.2, 0.21, 0.1, 0.21]), sampleCount, mode: "pen",
    }]]),
  });

  v.drawPreview();

  if (sampleCount === stroke.points.length) {
    expect(drawInkStrokeTail).not.toHaveBeenCalled();
  } else {
    const call = vi.mocked(drawInkStrokeTail).mock.calls.at(-1)!;
    // The tail view shares the live array and re-renders the unconfirmed
    // samples plus one retained seam sample: window content = slice(start).
    expect((call[1] as typeof stroke).points).toBe(stroke.points);
    expect((call[1] as typeof stroke).points.slice(call[4] as number))
      .toEqual(stroke.points.slice(Math.max(0, sampleCount - 1)));
  }
});

it("reuses one stable tail view across preview frames without new samples", () => {
  const v = view();
  const stroke = {
    id: "stable-tail", pageId: "page", tool: "pen", color: "#000", opacity: 1, width: 4,
    points: Array.from({ length: 96 }, (_, index) => ({
      x: 0.1 + index / 160, y: 0.2 + Math.sin(index / 10) / 20, pressure: 0.5, t: index,
    })),
  };
  Object.assign(v, {
    previewCtx: drawingContext(),
    activeStroke: stroke,
    confirmedStrokeOutlines: new Map(),
  });

  v.drawPreview();
  v.drawPreview();
  expect(drawInkStrokeTail).toHaveBeenCalledTimes(2);
  const first = vi.mocked(drawInkStrokeTail).mock.calls[0][1] as typeof stroke;
  const second = vi.mocked(drawInkStrokeTail).mock.calls[1][1] as typeof stroke;
  // One cloned view for the stroke's lifetime, sharing the growing points
  // array: fresh per-frame clones would defeat the renderer's path cache.
  expect(first).toBeTruthy();
  expect(second).toBe(first);
  expect(second.points).toBe(stroke.points);
  expect(second).toEqual(stroke);
});

it("allocates overlays with the mobile high-density pixel budget", () => {
  const v = view();
  const canvas = { width: 1, height: 1, style: {}, setCssStyles };
  const ctx = { setTransform: vi.fn() };
  v.previewCanvas = canvas;
  v.previewCtx = ctx;
  vi.mocked(canvasResolution).mockReturnValue({ width: 1600, height: 2000 });
  v.resizePreview();
  expect(canvasResolution).toHaveBeenCalledWith(800, 1000, 1, 1, 12_000_000);
  expect(canvas).toMatchObject({ width: 1600, height: 2000 });
});

it("repaints only changed eraser cells during the interaction", () => {
  const v = view();
  v.pageElement = {};
  v.ctx = { clearRect: vi.fn() };
  v.drawSelection = vi.fn();
  v.interaction = { tool: "eraser" };
  v.eraserPreviewCells = new Set(["1:2", "2:2"]);
  v.requestRender();
  vi.mocked(window.requestAnimationFrame).mock.calls[0][0](0);
  expect(v.tiles.previewInteractiveCells).toHaveBeenCalledWith(["1:2", "2:2"], v.viewport, 1);
  expect(v.eraserPreviewCells.size).toBe(0);
  expect(v.tiles.commitInteractive).not.toHaveBeenCalled();
  expect(v.tiles.update).not.toHaveBeenCalled();
});

it("moves a cached lasso preview without rebuilding stroke geometry", () => {
  const v = view();
  v.inputRect = vi.fn(() => ({ width: 800, height: 1000 }));
  v.lassoCanvas = { style: {} };
  const points = [{ x: 0.2, y: 0.2, pressure: 0.5, t: 1 }];
  v.lassoDrag = {
    start: { x: 0.2, y: 0.2 }, pageId: "page", bounds: { minX: 0.2, minY: 0.2, maxX: 0.4, maxY: 0.4 },
    strokes: [{ id: "selected", points }], before: new Map([["selected", points]]), dx: 0, dy: 0,
  };
  expect(v.applyLassoPoint({ x: 0.3, y: 0.25 })).toBe(true);
  expect(v.lassoDrag.strokes[0].points).toBe(points);
  expect(v.lassoDrag.dx).toBeCloseTo(0.1);
  expect(v.lassoDrag.dy).toBeCloseTo(0.05);
  expect(v.lassoCanvas.style.transform).toContain("translate(");
  expect(v.tiles.sync).not.toHaveBeenCalled();
});

it("excludes lasso-selected strokes from worker-rendered tiles while the drag preview lives", () => {
  const v = view();
  v.stickyInput = null;
  v.lassoCanvas = { style: {}, setCssStyles };
  v.lassoCtx = { setTransform: vi.fn(), clearRect: vi.fn() };
  vi.mocked(canvasResolution).mockReturnValue({ width: 1600, height: 2000 });
  v.lassoDrag = {
    start: { x: 0.2, y: 0.2 }, pageId: "page", bounds: { minX: 0.2, minY: 0.2, maxX: 0.4, maxY: 0.4 },
    strokes: [{ id: "sel-a", points: [] }, { id: "sel-b", points: [] }], before: new Map(), dx: 0, dy: 0,
  };
  // Runtime state before beginLassoPreview: finishLasso has already recorded
  // the selection, and tileExclusion() now reads it while lassoDrag lives.
  v.selectedStrokeIds = new Set(["sel-a", "sel-b"]);

  v.beginLassoPreview(v.currentPage());

  // The replacement tiles must drop the selection before the commit snapshots
  // the exclusion, or the Worker redraws it as a static ghost under the moving
  // lassoCanvas preview.
  expect(v.tiles.setWorkerExclusion).toHaveBeenCalledOnce();
  expect([...v.tiles.setWorkerExclusion.mock.calls[0][0]].sort()).toEqual(["sel-a", "sel-b"]);
  expect(v.tiles.setWorkerExclusion.mock.invocationCallOrder[0])
    .toBeLessThan(v.tiles.commitInteractive.mock.invocationCallOrder[0]);
});

it("restores the worker exclusion baseline when the lasso preview is hidden", () => {
  const v = view();
  v.stickyInput = null;
  v.lassoCanvas = { style: {}, setCssStyles };

  v.hideLassoPreview();

  expect(v.tiles.setWorkerExclusion).toHaveBeenCalledWith(undefined);
});

it("debounces expensive zoom rasterization while updating the displayed scale immediately", () => {
  const v = view();
  v.pageElement = { style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800 * v.zoom, height: 1000 * v.zoom }) };
  v.pageScroller = { clientWidth: 800, clientHeight: 600, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  v.layoutPage = vi.fn(() => { v.pageElement.style.width = `${800 * v.zoom}px`; });
  v.requestRender = vi.fn();
  v.updateViewport = vi.fn();
  v.setZoom(2); v.setZoom(3);
  expect(v.pageElement.style.width).toBe("2400px");
  expect(v.tiles.setDisplayScale).toHaveBeenNthCalledWith(1, 2);
  expect(v.tiles.setDisplayScale).toHaveBeenNthCalledWith(2, 3);
  expect(window.clearTimeout).toHaveBeenCalledWith(2);
  expect(v.requestRender).not.toHaveBeenCalled();
  (vi.mocked(window.setTimeout).mock.calls[1][0] as () => void)();
  expect(v.updateViewport).toHaveBeenLastCalledWith(true);
});

it("keeps pinch raster density fixed and defers refinement even when fingers pause", () => {
  const v = view();
  v.pageElement = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800 * v.zoom, height: 1000 * v.zoom }) };
  v.pageScroller = { clientWidth: 800, clientHeight: 600, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600 }) };
  v.layoutPage = vi.fn();
  v.hasInkPreview = vi.fn(() => false);
  v.tiles.beginInput = vi.fn();
  v.zoomRenderTimer = 42;

  v.applyGestureZoom(1.37, { x: 400, y: 300 }, { x: 0.5, y: 0.3 });
  v.applyGestureZoom(1.57, { x: 400, y: 300 }, { x: 0.5, y: 0.3 });

  expect(v.pinchRenderZoom).toBe(1);
  expect(v.tiles.beginInput).toHaveBeenCalledOnce();
  expect(v.tiles.setDisplayScale).not.toHaveBeenCalled();
  expect(v.tiles.update).toHaveBeenLastCalledWith(expect.any(Object), 1, false);
  expect(window.clearTimeout).toHaveBeenCalledWith(42);
  expect(window.setTimeout).not.toHaveBeenCalled();
  v.resizeCanvas = vi.fn();
  v.finishPinchRender();
  v.finishPinchRender();
  expect(v.pinchRenderZoom).toBeUndefined();
  expect(v.resizeCanvas).toHaveBeenCalledOnce();
});

it("uses explicit scaled layout without CSS zoom or transform", () => {
  const v = view();
  v.zoom = 2;
  v.notebook = { pageWidth: 1600, pageHeight: 2200 };
  v.pageScroller = { clientWidth: 800 };
  v.pageElement = { style: {}, setCssStyles };
  v.pageExtent = { style: {} };
  vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "20", paddingRight: "20" }));
  v.layoutPage();

  expect(v.pageElement.style).toMatchObject({ left: "0px", width: "1520px", height: "2090px", zoom: "", transform: "none" });
  expect(v.pageExtent.style).toMatchObject({ width: "1520px", height: "2090px" });
  expect(v.pageBaseWidth).toBe(760);
  expect(v.pageBaseHeight).toBe(1045);
});

it("keeps wide-screen centering space inside the zoomable scroll track", () => {
  const v = view();
  v.zoom = 1.5;
  v.notebook = { pageWidth: 1600, pageHeight: 2200 };
  v.pageScroller = { clientWidth: 1366 };
  v.pageElement = { style: {}, setCssStyles };
  v.pageExtent = { style: {} };
  vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "28", paddingRight: "28" }));

  v.layoutPage();

  expect(v.pageElement.style).toMatchObject({ left: "165px", width: "1470px", height: "2021.25px" });
  expect(v.pageExtent.style).toMatchObject({ width: "1800px", height: "2021.25px" });
  expect(v.pageBaseWidth).toBe(980);
});

it("keeps logical coordinates stable while the page uses scaled layout dimensions", () => {
  const v = view();
  v.zoom = 2;
  v.notebook = { pageWidth: 1600, pageHeight: 2200 };
  v.pageScroller = { clientWidth: 800 };
  v.pageElement = { style: { setProperty: vi.fn() }, setCssStyles, getBoundingClientRect: () => ({ left: 100, top: 50, width: 1520, height: 2090 }) };
  v.pageExtent = { style: {} };
  v.canvas = {};
  v.state = { tool: "pen", eraserMode: "stroke", eraserSize: 32 };
  v.eraserCursor = { toggleClass: vi.fn(), style: {} };
  v.tiles = { setDisplayScale: vi.fn(), setPage: vi.fn() };
  v.currentPage = vi.fn(() => ({ strokes: [] }));
  v.tileExclusion = vi.fn();
  v.updateViewport = vi.fn();
  vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "20", paddingRight: "20" }));

  v.resizeCanvas();

  expect(v.canvasLogicalWidth).toBe(760);
  expect(v.canvasLogicalHeight).toBe(1045);
  expect(v.tiles.setDisplayScale).toHaveBeenCalledWith(2);
  expect(v.toPoint({ clientX: 860, clientY: 1095, pressure: 0.5 }, v.pageElement.getBoundingClientRect()))
    .toMatchObject({ x: 0.5, y: 0.5 });
});

it("does not create a transformed canvas layer at 100% on older engines", () => {
  const v = view();
  v.zoom = 1;
  v.notebook = { pageWidth: 1600, pageHeight: 2200 };
  v.pageScroller = { clientWidth: 800 };
  v.pageElement = { style: {}, setCssStyles };
  v.pageExtent = { style: {} };
  vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "20", paddingRight: "20" }));
  vi.stubGlobal("CSS", { supports: () => false });

  v.layoutPage();

  expect(v.pageElement.style.transform).toBe("none");
  expect(v.pageElement.style.zoom).toBe("");
});

it("renders retained pen previews as the same faithful polygon as committed tiles", () => {
  const v = view();
  const ctx = drawingContext();
  const stroke = { id: "pen", tool: "pen", color: "#111111", opacity: 1, width: 3, points: [
    { x: 0.1, y: 0.1, pressure: 0.5, t: 1 }, { x: 0.3, y: 0.2, pressure: 0.5, t: 2 }, { x: 0.5, y: 0.1, pressure: 0.5, t: 3 },
  ] };
  v.confirmedStrokeOutlines = new Map([["pen", {
    points: new Float32Array([0.1, 0.1, 0.2, 0.16, 0.3, 0.2, 0.2, 0.12]),
    sampleCount: 3, mode: "pen",
  }]]);
  v.drawCompletedPreviewStroke(ctx, stroke);
  const outlinePath = pathInstances.at(-1);
  expect(outlinePath.closePath).toHaveBeenCalled();
  expect(outlinePath.lineTo).toHaveBeenCalled();
  expect(outlinePath.quadraticCurveTo).not.toHaveBeenCalled();
  expect(ctx.fill).toHaveBeenCalledWith(outlinePath);
});

it("reuses one cached outline path across frames of the same confirmed stroke", () => {
  const v = view();
  const ctx = drawingContext();
  const points = new Float32Array([0.1, 0.1, 0.2, 0.16, 0.3, 0.2, 0.2, 0.12]);
  v.drawConfirmedOutline(ctx, points, "#111111", 1, 3, "pen");
  const firstPath = pathInstances.at(-1);
  v.drawConfirmedOutline(ctx, points, "#111111", 1, 3, "pen");
  expect(pathInstances).toHaveLength(1);
  expect(ctx.fill).toHaveBeenLastCalledWith(firstPath);

  // A replacement outline (a new Float32Array from the Worker) builds a fresh
  // path, and the highlighter mode keys separately and renders as a stroke.
  v.drawConfirmedOutline(ctx, new Float32Array([0.1, 0.1, 0.4, 0.2]), "#111111", 1, 3, "pen");
  expect(pathInstances).toHaveLength(2);
  const highlighterCtx = drawingContext();
  v.drawConfirmedOutline(highlighterCtx, points, "#ffee00", 1, 6, "highlighter");
  expect(pathInstances).toHaveLength(3);
  expect(highlighterCtx.stroke).toHaveBeenCalledWith(pathInstances.at(-1));
  expect(highlighterCtx.fill).not.toHaveBeenCalled();
});
