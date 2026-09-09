import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ FileView: class {}, Scope: class {}, TFile: class {} }));
vi.mock("../src/rendering", () => ({ canvasResolution: vi.fn(), drawInkStroke: vi.fn() }));
import { InkView } from "../src/view";
import { drawInkStroke } from "../src/rendering";

// Exercise rendering coordination without needing an Obsidian workspace.
function view(): any {
  const v = Object.create(InkView.prototype);
  Object.assign(v, {
    root: { querySelector: vi.fn(() => null) },
    ctx: {}, previewCtx: { clearRect: vi.fn() }, previewCanvas: {
      width: 800, height: 1000, classList: { toggle: vi.fn(), remove: vi.fn() },
    },
    canvasLogicalWidth: 800, canvasLogicalHeight: 1000, renderFrame: null, resizeRequested: false,
    currentPage: () => ({ strokes: [] }),
    viewport: { x: 0, y: 0, width: 800, height: 1000 }, zoom: 1,
    tiles: { sync: vi.fn(), update: vi.fn(), flushVisible: vi.fn(), commitInteractive: vi.fn() },
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

it("commits visible tiles atomically before releasing the pen preview bitmap", () => {
  const v = view();
  v.activeStroke = { tool: "pen" };
  v.commitPreview();
  expect(v.tiles.sync).toHaveBeenCalledOnce();
  expect(v.tiles.commitInteractive).toHaveBeenCalledWith(v.viewport, 1);
  expect(drawInkStroke).not.toHaveBeenCalled();
  expect(v.previewCanvas.width).toBe(1);
  expect(v.previewCanvas.height).toBe(1);
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

it("commits a highlighter atomically before clearing its preview", () => {
  const v = view();
  v.activeStroke = { tool: "highlighter" };
  v.commitPreview();
  expect(v.tiles.sync).toHaveBeenCalledOnce();
  expect(v.tiles.commitInteractive).toHaveBeenCalledWith(v.viewport, 1);
  expect(v.previewCanvas.width).toBe(1);
  expect(v.previewCanvas.height).toBe(1);
  expect(v.previewCanvas.classList.remove).toHaveBeenCalledWith("is-highlighter-preview");
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
