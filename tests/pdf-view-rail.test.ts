import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { PdfInkView, VIEW_TYPE_PDF_INK } from "../src/pdf-view";
import { PdfSidecarStore, serializeSidecar } from "../src/pdf-store";
import { createSidecar, insertBlankNotePage, sourcePageId } from "../src/pdf-sidecar";
import type { PdfSidecar } from "../src/pdf-sidecar";
import { InkWorkerService } from "../src/worker-service";
import { PdfTabTakeover } from "../src/pdf-takeover";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { InkView } from "../src/view";
import type { NotebookStore } from "../src/storage";
import { InkClipboard } from "../src/lasso-clipboard";
import { defaultToolState, type SharedToolState } from "../src/tool-state";
import type { InkNotebook, InkStroke } from "../src/model";
import { mergeNotebooks } from "../src/model";
import type { ImageLibraryStore } from "../src/image-library";
import type { StickyNote } from "../src/sticky-model";
import { gestureContract } from "./gesture-contract";

const FINGERPRINT = { sha256: "a".repeat(64), byteLength: 100 };
const views = new Set<PdfInkView>();
const resizeCallbacks: (() => void)[] = [];

interface RailInternals {
  sidecar: PdfSidecar;
  noteIndex: number;
  zoom: number;
  zoomTouched: boolean;
  fitZoom: number;
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

async function setup(sourcePageCount = 3, imageLibrary?: ImageLibraryStore) {
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
    serializeStorage: vi.fn(async (value: unknown) => serializeStoredJson(value)),
    apply: vi.fn(async () => ({ type: "operation-applied", revision: 0 })),
    dispose: vi.fn(),
  };
  const workers = { createSession: vi.fn(() => session) } as unknown as InkWorkerService;
  const view = new PdfInkView({} as WorkspaceLeaf);
  if (imageLibrary) view.useImageLibrary(imageLibrary);
  views.add(view);
  view.configure({
    store: store as unknown as PdfSidecarStore,
    workers,
    takeover: new PdfTabTakeover(() => ({ enabled: false, enhancerActive: false, isPdfFile: () => true }), VIEW_TYPE_PDF_INK),
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
gestureContract(async () => { const { view, internal } = await setup(); internal.renderAll(); return view; });
const thumbAt = (index: number) => thumbs()[index]!;

it("keeps mounted PDF tiles, preview buttons and background caches through ink-only peer merges", async () => {
  vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} closePath() {} });
  const { view, internal, sidecar, fakeDoc } = await setupExpanded(2);
  internal.renderAll();
  const editor = view as any, page = sidecar.notebook.pages[0];
  const local: InkStroke = { id:"local", pageId:page.id, tool:"pen", color:"#000", width:3, opacity:1,
    points:[{x:.1,y:.1,pressure:.5,t:1}], createdAt:1, updatedAt:1 };
  page.strokes.push(local); editor.drawStrokes(page.strokes); editor.tiles.flushVisible();
  await vi.waitFor(() => expect(editor.thumbCache.size).toBeGreaterThan(0));
  const mounted = Array.from(document.querySelectorAll(".ink-tile-layer > div"));
  expect(mounted.length).toBeGreaterThan(0);
  const buttons = Array.from(thumbs());
  const cache = editor.thumbCache, raster = vi.spyOn(editor, "renderPdfPage"), draw = vi.spyOn(editor, "drawStrokes");
  const setPage = vi.spyOn(editor.tiles, "setPage"), rebuild = vi.spyOn(editor, "rebuildRailButtons");
  const backgrounds = [...cache]; fakeDoc.getPage.mockClear();
  for (let i = 0; i < 3; i++) {
    const remote = parseStoredJson(serializeSidecar(editor.sidecar)) as PdfSidecar;
    remote.notebook.pages[0].strokes.push({...local, id:`peer-${i}`, points:[{x:.6,y:.6,pressure:.5,t:1}]});
    editor.receiveMergedSidecar(remote);
    expect(editor.currentPage()).toBe(page); expect(page.strokes[0]).toBe(local);
    expect(mounted.every(node => node.isConnected)).toBe(true);
    expect(Array.from(thumbs())).toEqual(buttons);
    expect([...cache]).toEqual(backgrounds);
  }
  expect(draw).toHaveBeenCalledTimes(3);
  expect(setPage).not.toHaveBeenCalled(); expect(rebuild).not.toHaveBeenCalled(); expect(raster).not.toHaveBeenCalled();
  // Source rasters prepared before this merge may finish asynchronously;
  // ink-only changes must not request new source thumbnail decoding.
  expect(fakeDoc.getPage).not.toHaveBeenCalled();
});

it("updates a remote PDF page's preview without touching the selected canvas or zoom", async () => {
  const { view, internal } = await setupExpanded(2); internal.renderAll();
  const editor = view as any, selected = editor.currentPage();
  const remote = parseStoredJson(serializeSidecar(editor.sidecar)) as PdfSidecar;
  const other = remote.notebook.pages[1];
  other.strokes.push({id:"peer-other",pageId:other.id,tool:"pen",color:"#000",width:3,opacity:1,
    points:[{x:.1,y:.1,pressure:.5,t:1}],createdAt:1,updatedAt:1});
  editor.zoom = 2; const raster = vi.spyOn(editor,"renderPdfPage"), draw = vi.spyOn(editor,"drawStrokes");
  const setPage = vi.spyOn(editor.tiles,"setPage"), layout = vi.spyOn(editor,"layoutPage");
  editor.receiveMergedSidecar(remote);
  expect(editor.currentPage()).toBe(selected); expect(editor.zoom).toBe(2);
  expect(draw).not.toHaveBeenCalled(); expect(setPage).not.toHaveBeenCalled();
  expect(layout).not.toHaveBeenCalled(); expect(raster).not.toHaveBeenCalled();
  expect(editor.sidecar.notebook.pages[1].strokes[0].id).toBe("peer-other");
});

it("routes image-target finger movement before PDF navigation and keeps native touch targets attached", async () => {
  const { view, internal, sidecar } = await setup(2, { url: () => "data:image/png;base64,", image: async () => document.createElement("img") } as unknown as ImageLibraryStore);
  internal.renderAll();
  const editor = view as any, page = sidecar.notebook.pages[0];
  editor.changeImages(page.id, [], [{ id: "pdf-touch-image", pageId: page.id, assetPath: "Ink Notes/Images/assets/a.png", x: .1, y: .1, width: .3, height: .3,
    foreground: false, createdAt: 1, updatedAt: 1 }]);
  const host = document.querySelector<HTMLElement>(".ink-pdf-ink-host")!;
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 1000, height: 1500, right: 1000, bottom: 1500, toJSON: () => ({}) });
  const dispatch = (target: HTMLElement, type: string, x: number, y: number) => {
    const finger = { identifier: 41, target, clientX: x, clientY: y, touchType: "direct" };
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [finger] }, changedTouches: { value: [finger] } });
    target.dispatchEvent(event);
  };
  const image = document.querySelector<HTMLElement>(".ink-placed-image")!;
  dispatch(image, "touchstart", 150, 200);
  expect(image.isConnected).toBe(true);
  dispatch(image, "touchmove", 200, 230);
  expect(parseFloat(image.style.left)).toBeCloseTo(15);
  dispatch(image, "touchend", 200, 230);
  expect(page.images![0].x).toBeCloseTo(.15); expect(page.images![0].y).toBeCloseTo(.12);
  expect(editor.touchGesture).toBeNull(); expect(editor.noteIndex).toBe(0);
  const handle = document.querySelector<HTMLElement>('[aria-label="Resize image"]')!;
  dispatch(handle, "touchstart", 400, 600);
  expect(handle.isConnected).toBe(true);
  dispatch(handle, "touchmove", 460, 660); dispatch(handle, "touchend", 460, 660);
  expect(page.images![0].width).toBeCloseTo(.36); expect(page.images![0].height).toBeCloseTo(.36);
  editor.undo(); expect(page.images![0].width).toBeCloseTo(.3);
  editor.undo(); expect(page.images![0].x).toBeCloseTo(.1);
});

it("edits PDF page images, restores deletion with fresh IDs, and keeps images separate across pages", async () => {
  const { view, internal, sidecar } = await setup(2, { url: () => "data:image/png;base64,", image: async () => document.createElement("img") } as unknown as ImageLibraryStore);
  internal.renderAll();
  expect(document.querySelector('[aria-label="Image library"]')).not.toBeNull();
  document.querySelector<HTMLButtonElement>('[aria-label="Pointer"]')!.click();
  const editor = view as any, pageId = sidecar.notebook.pages[0].id;
  editor.changeImages(pageId, [], [{ id: "pdf-image", pageId, assetPath: "Ink Notes/Images/assets/a.png", x: .1, y: .1, width: .3, height: .3,
    foreground: false, createdAt: 1, updatedAt: 1 }]);
  editor.pageImages.select("pdf-image");
  expect(document.querySelectorAll(".ink-placed-image")).toHaveLength(1);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Image X percent"]')!;
  input.value = "40"; input.dispatchEvent(new Event("change"));
  expect(sidecar.notebook.pages[0].images![0].x).toBe(.4);
  editor.undo(); expect(sidecar.notebook.pages[0].images![0].x).toBe(.1);
  editor.redo(); expect(sidecar.notebook.pages[0].images![0].x).toBe(.4);
  editor.pageImages.select("pdf-image");
  const remove = Array.from(document.querySelectorAll<HTMLButtonElement>(".ink-image-inspector button")).find((b) => b.textContent === "Delete image")!;
  remove.click(); expect(sidecar.notebook.pages[0].images).toHaveLength(0);
  editor.undo(); expect(sidecar.notebook.pages[0].images).toHaveLength(1);
  expect(sidecar.notebook.pages[0].images![0].id).not.toBe("pdf-image");
  await view.navigatePages(1); expect(document.querySelectorAll(".ink-placed-image")).toHaveLength(0);
  await view.navigatePages(-1); expect(document.querySelectorAll(".ink-placed-image")).toHaveLength(1);
  editor.setReadingMode(true); editor.drawSelection(100, 100);
  expect((document.querySelector(".ink-placed-image") as HTMLElement).style.pointerEvents).toBe("none");
});

it("persists PDF sticky notes independently, locates their page and preserves content on resize", async () => {
  const { view, sidecar } = await setup(2); const editor = view as any, pageId = sidecar.notePages[0].id;
  const note: StickyNote = { id: "pdf-sticky", pageId, x: .1, y: .1, width: .5, height: .3, title: "Review", keywords: "exam", text: "PDF text",
    textUpdatedAt: 1, color: "#fff1a8", collapsed: false, preview: true, scrollX: 0, scrollY: 0, boardPageWidth: 600,
    strokes: [], deletedStrokeIds: [], createdAt: 1, updatedAt: 1 };
  editor.changeSticky(undefined, note);
  expect(sidecar.notebook.pages[0].stickyNotes).toHaveLength(1);
  const original = sidecar.notebook.pages[0].stickyNotes![0];
  editor.changeSticky(original, { ...original, width: .2 });
  expect(sidecar.notebook.pages[0].stickyNotes![0].text).toBe("PDF text");
  editor.undo(); expect(sidecar.notebook.pages[0].stickyNotes![0].width).toBe(.5);
  editor.redo(); expect(sidecar.notebook.pages[0].stickyNotes![0].width).toBe(.2);
  await view.navigatePages(1); expect(document.querySelectorAll(".ink-sticky-note")).toHaveLength(0);
  await view.revealSticky(pageId, note.id); expect(document.querySelectorAll(".ink-sticky-note")).toHaveLength(1);
  await expect(view.revealSticky("missing-page", note.id)).rejects.toThrow("no longer exists");
  expect(document.querySelector('[aria-label="Type on sticky note"]')).not.toBeNull();
  expect(document.querySelector(".ink-sticky-editor")).toBeNull();
  editor.setReadingMode(true); editor.changeSticky(sidecar.notebook.pages[0].stickyNotes![0], { ...original, text: "Blocked" });
  expect(sidecar.notebook.pages[0].stickyNotes![0].text).toBe("PDF text");
});

it("keeps erased sticky ink removed after repeated undo, redo and stale saves", async () => {
  const { view, sidecar } = await setup(1), editor = view as any;
  const page = sidecar.notebook.pages[0], pageId = page.id;
  const note: StickyNote = { id: "sticky-history", pageId, x: .1, y: .1, width: .5, height: .3, title: "History", keywords: "", text: "",
    textUpdatedAt: 1, color: "#fff1a8", collapsed: false, preview: true, scrollX: 0, scrollY: 0, boardPageWidth: 600,
    strokes: [{ id: "original-ink", pageId: "sticky-history", tool: "pen", color: "#000000", width: 3, opacity: 1,
      points: [{ x: .2, y: .3, pressure: .5, t: 1 }], createdAt: 1, updatedAt: 1 }], deletedStrokeIds: [], createdAt: 1, updatedAt: 1 };
  editor.changeSticky(undefined, note);
  editor.changeSticky(page.stickyNotes![0], { ...page.stickyNotes![0], strokes: [], deletedStrokeIds: ["original-ink"] });
  for (let iteration = 0; iteration < 3; iteration++) {
    editor.undo(); expect(page.stickyNotes![0].strokes).toHaveLength(1);
    const savedUndo = JSON.parse(JSON.stringify(sidecar.notebook));
    editor.redo(); expect(page.stickyNotes![0].strokes).toHaveLength(0);
    expect(mergeNotebooks(sidecar.notebook, savedUndo).pages[0].stickyNotes![0].strokes).toHaveLength(0);
  }
  editor.undo();
  const restored = page.stickyNotes![0];
  editor.changeSticky(restored, { ...restored, width: .2 });
  editor.changeSticky(restored, { ...restored, text: "Stale drag draft" });
  expect(page.stickyNotes![0].text).toBe("");
  editor.undo(); editor.redo();
  expect(page.stickyNotes![0].strokes).toHaveLength(1);
  expect(mergeNotebooks(sidecar.notebook, JSON.parse(JSON.stringify(sidecar.notebook))).pages[0].stickyNotes![0].strokes).toHaveLength(1);
  await view.revealSticky(pageId, note.id);
  expect(document.querySelector('.ink-sticky-note')).not.toBeNull();
  await view.onUnloadFile(view.file!);
  expect(document.querySelector('.ink-sticky-editor')).toBeNull();
  expect(document.querySelector('.ink-sticky-layer')).toBeNull();
});

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
  // The host normally unloads every view; do so before restoring Canvas mocks.
  for (const view of views) {
    await view.onClose();
    (view as unknown as { cleanups: (() => void)[] }).cleanups.forEach((cleanup) => cleanup());
  }
  views.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pdf page preview rail", () => {
  it("gates PDF finger-hold paste by clipboard scope and source writability", async () => {
    const { view, sidecar } = await setup(1), host = view as any;
    const clipboard = new InkClipboard(), shared: SharedToolState = { config: defaultToolState(), clipboard, scheduleSave: vi.fn() };
    host.useSharedToolState(shared); host.selectWritingTool("eraser");
    const page = sidecar.notebook.pages[0];
    clipboard.copy({ filePath: "Other.ink", width: 100, height: 100, strokes: [{ id: "copied", pageId: "other", tool: "pen",
      color: "#123456", width: 3, opacity: 1, points: [{ x: .1, y: .1, pressure: .5, t: 1 }], createdAt: 1, updatedAt: 1 }] });
    const paper = document.querySelector<HTMLElement>('.ink-pdf-ink-host')!;
    vi.spyOn(host, "inputRect").mockReturnValue(new DOMRect(0, 0, 600, 800));
    const finger = { identifier: 91, target: paper, clientX: 360, clientY: 320, touchType: "direct" };
    const touch = (type: string) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [finger] }, changedTouches: { value: [finger] } });
      paper.dispatchEvent(event);
    };
    vi.useFakeTimers();
    try {
      touch("touchstart"); vi.advanceTimersByTime(700);
      expect(document.querySelector('.ink-selection-actions')).toBeNull(); touch("touchend");
      shared.config.lasso.crossFileClipboard = true;
      touch("touchstart"); vi.advanceTimersByTime(600); touch("touchend");
      expect(document.querySelector('.ink-selection-actions')).not.toBeNull();
      document.querySelector<HTMLButtonElement>('[aria-label="Paste"]')!.click();
      expect(page.strokes).toHaveLength(1); expect(page.strokes[0].points[0]).toMatchObject({ x: .6, y: .4 });
      expect(document.querySelector('.ink-selection-actions')).toBeNull(); expect(host.state.tool).toBe("eraser");
      host.writeBlockedReason = "source revision changed";
      touch("touchstart"); vi.advanceTimersByTime(700);
      expect(document.querySelector('.ink-selection-actions')).toBeNull(); touch("touchend");
    } finally { host.writeBlockedReason = null; vi.useRealTimers(); }
  });

  it("shares copied Ink strokes with PDF notes only when cross-file paste is enabled", async () => {
    const { view: target, sidecar } = await setup(1);
    const source = new InkView({} as WorkspaceLeaf, {} as NotebookStore);
    source.file = { path: "source.ink" } as TFile;
    const shared: SharedToolState = { config: defaultToolState(), clipboard: new InkClipboard(), scheduleSave: vi.fn() };
    const sourceHost = source as unknown as { useSharedToolState(binding: SharedToolState): void; notebook: InkNotebook;
      selectedStrokeIds: Set<string>; copySelection(): void; canvasLogicalWidth: number; canvasLogicalHeight: number };
    const targetHost = target as unknown as { useSharedToolState(binding: SharedToolState): void; pasteSelection(): void;
      canvasLogicalWidth: number; canvasLogicalHeight: number; state: ReturnType<typeof defaultToolState> };
    sourceHost.useSharedToolState(shared); targetHost.useSharedToolState(shared);
    const page = sourceHost.notebook.pages[0];
    const ink: InkStroke = { id: "source-ink", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.1, y: 0.1, pressure: 0.6, t: 1 }, { x: 0.2, y: 0.2, pressure: 0.7, t: 2 }], createdAt: 1, updatedAt: 1 };
    page.strokes.push(ink); sourceHost.selectedStrokeIds.add(ink.id);
    sourceHost.canvasLogicalWidth = 100; sourceHost.canvasLogicalHeight = 100;
    targetHost.canvasLogicalWidth = 100; targetHost.canvasLogicalHeight = 150;
    sourceHost.copySelection();
    targetHost.pasteSelection();
    expect(sidecar.notebook.pages[0].strokes).toHaveLength(0);
    document.querySelector<HTMLButtonElement>('[aria-label="Select"]')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Select"]')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Rectangle selection"]')!.click();
    expect(shared.config.lasso.mode).toBe("rectangle");
    expect(sourceHost.notebook.pages[0].strokes).toHaveLength(1);
    const toggle = document.querySelector<HTMLInputElement>('[aria-label="Copy and paste across files"]')!;
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
    document.querySelector<HTMLButtonElement>('[aria-label="Paste handwriting"]')!.click();
    expect(sidecar.notebook.pages[0].strokes).toHaveLength(1);
    expect(sidecar.notebook.pages[0].strokes[0].pageId).toBe(sidecar.notebook.pages[0].id);
    expect(sidecar.notebook.pages[0].strokes[0].id).not.toBe(ink.id);
    expect(page.strokes).toHaveLength(1);
    expect(shared.scheduleSave).toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click();
    expect(sidecar.notebook.pages[0].strokes).toHaveLength(0);
    await target.onClose();
  });
  it("switches PDF reading mode without changing navigation or sidecar writability", async () => {
    const { view, internal, sidecar } = await setup(2);
    const host = view as unknown as { readingMode: boolean; setReadingMode(value: boolean): void;
      addBlankPage(index: number): void; withPageUndo(change: () => boolean, label: string): void;
      writeBlockedReason: string | null; inputLocked(): boolean; state: { tool: string }; ensureSwipeStage(offset: number): void;
      exportHandwrittenCopy(): Promise<void> };
    const before = serializeSidecar(sidecar);
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Reading mode"]')!;
    toggle.click();
    expect(host.readingMode).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".ink-pdf-view")!.classList.contains("ink-reading")).toBe(true);
    expect(host.writeBlockedReason).toBeNull();
    expect(host.inputLocked()).toBe(true);
    const scroller = document.querySelector<HTMLElement>(".ink-pdf-scroller")!;
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    expect(internal.noteIndex).toBe(1);
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    expect(host.state.tool).toBe("pen");
    host.ensureSwipeStage(-250);
    expect(document.querySelector(".ink-swipe-stage")).toBeNull();
    const exportCopy = vi.spyOn(host, "exportHandwrittenCopy").mockResolvedValue();
    document.querySelector<HTMLButtonElement>('[aria-label="Export PDF with handwriting"]')!.click();
    expect(exportCopy).toHaveBeenCalledOnce();
    host.addBlankPage(1);
    host.withPageUndo(() => true, "change the page");
    expect(serializeSidecar(sidecar)).toBe(before);
    toggle.click();
    expect(host.readingMode).toBe(false);
    expect(document.querySelector(".ink-pdf-view")!.classList.contains("ink-reading")).toBe(false);
    expect(host.inputLocked()).toBe(false);
    host.writeBlockedReason = "source revision changed";
    toggle.click(); toggle.click();
    expect(host.inputLocked()).toBe(true);
  });

  it("shares PDF desktop navigation and tool shortcuts, without taking text input or read-only history", async () => {
    const { view, internal } = await setup(3);
    const scroller = document.querySelector<HTMLElement>(".ink-pdf-scroller")!;
    const key = (value: string, options = {}) => scroller.dispatchEvent(new KeyboardEvent("keydown",
      { key: value, bubbles: true, cancelable: true, ...options }));
    scroller.focus();
    key("PageDown");
    expect(internal.noteIndex).toBe(1);
    key("End");
    expect(internal.noteIndex).toBe(2);
    key("Home");
    expect(internal.noteIndex).toBe(0);
    key("e");
    expect(document.querySelector('[aria-label="Erase"]')?.getAttribute("aria-pressed")).toBe("true");
    const host = view as unknown as { undo(): void; writeBlockedReason: string | null };
    const undo = vi.spyOn(host, "undo");
    host.writeBlockedReason = "source revision changed";
    key("z", { ctrlKey: true });
    expect(undo).not.toHaveBeenCalled();
    key("PageDown");
    expect(internal.noteIndex).toBe(1);
  });

  it("allows read-only PDF middle-button panning and clears it when capture is lost", async () => {
    const { view } = await setup();
    const host = view as unknown as { writeBlockedReason: string | null; scroller: HTMLElement; desktopPan: unknown;
      onPointerDown(e: PointerEvent): void; onPointerMove(e: PointerEvent): void; onLostPointerCapture(e: PointerEvent): void;
      capturePointer(id: number): void; releasePointer(id: number): void };
    host.writeBlockedReason = "source revision changed";
    vi.spyOn(host, "capturePointer").mockImplementation(() => undefined);
    vi.spyOn(host, "releasePointer").mockImplementation(() => undefined);
    const event = { pointerType: "mouse", pointerId: 2, button: 1, clientX: 200, clientY: 200, preventDefault: vi.fn() } as unknown as PointerEvent;
    host.onPointerDown(event);
    host.onPointerMove({ ...event, clientX: 170, clientY: 160 });
    expect(host.scroller.scrollLeft).toBe(30);
    expect(host.scroller.scrollTop).toBe(40);
    host.onLostPointerCapture(event);
    expect(host.desktopPan).toBeNull();
    expect(host.scroller.classList.contains("ink-panning")).toBe(false);
  });

  it.each([
    ["Add page before current", 1], ["Add page after current", 2],
    ["Add page before first", 0], ["Add page after last", 3],
  ])("inserts a selected PDF blank with %s and restores selection on undo/redo", async (label, index) => {
    const { view, internal } = await setup(3);
    await view.navigatePages(1);
    const sources = internal.sidecar.notePages.map((page) => ({ ...page }));
    document.querySelector<HTMLButtonElement>('[aria-label="Add page"]')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".preview-menu button"))
      .find((item) => item.textContent === label)!.click();
    const id = internal.sidecar.notePages[index].id;
    expect(internal.noteIndex).toBe(index);
    expect(internal.sidecar.notePages[index].sourceIndex).toBeUndefined();
    expect(internal.sidecar.notebook.pages[index]).toMatchObject({ id, paper: "blank", strokes: [] });
    expect(internal.sidecar.notePages.filter((page) => page.id !== id)).toEqual(sources);
    document.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click();
    expect(internal.sidecar.notePages).toEqual(sources);
    expect(internal.noteIndex).toBe(1);
    document.querySelector<HTMLButtonElement>('[aria-label="Redo"]')!.click();
    expect(internal.sidecar.notePages[index].id).toBe(id);
    expect(internal.noteIndex).toBe(index);
  });

  it.each([-1, 1])("adds once at PDF boundary %s only after the distance threshold", async (side) => {
    const { view, internal } = await setup(3);
    const host = view as unknown as SwipeInternals;
    Object.defineProperties(host.scroller, { clientWidth: { value: 800 }, clientHeight: { value: 700 } });
    if (side > 0) await view.navigatePages(2);
    host.onTouchStart(swipeTouch([[1, 400, 300]]));
    host.onTouchMove(swipeTouch([[1, 400 - side * 80, 300]]));
    host.onTouchStart(swipeTouch([]));
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(internal.sidecar.notePages).toHaveLength(3);
    host.onTouchStart(swipeTouch([[1, 400, 300]]));
    host.onTouchMove(swipeTouch([[1, 400 - side * 250, 300]]));
    expect(document.querySelector(".ink-swipe-stage")?.classList.contains("is-ready")).toBe(true);
    host.onTouchStart(swipeTouch([])); host.onTouchStart(swipeTouch([]));
    expect(internal.sidecar.notePages).toHaveLength(4);
    expect(internal.noteIndex).toBe(side < 0 ? 0 : 3);
    expect(internal.sidecar.notePages[internal.noteIndex].sourceIndex).toBeUndefined();
  });

  it("blocks menu and boundary insertion when the PDF source revision changes", async () => {
    const { view, internal } = await setup();
    const host = view as unknown as SwipeInternals & { writeBlockedReason: string | null };
    host.writeBlockedReason = "source revision changed";
    Object.defineProperties(host.scroller, { clientWidth: { value: 800 }, clientHeight: { value: 700 } });
    document.querySelector<HTMLButtonElement>('[aria-label="Add page"]')!.click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".preview-menu button"))[0].click();
    rapidSwipe(host, -1);
    await Promise.resolve();
    expect(internal.sidecar.notePages).toHaveLength(3);
    expect(document.querySelector(".ink-page-insert-hint")).toBeNull();
  });

  it("shows a locked PDF pinch again and pans without changing the scale", async () => {
    const { view, host } = await rasterSetup(800, 700, 1, 1);
    const gestureHost = host as unknown as { zoom: number; zoomLocked: boolean; onTouchStart(event: TouchEvent): void; onTouchMove(event: TouchEvent): void };
    gestureHost.zoom = 1.5;
    gestureHost.zoomLocked = true;
    const before = host.scroller.scrollTop;
    gestureHost.onTouchStart(swipeTouch([[1, 300, 300], [2, 400, 300]]));
    gestureHost.onTouchMove(swipeTouch([[1, 250, 260], [2, 450, 260]]));
    expect(gestureHost.zoom).toBe(1.5);
    expect(host.scroller.scrollTop).toBeGreaterThan(before);
    expect(document.querySelector(".ink-zoom-hud")?.classList.contains("is-visible")).toBe(true);
    await view.onClose();
  });
  it("keeps a locked PDF magnification across mixed page fits and disables menu zoom", async () => {
    const { view, sidecar, host } = await rasterSetup(800, 700, 2);
    const oldFit = host.fitZoom;
    // 200% is relative to each page's default fit, including portrait/landscape.
    host.zoom = oldFit * 2;
    const lock = document.querySelector<HTMLButtonElement>('[aria-label="Lock zoom"]')!;
    lock.click();
    sidecar.notePages[1].width = 960;
    sidecar.notePages[1].height = 540;
    const previewSize = (view as unknown as { swipePageSize(page: unknown): { zoom: number } }).swipePageSize(sidecar.notePages[1]);
    expect(previewSize.zoom).toBe(2);
    await view.navigatePages(1);
    expect(host.fitZoom).toBe(1);
    expect(host.zoom).toBe(2);
    expect(document.querySelector(".ink-zoom-hud-value")?.textContent).toBe("200%");
    document.querySelector<HTMLButtonElement>('[aria-label="Page options"]')!.click();
    const entries = Array.from(document.querySelectorAll<HTMLButtonElement>(".preview-menu button"))
      .filter((item) => ["Zoom out", "Reset zoom", "Zoom in"].includes(item.textContent!));
    expect(entries).toHaveLength(3);
    expect(entries.every((item) => item.disabled)).toBe(true);
    (view as unknown as { resetZoom(): void; setZoom(value: number): void }).resetZoom();
    (view as unknown as { setZoom(value: number): void }).setZoom(3);
    expect(host.zoom).toBe(2);
    document.querySelector<HTMLButtonElement>('[aria-label="Page options"]')!.click();
    document.querySelector<HTMLButtonElement>('[aria-label="Unlock zoom"]')!.click();
    await view.navigatePages(-1);
    expect(host.zoom).toBeCloseTo(oldFit);
    expect(document.querySelector(".ink-zoom-hud-value")?.textContent).toBe("100%");
  });

  it("toggles the PDF three-dot menu instead of reopening after native dismissal", async () => {
    const { view } = await setup();
    try {
      const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="Page options"]')!;
      const tap = () => {
        trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        trigger.click();
      };
      tap();
      expect(document.querySelector(".preview-menu")).not.toBeNull();
      tap();
      expect(document.querySelector(".preview-menu")).toBeNull();
      trigger.click();
      expect(document.querySelector(".preview-menu")).not.toBeNull();
      trigger.click();
      expect(document.querySelector(".preview-menu")).toBeNull();
      tap();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      tap();
      expect(document.querySelector(".preview-menu")).not.toBeNull();
      await view.onClose();
      expect(document.querySelector(".preview-menu")).toBeNull();
    } finally {
      await view.onClose();
    }
  });

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
    const { view, sidecar, host } = await rasterSetup(1318, 928, 2, 2);
    // The current portrait page fits by height; the landscape neighbour fits by width.
    sidecar.notePages[1].width = 960;
    sidecar.notePages[1].height = 540;
    host.layoutPage();
    host.swipeDrag(-180);
    const stage = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
    await host.prewarmNeighbour(1, host.prewarmToken);
    const cached = host.neighbourCache.get(1)!;
    expect(cached.width).toBe(2540);
    expect(cached.height).toBe(Math.round(2540 * 540 / 960));
    expect(parseFloat(stage.style.width)).toBe(1270);
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
    const pageFitWidth = Math.min(1318 - 48, (928 - 48) / (841.89 / 595.28));
    expect(host.neighbourCache.get(1)?.width).toBe(Math.round(pageFitWidth * 2));
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
    const pageFitWidth = Math.min(900 - 48, (928 - 48) / (841.89 / 595.28));
    expect(host.neighbourCache.get(1)?.width).toBe(Math.round(pageFitWidth * 2));
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

  it("coalesces mouse and trackpad navigation during a slow PDF handoff", async () => {
    const { view, internal, host, release } = await delayedSwipeSetup();
    const desktop = view as any;
    desktop.readingMode = true;
    vi.spyOn(desktop, "capturePointer").mockImplementation(() => undefined);
    vi.spyOn(desktop, "releasePointer").mockImplementation(() => undefined);
    const mouse = { pointerType: "mouse", pointerId: 22, button: 0,
      clientX: 400, clientY: 300, preventDefault: vi.fn() };
    desktop.onPointerDown(mouse);
    desktop.onPointerMove({ ...mouse, clientX: -200 });
    desktop.onPointerUp({ ...mouse, clientX: -200 });
    desktop.onWheel({ deltaMode: 0, deltaX: 120, deltaY: 0, preventDefault: vi.fn() });
    expect(host.flipSettling).toBe(true);
    release();
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(internal.noteIndex).toBe(3);
  });

  it("keeps PDF ink at one density throughout a desktop zoom burst", async () => {
    const { view, host } = await rasterSetup(1280, 800, 2);
    const desktop = view as any;
    const update = vi.spyOn(desktop.tiles, "update");
    vi.useFakeTimers();
    try {
      desktop.desktopZoom(1.1, { x: 400, y: 300 });
      vi.advanceTimersByTime(120);
      desktop.desktopZoom(1.1, { x: 400, y: 300 });
      const density = desktop.desktopRenderDensity;
      expect(density).toBe(2);
      desktop.onViewportMotion();
      expect(update.mock.calls.every((call: any[]) => call[1] === density && call[2] === false)).toBe(true);
      vi.advanceTimersByTime(179);
      expect(desktop.desktopRenderDensity).toBe(density);
      vi.advanceTimersByTime(1);
      expect(desktop.desktopRenderDensity).toBeUndefined();
      expect(update).toHaveBeenLastCalledWith(expect.any(Object), 2 * host.zoom, true);
    } finally { vi.useRealTimers(); }
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
    const labels = (selector: string) => Array.from(root.querySelectorAll(selector)).map((el) => el.getAttribute("aria-label"));
    expect(labels(".ink-toolbar-start button")).toEqual(["Pages", "Undo", "Redo"]);
    expect(labels(".ink-toolbar-section-draw button")).toEqual(["Pen", "Highlight", "Erase", "Select", "Pointer", "Shapes", "Add text box", "Add sticky note"]);
    expect(labels(".ink-toolbar-section-document button")).toEqual(["Reading mode", "Add page", "Export PDF with handwriting", "Page options"]);
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

  it("hides selected source pages from the handwriting sidecar without changing the PDF", async () => {
    const { view, internal, sidecar, fakeDoc } = await setup(3);
    internal.renderAll();
    document.querySelector<HTMLButtonElement>('[aria-label="Manage pages"]')!.click();
    thumbAt(0).click();
    thumbAt(2).click();
    expect(document.querySelector<HTMLElement>(".ink-rail-count")!.textContent).toBe("2 selected");
    document.querySelector<HTMLButtonElement>('[aria-label="Delete selected pages"]')!.click();
    expect(sidecar.notePages.map((page) => page.id)).toEqual([sourcePageId(1)]);
    expect(sidecar.deletedNotePages).toMatchObject({ [sourcePageId(0)]: expect.any(Number), [sourcePageId(2)]: expect.any(Number) });
    expect(fakeDoc.doc.numPages).toBe(3);
    document.querySelector<HTMLButtonElement>('[aria-label="Undo"]')!.click();
    expect(internal.sidecar.notePages.map((page) => page.id)).toEqual([sourcePageId(0), sourcePageId(1), sourcePageId(2)]);
    expect(fakeDoc.doc.numPages).toBe(3);
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

  it("opens the page menu and export even when editing is blocked", async () => {
    const { view, internal } = await setup(3);
    // Read-only source state must not turn the buttons dead.
    (view as unknown as { writeBlockedReason: string | null }).writeBlockedReason = "source revision changed";
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

  it("clears manual zoom when navigating to another PDF page", async () => {
    const { view, internal } = await setup(3);
    internal.zoom = 2;
    internal.zoomTouched = true;
    const scroller = (view as unknown as { scroller: HTMLElement }).scroller;
    scroller.scrollLeft = 180;
    scroller.scrollTop = 240;

    await view.navigatePages(1);

    expect(internal.noteIndex).toBe(1);
    expect(internal.zoomTouched).toBe(false);
    expect(internal.zoom).toBe(internal.fitZoom);
    expect(scroller.scrollLeft).toBe(0);
    expect(scroller.scrollTop).toBe(0);
  });

  it("resists an unavailable neighbour and restores the page without navigation", async () => {
    const { view } = await setup(3);
    const host = view as unknown as { pageWrap: HTMLElement; swipeDrag(x: number): void; swipeSettle(delta: number): void };
    const navigation = vi.spyOn(view, "navigatePages");
    host.swipeDrag(240);
    expect(host.pageWrap.style.transform).toBe("translateX(16px)");
    host.swipeSettle(-1);
    expect(navigation).not.toHaveBeenCalled();
    expect(host.pageWrap.style.transform).toBe("");
    await view.onClose();
  });
});


it("routes PDF Pencil ink between page and sticky, preserves peer ink through undo and redo", async () => {
  vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} closePath() {} });
  const { view, internal, sidecar } = await setup(); internal.renderAll();
  const editor = view as any, page = sidecar.notebook.pages[0];
  vi.spyOn(editor, "capturePointer").mockImplementation(() => undefined);
  vi.spyOn(editor, "releasePointer").mockImplementation(() => undefined);
  vi.spyOn(editor, "inputRect").mockReturnValue(new DOMRect(0, 0, 1000, 1000));
  editor.canvasLogicalWidth = editor.canvasLogicalHeight = 1000;
  editor.changeSticky(undefined, { id: "inline-note", pageId: page.id, x: .2, y: .2, width: .5, height: .5, boardPageWidth: 1000,
    title: "Inline", keywords: "", text: "", textUpdatedAt: 1, color: "#fff1a8", collapsed: false, preview: true,
    scrollX: 0, scrollY: 0, strokes: [], deletedStrokeIds: [], createdAt: 1, updatedAt: 1 });
  const sample = (x: number) => ({ pointerType: "pen", pointerId: 78, clientX: x, clientY: 400, pressure: .5, timeStamp: Date.now(), preventDefault() {} });
  editor.state.tool = "pen"; editor.state.scribbleErase = false;
  editor.onPointerDown(sample(100)); editor.onPointerMove(sample(400)); editor.onPointerUp(sample(400));
  expect(page.strokes).toHaveLength(1); expect(page.stickyNotes![0].strokes).toHaveLength(1);
  expect(page.strokes.every((stroke) => stroke.pageId === page.id)).toBe(true);
  const peer = { ...page.stickyNotes![0].strokes[0], id: "peer-ink" };
  page.stickyNotes![0].strokes.push(peer);
  editor.undo(); expect(page.strokes).toHaveLength(0); expect(page.stickyNotes![0].strokes.map((s) => s.id)).toEqual(["peer-ink"]);
  editor.redo(); expect(page.strokes).toHaveLength(1); expect(page.stickyNotes![0].strokes).toHaveLength(2);
  const undoSnapshot = structuredClone(sidecar.notebook);
  editor.undo();
  expect(mergeNotebooks(sidecar.notebook, undoSnapshot).pages[0].stickyNotes![0].strokes.map((s) => s.id)).toEqual(["peer-ink"]);
  editor.state.tool = "eraser";
  editor.onPointerDown(sample(320)); editor.onPointerUp(sample(320));
  expect(page.stickyNotes![0].strokes).toHaveLength(0);
  editor.undo(); expect(page.stickyNotes![0].strokes).toHaveLength(1);
});
