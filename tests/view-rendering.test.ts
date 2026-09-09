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
    tiles: { sync: vi.fn(), update: vi.fn(), flushVisible: vi.fn(), commitInteractive: vi.fn(), commitInk: vi.fn(),
      pauseInkCommit: vi.fn(), resumeInkCommit: vi.fn(), cancelInkCommit: vi.fn() },
  });
  return v;
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
  const stroke = { id: "marker", tool: "highlighter" };
  v.activeStroke = stroke;
  v.commitPreview();
  v.activeStroke = null;
  v.drawPreview();
  expect(v.pendingInkStrokes).toEqual([stroke]);
  expect(drawInkStroke).toHaveBeenCalledWith(v.previewCtx, stroke, 800, 1000);
  expect(v.previewCanvas.classList.toggle).toHaveBeenCalledWith("is-highlighter-preview", true);
  expect(v.tiles.commitInteractive).not.toHaveBeenCalled();
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

it("commits eraser changes as a coherent fallback frame", () => {
  const v = view();
  v.pageElement = {};
  v.ctx = { clearRect: vi.fn() };
  v.drawSelection = vi.fn();
  v.interaction = { tool: "eraser" };
  v.requestRender();
  vi.mocked(window.requestAnimationFrame).mock.calls[0][0](0);
  expect(v.tiles.commitInteractive).toHaveBeenCalledWith(v.viewport, 1, false);
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
  v.layoutPage = vi.fn(() => { v.pageElement.style.transform = `scale(${v.zoom})`; });
  v.requestRender = vi.fn();
  v.updateViewport = vi.fn();
  v.setZoom(2); v.setZoom(3);
  expect(v.pageElement.style.transform).toBe("scale(3)");
  expect(window.clearTimeout).toHaveBeenCalledWith(2);
  expect(v.requestRender).not.toHaveBeenCalled();
  (vi.mocked(window.setTimeout).mock.calls[1][0] as () => void)();
  expect(v.updateViewport).toHaveBeenLastCalledWith(true);
});

it("uses layout zoom instead of a transformed canvas subtree when supported", () => {
  const v = view();
  v.zoom = 2;
  v.notebook = { pageWidth: 1600, pageHeight: 2200 };
  v.pageScroller = { clientWidth: 800 };
  v.pageElement = { style: {} };
  v.pageExtent = { style: {} };
  vi.stubGlobal("getComputedStyle", () => ({ paddingLeft: "20", paddingRight: "20" }));
  vi.stubGlobal("CSS", { supports: (property: string) => property === "zoom" });

  v.layoutPage();

  expect(v.pageElement.style).toMatchObject({ width: "760px", height: "1045px", zoom: "2", transform: "none" });
  expect(v.pageExtent.style).toMatchObject({ width: "1520px", height: "2090px" });
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
