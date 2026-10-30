import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TFile, type WorkspaceLeaf } from "obsidian";
import type { NotebookOperation } from "../src/worker-protocol";
import type { InkPoint, InkStroke } from "../src/model";
import { InkWorkerService } from "../src/worker-service";
import { PdfSidecarStore, serializeSidecar } from "../src/pdf-store";
import { createSidecar, disambiguatedSidecarPathFor, insertBlankNotePage, sidecarPathFor, sourcePageId } from "../src/pdf-sidecar";
import type { PdfSidecar, PdfSourcePageGeometry } from "../src/pdf-sidecar";
import { PdfInkView, VIEW_TYPE_PDF_INK } from "../src/pdf-view";
import { PdfTabTakeover } from "../src/pdf-takeover";

const FINGERPRINT = { sha256: "a".repeat(64), byteLength: 100 };
const SOURCE_PAGES = [{ width: 595.28, height: 841.89, rotation: 0 }];

interface VaultCalls {
  created: string[];
  createdContents: string[];
}

interface PdfViewInternals {
  app: { scope: unknown; vault: unknown };
  file: TFile | null;
  mode: string;
  sidecar: PdfSidecar;
  sidecarRaw: string;
  sidecarFile: TFile | null;
  pendingMergedSidecar: PdfSidecar | null;
  dirty: boolean;
  writeBlockedReason: string | null;
  loadGeneration: number;
  canEdit(): boolean;
  resolveSidecar(file: TFile, fingerprint: { sha256: string; byteLength: number }, generation: number): Promise<void>;
  noteIndex: number;
  canvasLogicalWidth: number;
  canvasLogicalHeight: number;
  lastPoint: InkPoint | null;
  predictedTip: InkPoint[] | null;
  activeStroke: InkStroke | null;
  attachSidecar(sidecar: PdfSidecar, raw: string, file: TFile | null): void;
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
  startPendingInkCommit(page: PdfSidecar["notebook"]["pages"][number]): void;
  renderAll(): void;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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
    sidecarFileFor: vi.fn((_pdfPath: string, _slotPath?: string): TFile | null => sidecarFile),
    createFor: vi.fn(async (_pdf: TFile, _fingerprint: { sha256: string; byteLength: number },
      _sourcePages: PdfSourcePageGeometry[], _slotPath?: string) => sidecarFile),
    readRaw: vi.fn(async (_file: TFile) => serializeSidecar(sidecar)),
    writeIfUnchanged: vi.fn(async (_file: TFile, _expectedRaw: string, _nextRaw: string): Promise<boolean> => true),
    computeFingerprint: vi.fn(async () => FINGERPRINT),
    findRecoveryCandidates: vi.fn(async () => []),
    migrateForRename: vi.fn(async () => true),
  };

  const session = {
    canRenderTiles: () => false,
    initializeRaw: vi.fn(async () => sidecar.notebook),
    serializeStorage: vi.fn(async (value: unknown) => serializeStoredJson(value)),
    apply: vi.fn(async (_revision: number, operation: NotebookOperation) => {
      appliedOps.push(operation);
      return { type: "operation-applied", revision: _revision };
    }),
    dispose: vi.fn(),
  };
  const workers = { createSession: vi.fn(() => session), isDisabled: () => false } as unknown as InkWorkerService;

  const vaultCalls: VaultCalls = { created: [], createdContents: [] };
  const vault = {
    async create(path: string, data?: string) {
      vaultCalls.created.push(path);
      if (typeof data === "string") vaultCalls.createdContents.push(data);
      return { path };
    },
    getAbstractFileByPath: () => null,
  };

  const takeover = new PdfTabTakeover(() => ({ enabled: true, enhancerActive: false, isPdfFile: () => true }), VIEW_TYPE_PDF_INK);
  const view = new PdfInkView({} as WorkspaceLeaf);
  view.configure({
    store: store as unknown as PdfSidecarStore,
    workers,
    takeover,
  });
  view.file = { path: "docs/lecture.pdf", basename: "lecture" } as TFile;
  const internal = view as unknown as PdfViewInternals;
  internal.app = { scope: {}, vault };

  const fakeTiles = new Proxy({}, {
    get: (_target, property: string) => {
      if (property === "queryNear") return () => [];
      if (property === "commitInk") return (_strokes: unknown, _viewport: unknown, _density: unknown,
        committed: (result: boolean) => void) => committed(true);
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

  return { view, internal, store, session, appliedOps, sidecar, sidecarFile, vaultCalls };
}

describe("split-pane edit availability", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); });

  it("does not retain the previous sidecar while a reused view loads another PDF", () => {
    const { internal, session } = setup();
    const nextSidecar = createSidecar("docs/next.pdf", FINGERPRINT, SOURCE_PAGES);
    const nextRaw = serializeSidecar(nextSidecar);
    const nextSidecarFile = { path: "A_pdfinkwrittern/next--x.pdfink.json" } as TFile;
    expect((internal as any).inputLocked()).toBe(false);

    (internal as any).resetViewState();

    expect((internal as any).sidecar).toBeNull();
    expect((internal as any).sidecarFile).toBeNull();
    expect((internal as any).sidecarRaw).toBe("");
    expect((internal as any).inputLocked()).toBe(true);
    expect(session.dispose).toHaveBeenCalledOnce();

    (internal as any).attachSidecar(nextSidecar, nextRaw, nextSidecarFile);
    expect((internal as any).inputLocked()).toBe(false);
  });

  it("allows two independent panes of the same PDF to write", () => {
    const first = setup();
    const second = setup();
    expect(first.internal.canEdit()).toBe(true);
    expect(second.internal.canEdit()).toBe(true);
    first.internal.onPointerDown(pointer(60, 60));
    second.internal.onPointerDown(pointer(160, 60));
    first.internal.onPointerUp(pointer(80, 90));
    second.internal.onPointerUp(pointer(180, 90));
    expect(first.internal.sidecar.notebook.pages[0].strokes).toHaveLength(1);
    expect(second.internal.sidecar.notebook.pages[0].strokes).toHaveLength(1);
  });

  it("still blocks ink when the source revision is invalid", () => {
    const { internal, sidecar } = setup();
    internal.writeBlockedReason = "fingerprint mismatch";
    expect(internal.canEdit()).toBe(false);
    internal.onPointerDown(pointer(100, 100));
    expect(sidecar.notebook.pages[0].strokes).toHaveLength(0);
  });
});

describe("split-pane sidecar synchronization", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); });

  function split() {
    const panes = [setup(), setup()];
    let raw = serializeSidecar(panes[0].internal.sidecar);
    for (const pane of panes) {
      pane.internal.attachSidecar(parseStoredJson(raw) as PdfSidecar, raw, pane.sidecarFile);
      pane.store.readRaw.mockImplementation(async () => raw);
      pane.store.writeIfUnchanged.mockImplementation(async (_file, expected, next) => {
        if (raw !== expected) return false;
        raw = next;
        return true;
      });
    }
    const settle = (pane: typeof panes[number]) => {
      pane.internal.startPendingInkCommit(pane.internal.sidecar.notebook.pages[pane.internal.noteIndex]);
    };
    const draw = (pane: typeof panes[number], x: number) => {
      pane.internal.onPointerDown(pointer(x, 60));
      pane.internal.onPointerUp(pointer(x + 30, 90));
      settle(pane);
    };
    const refresh = () => Promise.all(panes.map(pane => pane.view.reloadExternalSidecar(pane.sidecarFile.path)));
    return { panes, draw, settle, refresh, disk: () => parseStoredJson(raw) as PdfSidecar };
  }

  it("retains both panes' concurrent strokes on disk and synchronizes each pane", async () => {
    const { panes: [left, right], draw, refresh, disk } = split();
    draw(left, 60); draw(right, 160);
    const ids = [left.internal.sidecar.notebook.pages[0].strokes[0].id,
      right.internal.sidecar.notebook.pages[0].strokes[0].id];
    const outcomes = await Promise.all([left.internal.flushSaveNow(), right.internal.flushSaveNow()]);
    expect(outcomes.every(outcome => outcome.status === "saved")).toBe(true);
    expect(disk().notebook.pages[0].strokes.map(stroke => stroke.id).sort()).toEqual(ids.sort());
    await refresh();
    for (const pane of [left, right]) {
      expect(pane.internal.sidecar.notebook.pages[0].strokes).toHaveLength(2);
      expect(pane.internal.canEdit()).toBe(true);
      expect(pane.vaultCalls.created).toHaveLength(0);
    }
  });

  it("retains page and stroke identity without a full render during repeated peer saves", async () => {
    const { panes: [left, right], draw, refresh, disk } = split();
    draw(right, 160); await right.internal.flushSaveNow(); await refresh();
    const page = right.internal.sidecar.notebook.pages[0], local = page.strokes[0];
    const render = vi.mocked(right.internal.renderAll); render.mockClear();
    const redraw = vi.spyOn(right.internal as any, "drawStrokes");
    for (let i = 0; i < 4; i++) {
      draw(left, 60 + i * 30); await left.internal.flushSaveNow(); await refresh();
      expect(right.internal.sidecar.notebook.pages[0]).toBe(page);
      expect(page.strokes.find(s => s.id === local.id)).toBe(local);
      expect(page.strokes).toHaveLength(i + 2);
      expect(render).not.toHaveBeenCalled();
    }
    expect(redraw).toHaveBeenCalledTimes(4);
    await right.internal.flushSaveNow();
    expect(disk().notebook.pages[0].strokes).toHaveLength(5);
  });

  it("adopts peer timestamps without rendering, clearing history or dirtying a clean save", async () => {
    const { panes: [left, right], draw, refresh } = split();
    draw(right, 160); await right.internal.flushSaveNow(); await refresh();
    const page = right.internal.sidecar.notebook.pages[0], stroke = page.strokes[0];
    const remote = parseStoredJson(serializeSidecar(left.internal.sidecar)) as PdfSidecar;
    remote.updatedAt += 1000; remote.notebook.updatedAt += 1000;
    remote.notebook.pages[0].updatedAt += 1000; remote.notebook.pages[0].strokes[0].updatedAt += 1000;
    right.store.readRaw.mockResolvedValueOnce(serializeSidecar(remote));
    vi.mocked(right.internal.renderAll).mockClear();
    const redraw = vi.spyOn(right.internal as any, "drawStrokes");
    const history = (right.internal as any).undoStack, revision = (right.internal as any).editRevision;
    await right.view.reloadExternalSidecar(right.sidecarFile.path);
    expect(right.internal.sidecar.notebook.pages[0]).toBe(page);
    expect(page.strokes[0]).toBe(stroke);
    expect(stroke.updatedAt).toBe(remote.notebook.pages[0].strokes[0].updatedAt);
    expect(right.internal.renderAll).not.toHaveBeenCalled(); expect(redraw).not.toHaveBeenCalled();
    expect((right.internal as any).undoStack).toBe(history);
    expect((right.internal as any).editRevision).toBe(revision); expect(right.internal.dirty).toBe(false);
  });

  it("snapshots queued Worker replacements so the next stroke cannot mutate them", async () => {
    const { panes: [left, right], draw, refresh } = split();
    draw(left,60); await left.internal.flushSaveNow(); await refresh();
    const operation = [...right.appliedOps].reverse().find(op => op.type === "replace-notebook");
    expect(operation?.type).toBe("replace-notebook");
    if (operation?.type !== "replace-notebook") throw new Error("Missing peer replacement");
    right.internal.onPointerDown(pointer(160,60));
    expect(operation.notebook.pages[0].strokes).toHaveLength(1);
    expect(right.internal.sidecar.notebook.pages[0].strokes).toHaveLength(2);
    right.internal.onPointerUp(pointer(180,90));
  });

  it("defers peer state through an active stroke and applies it when tile commit settles", async () => {
    const { panes: [left, right], draw, settle, refresh } = split();
    right.internal.onPointerDown(pointer(160, 60));
    const active = right.internal.activeStroke;
    draw(left, 60);
    await left.internal.flushSaveNow();
    await refresh();
    expect(right.internal.activeStroke).toBe(active);
    expect(right.internal.sidecar.notebook.pages[0].strokes).toHaveLength(1);
    right.internal.onPointerMove(pointer(180, 90));
    right.internal.onPointerUp(pointer(200, 100));
    expect(right.internal.sidecar.notebook.pages[0].strokes).toHaveLength(1);
    settle(right);
    expect(right.internal.sidecar.notebook.pages[0].strokes).toHaveLength(2);
    await right.internal.flushSaveNow();
    await refresh();
    expect(left.internal.sidecar.notebook.pages[0].strokes).toHaveLength(2);
  });

  it("keeps unsaved local ink dirty when a peer refresh arrives", async () => {
    const { panes: [left, right], draw, refresh, disk } = split();
    draw(left, 60); draw(right, 160);
    await left.internal.flushSaveNow();
    await refresh();
    expect(right.internal.sidecar.notebook.pages[0].strokes).toHaveLength(2);
    expect(right.internal.dirty).toBe(true);
    await right.internal.flushSaveNow();
    expect(disk().notebook.pages[0].strokes).toHaveLength(2);
    expect(right.internal.dirty).toBe(false);
  });

  it("flushes newer ink added while a prior save is in flight", async () => {
    const { panes: [left, right], draw, refresh, disk } = split();
    draw(left, 60); draw(right, 160);
    const write = right.store.writeIfUnchanged.getMockImplementation()!;
    let release!: () => void;
    right.store.writeIfUnchanged.mockImplementationOnce(async (...args) => {
      await new Promise<void>(done => { release = done; });
      return write(...args);
    });
    const saving = right.internal.flushSaveNow();
    draw(right, 260);
    await left.internal.flushSaveNow();
    await refresh();
    release();
    await expect(saving).resolves.toMatchObject({ status: "saved" });
    await refresh();
    expect(disk().notebook.pages[0].strokes).toHaveLength(3);
    expect(right.internal.dirty).toBe(false);
    expect(left.internal.sidecar.notebook.pages[0].strokes).toHaveLength(3);
  });

  it("includes queued peer ink in a save without replacing an active stroke", async () => {
    const { panes: [left, right], draw, settle, refresh, disk } = split();
    draw(left, 60); draw(right, 160);
    right.internal.onPointerDown(pointer(260, 60));
    const active = right.internal.activeStroke;
    await left.internal.flushSaveNow();
    await refresh();
    await right.internal.flushSaveNow();
    expect(right.internal.activeStroke).toBe(active);
    expect(disk().notebook.pages[0].strokes).toHaveLength(3);
    right.internal.onPointerMove(pointer(280, 90));
    right.internal.onPointerUp(pointer(300, 100));
    settle(right);
    await right.internal.flushSaveNow();
    await refresh();
    expect(left.internal.sidecar.notebook.pages[0].strokes).toHaveLength(3);
    expect(right.internal.dirty).toBe(false);
  });

  it("merges peer deletions without resurrecting ink from a stale pane", async () => {
    const { panes: [left, right], draw, refresh, disk } = split();
    draw(left, 60); await left.internal.flushSaveNow(); await refresh();
    const deleted = left.internal.sidecar.notebook.pages[0].strokes[0].id;
    left.internal.undo(); // delete left's own stroke before any peer change
    draw(right, 160);
    await Promise.all([left.internal.flushSaveNow(), right.internal.flushSaveNow()]);
    await refresh();
    expect(disk().notebook.pages[0].strokes).toHaveLength(1);
    expect(disk().notebook.pages[0].deletedStrokeIds).toContain(deleted);
    for (const pane of [left, right]) expect(pane.internal.sidecar.notebook.pages[0].strokes[0].id).not.toBe(deleted);
  });

  it("preserves pane selection through peer insertion and keeps both page additions", async () => {
    const { panes: [left, right], refresh, disk } = split();
    left.internal.withPageUndo(() => !!insertBlankNotePage(left.internal.sidecar, sourcePageId(0)), "insert");
    right.internal.withPageUndo(() => !!insertBlankNotePage(right.internal.sidecar, sourcePageId(0)), "insert");
    const rightSelected = right.internal.sidecar.notePages[1].id;
    right.internal.noteIndex = 1;
    await Promise.all([left.internal.flushSaveNow(), right.internal.flushSaveNow()]);
    await refresh();
    expect(disk().notePages).toHaveLength(3);
    expect(right.internal.sidecar.notePages[right.internal.noteIndex].id).toBe(rightSelected);
    expect(right.internal.sidecar.notePages).toHaveLength(3);
  });

  it("ignores late refreshes after unloading and foreign PDF revision state", async () => {
    const { panes: [left, right] } = split();
    const foreign = parseStoredJson(serializeSidecar(right.internal.sidecar)) as PdfSidecar;
    foreign.source.sha256 = "b".repeat(64);
    right.store.readRaw.mockResolvedValueOnce(serializeSidecar(foreign));
    await right.view.reloadExternalSidecar(right.sidecarFile.path);
    expect(right.internal.sidecar.source.sha256).toBe(FINGERPRINT.sha256);
    right.internal.markSidecarChanged();
    await expect(right.internal.flushSaveNow()).resolves.toMatchObject({ status: "saved" });
    let resolve!: (raw: string) => void;
    right.store.readRaw.mockImplementationOnce(() => new Promise<string>(done => { resolve = done; }));
    const refresh = right.view.reloadExternalSidecar(right.sidecarFile.path);
    await right.view.onUnloadFile(right.view.file!);
    resolve(serializeSidecar(left.internal.sidecar));
    await refresh;
    expect(right.internal.sidecar).toBeNull();
  });

  it("blocks stale saves after a source revision change and keeps deferred peer ink in recovery", async () => {
    const { panes: [left, right], draw, refresh, disk } = split();
    draw(right, 160);
    right.internal.onPointerDown(pointer(260, 60));
    const localIds = right.internal.sidecar.notebook.pages[0].strokes.map((stroke) => stroke.id);
    draw(left, 60);
    await left.internal.flushSaveNow();
    await refresh();
    const peerStrokeId = disk().notebook.pages[0].strokes[0].id;
    await right.internal.flushSaveNow();
    expect(right.internal.sidecar.notebook.pages[0].strokes.map((stroke) => stroke.id)).not.toContain(peerStrokeId);
    expect(disk().notebook.pages[0].strokes.map((stroke) => stroke.id)).toContain(peerStrokeId);
    const writesBeforeBlock = right.store.writeIfUnchanged.mock.calls.length;

    right.view.sourcePdfModified();
    expect(right.internal.writeBlockedReason).toContain("source PDF changed");
    expect(right.internal.pendingMergedSidecar?.notebook.pages[0].strokes.map((stroke) => stroke.id))
      .toContain(peerStrokeId);

    await expect(right.internal.flushSaveNow()).resolves.toMatchObject({ status: "failed" });
    expect(right.store.writeIfUnchanged.mock.calls.length).toBe(writesBeforeBlock);
    expect(disk().notebook.pages[0].strokes.map((stroke) => stroke.id))
      .toEqual(expect.arrayContaining([...localIds, peerStrokeId]));

    await right.view.onClose();
    expect(right.vaultCalls.created).toHaveLength(1);
    const recovery = parseStoredJson(right.vaultCalls.createdContents[0]) as PdfSidecar;
    expect(recovery.notebook.pages[0].strokes.map((stroke) => stroke.id))
      .toEqual(expect.arrayContaining([...localIds, peerStrokeId]));
  });

  it("ignores external sidecar refreshes after the source revision is blocked", async () => {
    const { panes: [left, right], draw, refresh, disk } = split();
    right.view.sourcePdfModified();
    draw(left, 60);
    await left.internal.flushSaveNow();
    await refresh();
    expect(disk().notebook.pages[0].strokes).toHaveLength(1);
    expect(right.internal.sidecar.notebook.pages[0].strokes).toHaveLength(0);
    expect(right.internal.pendingMergedSidecar).toBeNull();
    await expect(right.internal.flushSaveNow()).resolves.toMatchObject({ status: "saved" });
    expect(right.store.writeIfUnchanged).not.toHaveBeenCalled();
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
      expect.any(String),
    );
    expect(parseStoredJson(store.writeIfUnchanged.mock.calls[0][2])).toMatchObject({format:1,source:sidecar.source});
    expect(internal.dirty).toBe(false);
  });

  it("stops CAS retries if the source changes during the disk read", async () => {
    const { view, internal, store } = setup();
    let release!: (raw: string) => void;
    store.writeIfUnchanged.mockResolvedValue(false);
    store.readRaw.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    internal.markSidecarChanged();
    const saving = internal.flushSaveNow();
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    view.sourcePdfModified();
    release(serializeSidecar(internal.sidecar));
    await expect(saving).resolves.toMatchObject({ status: "failed" });
    expect(store.writeIfUnchanged).toHaveBeenCalledTimes(1);
    expect(internal.dirty).toBe(true);
  });

  it("waits for an in-flight write before closing a blocked pane", async () => {
    const { view, internal, store, session } = setup();
    let release!: (saved: boolean) => void;
    store.writeIfUnchanged.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }));
    internal.markSidecarChanged();
    const saving = internal.flushSaveNow();
    await vi.waitFor(() => expect(release).toBeDefined());
    view.sourcePdfModified();
    const closing = view.onClose();
    await Promise.resolve();
    expect(session.dispose).not.toHaveBeenCalled();
    release(true);
    await Promise.all([saving, closing]);
    expect(session.dispose).toHaveBeenCalled();
    expect(store.writeIfUnchanged).toHaveBeenCalledTimes(1);
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

  it("persists edits made during a write and serializes concurrent flush callers", async () => {
    const { internal, store } = setup();
    let release!: (saved: boolean) => void;
    store.writeIfUnchanged.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    internal.markSidecarChanged();
    const saving = internal.flushSaveNow();
    await vi.waitFor(() => expect(release).toBeDefined());
    internal.withPageUndo(() => insertBlankNotePage(internal.sidecar, sourcePageId(0)) !== null, "insert");
    const second = internal.flushSaveNow();
    const third = internal.flushSaveNow();
    release(true);
    await Promise.all([saving, second, third]);
    expect(store.writeIfUnchanged).toHaveBeenCalledTimes(2);
    const lastRaw = store.writeIfUnchanged.mock.calls[1][2] as string;
    expect(parseStoredJson(lastRaw).notePages).toHaveLength(2);
    expect(internal.sidecar.notePages).toHaveLength(2);
    expect(internal.dirty).toBe(false);
  });

  it("freezes the compression snapshot and saves edits arriving while the worker is busy", async () => {
    const {internal,store,session}=setup();
    let finish!:()=>void;
    session.serializeStorage.mockImplementationOnce(value=>new Promise<string>(resolve=>{finish=()=>resolve(serializeStoredJson(value));}));
    internal.markSidecarChanged(); const saving=internal.flushSaveNow();
    await vi.waitFor(()=>expect(finish).toBeDefined());
    internal.withPageUndo(()=>insertBlankNotePage(internal.sidecar,sourcePageId(0))!==null,"insert");
    finish(); await saving;
    expect(parseStoredJson(store.writeIfUnchanged.mock.calls[0][2]).notePages).toHaveLength(1);
    expect(parseStoredJson(store.writeIfUnchanged.mock.calls[1][2]).notePages).toHaveLength(2);
    expect(internal.dirty).toBe(false);
  });

  it("blocks a source revision change while compression is pending before issuing a CAS write",async()=>{
    const {view,internal,store,session}=setup(); let finish!:()=>void;
    session.serializeStorage.mockImplementationOnce(value=>new Promise<string>(resolve=>{finish=()=>resolve(serializeStoredJson(value));}));
    internal.markSidecarChanged(); const saving=internal.flushSaveNow();
    await vi.waitFor(()=>expect(finish).toBeDefined()); view.sourcePdfModified(); finish();
    await expect(saving).resolves.toMatchObject({status:"failed"});
    expect(store.writeIfUnchanged).not.toHaveBeenCalled(); expect(internal.dirty).toBe(true);
  });

  it("falls back to lossless local serialization when the storage worker fails",async()=>{
    const {internal,store,session}=setup(); session.serializeStorage.mockRejectedValueOnce(new Error("worker stopped"));
    internal.markSidecarChanged(); await expect(internal.flushSaveNow()).resolves.toMatchObject({status:"saved"});
    expect(session.dispose).toHaveBeenCalled(); expect(parseStoredJson(store.writeIfUnchanged.mock.calls[0][2]).source).toMatchObject(FINGERPRINT);
  });

  it("retains both disk edits and local edits arriving during a merge write", async () => {
    const { internal, store } = setup();
    let release!: (saved: boolean) => void;
    const remote = parseStoredJson(serializeSidecar(internal.sidecar)) as PdfSidecar;
    insertBlankNotePage(remote, sourcePageId(0));
    store.readRaw.mockResolvedValue(serializeSidecar(remote));
    store.writeIfUnchanged.mockResolvedValueOnce(false).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    internal.markSidecarChanged();
    const saving = internal.flushSaveNow();
    for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
    expect(release).toBeDefined();
    internal.withPageUndo(() => insertBlankNotePage(internal.sidecar, sourcePageId(0)) !== null, "insert");
    release(true);
    await saving;
    const finalRaw = store.writeIfUnchanged.mock.calls.at(-1)![2] as string;
    expect(parseStoredJson(finalRaw).notePages).toHaveLength(3);
    expect(internal.dirty).toBe(false);
  });
});

describe("PDF plugin handoff and source revisions", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); });

  it("tries a recovery copy on close if updating the sidecar fails and releases resources", async () => {
    const { view, internal, store, vaultCalls, session } = setup();
    internal.onPointerDown(pointer(60, 60));
    internal.onPointerMove(pointer(140, 100));
    store.writeIfUnchanged.mockRejectedValue(new Error("process failed"));
    await view.onClose();
    expect(vaultCalls.created).toHaveLength(1);
    expect(vaultCalls.created[0]).toMatch(/\.conflict-\d+\.pdfink\.json$/);
    expect(session.dispose).toHaveBeenCalled();
    expect(internal.activeStroke).toBeNull();
  });

  it("saves the active stroke before unloading and clears the sidecar after saving", async () => {
    const { view, internal, store } = setup();
    internal.onPointerDown(pointer(60, 60));
    internal.onPointerMove(pointer(140, 100));
    await view.onUnloadFile(view.file!);
    expect(store.writeIfUnchanged).toHaveBeenCalled();
    const saved = parseStoredJson(store.writeIfUnchanged.mock.calls[0][2] as string);
    expect(saved.notebook.pages[0].strokes).toHaveLength(1);
    expect(saved.notebook.pages[0].strokes[0].points.length).toBeGreaterThan(1);
    expect(internal.sidecar).toBeNull();
  });

  it("recovers a conflict copy and unloads when saving fails", async () => {
    const { view, internal, store, vaultCalls, session } = setup();
    internal.markSidecarChanged();
    store.writeIfUnchanged.mockRejectedValue(new Error("disk full"));
    await view.onUnloadFile(view.file!);
    expect(vaultCalls.created).toHaveLength(1);
    expect(vaultCalls.created[0]).toMatch(/\.conflict-\d+\.pdfink\.json$/);
    expect(internal.sidecar).toBeNull();
    expect(session.dispose).toHaveBeenCalled();
  });

  it("keeps local ink in a conflict copy when the source changes before unload", async () => {
    const { view, internal, vaultCalls, session } = setup();
    internal.onPointerDown(pointer(60, 60));
    internal.onPointerMove(pointer(140, 100));
    view.sourcePdfModified();

    await view.onUnloadFile(view.file!);

    expect(vaultCalls.created).toHaveLength(1);
    const recovery = parseStoredJson(vaultCalls.createdContents[0]) as PdfSidecar;
    expect(recovery.notebook.pages[0].strokes).toHaveLength(1);
    expect(internal.sidecar).toBeNull();
    expect(internal.sidecarFile).toBeNull();
    expect(session.dispose).toHaveBeenCalled();
  });

  it("tears down after both the save and conflict recovery fail", async () => {
    const { view, internal, store, session } = setup();
    const vault = internal.app.vault as { create: (path: string, data?: string) => Promise<unknown> };
    vault.create = async () => { throw new Error("recovery disk full"); };
    internal.markSidecarChanged();
    store.writeIfUnchanged.mockRejectedValue(new Error("disk full"));

    await expect(view.onUnloadFile(view.file!)).rejects.toThrow("disk full");

    expect(internal.sidecar).toBeNull();
    expect(internal.sidecarFile).toBeNull();
    expect(session.dispose).toHaveBeenCalled();
  });

  it("returns source page numbers rather than inserted blank-page positions and keeps the leaf native", async () => {
    const { view, internal } = setup();
    insertBlankNotePage(internal.sidecar, sourcePageId(0));
    internal.sidecar.notePages.reverse();
    internal.sidecar.notebook.pages.reverse();
    internal.noteIndex = 1;
    const calls: unknown[][] = [];
    const host = { async setViewState(...args: unknown[]) { calls.push(args); } };
    const takeover = new PdfTabTakeover(() => ({ enabled: true, enhancerActive: false, isPdfFile: () => true }), VIEW_TYPE_PDF_INK);
    takeover.install(host as never);
    const leaf = { setViewState: host.setViewState };
    Object.assign(internal, { leaf, takeover });
    internal.onPointerDown(pointer(60, 60));
    await view.restoreBuiltinViewer();
    expect(calls[0]).toEqual([{ type: "pdf", state: { file: "docs/lecture.pdf" } }, { subpath: "#page=1" }]);
    await leaf.setViewState({ type: "pdf", state: { file: "docs/lecture.pdf" } });
    expect(calls[1][0]).toMatchObject({ type: "pdf" });
    takeover.uninstall();
  });

  it("hands a reused handwriting tab's native selection state back intact", async () => {
    const { view, internal } = setup();
    const leaf = { setViewState: vi.fn(async () => undefined) };
    Object.assign(internal, { leaf });
    const state = { subpath: "#page=5&rect=10,20,30,40", selection: [2, 8] };
    view.setEphemeralState({});
    view.setEphemeralState(state);
    await Promise.resolve();
    expect(leaf.setViewState).toHaveBeenCalledOnce();
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: "pdf", state: { file: "docs/lecture.pdf" } }, state);
  });

  it.each([undefined, null, {}, { focus: true }, { focus: false }, { subpath: "" }, { subpath: "#" },
    { focus: true, subpath: undefined }, { focus: false, subpath: "", selection: null }])(
    "keeps handwriting and pending ink when receiving non-navigation state: %j", async (state) => {
      const { view, internal } = setup();
      internal.onPointerDown(pointer(60, 60));
      const stroke = internal.activeStroke;
      const restore = vi.spyOn(view, "restoreBuiltinViewer").mockResolvedValue();
      view.setEphemeralState(state);
      await Promise.resolve();
      expect(restore).not.toHaveBeenCalled();
      expect(internal.activeStroke).toBe(stroke);
      expect(internal.canEdit()).toBe(true);
    });

  it("keeps a taken-over PDF in handwriting through host state delivery and tab refocus", async () => {
    const { view, internal } = setup();
    let currentType = "empty";
    const host = {
      async setViewState(state: { type: string; state?: Record<string, unknown> }, eState?: unknown) {
        currentType = state.type;
        // Real host forwards ephemeral state after installing the new view.
        if (currentType === VIEW_TYPE_PDF_INK) view.setEphemeralState(eState);
      },
      async openFile(file: TFile) {
        await this.setViewState({ type: "pdf", state: { file: file.path, page: 4, zoom: 1.5 } }, { focus: true });
      },
    };
    const takeover = new PdfTabTakeover(() => ({ enabled: true, preferInk: true,
      enhancerActive: true, isPdfFile: () => true }), VIEW_TYPE_PDF_INK);
    takeover.install(host as never);
    Object.assign(internal, { leaf: host, takeover });
    try {
      await host.openFile(view.file!);
      await Promise.resolve();
      expect(currentType).toBe(VIEW_TYPE_PDF_INK);
      view.setEphemeralState({ focus: false }); // leave the tab
      view.setEphemeralState({ focus: true }); // return to the tab
      await Promise.resolve();
      expect(currentType).toBe(VIEW_TYPE_PDF_INK);
      expect(internal.canEdit()).toBe(true);
      // A focus update must not suppress future ordinary opens on this leaf.
      await host.openFile(view.file!);
      expect(currentType).toBe(VIEW_TYPE_PDF_INK);
    } finally { takeover.uninstall(); }
  });

  it.each([{ subpath: "#page=5" }, { search: "phrase" }, { selection: [2, 8] },
    { futureNativeOption: true }, { focus: "unexpected" }])(
    "still delegates explicit and unknown native navigation intact: %j", async (state) => {
      const { view } = setup();
      const restore = vi.spyOn(view, "restoreBuiltinViewer").mockResolvedValue();
      view.setEphemeralState(state);
      expect(restore).toHaveBeenCalledOnce();
      expect(restore).toHaveBeenCalledWith(state);
    });

  it("ignores identical source modify events but blocks new ink on changed PDF bytes", async () => {
    const { view, internal, store } = setup();
    Object.assign(internal.app.vault as object, { readBinary: vi.fn(async () => new ArrayBuffer(100)) });
    await view.checkSourcePdfRevision();
    expect(internal.canEdit()).toBe(true);
    internal.onPointerDown(pointer(60, 60));
    store.computeFingerprint.mockResolvedValue({ sha256: "b".repeat(64), byteLength: 100 });
    await view.checkSourcePdfRevision();
    expect(internal.canEdit()).toBe(false);
    expect(internal.dirty).toBe(true);
    expect(internal.sidecar.notebook.pages[0].strokes).toHaveLength(1);
    internal.onPointerDown(pointer(90, 90));
    expect(internal.activeStroke).toBeNull();
  });

  it("checks source identity at export even without a vault modify event", async () => {
    const { view, internal, store } = setup();
    internal.onPointerDown(pointer(60, 60));
    internal.onPointerUp(pointer(100, 100));
    const createBinary = vi.fn();
    Object.assign(internal.app.vault as object, { readBinary: vi.fn(async () => new ArrayBuffer(100)), createBinary });
    store.computeFingerprint.mockResolvedValue({ sha256: "b".repeat(64), byteLength: 100 });
    await view.exportHandwrittenCopy();
    expect(store.computeFingerprint).toHaveBeenCalledOnce();
    expect(createBinary).not.toHaveBeenCalled();
    expect(internal.canEdit()).toBe(false);
    expect(internal.sidecar.source.sha256).toBe(FINGERPRINT.sha256);
  });
});

describe("case-twin sidecar collision", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", globalThis); });

  const PDF_PATH = "docs/lecture.pdf";
  const TWIN_PATH = "Docs/Lecture.pdf";
  const LEGACY_SLOT = sidecarPathFor(PDF_PATH);
  const DISAMBIGUATED_SLOT = disambiguatedSidecarPathFor(PDF_PATH);
  const FOREIGN_FINGERPRINT = { sha256: "b".repeat(64), byteLength: 200 };
  const CHANGED_MESSAGE = "This PDF changed since these notes were created; handwriting is read-only for this copy";

  /** The case twin's foreign sidecar occupies the legacy (lowercased) slot;
   *  with `disambiguated`, our own matching sidecar sits in the exact-case
   *  slot (steady state after a resolved collision). `indexedPaths` models
   *  which spellings the vault index holds as files besides the open PDF —
   *  the twin probe's signal source. adapter.exists defaults to answering
   *  for both spellings, which every real disk does (distinct files on ext4,
   *  one shared physical file on NTFS/APFS); `existsPaths` narrows it to
   *  model a case-sensitive disk. */
  function twinSetup(indexedPaths: string[], options: { existsPaths?: string[]; disambiguated?: boolean } = {}) {
    const { existsPaths = [TWIN_PATH, PDF_PATH], disambiguated } = options;
    const harness = setup();
    const foreign = createSidecar(TWIN_PATH, FOREIGN_FINGERPRINT, SOURCE_PAGES);
    const foreignFile = { path: LEGACY_SLOT } as TFile;
    const ours = createSidecar(PDF_PATH, FINGERPRINT, SOURCE_PAGES);
    const oursFile = { path: DISAMBIGUATED_SLOT } as TFile;
    const twinFile = Object.assign(new TFile(), { path: TWIN_PATH });
    harness.store.sidecarFileFor.mockImplementation((_pdfPath: string, slotPath?: string) =>
      slotPath === DISAMBIGUATED_SLOT && disambiguated ? oursFile
        : slotPath === undefined || slotPath === LEGACY_SLOT ? foreignFile : null);
    harness.store.readRaw.mockImplementation(async (file: TFile) =>
      file.path === DISAMBIGUATED_SLOT ? serializeSidecar(ours) : serializeSidecar(foreign));
    harness.store.findRecoveryCandidates.mockResolvedValue([]);
    harness.store.createFor.mockImplementation(async (_pdf: TFile, _fp: unknown, _pages: unknown, slotPath?: string) =>
      ({ path: slotPath ?? LEGACY_SLOT } as TFile));
    Object.assign(harness.internal.app.vault as object, {
      getAbstractFileByPath: vi.fn((path: string) =>
        path === PDF_PATH ? harness.view.file : indexedPaths.includes(path) ? twinFile : null),
      adapter: { exists: vi.fn(async (path: string) => existsPaths.includes(path)) },
    });
    return { ...harness, foreign, foreignFile, ours, oursFile };
  }

  it("gives a case-twin PDF its own disambiguated slot instead of read-only foreign ink", async () => {
    const { view, internal, store } = twinSetup([TWIN_PATH, PDF_PATH]);
    await internal.resolveSidecar(view.file!, FINGERPRINT, internal.loadGeneration);
    expect(internal.writeBlockedReason).toBeNull();
    expect(internal.sidecar.source.sha256).toBe(FINGERPRINT.sha256);
    expect(internal.sidecarFile?.path).toBe(DISAMBIGUATED_SLOT);
    expect(store.createFor).toHaveBeenCalledWith(view.file, FINGERPRINT, expect.anything(), DISAMBIGUATED_SLOT);
  });

  it("reopens into an existing disambiguated slot without re-creating", async () => {
    const { view, internal, store } = twinSetup([TWIN_PATH, PDF_PATH], { disambiguated: true });
    await internal.resolveSidecar(view.file!, FINGERPRINT, internal.loadGeneration);
    expect(internal.writeBlockedReason).toBeNull();
    expect(internal.sidecar.source.path).toBe(PDF_PATH);
    expect(internal.sidecarFile?.path).toBe(DISAMBIGUATED_SLOT);
    expect(store.createFor).not.toHaveBeenCalled();
  });

  it("keeps the read-only changed-revision path when the twin file does not exist", async () => {
    // Case-sensitive disk: the twin spelling is no real file, so it is absent
    // from the index and adapter.exists only answers for the open PDF.
    const { view, internal, store, foreignFile } = twinSetup([PDF_PATH], { existsPaths: [PDF_PATH] });
    await internal.resolveSidecar(view.file!, FINGERPRINT, internal.loadGeneration);
    expect(internal.writeBlockedReason).toBe(CHANGED_MESSAGE);
    expect(internal.sidecar.source.sha256).toBe(FOREIGN_FINGERPRINT.sha256);
    expect(internal.sidecarFile).toBe(foreignFile);
    expect(store.createFor).not.toHaveBeenCalled();
  });

  it("keeps the read-only changed-revision path on case-insensitive disks after a case-only rename", async () => {
    // NTFS/APFS drift: the PDF was renamed case-only outside the app, so
    // adapter.exists answers for both spellings (same physical file) while
    // the vault index holds only the new spelling. The old exists probe read
    // this as a twin and forked an empty disambiguated slot, silently
    // dropping the recorded ink; only the index can veto that.
    const { view, internal, store, foreignFile } = twinSetup([PDF_PATH]);
    await internal.resolveSidecar(view.file!, FINGERPRINT, internal.loadGeneration);
    expect(internal.writeBlockedReason).toBe(CHANGED_MESSAGE);
    expect(internal.sidecar.source.sha256).toBe(FOREIGN_FINGERPRINT.sha256);
    expect(internal.sidecarFile).toBe(foreignFile);
    expect(store.createFor).not.toHaveBeenCalled();
  });

  it("keeps the read-only path when the recorded path matches exactly", async () => {
    const harness = twinSetup([PDF_PATH]);
    // Same exact path, different bytes: a genuinely replaced PDF, not a twin.
    const replaced = createSidecar(PDF_PATH, FOREIGN_FINGERPRINT, SOURCE_PAGES);
    harness.store.readRaw.mockImplementation(async () => serializeSidecar(replaced));
    await harness.internal.resolveSidecar(harness.view.file!, FINGERPRINT, harness.internal.loadGeneration);
    expect(harness.internal.writeBlockedReason).toBe(CHANGED_MESSAGE);
    expect(harness.internal.sidecar.source.sha256).toBe(FOREIGN_FINGERPRINT.sha256);
    expect(harness.store.createFor).not.toHaveBeenCalled();
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
    ownerDocument: { activeElement: null }, contains: () => false,
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


describe("pdf page fit", () => {
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


describe("pdf setPage relays the ink exclusion", () => {
  beforeEach(() => { vi.stubGlobal("window", globalThis); });

  /** layoutHarness plus a tiles mock and pending-ink state, so the real
   *  prototype tileExclusion() drives the fourth setPage argument. */
  function exclusionHarness(pendingIds: string[]) {
    const view = layoutHarness(1318, 928, { width: 960, height: 540 }) as unknown as {
      tiles: { setPage: ReturnType<typeof vi.fn>; setDisplayScale: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>; setWorkerExclusion: ReturnType<typeof vi.fn> };
      pendingInkStrokes: InkStroke[];
      activeStroke: InkStroke | null;
      committingInkStrokes: InkStroke[] | null;
      stickyInput: unknown;
      selectedStrokeIds: Set<string>;
      lassoPath: InkPoint[];
      lassoDrag: unknown;
      viewport: { x: number; y: number; width: number; height: number };
      canvasLogicalWidth: number;
      canvasLogicalHeight: number;
      resizeSelectionCanvas(): void;
      resizePreview(): void;
      drawSelection(): void;
      updatePageIndicator(): void;
      refreshPageRail(): void;
      updateToolButtons(): void;
      updateHistoryButtons(): void;
      hideLassoPreview(): void;
      layoutPage(): void;
      renderAll(renderPageContent?: boolean): void;
    };
    view.tiles = {
      setPage: vi.fn(), setDisplayScale: vi.fn(), update: vi.fn(), setWorkerExclusion: vi.fn(),
    };
    // Only the id is read by tileExclusion(); the rest keeps the shape honest.
    view.pendingInkStrokes = pendingIds.map((id) => ({ id, points: [], tool: "pen" })) as unknown as InkStroke[];
    view.activeStroke = null;
    view.committingInkStrokes = null;
    view.stickyInput = null;
    view.selectedStrokeIds = new Set();
    view.lassoPath = [];
    view.lassoDrag = null;
    view.viewport = { x: 0, y: 0, width: 10, height: 10 };
    view.canvasLogicalWidth = 1270;
    view.canvasLogicalHeight = 900;
    view.resizeSelectionCanvas = vi.fn();
    view.resizePreview = vi.fn();
    view.drawSelection = vi.fn();
    return view;
  }

  it("layoutPage relays the pending-ink exclusion as setPage's fourth argument", () => {
    const view = exclusionHarness(["s1"]);
    view.layoutPage();
    expect(view.tiles.setPage).toHaveBeenCalledOnce();
    // The 180ms commit window outlives a ResizeObserver relayout; without the
    // relay the worker snapshot (#292) is cleared and highlighter double-draws.
    expect(view.tiles.setPage.mock.calls[0]![3]).toEqual(new Set(["s1"]));
  });

  it("renderAll relays the exclusion too", () => {
    const view = exclusionHarness(["s1"]);
    view.updatePageIndicator = vi.fn();
    view.refreshPageRail = vi.fn();
    view.updateToolButtons = vi.fn();
    view.updateHistoryButtons = vi.fn();
    view.renderAll();
    expect(view.tiles.setPage.mock.calls[0]![3]).toEqual(new Set(["s1"]));
  });

  it("mid-lasso relayout carries the selected ids and hideLassoPreview restores the baseline", () => {
    const view = exclusionHarness(["s1"]);
    view.selectedStrokeIds = new Set(["s2", "s3"]);
    view.lassoDrag = {
      start: { x: 0, y: 0 }, pageId: "p1", bounds: null, strokes: [], before: new Map(), dx: 0, dy: 0,
    };
    view.layoutPage();
    // A relayout between patchStrokes and the drop commit must not re-index
    // the moved selection (#311): worker tiles would redraw static ghosts.
    expect([...(view.tiles.setPage.mock.calls[0]![3] as Set<string>)].sort()).toEqual(["s1", "s2", "s3"]);
    // Every lasso exit path clears lassoDrag first, so the baseline restore
    // drops the selection again and worker rendering rejoins it.
    view.lassoDrag = null;
    view.hideLassoPreview();
    expect(view.tiles.setWorkerExclusion).toHaveBeenCalled();
    expect([...(view.tiles.setWorkerExclusion.mock.calls.at(-1)![0] as Set<string>)].sort()).toEqual(["s1"]);
  });
});
