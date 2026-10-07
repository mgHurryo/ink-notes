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

interface RailInternals {
  sidecar: PdfSidecar;
  noteIndex: number;
  pdfDoc: { numPages: number; getPage(n: number): Promise<unknown> } | null;
  neighbourCache: Map<number, HTMLCanvasElement>;
  thumbCache: Map<number, HTMLCanvasElement>;
  renderPdfPage(): Promise<void>;
  renderAll(): void;
  refreshPageRail(): void;
  paintThumbnail(index: number): void;
  paintVisibleThumbnails(): void;
}

/** Minimal pdf.js document stub: getPage(n) hands out a page whose render
 *  records the 1-based page number it painted. */
function fakePdfDoc(pageCount: number) {
  const renderedPages: number[] = [];
  const getPage = vi.fn(async (pageNumber: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 595.28 * scale, height: 841.89 * scale }),
    render: vi.fn(async () => { renderedPages.push(pageNumber); }),
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

beforeEach(() => {
  document.body.innerHTML = '<div id="host"><div></div><main></main></div>';
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const ctx = new Proxy({}, { get: () => vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as CanvasRenderingContext2D);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("pdf page preview rail", () => {
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
    const { view, internal, fakeDoc } = await setup(8);
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
    const { view, internal, fakeDoc } = await setup(3);
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
    const { view, internal, sidecar, fakeDoc } = await setup(3);
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

  it("evicts cached thumbnails further than one page from the current page", async () => {
    const { view, internal } = await setup(6);
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
    const { view, internal, fakeDoc } = await setup(3);
    fakeDoc.getPage.mockRejectedValueOnce(new Error("pdf.js exploded"));
    internal.renderAll();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The failed thumb simply has no bitmap; the others still rendered.
    expect(internal.thumbCache.has(0)).toBe(false);
    expect(fakeDoc.renderedPages).toEqual([2]);
    await view.onClose();
  });
});
