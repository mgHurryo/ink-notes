import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ FileView: class {}, Scope: class {}, TFile: class {} }));
vi.mock("../src/rendering", () => ({ canvasResolution: vi.fn(), drawInkStroke: vi.fn() }));
import { InkView } from "../src/view";
import { canvasResolution, drawInkStroke } from "../src/rendering";

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
    currentPage: () => page,
    viewport: { x: 0, y: 0, width: 800, height: 1000 }, zoom: 1,
    tiles: { sync: vi.fn(), patchStrokes: vi.fn(), update: vi.fn(), flushVisible: vi.fn(), commitInteractive: vi.fn(), commitInk: vi.fn(),
      removeStrokes: vi.fn(), previewInteractiveCells: vi.fn(), pauseInkCommit: vi.fn(), resumeInkCommit: vi.fn(), cancelInkCommit: vi.fn(),
      setDisplayScale: vi.fn() },
  });
  return v;
}

function drawingContext() {
  return { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
    lineTo: vi.fn(), quadraticCurveTo: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), arc: vi.fn(),
    drawImage: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  expect(drawInkStroke).toHaveBeenCalledWith(tail, expect.objectContaining({
    id: stroke.id,
    points: stroke.points.slice(1),
  }), 800, 1000);
  expect(confirmed.fill).not.toHaveBeenCalled();

  v.commitPreview();
  v.activeStroke = null;
  v.redrawConfirmedPreview();
  expect(confirmed.fill).toHaveBeenCalledOnce();
  expect(confirmed.clearRect).toHaveBeenCalledOnce();
});

it("allocates overlays with the mobile high-density pixel budget", () => {
  const v = view();
  const canvas = { width: 1, height: 1, style: {} };
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

it("uses explicit scaled layout without CSS zoom or transform", () => {
  const v = view();
  v.zoom = 2;
  v.notebook = { pageWidth: 1600, pageHeight: 2200 };
  v.pageScroller = { clientWidth: 800 };
  v.pageElement = { style: {} };
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
  v.pageElement = { style: {} };
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
  v.pageElement = { style: { setProperty: vi.fn() }, getBoundingClientRect: () => ({ left: 100, top: 50, width: 1520, height: 2090 }) };
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
  v.pageElement = { style: {} };
  v.pageExtent = { style: {} };
  vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "20", paddingRight: "20" }));
  vi.stubGlobal("CSS", { supports: () => false });

  v.layoutPage();

  expect(v.pageElement.style.transform).toBe("none");
  expect(v.pageElement.style.zoom).toBe("");
});
