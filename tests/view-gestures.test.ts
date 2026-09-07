import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ FileView: class {} }));

import { InkView } from "../src/view";

// Exercise the real view handlers with scroll bounds and centered-page geometry.
function setup(viewportWidth = 800) {
  const view = Object.create(InkView.prototype) as any;
  const width = viewportWidth - 48;
  const height = width * 1.4;
  const viewportHeight = Math.min(600, height);
  let left = 0;
  let top = 0;
  Object.assign(view, { zoom: 1, activePointerId: null, touchGesture: null });
  const zoomReadout = { textContent: "100%" };
  const zoomOut = { disabled: false };
  const zoomIn = { disabled: false };
  view.root = { querySelector: (selector: string) => {
    if (selector === ".ink-zoom-value") return zoomReadout;
    if (selector.includes("Zoom out")) return zoomOut;
    if (selector.includes("Zoom in")) return zoomIn;
    return null;
  } };
  view.pageScroller = {
    clientWidth: viewportWidth,
    clientHeight: viewportHeight,
    getBoundingClientRect: () => ({ left: 90, top: 120 }),
    get scrollLeft() { return left; },
    set scrollLeft(value: number) { left = Math.max(0, Math.min(width * view.zoom + 48 - viewportWidth, value)); },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(height * view.zoom + 48 - viewportHeight, value)); },
  };
  view.pageElement = {
    getBoundingClientRect: () => ({
      left: 90 + 24 + Math.max(0, (width - width * view.zoom) / 2) - left,
      top: 120 + 24 - top,
      width: width * view.zoom,
      height: height * view.zoom,
    }),
  };
  view.resizeCanvas = vi.fn();
  view.layoutPage = vi.fn();
  view.onViewportMotion = vi.fn();
  const point = (x: number, y: number) => {
    const rect = view.pageElement.getBoundingClientRect();
    return { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
  };
  return { view, point, zoomReadout, zoomOut, zoomIn };
}

function touchEvent(points: number[][]) {
  const touches = points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY }));
  return { touches: Object.assign(touches, { item: (index: number) => touches[index] ?? null }), preventDefault: vi.fn() };
}

describe("page touch navigation", () => {
  it("updates the toolbar readout and limits after gesture zoom", () => {
    const { view, zoomReadout, zoomOut, zoomIn } = setup();
    view.setZoom(3);
    expect(zoomReadout.textContent).toBe("300%");
    expect(zoomIn.disabled).toBe(true);
    view.setZoom(0.5);
    expect(zoomReadout.textContent).toBe("50%");
    expect(zoomOut.disabled).toBe(true);
    expect(zoomIn.disabled).toBe(false);
  });
  it.each([800, 340])("keeps an off-center pinch anchor under the moving midpoint at width %i", (width) => {
    const { view, point } = setup(width);
    const anchor = point(250, 420);
    view.onTouchStart(touchEvent([[1, 210, 420], [2, 290, 420]]));
    view.onTouchMove(touchEvent([[1, 160, 390], [2, 320, 390]]));
    expect(view.zoom).toBe(2);
    expect(point(240, 390).x).toBeCloseTo(anchor.x);
    expect(point(240, 390).y).toBeCloseTo(anchor.y);
  });

  it("pans with two fingers without changing their distance", () => {
    const { view } = setup();
    view.setZoom(2);
    const left = view.pageScroller.scrollLeft;
    const top = view.pageScroller.scrollTop;
    view.onTouchStart(touchEvent([[1, 300, 400], [2, 400, 400]]));
    view.onTouchMove(touchEvent([[2, 360, 350], [1, 260, 350]]));
    expect(view.zoom).toBe(2);
    expect(view.pageScroller.scrollLeft).toBeCloseTo(left + 40);
    expect(view.pageScroller.scrollTop).toBeCloseTo(top + 50);
  });

  it("continues with one finger after a pinch and rebases when a finger is added", () => {
    const { view } = setup();
    view.onTouchStart(touchEvent([[1, 300, 400], [2, 400, 400]]));
    view.onTouchMove(touchEvent([[1, 250, 400], [2, 450, 400]]));
    const left = view.pageScroller.scrollLeft;
    const top = view.pageScroller.scrollTop;
    view.onTouchStart(touchEvent([[2, 450, 400]]));
    view.onTouchMove(touchEvent([[2, 410, 340]]));
    expect(view.pageScroller.scrollLeft).toBeCloseTo(left + 40);
    expect(view.pageScroller.scrollTop).toBeCloseTo(top + 60);
    view.onTouchStart(touchEvent([[2, 410, 340], [3, 510, 340]]));
    view.onTouchMove(touchEvent([[2, 410, 340], [3, 510, 340]]));
    expect(view.zoom).toBe(2);
    expect(view.pageScroller.scrollLeft).toBeCloseTo(left + 40);
    view.onTouchStart(touchEvent([]));
    expect(view.touchGesture).toBeNull();
  });

  it("can drag to either horizontal edge and immediately reverse direction", () => {
    const { view } = setup();
    view.setZoom(3);
    view.onTouchStart(touchEvent([[1, 500, 400]]));
    view.onTouchMove(touchEvent([[1, -5000, 400]]));
    expect(view.pageScroller.scrollLeft).toBe(1504);
    view.onTouchMove(touchEvent([[1, -4980, 400]]));
    expect(view.pageScroller.scrollLeft).toBe(1484);
    view.onTouchMove(touchEvent([[1, 5000, 400]]));
    expect(view.pageScroller.scrollLeft).toBe(0);
  });

  it("preserves cursor-centered wheel zoom and ignores ordinary scrolling", () => {
    const { view, point } = setup();
    const anchor = point(320, 430);
    const event = { ctrlKey: true, metaKey: false, deltaY: -20, clientX: 320, clientY: 430, preventDefault: vi.fn() };
    view.onWheel(event);
    expect(view.zoom).toBeCloseTo(1.08);
    expect(view.layoutPage).toHaveBeenCalledOnce();
    expect(view.onViewportMotion).toHaveBeenCalledOnce();
    expect(view.resizeCanvas).not.toHaveBeenCalled();
    expect(point(320, 430).x).toBeCloseTo(anchor.x);
    expect(point(320, 430).y).toBeCloseTo(anchor.y);
    event.ctrlKey = false;
    event.preventDefault.mockClear();
    view.onWheel(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(view.zoom).toBeCloseTo(1.08);
  });

  it("allows panning at maximum zoom and clamps the scale", () => {
    const { view } = setup();
    view.setZoom(20);
    expect(view.zoom).toBe(3);
    const anchor = view.pageScroller.scrollLeft;
    view.onTouchStart(touchEvent([[1, 300, 400], [2, 400, 400]]));
    view.onTouchMove(touchEvent([[1, 230, 380], [2, 430, 380]]));
    expect(view.zoom).toBe(3);
    expect(view.pageScroller.scrollLeft).toBeCloseTo(anchor + 20);
    view.setZoom(0.1);
    expect(view.zoom).toBe(0.5);
    view.setZoom(Number.NaN);
    expect(view.zoom).toBe(0.5);
  });

  it("rebases coincident fingers without dividing by zero", () => {
    const { view } = setup();
    view.onTouchStart(touchEvent([[1, 300, 400], [2, 300, 400]]));
    view.onTouchMove(touchEvent([[1, 290, 400], [2, 310, 400]]));
    expect(view.zoom).toBe(1);
    view.onTouchMove(touchEvent([[1, 280, 400], [2, 320, 400]]));
    expect(view.zoom).toBe(2);
  });

  it("does not move the page while a pen stroke is active", () => {
    const { view } = setup();
    view.activePointerId = 5;
    view.onTouchStart(touchEvent([[1, 300, 400]]));
    expect(view.touchGesture).toBeNull();
    view.activePointerId = null;
    view.onTouchStart(touchEvent([[1, 300, 400]]));
    view.activePointerId = 5;
    view.onTouchMove(touchEvent([[1, 250, 300]]));
    expect(view.touchGesture).toBeNull();
    expect(view.pageScroller.scrollTop).toBe(0);
  });
});
