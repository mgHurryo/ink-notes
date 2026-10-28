import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ Modal: class {}, FileView: class {} }));

import { InkView } from "../src/view";
import { DesktopWheelGesture } from "../src/desktop-wheel";

// Exercise the real view handlers with scroll bounds and centered-page geometry.
function setup(viewportWidth = 800) {
  const view = Object.create(InkView.prototype) as any;
  const availableWidth = viewportWidth - 48;
  const width = Math.min(980, availableWidth);
  const horizontalGutter = Math.max(0, (availableWidth - width) / 2);
  const height = width * 1.4;
  const viewportHeight = Math.min(600, height);
  let left = 0;
  let top = 0;
  Object.assign(view, { zoom: 1, activePointerId: null, touchGesture: null, desktopWheel: new DesktopWheelGesture(),
    selectedStrokeIds: new Set(), lassoPath: [], lassoDrag: null });
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
    get scrollWidth() { return width * view.zoom + horizontalGutter * 2; },
    get scrollHeight() { return height * view.zoom + 48; },
    getBoundingClientRect: () => ({ left: 90, top: 120 }),
    get scrollLeft() { return left; },
    set scrollLeft(value: number) {
      left = Math.max(0, Math.min(width * view.zoom + horizontalGutter * 2 - availableWidth, value));
    },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(height * view.zoom + 48 - viewportHeight, value)); },
  };
  view.pageElement = {
    getBoundingClientRect: () => ({
      left: 90 + 24
        + Math.max(0, (availableWidth - width * view.zoom - horizontalGutter * 2) / 2)
        + horizontalGutter - left,
      top: 120 + 24 - top,
      width: width * view.zoom,
      height: height * view.zoom,
    }),
  };
  view.resizeCanvas = vi.fn();
  view.layoutPage = vi.fn();
  view.onViewportMotion = vi.fn();
  view.tiles = { setDisplayScale: vi.fn() };
  const point = (x: number, y: number) => {
    const rect = view.pageElement.getBoundingClientRect();
    return { x: (x - rect.left) / rect.width, y: (y - rect.top) / rect.height };
  };
  return { view, point, zoomReadout, zoomOut, zoomIn };
}

function touchEvent(points: number[][]) {
  const touches = points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY }));
  return { touches: Object.assign(touches, { item: (index: number) => touches[index] ?? null }), cancelable: true, preventDefault: vi.fn() };
}

describe("page touch navigation", () => {
  it("does not pan or pinch the live page during an asynchronous swipe handoff", () => {
    const { view } = setup();
    view.flipSettling = true;
    view.onTouchStart(touchEvent([[1, 300, 400]]));
    view.onTouchMove(touchEvent([[1, 300, 200]]));
    expect(view.pageScroller.scrollTop).toBe(0);
    view.onTouchStart(touchEvent([[1, 300, 200], [2, 400, 200]]));
    view.onTouchMove(touchEvent([[1, 250, 200], [2, 450, 200]]));
    expect(view.zoom).toBe(1);
    expect(view.touchGesture).toBeNull();
  });

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

  it("resets magnification and scroll position when opening another notebook page", async () => {
    const { view, zoomReadout, zoomOut, zoomIn } = setup();
    Object.assign(view, {
      notebook: { pages: [{ id: "first" }, { id: "second" }] },
      pageIndex: 0,
      pageNavigationGeneration: 0,
      viewReady: true,
      file: null,
      workerSession: null,
      renderPageRail: vi.fn(),
      renderPage: vi.fn(),
      finishPointerInput: vi.fn(),
      clearSaveTimers: vi.fn(),
    });
    Object.assign(view.pageScroller, {
      scrollLeft: 250,
      scrollTop: 300,
    });
    view.zoom = 2;
    const navigate = (view as any).navigateToPage.bind(view) as (id: string) => Promise<void>;

    await navigate("second");

    expect(view.zoom).toBe(1);
    expect(view.pageScroller.scrollLeft).toBe(0);
    expect(view.pageScroller.scrollTop).toBe(0);
    expect(zoomReadout.textContent).toBe("100%");
    expect(zoomOut.disabled).toBe(false);
    expect(zoomIn.disabled).toBe(false);
    expect(view.renderPage).toHaveBeenCalledOnce();
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

  it.each([0.15, 0.85])("keeps a %d page anchor under the fingers on a centered wide page", (pageX) => {
    const { view, point } = setup(1366);
    const rect = view.pageElement.getBoundingClientRect();
    const startX = rect.left + rect.width * pageX;
    const targetX = startX + (pageX < 0.5 ? 20 : -20);
    const anchor = point(startX, 420);
    view.onTouchStart(touchEvent([[1, startX - 40, 420], [2, startX + 40, 420]]));
    view.onTouchMove(touchEvent([[1, targetX - 60, 390], [2, targetX + 60, 390]]));
    expect(view.zoom).toBe(1.5);
    expect(point(targetX, 390).x).toBeCloseTo(anchor.x);
    expect(point(targetX, 390).y).toBeCloseTo(anchor.y);
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

  it("keeps panning while zoom is locked and ignores pinch distance changes", () => {
    const { view } = setup();
    view.setZoom(2);
    view.zoomLocked = true;
    const applyZoom = vi.spyOn(view, "applyGestureZoom");
    const left = view.pageScroller.scrollLeft;
    const top = view.pageScroller.scrollTop;
    view.onTouchStart(touchEvent([[1, 300, 400], [2, 400, 400]]));
    view.onTouchMove(touchEvent([[1, 190, 350], [2, 410, 350]]));
    expect(view.zoom).toBe(2);
    expect(view.pageScroller.scrollLeft).toBeCloseTo(left + 50);
    expect(view.pageScroller.scrollTop).toBeCloseTo(top + 50);
    expect(applyZoom).not.toHaveBeenCalled();
  });

  it("preserves a locked zoom level when navigating to another page", async () => {
    const { view } = setup();
    Object.assign(view, {
      notebook: { pages: [{ id: "first" }, { id: "second" }] },
      pageIndex: 0,
      pageNavigationGeneration: 0,
      viewReady: true,
      file: null,
      workerSession: null,
      zoomLocked: true,
      renderPageRail: vi.fn(),
      renderPage: vi.fn(),
      finishPointerInput: vi.fn(),
      clearSaveTimers: vi.fn(),
    });
    view.zoom = 2;
    const navigate = (view as any).navigateToPage.bind(view) as (id: string) => Promise<void>;
    await navigate("second");
    expect(view.zoom).toBe(2);
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

  it("follows a horizontal drag and decides the flip once, on release, by distance or fling", () => {
    const { view } = setup();
    Object.defineProperty(view.pageScroller, "scrollWidth", { get: () => view.pageScroller.clientWidth });
    const drags: number[] = [];
    const settles: number[] = [];
    (view as unknown as { swipeDrag: (o: number) => void }).swipeDrag = (o) => drags.push(o);
    (view as unknown as { swipeSettle: (d: number) => void }).swipeSettle = (d) => settles.push(d);

    view.onTouchStart(touchEvent([[1, 500, 400]]));
    view.onTouchMove(touchEvent([[1, 560, 400]]));
    expect(settles).toEqual([]);
    expect(drags.at(-1)).toBe(60);
    view.onTouchMove(touchEvent([[1, 700, 400]]));
    expect(drags.at(-1)).toBe(200);
    // Lift (touch list no longer holds the finger): far past the threshold → flip.
    view.onTouchStart(touchEvent([]));
    expect(settles).toEqual([-1]);

    // A short slow drag springs back.
    view.onTouchStart(touchEvent([[1, 500, 400]]));
    view.onTouchMove(touchEvent([[1, 520, 400]]));
    view.onTouchStart(touchEvent([]));
    expect(settles.at(-1)).toBe(0);

    // A long drag never double-flips: exactly one settle decision per gesture.
    view.onTouchStart(touchEvent([[1, 500, 400]]));
    view.onTouchMove(touchEvent([[1, 900, 400]]));
    view.onTouchMove(touchEvent([[1, 1300, 400]]));
    view.onTouchStart(touchEvent([]));
    expect(settles.at(-1)).toBe(-1);
    expect(settles.filter((d) => d !== 0)).toHaveLength(2);
  });

  it.each([
    { release: 120, velocity: -0.8, expected: 1 },
    { release: 350, velocity: -0.8, expected: 0 },
    { release: 120, velocity: 0.8, expected: 0 },
  ])("only flings with fresh velocity in the travel direction: $release/$velocity", ({ release, velocity, expected }) => {
    const { view } = setup();
    view.swipeSettle = vi.fn();
    view.touchGesture = { ids: [1], axis: "x", dragX: -60, lastT: 100, velocity };
    view.onTouchStart({ ...touchEvent([]), timeStamp: release });
    expect(view.swipeSettle).toHaveBeenCalledWith(expected, -60);
  });

  it("rebounds a page drag when a second finger arrives", () => {
    const { view } = setup();
    view.swipeSettle = vi.fn();
    view.touchGesture = { ids: [1], axis: "x", dragX: -60 };
    view.onTouchStart(touchEvent([[1, 300, 400], [2, 600, 400]]));
    expect(view.swipeSettle).toHaveBeenCalledWith(0);
    expect(view.touchGesture).toBeNull();
  });

  it("rebounds a page drag when a stylus touch lands mid-flip", () => {
    const { view } = setup();
    view.swipeSettle = vi.fn();
    view.onPointerDown = vi.fn();
    view.pageElement.contains = () => true;
    view.state = { tool: "pen" };
    view.touchGesture = { ids: [1], axis: "x", dragX: -60 };
    const stylus = { identifier: 9, clientX: 400, clientY: 400, force: 0.35, touchType: "stylus", target: view.pageElement };
    view.onTouchStart({ ...touchEvent([[1, 300, 400]]), type: "touchstart", timeStamp: 100, changedTouches: [stylus] });
    expect(view.swipeSettle).toHaveBeenCalledWith(0);
    expect(view.touchGesture).toBeNull();
    // The Pencil still takes over input for its own contact.
    expect(view.onPointerDown).toHaveBeenCalledTimes(1);
    expect(view.onPointerDown).toHaveBeenCalledWith(
      expect.objectContaining({ pointerId: 9, pointerType: "pen" }), "stylus-touch");
    // Lifting the dragging finger afterwards settles nothing twice: the
    // gesture is gone, so settlePageFlip returns without deciding a flip.
    view.onTouchStart({ ...touchEvent([]), type: "touchend",
      changedTouches: [{ identifier: 1, clientX: 300, clientY: 400, touchType: "direct" }] });
    expect(view.swipeSettle).toHaveBeenCalledTimes(1);
  });

  it("rebounds a page drag when a pen pointer takes over mid-flip", () => {
    // Pointer-only platforms never classify a stylus Touch, so the takeover
    // surfaces as an active pointer during onTouchMove; the page must still
    // spring back instead of stranding the drag translateX.
    const { view } = setup();
    view.swipeSettle = vi.fn();
    view.touchGesture = { ids: [1], axis: "x", dragX: -60 };
    view.activePointerId = 9;
    view.onTouchMove(touchEvent([[1, 300, 400]]));
    expect(view.swipeSettle).toHaveBeenCalledWith(0);
    expect(view.touchGesture).toBeNull();
  });

  it("allows a zoomed flip drag only from the scroll edge the drag heads for", () => {
    const { view } = setup();
    const scroller = view.pageScroller;
    Object.defineProperty(scroller, "scrollWidth", { get: () => scroller.clientWidth * 3 });
    let scroll = 0;
    Object.defineProperty(scroller, "scrollLeft", { get: () => scroll, set: (v: number) => { scroll = v; } });
    const drags: number[] = [];
    (view as unknown as { swipeDrag: (o: number) => void }).swipeDrag = (o) => drags.push(o);

    // Zoomed, mid-document: a horizontal drag pans (axis y, no drag events).
    scroller.scrollLeft = scroller.clientWidth;
    view.onTouchStart(touchEvent([[1, 500, 400]]));
    view.onTouchMove(touchEvent([[1, 620, 400]]));
    expect(drags).toEqual([]);
    view.onTouchStart(touchEvent([]));

    // At the left edge, dragging right flips to the previous page.
    scroller.scrollLeft = 0;
    view.onTouchStart(touchEvent([[1, 500, 400]]));
    view.onTouchMove(touchEvent([[1, 620, 400]]));
    expect(drags.at(-1)).toBe(120);
  });

  it("preserves cursor-centered wheel zoom", () => {
    const { view, point } = setup();
    const anchor = point(320, 430);
    const event = { ctrlKey: true, metaKey: false, deltaMode: 0, deltaX: 0, deltaY: -20, clientX: 320, clientY: 430,
      timeStamp: 100, target: null, cancelable: true, preventDefault: vi.fn() };
    view.onWheel(event);
    expect(view.zoom).toBeCloseTo(1.08);
    expect(view.layoutPage).toHaveBeenCalledOnce();
    expect(view.onViewportMotion).toHaveBeenCalledOnce();
    expect(view.resizeCanvas).not.toHaveBeenCalled();
    expect(point(320, 430).x).toBeCloseTo(anchor.x);
    expect(point(320, 430).y).toBeCloseTo(anchor.y);
  });

  it("holds the desktop raster until wheel zoom ends and preserves cursor anchoring", () => {
    vi.useFakeTimers();
    try {
      const { view, point } = setup();
      const anchor = point(320, 430);
      view.desktopZoom(1.1, { x: 320, y: 430 });
      vi.advanceTimersByTime(120);
      view.desktopZoom(1.1, { x: 320, y: 430 });
      expect(view.zoom).toBeCloseTo(1.21);
      expect(view.pinchRenderZoom).toBe(1);
      expect(view.tiles.setDisplayScale).not.toHaveBeenCalled();
      expect(point(320, 430)).toEqual(expect.objectContaining({ x: expect.closeTo(anchor.x), y: expect.closeTo(anchor.y) }));
      vi.advanceTimersByTime(179);
      expect(view.resizeCanvas).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(view.resizeCanvas).toHaveBeenCalledOnce();
      expect(view.pinchRenderZoom).toBeUndefined();
    } finally { vi.useRealTimers(); }
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
    const pencilTouch = touchEvent([[1, 300, 400]]);
    view.onTouchStart(pencilTouch);
    expect(pencilTouch.preventDefault).toHaveBeenCalledOnce();
    expect(view.touchGesture).toBeNull();
    view.activePointerId = null;
    view.onTouchStart(touchEvent([[1, 300, 400]]));
    view.activePointerId = 5;
    view.onTouchMove(touchEvent([[1, 250, 300]]));
    expect(view.touchGesture).toBeNull();
    expect(view.pageScroller.scrollTop).toBe(0);
  });

  it.each([null, 5])("cancels the native touch ending even with no remaining contacts and pointer %s", (pointerId) => {
    const { view } = setup();
    view.activePointerId = pointerId;
    const end = touchEvent([]);
    view.onTouchStart(end);
    expect(end.preventDefault).toHaveBeenCalledOnce();
    expect(view.activePointerId).toBe(pointerId);
    expect(view.touchGesture).toBeNull();
  });

  it("leaves three-contact system gestures uncanceled", () => {
    const { view } = setup();
    const gesture = touchEvent([[1, 300, 400], [2, 400, 400], [3, 500, 400]]);
    view.onTouchStart(gesture);
    expect(gesture.preventDefault).not.toHaveBeenCalled();
    expect(view.touchGesture).toBeNull();
  });

  it("keeps pinch-zoom working while editing input is locked", () => {
    const { view } = setup();
    view.readingMode = true; // inputLocked()
    view.onTouchStart(touchEvent([[1, 210, 420], [2, 290, 420]]));
    view.onTouchMove(touchEvent([[1, 160, 390], [2, 320, 390]]));
    expect(view.zoom).toBeGreaterThan(1);
  });

  it("lets a native menu dismissal see surface touches", () => {
    const { view } = setup();
    view.containerEl = { ownerDocument: { querySelector: (selector: string) => (selector === ".menu" ? { id: "menu" } : null) } };
    const event = touchEvent([[1, 210, 420]]);
    view.onTouchStart(event);
    expect(view.touchGesture).toBeNull();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
