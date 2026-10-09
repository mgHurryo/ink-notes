// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { PdfInkView, PdfWriterArbiter, VIEW_TYPE_PDF_INK } from "../src/pdf-view";
import { PdfSidecarStore, serializeSidecar } from "../src/pdf-store";
import { createSidecar, insertBlankNotePage, sourcePageId } from "../src/pdf-sidecar";
import type { PdfSidecar } from "../src/pdf-sidecar";
import { InkWorkerService } from "../src/worker-service";
import { PdfTabTakeover } from "../src/pdf-takeover";
import type { TFile, WorkspaceLeaf } from "obsidian";

const FINGERPRINT = { sha256: "a".repeat(64), byteLength: 100 };
const rasterViews = new Set<PdfInkView>();
const resizeCallbacks: (() => void)[] = [];

interface RailInternals {
  sidecar: PdfSidecar;
  noteIndex: number;
  pdfDoc: { numPages: number; getPage(n: number): Promise<unknown>; destroy(): Promise<void> } | null;
  neighbourCache: Map<number, HTMLCanvasElement>;
  thumbCache: Map<number, HTMLCanvasElement>;
  renderPdfPage(): Promise<void>;
  renderAll(): void;
  refreshPageRail(): void;
  paintThumbnail(index: number): void;
  paintVisibleThumbnails(): void;
  withPageUndo(change: () => boolean, label: string): void;
  prewarmNeighbours(): void;
  pendingThumbRenders: Set<number>;
}

/** Minimal pdf.js document stub: getPage(n) hands out a page whose render
 *  records the 1-based page number it painted. */
function fakePdfDoc(pageCount: number) {
  const renderedPages: number[] = [];
  const getPage = vi.fn(async (pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 595.28 * scale, height: 841.89 * scale }),
    render: vi.fn(() => { renderedPages.push(pageNumber); return { promise: Promise.resolve() }; }),
  }));
  return { renderedPages, getPage, doc: { numPages: pageCount, getPage, destroy: async () => undefined } };
}

async function setup(sourcePageCount = 3) {
  const sidecar = createSidecar("docs/lecture.pdf", FINGERPRINT,
    Array.from({ length: sourcePageCount }, () => ({ width: 595.28, height: 841.89, rotation: 0 })));
  const raw = serializeSidecar(sidecar);
  const sidecarFile = { path: "A_pdfinkwrittern/lecture--x.pdfink.json" } as TFile;
  const store = {
    sidecarFileFor: vi.fn(() => sidecarFile),
    createFor: vi.fn(async () => sidecarFile),
    readRaw: vi.fn(async () => raw),
    writeIfUnchanged: vi.fn(async (): Promise<boolean> => true),
    computeFingerprint: vi.fn(async () => FINGERPRINT),
    findRecoveryCandidates: vi.fn(async () => []),
  };
  const session = {
    canRenderTiles: () => false,
    initializeRaw: vi.fn(async () => sidecar.notebook),
    apply: vi.fn(async () => ({ type: "operation-applied", revision: 0 })),
    dispose: vi.fn(),
  };
  const workers = { createSession: vi.fn(() => session) } as unknown as InkWorkerService;
  const view = new PdfInkView({} as WorkspaceLeaf);
  view.configure({
    store: store as unknown as PdfSidecarStore,
    workers,
    takeover: new PdfTabTakeover(() => ({ enabled: false, enhancerActive: false, isPdfFile: () => true }), VIEW_TYPE_PDF_INK),
    arbiter: new PdfWriterArbiter(),
  });
  view.file = { path: "docs/lecture.pdf", basename: "lecture" } as TFile;
  await view.onOpen();
  const internal = view as unknown as RailInternals;
  // The main-page raster is out of scope here; thumbnails are what we test.
  internal.renderPdfPage = vi.fn(async () => undefined);
  const fakeDoc = fakePdfDoc(sourcePageCount);
  internal.pdfDoc = fakeDoc.doc;
  (internal as unknown as { attachSidecar(s: PdfSidecar, raw: string, f: TFile | null): void })
    .attachSidecar(sidecar, raw, sidecarFile);
  return { view, internal, sidecar, fakeDoc };
}

const thumbs = () => document.querySelectorAll<HTMLButtonElement>(".ink-pdf-view .ink-page-thumb");
const thumbAt = (index: number) => thumbs()[index]!;

interface SwipeInternals {
  scroller: HTMLElement;
  pageWrap: HTMLElement;
  flipSettling: boolean;
  touchGesture: unknown;
  onTouchStart(event: TouchEvent): void;
  onTouchMove(event: TouchEvent): void;
  cancelPageFlip(): void;
}

interface RasterInternals extends RailInternals {
  scroller: HTMLElement;
  pageWrap: HTMLElement;
  pdfCanvas: HTMLCanvasElement;
  zoom: number;
  zoomTouched: boolean;
  layoutPage(): void;
  swipeDrag(offset: number): void;
  prewarmToken: number;
  prewarmNeighbour(index: number, token: number): Promise<void>;
  renderSwipeStagePage(stage: HTMLElement, index: number): Promise<void>;
}

async function rasterSetup(width: number, height: number, dpr: number, zoom = 1) {
  const context = await setup(3);
  rasterViews.add(context.view);
  const host = context.view as unknown as RasterInternals;
  Object.defineProperties(host.scroller, { clientWidth: { value: width, configurable: true }, clientHeight: { value: height } });
  vi.stubGlobal("devicePixelRatio", dpr);
  host.zoomTouched = true;
  host.zoom = zoom;
  host.layoutPage();
  host.renderPdfPage = Reflect.get(PdfInkView.prototype, "renderPdfPage").bind(context.view);
  const viewports: { width: number; height: number }[] = [];
  const render = vi.fn(({ viewport }: { viewport: { width: number; height: number } }) => {
    viewports.push(viewport);
    return { promise: Promise.resolve(), cancel: vi.fn() };
  });
  host.pdfDoc = { numPages: 3, destroy: async () => undefined, getPage: vi.fn(async (number: number) => {
    const note = context.sidecar.notePages[number - 1];
    const rotated = note.rotation === 90 || note.rotation === 270;
    return { getViewport: ({ scale }: { scale: number }) => ({
      width: (rotated ? note.height : note.width) * scale,
      height: (rotated ? note.width : note.height) * scale,
    }), render };
  }) };
  // Keep main-raster assertions independent of optional neighbour prewarming.
  vi.spyOn(host, "prewarmNeighbours").mockImplementation(() => undefined);
  return { ...context, host, render, viewports };
}

function swipeTouch(points: number[][]): TouchEvent {
  return { touches: points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })),
    cancelable: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as TouchEvent;
}

function rapidSwipe(host: SwipeInternals, delta: number): void {
  host.onTouchStart(swipeTouch([[1, 400, 300]]));
  host.onTouchMove(swipeTouch([[1, 400 - delta * 600, 300]]));
  host.onTouchStart(swipeTouch([]));
}

async function delayedSwipeSetup(count = 8) {
  const context = await setup(count);
  const host = context.view as unknown as SwipeInternals;
  Object.defineProperties(host.scroller, { clientWidth: { value: 800 }, clientHeight: { value: 700 } });
  let release!: () => void;
  const render = vi.fn(async (): Promise<void> => undefined)
    .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
  context.internal.renderPdfPage = render;
  const navigation = vi.spyOn(context.view, "navigatePages");
  rapidSwipe(host, 1);
  return { ...context, host, render, navigation, release: () => release() };
}

/** Thumbnail tests need the rail expanded: it starts collapsed (parity with
 *  the notebook editor), and thumbnails skip painting while collapsed. */
async function setupExpanded(sourcePageCount = 3) {
  const context = await setup(sourcePageCount);
  (context.view as unknown as { root: HTMLElement }).root.classList.remove("ink-rail-hidden");
  return context;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="host"><div></div><main></main></div>';
  resizeCallbacks.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resizeCallbacks.push(callback); }
    observe() {} disconnect() {}
  });
  const ctx = new Proxy({}, { get: () => vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as CanvasRenderingContext2D);
});

afterEach(async () => {
  for (const view of rasterViews) await view.onClose();
  rasterViews.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pdf page preview rail", () => {
  it.each([[1318, 1, 1, 1270], [1318, 2, 1, 2540], [390, 3, 1, 1026], [800, 2, 2, 3008]])(
    "renders the visible PDF at display density (pane %ipx, DPR %i, zoom %i)",
    async (width, dpr, zoom, expectedWidth) => {
      const { view, host, viewports } = await rasterSetup(width, 928, dpr, zoom);
      await host.renderPdfPage();
      expect(host.pdfCanvas.width).toBe(expectedWidth);
      expect(host.pdfCanvas.height).toBeCloseTo(parseFloat(host.pageWrap.style.height) * dpr, -1);
      expect(viewports[0].width).toBeCloseTo(expectedWidth);
      expect(viewports[0].height).toBeCloseTo(host.pdfCanvas.height, 0);
      await view.onClose();
    });

  it("preserves display density for rotated pages at 100%", async () => {
    const { view, sidecar, host, viewports } = await rasterSetup(1318, 928, 2);
    sidecar.notePages[0].rotation = 90;
    host.layoutPage();
    await host.renderPdfPage();
    expect(host.pdfCanvas.width).toBe(2540);
    expect(viewports[0].width).toBeCloseTo(2540);
    expect(host.pdfCanvas.height).toBe(Math.round(2540 * 595.28 / 841.89));
    await view.onClose();
  });

  it("prewarms and renders swipe previews at their own displayed size and fit", async () => {
    const { view, sidecar, host } = await rasterSetup(1318, 928, 2);
    // The current portrait page fits by height; the landscape neighbour fits by width.
    host.zoomTouched = false;
    sidecar.notePages[1].width = 960;
    sidecar.notePages[1].height = 540;
    host.layoutPage();
    host.swipeDrag(-180);
    const stage = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
    await host.prewarmNeighbour(1, host.prewarmToken);
    const cached = host.neighbourCache.get(1)!;
    expect(cached.width).toBe(2540);
    expect(cached.height).toBe(Math.round(2540 * 540 / 960));
    expect(cached.width).toBe(parseFloat(stage.style.width) * 2);
    host.neighbourCache.clear();
    await host.renderSwipeStagePage(stage, 1);
    const raster = stage.querySelector<HTMLCanvasElement>("canvas:last-child")!;
    expect(raster.width).toBe(cached.width);
    expect(raster.height).toBe(cached.height);
    await view.onClose();
  });

  it("keeps high zoom and DPR PDF allocations within the existing canvas limits", async () => {
    const { view, host, viewports } = await rasterSetup(2000, 1200, 3, 3);
    await host.renderPdfPage();
    expect(host.pdfCanvas.width * host.pdfCanvas.height).toBeLessThanOrEqual(16_010_000);
    expect(Math.max(host.pdfCanvas.width, host.pdfCanvas.height)).toBeLessThanOrEqual(8192);
    expect(viewports[0].width).toBeCloseTo(host.pdfCanvas.width);
    // Width and height are independently rounded to integer backing pixels.
    expect(Math.abs(viewports[0].height - host.pdfCanvas.height)).toBeLessThanOrEqual(1);
    await view.onClose();
  });

  it("does not enlarge a cached swipe raster from an old pane size", async () => {
    const { view, host, render } = await rasterSetup(1318, 928, 2);
    const stale = document.createElement("canvas");
    stale.width = 595; stale.height = 842;
    host.neighbourCache.set(1, stale);
    host.swipeDrag(-180);
    const stage = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
    await host.renderSwipeStagePage(stage, 1);
    expect(render).toHaveBeenCalled();
    expect(host.neighbourCache.get(1)?.width).toBe(2540);
    await view.onClose();
  });

  it("invalidates old prewarm work when the pane resizes", async () => {
    const { view, host, render } = await rasterSetup(1318, 928, 2);
    let finish!: () => void;
    render.mockImplementationOnce(() => ({ promise: new Promise<void>((resolve) => { finish = resolve; }), cancel: vi.fn() }));
    const pending = host.prewarmNeighbour(1, host.prewarmToken);
    await Promise.resolve();
    expect(render).toHaveBeenCalledOnce();
    Object.defineProperty(host.scroller, "clientWidth", { value: 900 });
    resizeCallbacks[0]();
    finish();
    await pending;
    expect(host.neighbourCache.has(1)).toBe(false);
    await host.prewarmNeighbour(1, host.prewarmToken);
    expect(host.neighbourCache.get(1)?.width).toBe(1704);
    await view.onClose();
  });

  it("keeps rapid swipe destinations and coalesces renders while the PDF is loading", async () => {
    const { view, internal, host, render, navigation, release } = await delayedSwipeSetup();
    for (const delta of [1, 1, -1, 1]) rapidSwipe(host, delta);
    expect(internal.noteIndex).toBe(1);
    expect(host.flipSettling).toBe(true);
    expect(navigation).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(internal.noteIndex).toBe(3);
    expect(navigation.mock.calls.map(([delta]) => delta)).toEqual([1, 2]);
    expect(render).toHaveBeenCalledTimes(2);
    expect(host.pageWrap.style.visibility).toBe("");
    await view.onClose();
  });

  it("clamps each rapid swipe at the page edge before reversing", async () => {
    const { view, internal, host, release } = await delayedSwipeSetup(4);
    for (const delta of [1, 1, 1, 1, 1, -1]) rapidSwipe(host, delta);
    release();
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(internal.noteIndex).toBe(2);
    await view.onClose();
  });

  it("resumes the finger's current drag after rendering and ignores cancelled gestures", async () => {
    const { view, internal, host, release } = await delayedSwipeSetup();
    rapidSwipe(host, 1);
    host.onTouchStart(swipeTouch([[2, 400, 300]]));
    host.onTouchMove(swipeTouch([[2, -200, 300]]));
    host.cancelPageFlip();
    host.touchGesture = null;
    host.onTouchStart(swipeTouch([[3, 400, 300]]));
    host.onTouchMove(swipeTouch([[3, 280, 300]]));
    release();
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(internal.noteIndex).toBe(2);
    expect(host.pageWrap.style.transform).toBe("translateX(-120px)");
    expect(document.querySelector<HTMLElement>(".ink-swipe-stage")?.dataset.neighbor).toBe("3");
    host.cancelPageFlip();
    host.touchGesture = null;
    await view.onClose();
  });

  it("discards pending destinations when a PDF view closes during rendering", async () => {
    const { view, internal, host, navigation, release } = await delayedSwipeSetup();
    rapidSwipe(host, 1);
    rapidSwipe(host, 1);
    await view.onClose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(navigation).toHaveBeenCalledTimes(1);
    expect(internal.noteIndex).toBe(1);
    expect(document.querySelector(".ink-swipe-stage")).toBeNull();
  });

  it("releases the swipe input lock after a failed navigation without retrying", async () => {
    const { view } = await setup(3);
    const host = view as unknown as SwipeInternals;
    Object.defineProperties(host.scroller, { clientWidth: { value: 800 }, clientHeight: { value: 700 } });
    // Supply Obsidian's visibility helper, which the preview DOM shim omits.
    const status = (view as unknown as { statusEl: HTMLElement }).statusEl;
    Object.assign(status, { toggle: (visible: boolean) => { status.style.display = visible ? "" : "none"; } });
    const navigation = vi.spyOn(view, "navigatePages").mockRejectedValueOnce(new Error("render unavailable"));
    rapidSwipe(host, 1);
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(navigation).toHaveBeenCalledOnce();
    expect(status.textContent).toBe("Could not switch pages: render unavailable");
    expect(status.style.display).toBe("");
    expect(host.pageWrap.style.visibility).toBe("");
    expect(document.querySelector(".ink-swipe-stage")).toBeNull();
    await view.onClose();
  });

  it("starts collapsed and toggles from the toolbar Pages button", async () => {
    const { view } = await setup(3);
    const root = document.querySelector<HTMLElement>(".ink-pdf-view")!;
    expect(root.classList.contains("ink-rail-hidden")).toBe(true);
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Pages"]')!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    expect(root.classList.contains("ink-rail-hidden")).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    toggle.click();
    expect(root.classList.contains("ink-rail-hidden")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await view.onClose();
  });

  it("is always present with one thumbnail per note page and highlights the current page", async () => {
    const { view, internal } = await setup(3);
    internal.renderAll();
    const rail = document.querySelector<HTMLElement>(".ink-pdf-view .ink-page-rail")!;
    expect(rail).not.toBeNull();
    expect(rail.closest(".ink-pdf-body")).not.toBeNull();
    expect(thumbs()).toHaveLength(3);
    expect(rail.querySelector<HTMLElement>(".ink-rail-count")!.textContent).toBe("1 / 3");
    expect(thumbAt(0).classList.contains("is-active")).toBe(true);
    expect(thumbAt(0).getAttribute("aria-current")).toBe("true");
    expect(thumbAt(1).getAttribute("aria-current")).toBe("false");
    expect(thumbAt(2).getAttribute("aria-label")).toBe("Page 3");
    await view.onClose();
  });

  it("clicking a thumbnail navigates to that note page and moves the highlight", async () => {
    const { view, internal } = await setup(3);
    internal.renderAll();
    thumbAt(2).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internal.noteIndex).toBe(2);
    expect(document.querySelector<HTMLElement>(".ink-rail-count")!.textContent).toBe("3 / 3");
    expect(thumbAt(2).classList.contains("is-active")).toBe(true);
    expect(thumbAt(0).classList.contains("is-active")).toBe(false);
    await view.onClose();
  });

  it("renders thumbnails on demand for the visible range at thumbnail scale, and serves repaints from the cache", async () => {
    const { view, internal, fakeDoc } = await setupExpanded(8);
    internal.renderAll();
    // No layout in jsdom: the fallback visible range is the current page and
    // its neighbours (indexes 0 and 1 -> pdf.js pages 1 and 2), nothing else.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeDoc.getPage.mock.calls.map((call) => call[0])).toEqual([1, 2]);
    expect(fakeDoc.renderedPages).toEqual([1, 2]);
    const bitmap = internal.thumbCache.get(0)!;
    expect(bitmap.width).toBe(120); // RAIL_THUMB_WIDTH at devicePixelRatio 1
    expect(bitmap.height).toBe(Math.round(120 * 841.89 / 595.28));
    // A repaint sweep is served from the thumbnail cache: no new pdf.js work.
    internal.paintVisibleThumbnails();
    expect(fakeDoc.getPage.mock.calls).toHaveLength(2);
    await view.onClose();
  });

  it("downscales the neighbour prewarm raster instead of asking pdf.js again", async () => {
    const { view, internal, fakeDoc } = await setupExpanded(3);
    const neighbour = document.createElement("canvas");
    neighbour.width = 595;
    neighbour.height = 842;
    internal.neighbourCache.set(1, neighbour);
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeDoc.getPage.mock.calls.map((call) => call[0])).toEqual([1]); // page 2 came from the prewarm
    expect(internal.thumbCache.get(1)?.width).toBe(120);
    await view.onClose();
  });

  it("renders blank note pages as plain paper without touching pdf.js", async () => {
    const { view, internal, sidecar, fakeDoc } = await setupExpanded(3);
    insertBlankNotePage(sidecar, sourcePageId(0)); // [src0, blank, src1, src2]
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(thumbs()).toHaveLength(4);
    // The visible-range fallback painted indexes 0 (src0) and 1 (blank); the
    // blank page never reaches pdf.js and still gets a bitmap.
    expect(fakeDoc.getPage.mock.calls.map((call) => call[0])).toEqual([1]);
    expect(internal.thumbCache.get(1)?.width).toBe(120);
    // Off-screen thumbs render on demand when asked: index 2 is src1 -> pdf.js
    // page 2, index 3 is src2 -> page 3.
    internal.paintThumbnail(2);
    internal.paintThumbnail(3);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fakeDoc.getPage.mock.calls.map((call) => call[0])).toEqual([1, 2, 3]);
    await view.onClose();
  });

  it("immediately paints an inserted blank instead of a prewarmed PDF at its old index", async () => {
    const { view, internal, sidecar } = await setupExpanded(3);
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const oldPdf = document.createElement("canvas");
    oldPdf.width = 595; oldPdf.height = 842;
    internal.neighbourCache.set(1, oldPdf);
    const drawImage = vi.fn(), fillRect = vi.fn();
    const ctx = new Proxy({ drawImage, fillRect }, {
      get: (target, key) => Reflect.get(target, key) ?? vi.fn(), set: () => true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    internal.withPageUndo(() => insertBlankNotePage(sidecar, sourcePageId(0)) !== null, "insert a blank page");
    expect(sidecar.notePages[1].sourceIndex).toBeUndefined();
    expect(internal.neighbourCache.has(1)).toBe(false);
    expect(fillRect).toHaveBeenCalledWith(0, 0, 120, Math.round(120 * 841.89 / 595.28));
    expect(drawImage.mock.calls.some(([bitmap]) => bitmap === oldPdf)).toBe(false);
    expect(internal.thumbCache.has(1)).toBe(true);
    await view.onClose();
  });

  it("does not let a prewarm started before insertion populate the blank index", async () => {
    const { view, internal, sidecar, fakeDoc } = await setupExpanded(3);
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const render = vi.fn(() => ({ promise: pending }));
    fakeDoc.getPage.mockResolvedValueOnce({
      getViewport: ({ scale }: { scale: number }) => ({ width: 595.28 * scale, height: 841.89 * scale }), render,
    });
    internal.prewarmNeighbours();
    await Promise.resolve();
    expect(render).toHaveBeenCalledOnce();
    internal.withPageUndo(() => insertBlankNotePage(sidecar, sourcePageId(0)) !== null, "insert a blank page");
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internal.neighbourCache.has(1)).toBe(false);
    expect(internal.thumbCache.has(1)).toBe(true);
    await view.onClose();
  });

  it("discards a late thumbnail for an old page without clearing the replacement's pending render", async () => {
    const { view, internal, sidecar, fakeDoc } = await setupExpanded(3);
    let finishOld!: () => void, finishNew!: () => void;
    const oldPaint = new Promise<void>((resolve) => { finishOld = resolve; });
    const newPaint = new Promise<void>((resolve) => { finishNew = resolve; });
    let inserted = false;
    fakeDoc.getPage.mockImplementation(async (pageNumber) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 595.28 * scale, height: 841.89 * scale }),
      render: vi.fn(() => ({ promise: pageNumber === 3 ? oldPaint
        : inserted && pageNumber === 2 ? newPaint : Promise.resolve() })),
    }));
    internal.noteIndex = 1;
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internal.pendingThumbRenders.has(2)).toBe(true);
    inserted = true;
    internal.withPageUndo(() => insertBlankNotePage(sidecar, sourcePageId(0)) !== null, "insert a blank page");
    await Promise.resolve();
    finishOld();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internal.thumbCache.has(2)).toBe(false);
    expect(internal.pendingThumbRenders.has(2)).toBe(true);
    finishNew();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(internal.thumbCache.has(2)).toBe(true);
    expect(internal.pendingThumbRenders.has(2)).toBe(false);
    await view.onClose();
  });

  it("evicts cached thumbnails further than one page from the current page", async () => {
    const { view, internal } = await setupExpanded(6);
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    internal.noteIndex = 4;
    internal.renderAll();
    expect([...internal.thumbCache.keys()].every((key) => Math.abs(key - 4) <= 1)).toBe(true);
    await view.onClose();
  });

  it("rebuilds the rail when the page sequence changes, keeping the highlight at the current index", async () => {
    const { view, internal, sidecar } = await setup(2);
    internal.noteIndex = 1;
    internal.renderAll();
    expect(thumbs()).toHaveLength(2);
    expect(thumbAt(1).classList.contains("is-active")).toBe(true);
    insertBlankNotePage(sidecar, sourcePageId(0)); // indexes shift: [src0, blank, src1]
    internal.renderAll();
    expect(thumbs()).toHaveLength(3);
    // noteIndex is untouched by page ops: index 1 now shows the blank page.
    expect(internal.noteIndex).toBe(1);
    expect(thumbAt(1).classList.contains("is-active")).toBe(true);
    expect(thumbAt(1).getAttribute("aria-label")).toBe("Page 2");
    await view.onClose();
  });

  it("keeps a failing thumbnail render contained", async () => {
    const { view, internal, fakeDoc } = await setupExpanded(3);
    fakeDoc.getPage.mockRejectedValueOnce(new Error("pdf.js exploded"));
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The failed thumb simply has no bitmap; the others still rendered.
    expect(internal.thumbCache.has(0)).toBe(false);
    expect(fakeDoc.renderedPages).toEqual([2]);
    await view.onClose();
  });

  it("opens the page menu and export regardless of the writer lock", async () => {
    const { view, internal } = await setup(3);
    // Read-only state (writer lock) must not turn the buttons dead.
    (view as unknown as { writerHeld: boolean }).writerHeld = false;
    const menu = vi.spyOn(internal as never as { openPageMenu(e: MouseEvent): void }, "openPageMenu").mockImplementation(() => undefined);
    const exportCopy = vi.spyOn(internal as never as { exportHandwrittenCopy(): Promise<void> }, "exportHandwrittenCopy").mockImplementation(async () => undefined);
    document.querySelector<HTMLButtonElement>('button[aria-label="Page options"]')!.click();
    document.querySelector<HTMLButtonElement>('button[aria-label="Export PDF with handwriting"]')!.click();
    expect(menu).toHaveBeenCalledOnce();
    expect(exportCopy).toHaveBeenCalledOnce();
    await view.onClose();
  });

  it("never spring-backs a decided flip (double-settle = the flash)", async () => {
    const { view, internal } = await setup(3);
    // Stub the Web Animations API: settle(1) animates the stage toward the
    // neighbour slot; settle(0) while that flip is in flight must not add a
    // spring-back animation (that double-settle was the reported flash).
    const calls: string[] = [];
    const stub = (el: HTMLElement) => {
      (el as unknown as { animate: unknown }).animate = vi.fn((frames: { transform: string }[]) => {
        calls.push(frames[frames.length - 1].transform);
        return { onfinish: null, oncancel: null, cancel: vi.fn() };
      });
    };
    const stage = document.createElement("div");
    stage.dataset.neighbor = "1";
    stub(stage);
    stub((view as unknown as { pageWrap: HTMLElement }).pageWrap);
    (internal as unknown as { swipeStage: HTMLElement }).swipeStage = stage;
    const settle = (view as unknown as { swipeSettle(delta: number): void }).swipeSettle;
    settle.call(view, 1);
    const afterFlip = calls.length;
    expect(afterFlip).toBeGreaterThan(0);
    settle.call(view, 0);
    expect(calls.length).toBe(afterFlip);
    await view.onClose();
  });

  it("draws the page's handwriting over the rendered thumbnail", async () => {
    const { view, internal, sidecar } = await setupExpanded(3);
    const page = sidecar.notebook.pages[0];
    page.strokes.push({ id: "s1", pageId: page.id, tool: "pen", color: "#111111", width: 4, opacity: 1,
      points: [{ x: 0.1, y: 0.1, pressure: 0.5, t: 0 }], createdAt: 0, updatedAt: 0 });
    // A recording ctx: the shared beforeEach stub returns fresh spies per
    // property access, which cannot be asserted on.
    const ctx = { clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), setTransform: vi.fn() };
    const canvasSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The ink overlay mapped stroke space onto the thumbnail (transform set
    // for the thumbnail scale) on top of the page bitmap.
    expect(ctx.setTransform).toHaveBeenCalled();
    canvasSpy.mockRestore();
    await view.onClose();
  });

  it("preserves a landscape neighbour's ratio and previews its ink", async () => {
    const { view, sidecar } = await setup(3);
    const host = view as unknown as { scroller: HTMLElement; pageWrap: HTMLElement; swipeDrag(x: number): void };
    Object.defineProperties(host.scroller, { clientWidth: { value: 800 }, clientHeight: { value: 700 } });
    Object.defineProperties(host.pageWrap, { offsetWidth: { value: 400 }, offsetHeight: { value: 600 } });
    sidecar.notePages[1].width = 800;
    sidecar.notePages[1].height = 400;
    host.swipeDrag(-120);
    const stage = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
    expect(parseFloat(stage.style.width) / parseFloat(stage.style.height)).toBe(2);
    expect(stage.parentElement?.className).toBe("ink-swipe-layer");
    expect(stage.querySelectorAll("canvas")).toHaveLength(2);
    expect(stage.style.transform).toBe("translateX(-120px)");
    await view.onClose();
  });

  it("moves both pages equally and holds the snapshot until navigation finishes", async () => {
    const { view } = await setup(3);
    const host = view as unknown as { scroller: HTMLElement; pageWrap: HTMLElement;
      swipeDrag(x: number): void; swipeSettle(delta: number): void; flipSettling: boolean };
    Object.defineProperties(host.scroller, { clientWidth: { value: 800 }, clientHeight: { value: 700 } });
    Object.defineProperty(host.pageWrap, "offsetWidth", { value: 400 });
    host.swipeDrag(-180);
    const stage = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
    const animations: { onfinish: (() => void) | null; oncancel: (() => void) | null; cancel: ReturnType<typeof vi.fn> }[] = [];
    const targets: string[] = [];
    for (const el of [host.pageWrap, stage]) {
      el.animate = vi.fn((frames) => {
        targets.push((frames as { transform: string }[])[1].transform);
        const animation = { onfinish: null, oncancel: null, cancel: vi.fn() };
        animations.push(animation);
        return animation as unknown as Animation;
      });
    }
    let release!: () => void;
    const navigation = vi.spyOn(view, "navigatePages").mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    host.swipeSettle(1);
    expect(targets).toEqual(["translateX(-816px)", "translateX(-816px)"]);
    host.swipeSettle(0);
    expect(animations).toHaveLength(2);
    animations[0].onfinish!();
    expect(navigation).not.toHaveBeenCalled();
    animations[1].onfinish!();
    expect(navigation).toHaveBeenCalledOnce();
    expect(host.pageWrap.style.transform).toBe("");
    expect(stage.isConnected).toBe(true);
    expect(host.flipSettling).toBe(true);
    host.swipeDrag(200);
    expect(document.querySelector(".ink-swipe-stage")).toBe(stage);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stage.isConnected).toBe(false);
    expect(host.pageWrap.style.visibility).toBe("");
    expect(host.flipSettling).toBe(false);
    await view.onClose();
  });

  it("resists an unavailable neighbour and restores the page without navigation", async () => {
    const { view } = await setup(3);
    const host = view as unknown as { pageWrap: HTMLElement; swipeDrag(x: number): void; swipeSettle(delta: number): void };
    const navigation = vi.spyOn(view, "navigatePages");
    host.swipeDrag(240);
    expect(host.pageWrap.style.transform).toBe("translateX(60px)");
    host.swipeSettle(-1);
    expect(navigation).not.toHaveBeenCalled();
    expect(host.pageWrap.style.transform).toBe("");
    await view.onClose();
  });
});
