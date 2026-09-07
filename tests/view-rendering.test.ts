import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ FileView: class {}, Scope: class {}, TFile: class {} }));
vi.mock("../src/rendering", () => ({ canvasResolution: vi.fn(), drawInkStroke: vi.fn() }));
import { InkView } from "../src/view";
import { drawInkStroke } from "../src/rendering";

// Exercise rendering coordination without needing an Obsidian workspace.
function view(): any {
  const v = Object.create(InkView.prototype);
  Object.assign(v, {
    ctx: {}, previewCtx: { clearRect: vi.fn() }, previewCanvas: { width: 800, height: 1000 },
    canvasLogicalWidth: 800, canvasLogicalHeight: 1000, renderFrame: null, resizeRequested: false,
    currentPage: () => ({ strokes: [] }),
    viewport: { x: 0, y: 0, width: 800, height: 1000 }, zoom: 1,
    tiles: { sync: vi.fn(), update: vi.fn(), flushVisible: vi.fn() },
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

it("refreshes visible dirty tiles before releasing the preview bitmap", () => {
  const v = view();
  v.activeStroke = { tool: "pen" };
  v.commitPreview();
  expect(v.tiles.sync).toHaveBeenCalledOnce();
  expect(v.tiles.flushVisible).toHaveBeenCalledOnce();
  expect(drawInkStroke).not.toHaveBeenCalled();
  expect(v.previewCanvas).toEqual({ width: 1, height: 1 });
});

it("updates composited tiles for highlighters", () => {
  const v = view();
  v.activeStroke = { tool: "highlighter" };
  v.drawStrokes = vi.fn();
  v.requestRender();
  vi.mocked(window.requestAnimationFrame).mock.calls[0][0](0);
  expect(v.drawStrokes).toHaveBeenCalledOnce();
  expect(drawInkStroke).not.toHaveBeenCalled();
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
