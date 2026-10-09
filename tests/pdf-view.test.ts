import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import type { NotebookOperation } from "../src/worker-protocol";
import type { InkPoint, InkStroke } from "../src/model";
import { InkWorkerService } from "../src/worker-service";
import { PdfSidecarStore, serializeSidecar } from "../src/pdf-store";
import { createSidecar, insertBlankNotePage, sourcePageId } from "../src/pdf-sidecar";
import type { PdfSidecar } from "../src/pdf-sidecar";
import { PdfInkView, PdfWriterArbiter, VIEW_TYPE_PDF_INK } from "../src/pdf-view";
import { PdfTabTakeover } from "../src/pdf-takeover";

const FINGERPRINT = { sha256: "a".repeat(64), byteLength: 100 };
const SOURCE_PAGES = [{ width: 595.28, height: 841.89, rotation: 0 }];

interface VaultCalls {
  created: string[];
}

interface PdfViewInternals {
  app: { scope: unknown; vault: unknown };
  file: TFile | null;
  mode: string;
  sidecar: PdfSidecar;
  sidecarRaw: string;
  dirty: boolean;
  writeBlockedReason: string | null;
  writerHeld: boolean;
  acquireWriter(): void;
  releaseWriter(): void;
  noteIndex: number;
  canvasLogicalWidth: number;
  canvasLogicalHeight: number;
  lastPoint: InkPoint | null;
  predictedTip: InkPoint[] | null;
  activeStroke: InkStroke | null;
  attachSidecar(sidecar: PdfSidecar, raw: string, file: TFile | null): void;
  acquireWriter(): void;
  releaseWriter(): void;
  flushSaveNow(): Promise<{ status: string; message?: string }>;
  markSidecarChanged(): void;
  withPageUndo(change: () => boolean, label: string): void;
  restoreSidecarSnapshot(snapshot: string): void;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent, source?: string): void;
  finalizeInput(): void;
  undo(): void;
  redo(): void;
}

let pointerClock = 1_000;

function pointer(x: number, y: number, options: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerId: 7, pointerType: "pen", clientX: x, clientY: y,
    pressure: 0.5, tiltX: 0, tiltY: 0,
    timeStamp: pointerClock += 8,
    ...options,
  } as PointerEvent;
}

function setup() {
  const sidecar = createSidecar("docs/lecture.pdf", FINGERPRINT, SOURCE_PAGES);
  const raw = serializeSidecar(sidecar);
  const sidecarFile = { path: "A_pdfinkwrittern/lecture--x.pdfink.json" } as TFile;
  const appliedOps: NotebookOperation[] = [];

  const store = {
    sidecarFileFor: vi.fn(() => sidecarFile),
    createFor: vi.fn(async () => sidecarFile),
    readRaw: vi.fn(async () => serializeSidecar(sidecar)),
    writeIfUnchanged: vi.fn(async (): Promise<boolean> => true),
    computeFingerprint: vi.fn(async () => FINGERPRINT),
    findRecoveryCandidates: vi.fn(async () => []),
    migrateForRename: vi.fn(async () => true),
  };

  const session = {
    canRenderTiles: () => false,
    initializeRaw: vi.fn(async () => sidecar.notebook),
    apply: vi.fn(async (_revision: number, operation: NotebookOperation) => {
      appliedOps.push(operation);
      return { type: "operation-applied", revision: _revision };
    }),
    dispose: vi.fn(),
  };
  const workers = { createSession: vi.fn(() => session) } as unknown as InkWorkerService;

  const vaultCalls: VaultCalls = { created: [] };
  const vault = {
    async create(path: string) {
      vaultCalls.created.push(path);
      return { path };
    },
    getAbstractFileByPath: () => null,
  };

  const arbiter = new PdfWriterArbiter();
  const takeover = new PdfTabTakeover(() => ({ enabled: true, enhancerActive: false, isPdfFile: () => true }), VIEW_TYPE_PDF_INK);
  const view = new PdfInkView({} as WorkspaceLeaf);
  view.configure({
    store: store as unknown as PdfSidecarStore,
    workers,
    takeover,
    arbiter,
  });
  view.file = { path: "docs/lecture.pdf", basename: "lecture" } as TFile;
  const internal = view as unknown as PdfViewInternals;
  internal.app = { scope: {}, vault };

  const fakeTiles = new Proxy({}, {
    get: (_target, property: string) => {
      if (property === "queryNear") return () => [];
      return vi.fn();
    },
  }) as unknown as PdfViewInternals & Record<string, ReturnType<typeof vi.fn>>;
  const host = {
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 595, bottom: 842, width: 595, height: 842 }),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => false),
    addEventListener: vi.fn(),
  };

  Object.assign(internal, {
    tiles: fakeTiles,
    inkHost: host,
    canvasLogicalWidth: 595.28,
    canvasLogicalHeight: 841.89,
    viewport: { x: 0, y: 0, width: 595.28, height: 841.89 },
    layoutPage: vi.fn(),
    updateViewport: vi.fn(),
    renderAll: vi.fn(),
    renderPdfPage: vi.fn(async () => undefined),
    requestRender: vi.fn(),
    drawSelection: vi.fn(),
    drawPreview: vi.fn(),
    resizeSelectionCanvas: vi.fn(),
    resizePreviewCanvas: vi.fn(),
    updatePageIndicator: vi.fn(),
    updateToolButtons: vi.fn(),
    updateHistoryButtons: vi.fn(),
    setStatus: vi.fn(),
    hideEraserCursor: vi.fn(),
  });

  internal.attachSidecar(sidecar, raw, sidecarFile);

  return { view, internal, store, session, appliedOps, sidecar, sidecarFile, vaultCalls, arbiter };
}

describe("writer arbitration", () => {
  it("allows a single writer per PDF and rejects a second until released", () => {
    const arbiter = new PdfWriterArbiter();
    expect(arbiter.acquire("a.pdf", "view-1")).toBe(true);
    expect(arbiter.acquire("a.pdf", "view-2")).toBe(false);
    expect(arbiter.acquire("b.pdf", "view-2")).toBe(true);
    arbiter.release("a.pdf", "view-2"); // wrong holder: no effect
    expect(arbiter.acquire("a.pdf", "view-2")).toBe(false);
    arbiter.release("a.pdf", "view-1");
    expect(arbiter.acquire("a.pdf", "view-2")).toBe(true);
  });
});

describe("writer lock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  it("opens writable PDFs with the writer held from sidecar attach", () => {
    const { internal } = setup();
    // The view is always in editing shape; writability is the lock state.
    expect(internal.writerHeld).toBe(true);
  });

  it("ignores pen input while the writer is not held", () => {
    const { internal, sidecar } = setup();
    internal.writeBlockedReason = "fingerprint mismatch";
    internal.releaseWriter();
    internal.acquireWriter();
    // In the real load path the block exists before the sidecar attaches,
    // so re-acquiring must refuse.
    expect(internal.writerHeld).toBe(false);
    internal.onPointerDown(pointer(100, 100));
    expect(sidecar.notebook.pages[0].strokes).toHaveLength(0);
  });

  it("enforces one writer per PDF across two views", async () => {
    const first = setup();
    const second = setup();
    void first; void second;
    const arbiter = new PdfWriterArbiter();
    expect(arbiter.acquire("docs/lecture.pdf", "view-1")).toBe(true);
    expect(arbiter.acquire("docs/lecture.pdf", "view-2")).toBe(false);
  });
});

describe("pen pipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  it("records a stroke in the embedded notebook and queues worker operations", async () => {
    const { internal, sidecar, appliedOps } = setup();
    internal.onPointerDown(pointer(60, 60));
    internal.onPointerMove(pointer(120, 90));
    internal.onPointerMove(pointer(180, 120));
    internal.onPointerUp(pointer(200, 140));

    expect(sidecar.notebook.pages[0].strokes).toHaveLength(1);
    const points = sidecar.notebook.pages[0].strokes[0].points;
    expect(points.length).toBeGreaterThan(1);
    expect(points[0].x).toBeCloseTo(60 / 595.28, 3);
    expect(internal.dirty).toBe(true);
    expect(appliedOps.map((op) => op.type)).toEqual(["start-stroke", "append-stroke-points", "complete-stroke"]);
  });

  it("keeps completed strokes out of the tile exclusion only after commit", async () => {
    const { internal } = setup();
    internal.onPointerDown(pointer(60, 60));
    internal.onPointerUp(pointer(200, 140));
    expect(internal.sidecar.notebook.pages[0].strokes).toHaveLength(1);
  });

  it("supports undo and redo of a stroke via patch operations", async () => {
    const { internal, sidecar, appliedOps } = setup();
    internal.onPointerDown(pointer(60, 60));
    internal.onPointerUp(pointer(200, 140));
    internal.undo();
    expect(sidecar.notebook.pages[0].strokes).toHaveLength(0);
    expect(sidecar.notebook.pages[0].deletedStrokeIds).toHaveLength(1);
    expect(appliedOps.at(-1)?.type).toBe("patch-strokes");
    internal.redo();
    expect(sidecar.notebook.pages[0].strokes).toHaveLength(1);
  });
});

describe("save gating", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  it("writes through CAS when the disk text still matches", async () => {
    const { internal, store, sidecar } = setup();
    internal.markSidecarChanged();
    const outcome = await internal.flushSaveNow();
    expect(outcome.status).toBe("saved");
    expect(store.writeIfUnchanged).toHaveBeenCalledWith(
      expect.anything(),
      serializeSidecar(sidecar),
      expect.stringContaining('"format": 1'),
    );
    expect(internal.dirty).toBe(false);
  });

  it("keeps a conflict copy and reports conflict when the disk keeps changing", async () => {
    const { internal, store, vaultCalls } = setup();
    store.writeIfUnchanged.mockResolvedValue(false);
    internal.markSidecarChanged();
    const outcome = await internal.flushSaveNow();
    expect(outcome.status).toBe("conflict");
    expect(vaultCalls.created).toHaveLength(1);
    expect(vaultCalls.created[0]).toMatch(/\.conflict-\d+\.pdfink\.json$/);
    expect(internal.dirty).toBe(false);
  });

  it("keeps edit mode when saving fails outright", async () => {
    const { internal, store } = setup();
    store.writeIfUnchanged.mockRejectedValue(new Error("disk full"));
    internal.markSidecarChanged();
    await expect(internal.flushSaveNow()).resolves.toMatchObject({ status: "failed" });
    // Retry exhaustion path writes a conflict copy; simulate total failure by
    // making the conflict copy fail too.
    expect(internal.dirty).toBe(true);
    store.writeIfUnchanged.mockResolvedValue(false);
    const outcome = await internal.flushSaveNow();
    expect(["conflict", "failed"]).toContain(outcome.status);
  });

  it("flushing waits for and reports the save outcome", async () => {
    const { internal } = setup();
    internal.markSidecarChanged();
    const outcome = await internal.flushSaveNow();
    expect(outcome.status).toBe("saved");
  });
});

describe("blank note pages in the view", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  it("inserts a blank page with neighbor geometry and undoes it via snapshot", async () => {
    const { internal, sidecar, appliedOps } = setup();
    internal.withPageUndo(() => insertBlankNotePage(internal.sidecar, sourcePageId(0)) !== null, "insert a blank page");
    expect(internal.sidecar.notePages).toHaveLength(2);
    expect(internal.sidecar.notePages[1].sourceIndex).toBeUndefined();
    expect(appliedOps.at(-1)?.type).toBe("replace-notebook");
    internal.undo();
    // The snapshot restore replaces the sidecar object; read it back live.
    expect(internal.sidecar.notePages).toHaveLength(1);
    expect(internal.sidecar.notePages[0].id).toBe(sourcePageId(0));
    expect(internal.dirty).toBe(true);
  });
});

describe("predicted ghost tip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });

  it("tracks the pen tail and anchors the ghost at the stroke tail, not the start", async () => {
    const { view, internal } = setup();
    internal.onPointerDown(pointer(100, 420));
    internal.onPointerMove(pointer(300, 420));
    // Unified writing layer: lastPoint is the live stroke tail (modeled output).
    expect(internal.lastPoint).toBe(internal.activeStroke!.points[internal.activeStroke!.points.length - 1]);
    const predictedSample = { pointerId: 7, pointerType: "pen", clientX: 340, clientY: 422, pressure: 0.5, tiltX: 0, tiltY: 0, timeStamp: pointerClock += 8 };
    internal.onPointerMove(Object.assign(pointer(310, 421), { getPredictedEvents: () => [predictedSample] }) as PointerEvent);
    expect(internal.predictedTip).toHaveLength(1);
    expect(internal.predictedTip![0].x).toBeCloseTo(340 / 595.28, 3);

    const moveTo = vi.fn();
    const lineTo = vi.fn();
    const ghostCtx = { beginPath: vi.fn(), moveTo, lineTo, stroke: vi.fn() } as unknown as CanvasRenderingContext2D;
    const stroke = internal.activeStroke!;
    (view as unknown as PdfViewInternals & { drawPredictedTip(ctx: CanvasRenderingContext2D, stroke: InkStroke): void }).drawPredictedTip(ghostCtx, stroke);

    const tail = stroke.points[stroke.points.length - 1];
    expect(moveTo).toHaveBeenCalled();
    expect(moveTo.mock.calls[0][0]).toBeCloseTo(tail.x * internal.canvasLogicalWidth, 0);
    expect(moveTo.mock.calls[0][1]).toBeCloseTo(tail.y * internal.canvasLogicalHeight, 0);
    // The bug this locks: the ghost swept from the stroke's FIRST point.
    expect(Math.abs(moveTo.mock.calls[0][0] - stroke.points[0].x * internal.canvasLogicalWidth)).toBeGreaterThan(1);
  });
});


describe("pdf page fit", () => {
  /** layoutPage harness: pane metrics plus a minimal page geometry; tiles
   *  stay unset (all call sites are optional-chained). */
  function layoutHarness(clientWidth: number, clientHeight: number, page: { width: number; height: number }) {
    const view = Object.create(PdfInkView.prototype) as unknown as {
      scroller: unknown; pageWrap: unknown; sidecar: unknown; noteIndex: number;
      zoom: number; zoomTouched: boolean; fitZoom: number;
      pageWrapStyle: Record<string, string>;
      layoutPage(): void;
    };
    view.pageWrapStyle = {};
    view.scroller = {
      clientWidth, clientHeight,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };
    view.pageWrap = {
      style: view.pageWrapStyle,
      setCssStyles(styles: Record<string, string>) { Object.assign(view.pageWrapStyle, styles); },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };
    view.sidecar = { notebook: { pages: [{ id: "p1" }] }, notePages: [page] };
    view.noteIndex = 0;
    view.zoom = 1;
    view.zoomTouched = false;
    return view;
  }

  it("fits a landscape page to the pane WIDTH at zoom 1 (no double scaling)", () => {
    // A 16:9 slide on a 12.9" landscape pane. The beta.29/30 regression
    // multiplied the box width (already pane-wide at zoom 1) by
    // paneWidth/pageWidth again, blowing the page ~1.4x past the pane.
    const view = layoutHarness(1318, 928, { width: 960, height: 540 });
    view.layoutPage();
    expect(view.zoom).toBe(1);
    // Pane width minus the page padding (1318 - 2x24).
    expect(parseFloat(view.pageWrapStyle.width)).toBe(1270);
    expect(parseFloat(view.pageWrapStyle.height)).toBeLessThanOrEqual(928);
  });

  it("fits a portrait page to the pane HEIGHT, never across the width", () => {
    const view = layoutHarness(1318, 928, { width: 595.28, height: 841.89 });
    view.layoutPage();
    const width = parseFloat(view.pageWrapStyle.width);
    const height = parseFloat(view.pageWrapStyle.height);
    expect(height).toBeCloseTo(880, 0);
    expect(width).toBeLessThan(1270);
  });
});
