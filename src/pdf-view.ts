import { App, FileView, Menu, Notice, Scope, SuggestModal, TFile, WorkspaceLeaf, loadPdfJs, setIcon } from "obsidian";
import { InkPage, InkPoint, InkStroke, InkTool, newId } from "./model";
import { canvasResolution, clampPercent, drawInkStroke, normalizePressureCurve, samplePressureCurve } from "./rendering";
import { BrushPopoverController } from "./brush-popover";
import { StrokeModelInput, StrokeModeler, StrokeModelResult, strokeModelParamsForSmoothStrength } from "./stroke-modeler";
import { TileRenderer } from "./tiles";
import { InkWorkerService, InkWorkerSession } from "./worker-service";
import {
  BrushSettings,
  EraserMode,
  INK_COLORS,
  InkPointerSample,
  ToolState,
  boundsForPointSets,
  clampLiftPressure,
  clonePoints,
  cloneStroke,
  constrainDelta,
  distance,
  eraseStrokeSegments,
  isBrushTool,
  packStrokePoints,
  penSampleTimeMillis,
  pointInPolygon,
  selectionBounds,
  strokeIntersectsEraser,
  translatePoints,
} from "./view";
import {
  PdfSidecar,
  PdfSidecarFormatError,
  PdfSidecarNotePage,
  PdfSourcePageGeometry,
  deleteBlankNotePage,
  insertBlankNotePage,
  mergeSidecars,
  moveBlankNotePage,
  normalizeSidecar,
  sidecarPathFor,
} from "./pdf-sidecar";
import { PdfSidecarStore, serializeSidecar } from "./pdf-store";
import { PdfExportError, exportHandwrittenPdf, exportPathFor, sidecarHasInk } from "./pdf-export";
import { PdfTabTakeover } from "./pdf-takeover";

export const VIEW_TYPE_PDF_INK = "ink-notes-pdf-view";

const STROKE_ERASER_HIT_RADIUS = 10;
const SAVE_IDLE_DELAY = 1_500;
const SAVE_MAX_DELAY = 10_000;
const SAVE_CONFLICT_RETRIES = 3;
const INK_COMMIT_IDLE_DELAY = 180;
const PDF_ZOOM_MIN = 0.5;
const PDF_ZOOM_MAX = 3;
const PDF_ZOOM_STEP = 1.2;
const PDF_PAGE_PADDING = 24;

export type PdfViewMode = "reading" | "editing";
export type SaveOutcome = { status: "saved" } | { status: "conflict"; message: string } | { status: "failed"; message: string };

/** Only one view may edit a given PDF at a time; others stay read-only. */
export class PdfWriterArbiter {
  private readonly holders = new Map<string, string>();

  acquire(pdfPath: string, holderId: string): boolean {
    const holder = this.holders.get(pdfPath);
    if (holder !== undefined && holder !== holderId) return false;
    this.holders.set(pdfPath, holderId);
    return true;
  }

  release(pdfPath: string, holderId: string): void {
    if (this.holders.get(pdfPath) === holderId) this.holders.delete(pdfPath);
  }
}

interface PdfJsViewport { width: number; height: number }

interface PdfJsRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

interface PdfJsPage {
  getViewport(options: { scale: number }): PdfJsViewport;
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: PdfJsViewport }): PdfJsRenderTask;
  getTextContent?(): Promise<unknown>;
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  destroy(): Promise<void>;
}

interface PdfJsTextLayerTask {
  promise: Promise<void>;
  cancel?(): void;
}

interface PdfJsLib {
  getDocument(options: { data: ArrayBuffer }): { promise: Promise<PdfJsDocument> };
  TextLayer?: new (options: { textContentSource?: unknown; container: HTMLElement; viewport: PdfJsViewport }) => { render(): Promise<PdfJsTextLayerTask> };
  renderTextLayer?: (options: { textContentSource?: unknown; container: HTMLElement; viewport: PdfJsViewport }) => PdfJsTextLayerTask;
  RenderingCancelledException?: new (...args: unknown[]) => Error;
}

/** Capture-time state for modeling one active pen stroke. */
interface PenCapture {
  modeler: StrokeModeler;
  pageWidth: number;
  pageHeight: number;
  lastInput: StrokeModelInput | null;
  fallback: boolean;
}

interface Interaction {
  pointerId: number;
  pageId: string;
  tool: InkTool;
  eraserMode?: EraserMode;
  eraserSize?: number;
}

interface EditCommand {
  undo: () => void;
  redo: () => void;
}

interface LassoDrag {
  start: InkPoint;
  pageId: string;
  strokes: InkStroke[];
  before: Map<string, InkPoint[]>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
  dx: number;
  dy: number;
}

interface SidecarLoad {
  sidecar: PdfSidecar;
  raw: string;
  file: TFile;
}

let nextViewId = 1;

/**
 * Handwriting view for PDF tabs. Opens in reading mode; editing unlocks only
 * after the user explicitly toggles edit mode and the sidecar passed its
 * fingerprint check. The PDF page renders with Obsidian's own pdf.js below
 * the shared ink tile pipeline, so strokes persist through the same
 * merge/tombstone machinery as .ink notebooks.
 */
export class PdfInkView extends FileView {
  readonly viewId = `pdf-view-${nextViewId++}`;

  private store!: PdfSidecarStore;
  private workers!: InkWorkerService;
  private takeover!: PdfTabTakeover;
  private arbiter!: PdfWriterArbiter;

  private mode: PdfViewMode = "reading";
  private root: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private pageWrap: HTMLElement | null = null;
  private pdfCanvas: HTMLCanvasElement | null = null;
  private textLayer: HTMLElement | null = null;
  private inkHost: HTMLElement | null = null;
  private eraserCursor: HTMLElement | null = null;
  private selectionCanvas: HTMLCanvasElement | null = null;
  private selectionCtx: CanvasRenderingContext2D | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private previewCtx: CanvasRenderingContext2D | null = null;
  private brushPopover: BrushPopoverController | null = null;
  /** Predicted (speculative) tip points for the live stroke — render-only,
   *  never stored; dropped when the real tail takes over at lift. */
  private predictedTip: InkPoint[] | null = null;
  private statusEl: HTMLElement | null = null;
  private toolbarButtons = new Map<string, HTMLElement>();

  private pdfjs: PdfJsLib | null = null;
  private pdfDoc: PdfJsDocument | null = null;
  private pdfRenderTask: PdfJsRenderTask | null = null;
  private pdfRenderGeneration = 0;
  private textLayerTask: PdfJsTextLayerTask | null = null;
  private loadGeneration = 0;

  private sidecar: PdfSidecar | null = null;
  private sidecarRaw = "";
  private sidecarFile: TFile | null = null;
  /** Set when fingerprint mismatch or an unreadable sidecar blocks writing. */
  private writeBlockedReason: string | null = null;
  private writerHeld = false;

  private sourcePages: PdfSourcePageGeometry[] = [];
  private noteIndex = 0;
  private zoom = 1;
  private pageBaseWidth = 700;
  private pageBaseHeight = 990;
  private canvasLogicalWidth = 1;
  private canvasLogicalHeight = 1;
  private viewport = { x: 0, y: 0, width: 1, height: 1 };

  private tiles: TileRenderer | null = null;
  private session: InkWorkerSession | null = null;
  private workerRevision = 0;

  private state: ToolState = {
    tool: "pen",
    pen: { color: INK_COLORS[0].value, width: 3, opacity: 1, smooth: 60, taper: 30, pressureGain: 70, speedGain: 0 },
    highlighter: { color: "#ffe94a", width: 14, opacity: 0.4 },
    eraserMode: "stroke",
    eraserSize: 24,
  };

  private interaction: Interaction | null = null;
  private activePointerId: number | null = null;
  private activeStroke: InkStroke | null = null;
  private lastPoint: InkPoint | null = null;
  private workerStrokePointIndex = 0;
  private penCapture: PenCapture | null = null;
  private penSampleIntervals: number[] = [];
  private pendingInkStrokes: InkStroke[] = [];
  private pendingInkPageId: string | null = null;
  private committingInkStrokes: InkStroke[] | null = null;
  private inkCommitTimer: number | undefined;
  private erasedCandidateIds = new Set<string>();
  private erasedStrokeIds = new Set<string>();
  private eraserReplacementIds = new Set<string>();
  private erasedStrokes: InkStroke[] = [];
  private eraserReplacements: InkStroke[] = [];
  private lassoPath: InkPoint[] = [];
  private lassoDrag: LassoDrag | null = null;
  private selectedStrokeIds = new Set<string>();

  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];
  private dirty = false;
  private activeSave: Promise<SaveOutcome> | null = null;
  private saveRequested = false;
  private saveTimer: number | undefined;
  private saveMaxDue = 0;
  private renderFrame: number | null = null;
  private zoomTimer: number | undefined;
  private pendingRecoveryCandidates: TFile[] | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", () => this.undo());
    this.scope.register(["Mod", "Shift"], "z", () => this.redo());
  }

  /** Wired by the plugin right after construction. */
  configure(deps: { store: PdfSidecarStore; workers: InkWorkerService; takeover: PdfTabTakeover; arbiter: PdfWriterArbiter }): void {
    this.store = deps.store;
    this.workers = deps.workers;
    this.takeover = deps.takeover;
    this.arbiter = deps.arbiter;
  }

  getDisplayText(): string {
    return this.file ? `${this.file.basename} (handwriting)` : "PDF handwriting";
  }

  getViewType(): string {
    return VIEW_TYPE_PDF_INK;
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("ink-pdf-view", "ink-pdf-reading");
    this.root = root;
    this.renderToolbar(root);
    this.statusEl = root.createDiv({ cls: "ink-pdf-status" });
    const scroller = root.createDiv({ cls: "ink-pdf-scroller" });
    this.scroller = scroller;
    this.pageWrap = scroller.createDiv({ cls: "ink-pdf-page-wrap" });
    this.pdfCanvas = this.pageWrap.createEl("canvas", { cls: "ink-pdf-canvas" });
    this.textLayer = this.pageWrap.createDiv({ cls: "ink-pdf-text-layer" });
    this.buildInkHost();
    this.registerDomEvent(scroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(window, "resize", () => this.requestRender(true));
    // Editable PDFs open straight into editing mode: the reading-first
    // default hid the whole toolbar behind a toggle the user could not find.
    if (this.canEdit()) void this.setMode("editing");
  }

  async onClose(): Promise<void> {
    if (this.mode === "editing") {
      const outcome = await this.flushSaveNow();
      if (outcome.status !== "saved") {
        new Notice(`Ink Notes kept notes for ${this.file?.basename ?? "this PDF"} in a conflict copy: ${outcome.message}`);
      }
      this.exitEditState();
    }
    this.loadGeneration += 1;
    this.cancelPdfRender();
    this.finalizeInput();
    this.discardPendingInkPreview();
    this.clearSaveTimer();
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    if (this.zoomTimer !== undefined) window.clearTimeout(this.zoomTimer);
    this.tiles?.dispose();
    this.tiles = null;
    this.session?.dispose();
    this.session = null;
    void this.pdfDoc?.destroy().catch(() => undefined);
    this.pdfDoc = null;
    this.root = null;
  }

  async onLoadFile(file: TFile): Promise<void> {
    const generation = ++this.loadGeneration;
    this.resetViewState();
    let bytes: ArrayBuffer;
    try {
      bytes = await this.app.vault.readBinary(file);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.setStatus(`Could not read this PDF: ${messageOf(error)}`, true);
      return;
    }
    if (generation !== this.loadGeneration) return;
    let fingerprint: { sha256: string; byteLength: number };
    try {
      fingerprint = await this.store.computeFingerprint(bytes);
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.setStatus(`Could not fingerprint this PDF: ${messageOf(error)}`, true);
      return;
    }
    if (generation !== this.loadGeneration) return;
    let pdfjs: PdfJsLib;
    try {
      pdfjs = (await loadPdfJs()) as PdfJsLib;
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.setStatus(`Could not load the PDF renderer: ${messageOf(error)}`, true);
      return;
    }
    this.pdfjs = pdfjs;
    let doc: PdfJsDocument;
    try {
      doc = await pdfjs.getDocument({ data: bytes }).promise;
    } catch (error) {
      if (generation !== this.loadGeneration) return;
      this.setStatus(`This PDF could not be opened: ${messageOf(error)}`, true);
      return;
    }
    if (generation !== this.loadGeneration) {
      void doc.destroy().catch(() => undefined);
      return;
    }
    this.pdfDoc = doc;
    this.sourcePages = await this.readSourcePages(doc, generation);
    if (generation !== this.loadGeneration) return;

    await this.resolveSidecar(file, fingerprint, generation);
    if (generation !== this.loadGeneration) return;
    this.noteIndex = 0;
    this.layoutPage();
    this.renderAll();
    await this.renderPdfPage();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.finalizeInput();
    this.loadGeneration += 1;
    this.cancelPdfRender();
    this.discardPendingInkPreview();
    this.pdfDoc = null;
    this.sidecar = null;
    this.sidecarFile = null;
    this.writeBlockedReason = null;
    this.releaseWriter();
  }

  /**
   * Adopt an externally modified sidecar (another device synced new ink).
   * Ignored while local edits are pending — the save path merges those — and
   * while the user is mid-stroke.
   */
  async reloadExternalSidecar(changedPath: string): Promise<void> {
    if (!this.sidecar || !this.sidecarFile || this.sidecarFile.path !== changedPath) return;
    if (this.dirty || this.activePointerId !== null) return;
    const raw = await this.store.readRaw(this.sidecarFile).catch(() => null);
    if (raw === null || raw === this.sidecarRaw) return;
    try {
      const sidecar = normalizeSidecar(JSON.parse(raw));
      this.attachSidecar(sidecar, raw, this.sidecarFile);
      this.layoutPage();
      this.renderAll();
    } catch {
      // Corrupt external state: keep the in-memory sidecar, never write over it.
    }
  }

  // ------------------------------------------------------------------ mode

  get viewMode(): PdfViewMode {
    return this.mode;
  }

  /** Exposed for tests and diagnostics: why handwriting is read-only, if so. */
  get writeBlocked(): string | null {
    return this.writeBlockedReason;
  }

  private canEdit(): boolean {
    return this.sidecar !== null && this.writeBlockedReason === null && this.file !== null;
  }

  async setMode(mode: PdfViewMode): Promise<void> {
    if (mode === this.mode) return;
    if (mode === "editing") {
      if (!this.canEdit()) {
        new Notice(this.writeBlockedReason ?? "Handwriting is not available for this PDF");
        return;
      }
      if (!this.arbiter.acquire(this.file!.path, this.viewId)) {
        new Notice("This PDF is already being edited in another Ink Notes tab; it stays read-only here");
        return;
      }
      this.writerHeld = true;
      this.mode = "editing";
      this.root?.removeClass("ink-pdf-reading");
      this.root?.addClass("ink-pdf-editing");
      this.textLayer?.setAttribute("aria-hidden", "true");
      this.updateToolButtons();
      this.updateHistoryButtons();
      void this.flushSaveNow().then((outcome) => {
        if (outcome.status === "failed") new Notice(`Ink Notes could not save pending changes: ${outcome.message}`);
      });
      return;
    }
    // Leaving edit mode waits for the save; failures keep editing available.
    const outcome = await this.flushSaveNow();
    if (outcome.status === "failed") {
      new Notice(`Save failed, still in edit mode: ${outcome.message}`);
      return;
    }
    if (outcome.status === "conflict") {
      new Notice(`Saved a conflict copy instead of overwriting: ${outcome.message}`);
    }
    this.exitEditState();
  }

  private exitEditState(): void {
    this.finalizeInput();
    this.discardPendingInkPreview();
    this.mode = "reading";
    this.selectedStrokeIds.clear();
    this.lassoPath = [];
    this.lassoDrag = null;
    this.releaseWriter();
    this.root?.removeClass("ink-pdf-editing");
    this.root?.addClass("ink-pdf-reading");
    this.textLayer?.removeAttribute("aria-hidden");
    this.hideEraserCursor();
    this.updateToolButtons();
    this.updateHistoryButtons();
    this.drawSelection();
    this.setStatus(this.writeBlockedReason ?? "");
  }

  private releaseWriter(): void {
    if (this.writerHeld && this.file) this.arbiter.release(this.file.path, this.viewId);
    this.writerHeld = false;
  }

  /** Hand the tab back to the built-in (possibly PDF++-enhanced) viewer. */
  async restoreBuiltinViewer(): Promise<void> {
    if (this.mode === "editing") {
      const outcome = await this.flushSaveNow();
      if (outcome.status === "failed") {
        new Notice(`Save failed, staying in the handwriting view: ${outcome.message}`);
        return;
      }
      this.exitEditState();
    }
    if (!this.file) return;
    this.takeover.suppressLeaf(this.leaf);
    try {
      await this.leaf.setViewState({ type: "pdf", state: { file: this.file.path } });
    } finally {
      this.takeover.releaseLeaf(this.leaf);
    }
  }

  // --------------------------------------------------------------- sidecar

  private async readSourcePages(doc: PdfJsDocument, generation: number): Promise<PdfSourcePageGeometry[]> {
    const pages: PdfSourcePageGeometry[] = [];
    for (let index = 1; index <= doc.numPages; index++) {
      const page = await doc.getPage(index);
      if (generation !== this.loadGeneration) return [];
      const raw = page as unknown as { view?: number[]; rotate?: number };
      pages.push({
        width: Math.round((raw.view?.[2] ?? page.getViewport({ scale: 1 }).width) * 100) / 100,
        height: Math.round((raw.view?.[3] ?? page.getViewport({ scale: 1 }).height) * 100) / 100,
        rotation: (raw.rotate ?? 0) as PdfSourcePageGeometry["rotation"],
      });
    }
    return pages;
  }

  /**
   * Resolve the sidecar for this PDF: reuse, recover after a move while the
   * plugin was closed (unique fingerprint match only), or create empty.
   * Corrupt/unknown sidecars and fingerprint mismatches block writing but
   * never overwrite anything.
   */
  private async resolveSidecar(file: TFile, fingerprint: { sha256: string; byteLength: number }, generation: number): Promise<void> {
    const existing = this.store.sidecarFileFor(file.path);
    if (existing) {
      try {
        const raw = await this.store.readRaw(existing);
        if (generation !== this.loadGeneration) return;
        const sidecar = normalizeSidecar(JSON.parse(raw));
        if (sidecar.source.sha256 !== fingerprint.sha256 || sidecar.source.byteLength !== fingerprint.byteLength) {
          this.writeBlockedReason = "This PDF changed since these notes were created; handwriting is read-only for this copy";
        } else if (sidecar.source.path !== file.path) {
          sidecar.source.path = file.path;
          await this.writeSidecar(existing, raw, sidecar);
        }
        this.attachSidecar(sidecar, raw, existing);
      } catch (error) {
        if (error instanceof PdfSidecarFormatError || error instanceof SyntaxError) {
          this.writeBlockedReason = `The notes file for this PDF is corrupt or uses an unknown format; handwriting is disabled to protect it (${existing.path})`;
          this.setStatus(this.writeBlockedReason, true);
        } else {
          this.setStatus(`Could not read the notes file: ${messageOf(error)}`, true);
        }
      }
      return;
    }
    const candidates = await this.store.findRecoveryCandidates(fingerprint);
    if (generation !== this.loadGeneration) return;
    if (candidates.length === 1) {
      const { file: recovered, sidecar } = candidates[0];
      sidecar.source.path = file.path;
      try {
        if (!this.store.sidecarFileFor(file.path)) {
          await this.app.vault.rename(recovered, sidecarPathFor(file.path));
          const migrated = this.store.sidecarFileFor(file.path);
          if (migrated) await this.writeSidecar(migrated, serializeSidecar(sidecar), sidecar);
          this.attachSidecar(sidecar, serializeSidecar(sidecar), migrated ?? recovered);
          new Notice(`Restored handwriting notes from ${recovered.name}`);
          return;
        }
      } catch (error) {
        new Notice(`Recovered notes stayed at ${recovered.path}: ${messageOf(error)}`);
        this.attachSidecar(sidecar, serializeSidecar(sidecar), recovered);
        return;
      }
    }
    if (candidates.length > 1) {
      this.writeBlockedReason = `Several notes files match this PDF (${candidates.map((candidate) => candidate.file.name).join(", ")}). Choose one to restore.`;
      this.setStatus(this.writeBlockedReason, true);
      this.pendingRecoveryCandidates = candidates.map((candidate) => candidate.file);
      this.maybeOfferRecoveryChoice();
      return;
    }
    try {
      const created = await this.store.createFor(file, fingerprint, this.sourcePages);
      const raw = await this.store.readRaw(created);
      if (generation !== this.loadGeneration) return;
      this.attachSidecar(normalizeSidecar(JSON.parse(raw)), raw, created);
    } catch (error) {
      if (generation === this.loadGeneration) this.setStatus(`Could not create the notes file: ${messageOf(error)}`, true);
    }
  }

  /** Offer a choice when several sidecars match the fingerprint. */
  maybeOfferRecoveryChoice(): void {
    const candidates = this.pendingRecoveryCandidates;
    if (!candidates || !this.file) return;
    this.pendingRecoveryCandidates = null;
    new RecoveryChoiceModal(this.app, candidates, async (chosen) => {
      if (!chosen || !this.file) return;
      try {
        const sidecar = normalizeSidecar(JSON.parse(await this.store.readRaw(chosen)));
        sidecar.source.path = this.file.path;
        if (!this.store.sidecarFileFor(this.file.path)) {
          await this.app.vault.rename(chosen, sidecarPathFor(this.file.path));
        }
        const migrated = this.store.sidecarFileFor(this.file.path);
        const raw = serializeSidecar(sidecar);
        if (migrated) await this.writeSidecar(migrated, raw, sidecar);
        this.writeBlockedReason = null;
        this.attachSidecar(sidecar, raw, migrated ?? chosen);
        this.layoutPage();
        this.renderAll();
        void this.renderPdfPage();
      } catch (error) {
        new Notice(`Could not restore the selected notes file: ${messageOf(error)}`);
      }
    }).open();
  }

  private attachSidecar(sidecar: PdfSidecar, raw: string, file: TFile | null): void {
    this.sidecar = sidecar;
    this.sidecarRaw = raw;
    this.sidecarFile = file;
    this.dirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.disposeWorkerSession();
    this.initializeWorkerSession();
    this.maybeOfferRecoveryChoice();
  }

  private async writeSidecar(file: TFile, expectedRaw: string, sidecar: PdfSidecar): Promise<void> {
    try {
      const nextRaw = serializeSidecar(sidecar);
      if (await this.store.writeIfUnchanged(file, expectedRaw, nextRaw)) this.sidecarRaw = nextRaw;
    } catch {
      // Metadata only; the fingerprint is what protects the data.
    }
  }

  private initializeWorkerSession(): void {
    if (!this.sidecar) return;
    const session = this.workers.createSession(() => ({ notebook: this.sidecar!.notebook, revision: this.workerRevision }));
    this.session = session;
    if (session.canRenderTiles()) this.tiles?.setBackend(session, () => this.disableWorkerSession());
    void session.initializeRaw(JSON.stringify(this.sidecar.notebook), this.workerRevision).catch(() => this.disableWorkerSession());
  }

  private disableWorkerSession(): void {
    this.tiles?.setBackend(null);
  }

  private disposeWorkerSession(): void {
    this.tiles?.setBackend(null);
    this.session?.dispose();
    this.session = null;
  }

  private queueWorkerOperation(operation: Parameters<InkWorkerSession["apply"]>[1], transfer?: Transferable[]): void {
    const session = this.session;
    if (!session) return;
    this.workerRevision += 1;
    void session.apply(this.workerRevision, operation, transfer).catch(() => this.disableWorkerSession());
  }

  // -------------------------------------------------------------- toolbar

  private renderToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "ink-pdf-toolbar" });
    const group = (cls: string) => toolbar.createDiv({ cls: `ink-pdf-toolbar-group ${cls}` });

    const modeGroup = group("ink-pdf-mode-group");
    this.addIconButton(modeGroup, "mode", "eye", "Toggle handwriting editing", () => void this.setMode(this.mode === "editing" ? "reading" : "editing"));

    const navGroup = group("ink-pdf-nav-group");
    this.addIconButton(navGroup, "prev", "arrow-left", "Previous page", () => this.navigatePages(-1));
    const indicator = navGroup.createDiv({ cls: "ink-pdf-page-indicator" });
    indicator.setText("–");
    this.toolbarButtons.set("indicator", indicator);
    this.addIconButton(navGroup, "next", "arrow-right", "Next page", () => this.navigatePages(1));

    const zoomGroup = group("ink-pdf-zoom-group");
    this.addIconButton(zoomGroup, "zoom-out", "minus", "Zoom out", () => this.setZoom(this.zoom / PDF_ZOOM_STEP));
    this.addIconButton(zoomGroup, "zoom-reset", "scan", "Reset zoom", () => this.setZoom(1));
    this.addIconButton(zoomGroup, "zoom-in", "plus", "Zoom in", () => this.setZoom(this.zoom * PDF_ZOOM_STEP));

    const toolGroup = group("ink-pdf-tool-group");
    this.addToolButton(toolGroup, "pen", "pen-tool", "Pen");
    this.addToolButton(toolGroup, "highlighter", "highlighter", "Highlighter");
    this.addToolButton(toolGroup, "eraser", "eraser", "Eraser");
    this.addToolButton(toolGroup, "lasso", "lasso", "Lasso");
    this.addBrushPopover(toolGroup);

    const historyGroup = group("ink-pdf-history-group");
    this.addIconButton(historyGroup, "undo", "undo-2", "Undo", () => {
      if (!this.editingLocked()) this.undo();
    });
    this.addIconButton(historyGroup, "redo", "redo-2", "Redo", () => {
      if (!this.editingLocked()) this.redo();
    });

    const docGroup = group("ink-pdf-doc-group");
    this.addIconButton(docGroup, "pages", "files", "Page options (blank pages, export, built-in viewer)", (event) => {
      if (!this.editingLocked()) this.openPageMenu(event);
    });
    this.addIconButton(docGroup, "export", "download", "Export PDF with handwriting", () => {
      if (!this.editingLocked()) void this.exportHandwrittenCopy();
    });

    this.updateToolButtons();
    this.updateHistoryButtons();
    this.updatePageIndicator();
  }

  private addIconButton(parent: HTMLElement, key: string, icon: string, label: string, onClick: (event: MouseEvent) => void): void {
    const button = parent.createEl("button", { cls: "ink-pdf-icon-button ink-icon-button", attr: { type: "button", "aria-label": label } });
    setIcon(button, icon);
    button.addEventListener("click", (event) => onClick(event));
    this.toolbarButtons.set(key, button);
  }

  private addToolButton(parent: HTMLElement, tool: InkTool, icon: string, label: string): void {
    const button = parent.createEl("button", {
      cls: "ink-pdf-icon-button ink-icon-button ink-tool-button",
      attr: { type: "button", "data-tool": tool, "aria-label": label },
    });
    setIcon(button, icon);
    button.addEventListener("click", () => {
      if (this.mode !== "editing") {
        void this.setMode("editing");
      }
      this.state.tool = tool;
      this.selectedStrokeIds.clear();
      this.lassoPath = [];
      this.lassoDrag = null;
      this.updateToolButtons();
    });
    this.toolbarButtons.set(`tool-${tool}`, button);
  }

  /** Shared brush settings popover (same controller as the notebook view):
   *  pinned sample-stroke preview, dynamics sliders, pressure mapping curve
   *  and eraser controls. */
  private addBrushPopover(parent: HTMLElement): void {
    const button = parent.createEl("button", {
      cls: "ink-pdf-icon-button ink-icon-button",
      attr: { type: "button", "aria-label": "Brush settings" },
    });
    setIcon(button, "settings-2");
    this.toolbarButtons.set("brush", button);
    button.addEventListener("click", () => this.brushPopover!.toggle());
    // Mounted at the view root with fixed positioning (mainline parity):
    // nesting it inside the toolbar group exposed it to toolbar layout and
    // produced the mangled arc layout on iPad.
    this.brushPopover = new BrushPopoverController(this.root!, {
      // Extra class scopes the PDF-surface rules (paper canvases, spacing).
      extraClass: "ink-pdf-brush-popover",
      tools: [
        { tool: "pen", label: "Pen", presets: [2, 4, 8], maximum: 40 },
        { tool: "highlighter", label: "Highlighter", presets: [8, 16, 24], maximum: 48 },
      ],
      getSettings: (tool) => this.brushSettings(),
      activeTool: () => this.state.tool,
      showPenDynamics: () => this.state.tool === "pen",
      buildExtras: (body, { addRange }) => {
        body.createDiv({ cls: "ink-settings-label", text: "Eraser size" });
        addRange(body, "Eraser size", 6, 80, 2, this.state.eraserSize, (value: number) => {
          this.state.eraserSize = value;
        });
        const modes = body.createDiv({ cls: "ink-pdf-color-row" });
        for (const mode of ["stroke", "circle", "square"] as EraserMode[]) {
          const label = { stroke: "Stroke", circle: "Circle", square: "Square" }[mode];
          const modeButton = modes.createEl("button", { cls: "ink-pdf-mode-button", attr: { type: "button", "data-eraser-mode": mode } });
          modeButton.setText(label);
          modeButton.addEventListener("click", () => {
            this.state.eraserMode = mode;
            this.updateToolButtons();
          });
        }
      },
      onControlsChanged: () => this.updateToolButtons(),
      anchor: () => this.toolbarButtons.get("brush") ?? null,
    });
  }

  private brushSettings(): BrushSettings {
    return isBrushTool(this.state.tool) ? this.state[this.state.tool] : this.state.pen;
  }

  private updateToolButtons(): void {
    for (const tool of ["pen", "highlighter", "eraser", "lasso"] as InkTool[]) {
      this.toolbarButtons.get(`tool-${tool}`)?.toggleClass("is-active", this.mode === "editing" && this.state.tool === tool);
    }
    this.toolbarButtons.get("mode")?.toggleClass("is-active", this.mode === "editing");
  }

  private updateHistoryButtons(): void {
    this.toolbarButtons.get("undo")?.toggleClass("is-disabled", this.undoStack.length === 0);
    this.toolbarButtons.get("redo")?.toggleClass("is-disabled", this.redoStack.length === 0);
  }

  private updatePageIndicator(): void {
    const indicator = this.toolbarButtons.get("indicator");
    if (!indicator) return;
    indicator.setText(this.sidecar
      ? `${this.noteIndex + 1} / ${this.sidecar.notePages.length}`
      : this.pdfDoc ? `${this.noteIndex + 1} / ?` : "–");
  }

  private openPageMenu(event: MouseEvent): void {
    if (!this.sidecar) return;
    const menu = new Menu();
    const current = this.sidecar.notePages[this.noteIndex];
    menu.addItem((item) => item.setTitle("Insert blank page after this one").setIcon("plus")
      .onClick(() => this.withPageUndo(() => insertBlankNotePage(this.sidecar!, current?.id ?? null) !== null, "insert a blank page")));
    if (current && current.sourceIndex === undefined) {
      menu.addItem((item) => item.setTitle("Move blank page left").setIcon("arrow-left")
        .onClick(() => this.withPageUndo(() => moveBlankNotePage(this.sidecar!, current.id, this.noteIndex - 1), "move the blank page")));
      menu.addItem((item) => item.setTitle("Move blank page right").setIcon("arrow-right")
        .onClick(() => this.withPageUndo(() => moveBlankNotePage(this.sidecar!, current.id, this.noteIndex + 1), "move the blank page")));
      menu.addSeparator();
      menu.addItem((item) => item.setTitle("Delete blank page").setIcon("trash-2")
        .onClick(() => this.withPageUndo(() => deleteBlankNotePage(this.sidecar!, current.id), "delete the blank page")));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Export PDF with handwriting").setIcon("download")
      .onClick(() => void this.exportHandwrittenCopy()));
    menu.addItem((item) => item.setTitle("Open with the built-in viewer").setIcon("book-open")
      .onClick(() => void this.restoreBuiltinViewer()));
    menu.showAtMouseEvent(event);
  }

  // ------------------------------------------------------------- page ops

  /** Apply a note page sequence change, sync the worker, and record undo. */
  private withPageUndo(change: () => boolean, label: string): void {
    if (!this.sidecar) return;
    const before = serializeSidecar(this.sidecar);
    if (!change()) {
      new Notice(`Ink Notes could not ${label}: source PDF pages are permanent`);
      return;
    }
    const after = serializeSidecar(this.sidecar);
    this.markSidecarChanged();
    this.syncNotebookToWorker();
    this.layoutPage();
    this.renderAll();
    void this.renderPdfPage();
    this.pushCommand({
      undo: () => this.restoreSidecarSnapshot(before),
      redo: () => this.restoreSidecarSnapshot(after),
    });
  }

  private restoreSidecarSnapshot(snapshot: string): void {
    if (!this.sidecar) return;
    try {
      this.sidecar = normalizeSidecar(JSON.parse(snapshot));
      this.markSidecarChanged();
      this.syncNotebookToWorker();
      this.layoutPage();
      this.renderAll();
      void this.renderPdfPage();
    } catch (error) {
      new Notice(`Ink Notes could not restore the previous page state: ${messageOf(error)}`);
    }
  }

  private syncNotebookToWorker(): void {
    if (!this.sidecar) return;
    this.workerRevision += 1;
    void this.session?.apply(this.workerRevision, { type: "replace-notebook", notebook: this.sidecar.notebook }).catch(() => this.disableWorkerSession());
  }

  navigatePages(delta: number): void {
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 1;
    const next = this.noteIndex + delta;
    if (next < 0 || next >= count) return;
    this.finalizeInput();
    this.noteIndex = next;
    this.updatePageIndicator();
    this.layoutPage();
    this.renderAll();
    void this.renderPdfPage();
  }

  private setZoom(zoom: number): void {
    const clamped = Math.max(PDF_ZOOM_MIN, Math.min(PDF_ZOOM_MAX, zoom));
    if (clamped === this.zoom) return;
    this.zoom = clamped;
    this.layoutPage();
    void this.renderPdfPage();
  }

  // -------------------------------------------------------------- geometry

  private currentNotePage(): PdfSidecarNotePage | null {
    return this.sidecar?.notePages[this.noteIndex] ?? null;
  }

  private rotatedSize(page: PdfSidecarNotePage | null): { width: number; height: number } {
    if (!page) return { width: 595.28, height: 841.89 };
    const rotated = page.rotation === 90 || page.rotation === 270;
    return { width: rotated ? page.height : page.width, height: rotated ? page.width : page.height };
  }

  private layoutPage(): void {
    if (!this.scroller || !this.pageWrap) return;
    const display = this.rotatedSize(this.currentNotePage());
    this.pageBaseWidth = Math.min(980, Math.max(200, this.scroller.clientWidth - PDF_PAGE_PADDING * 2)) || 700;
    this.pageBaseHeight = this.pageBaseWidth * display.height / display.width;
    this.pageWrap.setCssStyles({
      width: `${this.pageBaseWidth * this.zoom}px`,
      height: `${this.pageBaseHeight * this.zoom}px`,
    });
    this.canvasLogicalWidth = Math.max(1, Math.round(display.width * 64) / 64);
    this.canvasLogicalHeight = Math.max(1, Math.round(display.height * 64) / 64);
    this.tiles?.setDisplayScale(this.zoom);
    const page = this.sidecar?.notebook.pages[this.noteIndex];
    if (page) this.tiles?.setPage(page, this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.updateViewport(true);
  }

  private updateViewport(refine: boolean): void {
    if (!this.pageWrap || !this.scroller) return;
    const pageRect = this.pageWrap.getBoundingClientRect();
    const screenRect = this.scroller.getBoundingClientRect();
    const x = Math.max(0, (screenRect.left - pageRect.left) / this.zoom);
    const y = Math.max(0, (screenRect.top - pageRect.top) / this.zoom);
    this.viewport = {
      x, y,
      width: Math.max(1, Math.min(this.canvasLogicalWidth - x, (screenRect.right - pageRect.left) / this.zoom - x)),
      height: Math.max(1, Math.min(this.canvasLogicalHeight - y, (screenRect.bottom - pageRect.top) / this.zoom - y)),
    };
    this.tiles?.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    this.resizeSelectionCanvas();
    this.resizePreviewCanvas();
    this.drawSelection();
    if (this.activeStroke) this.drawPreview();
  }

  private onViewportMotion(): void {
    this.updateViewport(false);
    if (this.zoomTimer !== undefined) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.updateViewport(true), 100);
  }

  private buildInkHost(): void {
    const host = this.pageWrap!.createDiv({ cls: "ink-page ink-pdf-ink-host" });
    this.inkHost = host;
    this.eraserCursor = host.createDiv({ cls: "ink-eraser-cursor" });
    const tileLayer = host.createDiv({ cls: "ink-tile-layer" });
    this.tiles = new TileRenderer(tileLayer);
    this.selectionCanvas = host.createEl("canvas", { cls: "ink-selection-canvas" });
    this.selectionCtx = this.selectionCanvas.getContext("2d");
    this.previewCanvas = host.createEl("canvas", { cls: "ink-preview-canvas" });
    this.previewCtx = this.previewCanvas.getContext("2d");
    host.addEventListener("pointerenter", (event) => this.onPointerEnter(event as PointerEvent));
    host.addEventListener("pointerdown", (event) => this.onPointerDownHost(event as PointerEvent));
    host.addEventListener("pointermove", (event) => this.onPointerMoveHost(event as PointerEvent));
    host.addEventListener("pointerup", (event) => this.onPointerEndHost(event as PointerEvent, false));
    host.addEventListener("pointercancel", (event) => this.onPointerEndHost(event as PointerEvent, true));
    host.addEventListener("pointerleave", () => this.hideEraserCursor());
    host.addEventListener("wheel", (event) => this.onWheel(event as WheelEvent), { passive: false });
  }

  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY < 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP));
  }

  private toPoint(event: InkPointerSample, rect: DOMRect): InkPoint {
    const pressure = event.pressure > 0 ? event.pressure : this.lastPoint?.pressure ?? 0.5;
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
      pressure,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: penSampleTimeMillis(event),
    };
  }

  // ----------------------------------------------------------------- input

  private editingLocked(): boolean {
    return this.mode !== "editing" || !this.canEdit() || !this.writerHeld;
  }

  private onPointerEnter(event: PointerEvent): void {
    if (event.pointerType === "touch" || this.editingLocked() || this.state.tool !== "eraser") return;
    this.updateEraserCursor(this.toPoint(event, this.inkHost!.getBoundingClientRect()));
  }

  private onPointerDownHost(event: PointerEvent): void {
    if (this.editingLocked() || event.pointerType === "touch") return;
    if (this.activePointerId !== null) this.finalizeInput();
    try {
      this.inkHost!.setPointerCapture(event.pointerId);
    } catch {
      // Capture is best-effort; WebKit can transiently reject a reused pen id.
    }
    this.clearSaveTimer();
    this.activePointerId = event.pointerId;
    const page = this.sidecar!.notebook.pages[this.noteIndex];
    this.interaction = {
      pointerId: event.pointerId,
      pageId: page.id,
      tool: this.state.tool,
      eraserMode: this.state.tool === "eraser" ? this.state.eraserMode : undefined,
      eraserSize: this.state.tool === "eraser" ? this.state.eraserSize : undefined,
    };
    this.tiles?.beginInput();
    this.cancelPendingInkCommitTimer();
    if (isBrushTool(this.state.tool)) this.tiles?.pauseInkCommit();
    const point = this.toPoint(event, this.inkHost!.getBoundingClientRect());
    this.lastPoint = point;
    this.penSampleIntervals = [];
    if (this.state.tool === "eraser") {
      if (this.eraseAt(point, page)) this.requestRender();
      return;
    }
    if (this.state.tool === "lasso") {
      const bounds = selectionBounds(page.strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id)));
      if (bounds && point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY) {
        const strokes = page.strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id));
        const before = new Map(strokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
        this.lassoDrag = { start: point, pageId: page.id, strokes, before, bounds, dx: 0, dy: 0 };
      } else {
        this.selectedStrokeIds.clear();
        this.lassoPath = [point];
        this.drawSelection();
      }
      return;
    }
    const brush = this.brushSettings();
    this.activeStroke = {
      id: newId("stroke"),
      pageId: page.id,
      tool: this.state.tool,
      color: brush.color,
      width: brush.width,
      opacity: brush.opacity,
      points: [point],
      dynamics: this.state.tool === "pen" ? {
        taper: this.state.pen.taper ?? 0,
        pressure: this.state.pen.pressureGain ?? 100,
        speed: this.state.pen.speedGain ?? 0,
        pressureCurve: this.state.pen.pressureCurve ? this.state.pen.pressureCurve.map((point) => [...point]) : undefined,
      } : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.workerStrokePointIndex = 1;
    if (this.state.tool === "pen") this.startPenCapture(point);
    this.queueWorkerOperation({
      type: "start-stroke",
      pageId: page.id,
      stroke: { ...this.activeStroke, points: [{ ...point }] },
      previewWidth: this.canvasLogicalWidth,
      previewHeight: this.canvasLogicalHeight,
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.sidecar!.notebook.updatedAt,
    });
    page.strokes.push(this.activeStroke);
    this.requestRender();
  }

  private onPointerMoveHost(event: PointerEvent): void {
    if (this.activePointerId === null || event.pointerId !== this.activePointerId || this.editingLocked()) return;
    const interaction = this.interaction;
    if (!interaction) return;
    const rect = this.inkHost!.getBoundingClientRect();
    for (const sample of pointerSamplesOf(event)) {
      if (sample.pointerId !== this.activePointerId) continue;
      const point = this.toPoint(sample, rect);
      if (interaction.tool === "eraser") {
        this.updateEraserCursor(point);
        const page = this.sidecar!.notebook.pages[this.noteIndex];
        if (this.eraseAt(point, page)) this.requestRender();
        continue;
      }
      if (interaction.tool === "lasso") {
        this.applyLassoPoint(point);
        this.drawSelection();
        continue;
      }
      const stroke = this.activeStroke;
      if (!stroke) continue;
      const previous = stroke.points[stroke.points.length - 1];
      if (distance(point, previous) < 0.001) continue;
      this.penSampleIntervals.push(Math.max(0, point.t - previous.t));
      if (this.penCapture && !this.penCapture.fallback) {
        this.appendModeledPoint(point);
      } else {
        clampLiftPressure(point, previous);
        stroke.points.push(point);
        stroke.updatedAt = Date.now();
      }
      this.requestRender();
    }
    // Predicted (speculative) tip points from the host: render-only ghost,
    // never stored; dropped when the real tail takes over at lift.
    const predicted = typeof event.getPredictedEvents === "function" ? event.getPredictedEvents() : [];
    this.predictedTip = predicted.length ? predicted.map((s) => this.toPoint(s, rect)) : null;
    if (this.predictedTip) this.requestRender();
  }

  private onPointerEndHost(event: PointerEvent, _cancelled: boolean): void {
    if (this.activePointerId === event.pointerId) this.predictedTip = null;
    if (this.activePointerId === null || event.pointerId !== this.activePointerId) return;
    try {
      this.inkHost?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    this.finalizeInput();
  }

  private applyLassoPoint(point: InkPoint): void {
    if (this.lassoDrag) {
      const bounds = this.lassoDrag.bounds;
      const dx = constrainDelta(point.x - this.lassoDrag.start.x, bounds?.minX ?? 0, bounds?.maxX ?? 1);
      const dy = constrainDelta(point.y - this.lassoDrag.start.y, bounds?.minY ?? 0, bounds?.maxY ?? 1);
      if (dx === this.lassoDrag.dx && dy === this.lassoDrag.dy) return;
      this.lassoDrag.dx = dx;
      this.lassoDrag.dy = dy;
      return;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance(point, previous) < 0.001) return;
    this.lassoPath.push(point);
  }

  /**
   * Commit the active interaction. Runs on pointerup/pointercancel and before
   * page switches, mode changes, and view close — like InkView, a stroke that
   * already reached the model is always finished, never discarded.
   */
  private finalizeInput(): void {
    const interaction = this.interaction;
    if (this.activePointerId === null && !interaction) return;
    const pointerId = this.activePointerId;
    if (pointerId !== null) {
      try {
        this.inkHost?.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
    }
    this.flushPenCapture();
    this.predictedTip = null;
    this.interaction = null;
    this.activePointerId = null;
    if (interaction) {
      const page = this.sidecar?.notebook.pages.find((candidate) => candidate.id === interaction.pageId) ?? null;
      if (page) {
        this.flushWorkerStrokePoints();
        if (interaction.tool === "lasso") this.finishLasso(page);
        else if (interaction.tool === "eraser") this.finishEraser(page);
        else if (this.activeStroke) this.finishBrushStroke(page);
      }
    }
    this.activeStroke = null;
    this.workerStrokePointIndex = 0;
    this.lastPoint = null;
    this.penCapture = null;
    this.hideEraserCursor();
    this.tiles?.resumeInkCommit();
    if (this.pendingInkStrokes.length > 0) this.schedulePendingInkCommit();
    this.scheduleSave();
    this.updateHistoryButtons();
  }

  private finishBrushStroke(page: InkPage): void {
    const stroke = this.activeStroke!;
    this.markSidecarChanged();
    if (!this.pendingInkStrokes.includes(stroke)) this.pendingInkStrokes.push(stroke);
    this.pendingInkPageId = page.id;
    this.queueWorkerOperation({
      type: "complete-stroke",
      pageId: page.id,
      strokeId: stroke.id,
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.sidecar!.notebook.updatedAt,
    });
    this.pushCommand({
      undo: () => this.removeStrokeById(page, stroke.id),
      redo: () => this.restoreStroke(page, stroke),
    });
  }

  private finishEraser(page: InkPage): void {
    if (this.erasedStrokes.length === 0) return;
    this.markSidecarChanged();
    const erased = this.erasedStrokes;
    const replacements = this.eraserReplacements;
    const replacementIds = new Set(replacements.map((stroke) => stroke.id));
    this.queueWorkerOperation({
      type: "patch-strokes",
      pageId: page.id,
      upsert: replacements.map(cloneStroke),
      remove: [...new Set([...erased.map((stroke) => stroke.id), ...replacementIds])],
      deletedStrokeIds: [...page.deletedStrokeIds],
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.sidecar!.notebook.updatedAt,
    });
    this.pushCommand({
      undo: () => {
        page.strokes = page.strokes.filter((stroke) => !replacementIds.has(stroke.id));
        page.strokes.push(...erased.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        page.deletedStrokeIds = page.deletedStrokeIds.filter((id) => !erased.some((stroke) => stroke.id === id) && !replacementIds.has(id));
        this.afterStrokeHistory(page);
      },
      redo: () => {
        page.strokes = page.strokes.filter((stroke) => !erased.some((candidate) => candidate.id === stroke.id));
        page.strokes.push(...replacements.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        for (const stroke of erased) if (!page.deletedStrokeIds.includes(stroke.id)) page.deletedStrokeIds.push(stroke.id);
        this.afterStrokeHistory(page);
      },
    });
    this.erasedStrokes = [];
    this.eraserReplacements = [];
    this.erasedCandidateIds.clear();
    this.erasedStrokeIds.clear();
    this.eraserReplacementIds.clear();
  }

  private finishLasso(page: InkPage): void {
    if (this.lassoDrag) {
      const drag = this.lassoDrag;
      this.lassoDrag = null;
      if (drag.dx !== 0 || drag.dy !== 0) {
        this.markSidecarChanged();
        const dx = drag.dx;
        const dy = drag.dy;
        for (const stroke of drag.strokes) {
          stroke.points = translatePoints(stroke.points, dx, dy);
          stroke.updatedAt = Date.now();
        }
        this.queueWorkerOperation({
          type: "translate-strokes",
          pageId: page.id,
          strokeIds: drag.strokes.map((stroke) => stroke.id),
          dx,
          dy,
          pageUpdatedAt: page.updatedAt,
          notebookUpdatedAt: this.sidecar!.notebook.updatedAt,
        });
        const ids = new Set(drag.strokes.map((stroke) => stroke.id));
        this.pushCommand({
          undo: () => {
            for (const stroke of page.strokes) {
              if (!ids.has(stroke.id)) continue;
              const original = drag.before.get(stroke.id);
              if (original) stroke.points = clonePoints(original);
              stroke.updatedAt = Date.now();
            }
            this.afterStrokeHistory(page);
          },
          redo: () => {
            for (const stroke of page.strokes) {
              if (!ids.has(stroke.id)) continue;
              stroke.points = translatePoints(drag.before.get(stroke.id) ?? stroke.points, dx, dy);
              stroke.updatedAt = Date.now();
            }
            this.afterStrokeHistory(page);
          },
        });
      }
    } else if (this.lassoPath.length > 2) {
      this.selectedStrokeIds = new Set(
        page.strokes.filter((stroke) => stroke.points.some((point) => pointInPolygon(point, this.lassoPath))).map((stroke) => stroke.id),
      );
    }
    this.lassoPath = [];
    this.drawSelection();
  }

  private afterStrokeHistory(page: InkPage): void {
    this.markSidecarChanged();
    this.queueWorkerOperation({
      type: "patch-strokes",
      pageId: page.id,
      upsert: page.strokes.map(cloneStroke),
      remove: [],
      deletedStrokeIds: [...page.deletedStrokeIds],
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.sidecar!.notebook.updatedAt,
    });
    this.renderAll();
  }

  private removeStrokeById(page: InkPage, strokeId: string): void {
    page.strokes = page.strokes.filter((stroke) => stroke.id !== strokeId);
    if (!page.deletedStrokeIds.includes(strokeId)) page.deletedStrokeIds.push(strokeId);
    this.afterStrokeHistory(page);
  }

  private restoreStroke(page: InkPage, stroke: InkStroke): void {
    page.deletedStrokeIds = page.deletedStrokeIds.filter((id) => id !== stroke.id);
    if (!page.strokes.some((candidate) => candidate.id === stroke.id)) page.strokes.push(cloneStroke(stroke));
    this.afterStrokeHistory(page);
  }

  // --------------------------------------------------------------- eraser

  /** Mirrors InkView.eraseAt: id-tracked so one drag can re-erase replacements. */
  private eraseAt(point: InkPoint, page: InkPage): boolean {
    const mode = this.interaction?.eraserMode ?? this.state.eraserMode;
    const size = this.interaction?.eraserSize ?? this.state.eraserSize;
    const radius = mode === "stroke" ? STROKE_ERASER_HIT_RADIUS : size / 2;
    const indexed = this.tiles?.queryNear(point, radius) ?? page.strokes;
    const candidates = [...new Map([...indexed, ...this.eraserReplacements].map((stroke) => [stroke.id, stroke])).values()]
      .filter((stroke) => !this.erasedCandidateIds.has(stroke.id));
    const removed = candidates.filter((stroke) => strokeIntersectsEraser(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight));
    if (removed.length === 0) return false;
    for (const stroke of removed) {
      this.erasedCandidateIds.add(stroke.id);
      if (!this.eraserReplacementIds.has(stroke.id) && !this.erasedStrokeIds.has(stroke.id)) {
        this.erasedStrokeIds.add(stroke.id);
        this.erasedStrokes.push(cloneStroke(stroke));
      }
      if (this.eraserReplacementIds.delete(stroke.id)) {
        this.eraserReplacements = this.eraserReplacements.filter((candidate) => candidate.id !== stroke.id);
      }
      page.strokes = page.strokes.filter((candidate) => candidate.id !== stroke.id);
      page.deletedStrokeIds.push(stroke.id);
    }
    if (mode !== "stroke") {
      const now = Date.now();
      for (const stroke of removed) {
        for (const points of eraseStrokeSegments(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight)) {
          if (points.length === 0) continue;
          const replacement = { ...cloneStroke(stroke), id: newId("stroke"), points, createdAt: now, updatedAt: now };
          page.strokes.push(replacement);
          this.eraserReplacementIds.add(replacement.id);
          this.eraserReplacements.push(cloneStroke(replacement));
        }
      }
      page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    }
    this.tiles?.patchStrokes(this.eraserReplacements, removed.map((stroke) => stroke.id), page.strokes);
    return true;
  }

  private updateEraserCursor(point: InkPoint): void {
    if (!this.eraserCursor) return;
    const size = this.state.eraserSize * this.zoom;
    this.eraserCursor.setCssStyles({
      display: "block",
      width: `${size}px`,
      height: `${size}px`,
      // CSS centers the cursor with translate(-50%, -50%), so position the
      // top-left at the raw point instead of pre-subtracting half the size.
      left: `${point.x * this.canvasLogicalWidth * this.zoom}px`,
      top: `${point.y * this.canvasLogicalHeight * this.zoom}px`,
    });
  }

  private hideEraserCursor(): void {
    this.eraserCursor?.setCssStyles({ display: "none" });
  }

  // ------------------------------------------------------------------- pen

  private startPenCapture(point: InkPoint): void {
    const sparse = this.isSparsePenInput();
    if ((this.state.pen.smooth ?? 0) <= 0 && !sparse) return;
    const modeler = new StrokeModeler(strokeModelParamsForSmoothStrength((this.state.pen.smooth ?? 0) > 0 ? this.state.pen.smooth! : 100));
    this.penCapture = {
      modeler,
      pageWidth: this.canvasLogicalWidth,
      pageHeight: this.canvasLogicalHeight,
      lastInput: null,
      fallback: false,
    };
    this.feedPenCapture("down", point);
  }

  private appendModeledPoint(point: InkPoint): void {
    this.feedPenCapture("move", point);
  }

  private feedPenCapture(type: StrokeModelInput["eventType"], point: InkPoint): void {
    const capture = this.penCapture;
    const stroke = this.activeStroke;
    if (!capture || !stroke) return;
    const input: StrokeModelInput = {
      eventType: type,
      position: { x: point.x * capture.pageWidth, y: point.y * capture.pageHeight },
      time: point.t / 1000,
      pressure: point.pressure,
      tiltX: point.tiltX,
      tiltY: point.tiltY,
    };
    if (capture.lastInput && input.time < capture.lastInput.time) input.time = capture.lastInput.time;
    try {
      const results: StrokeModelResult[] = capture.modeler.update(input);
      capture.lastInput = input;
      for (const result of results) {
        const normalized: InkPoint = {
          x: result.position.x / capture.pageWidth,
          y: result.position.y / capture.pageHeight,
          pressure: result.pressure ?? point.pressure,
          tiltX: result.tiltX,
          tiltY: result.tiltY,
          t: result.time * 1000,
        };
        const previous = stroke.points[stroke.points.length - 1];
        if (previous && distance(normalized, previous) < 0.0004) continue;
        stroke.points.push(normalized);
      }
      stroke.updatedAt = Date.now();
    } catch {
      capture.fallback = true;
      if (!stroke.points.some((candidate) => candidate.x === point.x && candidate.y === point.y)) stroke.points.push(point);
    }
  }

  private flushPenCapture(): void {
    const capture = this.penCapture;
    const stroke = this.activeStroke;
    if (!capture || capture.fallback || !stroke) return;
    if (!capture.modeler.strokeInProgress) return;
    // Synthesize the missing up so the modeler releases the stroke cleanly.
    const last = stroke.points[stroke.points.length - 1];
    if (last) this.feedPenCapture("up", last);
  }

  /** Sparse input streams get modeling even with smoothing off (mirrors InkView). */
  private isSparsePenInput(): boolean {
    if (this.penSampleIntervals.length < 8) return false;
    const recent = [...this.penSampleIntervals.slice(-32)].sort((left, right) => left - right);
    return recent[Math.floor(recent.length / 2)] > 24;
  }

  private flushWorkerStrokePoints(): void {
    const stroke = this.activeStroke;
    if (!stroke || !isBrushTool(stroke.tool)) return;
    if (this.workerStrokePointIndex >= stroke.points.length) return;
    const points = packStrokePoints(stroke.points, this.workerStrokePointIndex);
    this.workerStrokePointIndex = stroke.points.length;
    this.queueWorkerOperation({
      type: "append-stroke-points",
      pageId: stroke.pageId,
      strokeId: stroke.id,
      points,
      previewWidth: this.canvasLogicalWidth,
      previewHeight: this.canvasLogicalHeight,
      pageUpdatedAt: stroke.updatedAt,
      notebookUpdatedAt: this.sidecar!.notebook.updatedAt,
    }, [points.buffer]);
  }

  // -------------------------------------------------------------- previews

  private requestRender(resize = false): void {
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      if (resize) this.layoutPage();
      if (this.activeStroke) this.drawPreview();
      this.drawSelection();
    });
  }

  private resizeSelectionCanvas(): void {
    if (!this.selectionCanvas || !this.selectionCtx) return;
    this.resizeOverlay(this.selectionCanvas, this.selectionCtx, 4_000_000);
  }

  private resizePreviewCanvas(): void {
    if (!this.previewCanvas || !this.previewCtx) return;
    this.resizeOverlay(this.previewCanvas, this.previewCtx, 12_000_000);
  }

  private resizeOverlay(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, maxPixels: number): void {
    const { x, y, width, height } = this.viewport;
    const resolution = canvasResolution(width, height, window.devicePixelRatio || 1, this.zoom, maxPixels);
    if (canvas.width !== resolution.width) canvas.width = resolution.width;
    if (canvas.height !== resolution.height) canvas.height = resolution.height;
    canvas.setCssStyles({
      left: `${x * this.zoom}px`,
      top: `${y * this.zoom}px`,
      width: `${width * this.zoom}px`,
      height: `${height * this.zoom}px`,
    });
    const scaleX = resolution.width / width;
    const scaleY = resolution.height / height;
    ctx.setTransform(scaleX, 0, 0, scaleY, -x * scaleX, -y * scaleY);
  }

  private drawSelection(): void {
    if (!this.selectionCtx || !this.selectionCanvas) return;
    const ctx = this.selectionCtx;
    const width = this.canvasLogicalWidth;
    const height = this.canvasLogicalHeight;
    ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    if (this.mode !== "editing") return;
    ctx.save();
    ctx.strokeStyle = "#2f80ed";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    if (this.lassoPath.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.lassoPath[0].x * width, this.lassoPath[0].y * height);
      for (const point of this.lassoPath.slice(1)) ctx.lineTo(point.x * width, point.y * height);
      ctx.closePath();
      ctx.stroke();
    }
    if (this.lassoDrag?.bounds) {
      const bounds = this.lassoDrag.bounds;
      ctx.strokeRect((bounds.minX + this.lassoDrag.dx) * width, (bounds.minY + this.lassoDrag.dy) * height,
        (bounds.maxX - bounds.minX) * width, (bounds.maxY - bounds.minY) * height);
    }
    ctx.restore();
  }

  /**
   * Live stroke preview: renders the whole stroke each frame. InkView refines
   * this with worker outlines; the PDF view keeps v1 simple because PDF pages
   * are point-sized (≈600-800 logical px) and typical annotation strokes are
   * short, so the per-frame outline cost stays negligible.
   */
  private drawPreview(): void {
    if (!this.previewCtx) return;
    const ctx = this.previewCtx;
    const stroke = this.activeStroke;
    ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    if (!stroke || !isBrushTool(stroke.tool)) return;
    this.previewCanvas?.toggleClass("is-highlighter-preview", stroke.tool === "highlighter");
    drawInkStroke(ctx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.drawPredictedGhostTip(ctx, stroke);
  }

  /** Draws the predicted tip as a tapering ghost: continuous with the stroke
   *  at the junction (deep black), fading to faint at the predicted position.
   *  Preview-layer only; the stored stroke never includes these points. */
  private drawPredictedGhostTip(ctx: CanvasRenderingContext2D, stroke: InkStroke): void {
    if (!this.predictedTip || this.predictedTip.length === 0 || !this.lastPoint) return;
    const gain = clampPercent(stroke.dynamics?.pressure, 100) / 100;
    const mapped = samplePressureCurve(this.lastPoint.pressure, normalizePressureCurve(stroke.dynamics?.pressureCurve));
    const baseHalf = Math.max(0.6, (stroke.width * (0.55 + 0.75 * (0.5 + (mapped - 0.5) * gain))) / 2);
    let previous = { x: this.lastPoint.x * this.canvasLogicalWidth, y: this.lastPoint.y * this.canvasLogicalHeight };
    const segments = this.predictedTip.length;
    for (let index = 0; index < segments; index++) {
      const point = { x: this.predictedTip[index].x * this.canvasLogicalWidth, y: this.predictedTip[index].y * this.canvasLogicalHeight };
      const progress = (index + 1) / segments;
      ctx.globalAlpha = stroke.opacity * (0.6 - 0.45 * progress);
      ctx.lineWidth = Math.max(0.5, baseHalf * 2 * (1 - 0.45 * progress));
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      previous = point;
    }
    ctx.globalAlpha = 1;
  }

  private schedulePendingInkCommit(): void {
    if (this.pendingInkStrokes.length === 0) return;
    this.cancelPendingInkCommitTimer();
    this.inkCommitTimer = window.setTimeout(() => {
      this.inkCommitTimer = undefined;
      this.startPendingInkCommit();
    }, INK_COMMIT_IDLE_DELAY);
  }

  private cancelPendingInkCommitTimer(): void {
    if (this.inkCommitTimer === undefined) return;
    window.clearTimeout(this.inkCommitTimer);
    this.inkCommitTimer = undefined;
  }

  private startPendingInkCommit(): void {
    const page = this.sidecar?.notebook.pages[this.noteIndex];
    if (!page || !this.tiles || this.activePointerId !== null || this.committingInkStrokes
      || this.pendingInkStrokes.length === 0 || this.pendingInkPageId !== page.id) return;
    const batch = [...this.pendingInkStrokes];
    this.committingInkStrokes = batch;
    this.tiles.patchStrokes(batch, [], page.strokes);
    this.tiles.commitInk(batch, this.viewport, (window.devicePixelRatio || 1) * this.zoom, (committed) => {
      if (this.committingInkStrokes !== batch) return;
      this.committingInkStrokes = null;
      if (!committed) {
        this.tiles?.removeStrokes(batch.map((stroke) => stroke.id));
        if (this.activePointerId === null) this.schedulePendingInkCommit();
        return;
      }
      const ids = new Set(batch.map((stroke) => stroke.id));
      this.pendingInkStrokes = this.pendingInkStrokes.filter((stroke) => !ids.has(stroke.id));
      if (this.pendingInkStrokes.length === 0) this.pendingInkPageId = null;
      this.previewCtx?.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
      if (this.pendingInkStrokes.length > 0) this.schedulePendingInkCommit();
    });
  }

  private discardPendingInkPreview(): void {
    this.cancelPendingInkCommitTimer();
    this.committingInkStrokes = null;
    this.pendingInkStrokes = [];
    this.pendingInkPageId = null;
    this.tiles?.cancelInkCommit();
    if (this.previewCanvas) this.previewCanvas.width = 1;
  }

  // ----------------------------------------------------------- undo / redo

  private pushCommand(command: EditCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.updateHistoryButtons();
  }

  private redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo();
    this.undoStack.push(command);
    this.updateHistoryButtons();
  }

  // --------------------------------------------------------------- saving

  private markSidecarChanged(): void {
    if (!this.sidecar) return;
    this.sidecar.updatedAt = Date.now();
    this.sidecar.notebook.updatedAt = this.sidecar.updatedAt;
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.dirty || !this.sidecar) return;
    this.clearSaveTimer();
    const now = Date.now();
    if (this.saveMaxDue < now) this.saveMaxDue = now + SAVE_MAX_DELAY;
    const delay = Math.min(SAVE_IDLE_DELAY, Math.max(0, this.saveMaxDue - now));
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.flushSaveNow().then((outcome) => {
        if (outcome.status === "saved") this.setStatus("");
        else this.setStatus(`Save ${outcome.status}: ${outcome.message}`, true);
      });
    }, delay);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer === undefined) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }

  /**
   * Sidecar save: CAS write with bounded merge retries. Callers gate mode
   * switches and view close on the returned outcome; a save in flight is
   * awaited, and newer changes trigger a follow-up flush.
   */
  async flushSaveNow(): Promise<SaveOutcome> {
    if (!this.dirty || !this.sidecar || !this.sidecarFile) return { status: "saved" };
    if (this.activeSave) {
      this.saveRequested = true;
      const previous = await this.activeSave;
      if (previous.status !== "saved") return previous;
      if (!this.dirty) return { status: "saved" };
    }
    const save = this.performSave()
      .catch((error): SaveOutcome => ({ status: "failed", message: messageOf(error) }))
      .finally(() => { this.activeSave = null; });
    this.activeSave = save;
    const outcome = await save;
    if (this.saveRequested) {
      this.saveRequested = false;
      if (outcome.status === "saved" && this.dirty) return this.flushSaveNow();
    }
    return outcome;
  }

  private async performSave(): Promise<SaveOutcome> {
    let latestRaw = this.sidecarRaw;
    for (let attempt = 0; attempt <= SAVE_CONFLICT_RETRIES; attempt++) {
      const next = { ...this.sidecar!, updatedAt: Date.now() };
      const nextRaw = serializeSidecar(next);
      if (await this.store.writeIfUnchanged(this.sidecarFile!, this.sidecarRaw, nextRaw)) {
        this.sidecarRaw = nextRaw;
        this.sidecar = next;
        this.dirty = false;
        return { status: "saved" };
      }
      // CAS mismatch: re-read, merge, retry. Unreadable or foreign content
      // stops the overwrite and produces a conflict copy with the local ink.
      try {
        latestRaw = await this.store.readRaw(this.sidecarFile!);
      } catch (error) {
        return { status: "failed", message: messageOf(error) };
      }
      let latest: PdfSidecar;
      try {
        latest = normalizeSidecar(JSON.parse(latestRaw));
      } catch {
        return this.saveConflictCopy(latestRaw, "the notes file on disk is corrupt or uses an unknown format");
      }
      if (latest.source.sha256 !== this.sidecar!.source.sha256 || latest.source.byteLength !== this.sidecar!.source.byteLength) {
        return this.saveConflictCopy(latestRaw, "the notes file on disk belongs to a different PDF revision");
      }
      try {
        const merged = mergeSidecars(latest, this.sidecar!);
        const mergedRaw = serializeSidecar(merged);
        if (await this.store.writeIfUnchanged(this.sidecarFile!, latestRaw, mergedRaw)) {
          this.sidecarRaw = mergedRaw;
          this.sidecar = merged;
          this.dirty = false;
          this.syncNotebookToWorker();
          return { status: "saved" };
        }
      } catch (error) {
        return this.saveConflictCopy(latestRaw, messageOf(error));
      }
    }
    // The file kept changing underneath us: keep the local ink in a conflict
    // copy instead of racing further.
    return this.saveConflictCopy(latestRaw, `the notes file kept changing for ${SAVE_CONFLICT_RETRIES + 1} attempts`);
  }

  /** Keep local ink in a conflict copy; never clobber the file on disk. */
  private async saveConflictCopy(diskRaw: string, reason: string): Promise<SaveOutcome> {
    try {
      const conflictPath = `${this.sidecarFile!.path.replace(/\.pdfink\.json$/, "")}.conflict-${Date.now()}.pdfink.json`;
      const sidecar = { ...this.sidecar!, updatedAt: Date.now() };
      await this.app.vault.create(conflictPath, serializeSidecar(sidecar));
      this.sidecarRaw = diskRaw;
      this.dirty = false;
      new Notice(`Ink Notes kept your notes in ${conflictPath}`);
      return { status: "conflict", message: reason };
    } catch (error) {
      return { status: "failed", message: `${reason}; writing the conflict copy failed: ${messageOf(error)}` };
    }
  }

  // ---------------------------------------------------------------- export

  async exportHandwrittenCopy(): Promise<void> {
    if (!this.file || !this.sidecar) return;
    if (!sidecarHasInk(this.sidecar)) {
      new Notice("This PDF has no handwriting to export yet");
      return;
    }
    const outcome = await this.flushSaveNow();
    if (outcome.status === "failed") {
      new Notice(`Export cancelled: could not save notes (${outcome.message})`);
      return;
    }
    try {
      const bytes = await this.app.vault.readBinary(this.file);
      const output = await exportHandwrittenPdf(bytes, this.sidecar, this.file.basename);
      const target = exportPathFor(this.file.path, (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null);
      await this.app.vault.createBinary(target, output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
      new Notice(`Exported ${target}`);
    } catch (error) {
      if (error instanceof PdfExportError) {
        new Notice(`Export failed: ${error.message}. Your notes are untouched.`);
        return;
      }
      new Notice(`Export failed: ${messageOf(error)}`);
    }
  }

  // ------------------------------------------------------------- rendering

  private cancelPdfRender(): void {
    this.pdfRenderTask?.cancel();
    this.pdfRenderTask = null;
    this.textLayerTask?.cancel?.();
    this.textLayerTask = null;
  }

  private async renderPdfPage(): Promise<void> {
    const canvas = this.pdfCanvas;
    if (!canvas) return;
    const generation = ++this.pdfRenderGeneration;
    this.cancelPdfRender();
    const notePage = this.currentNotePage();
    const display = this.rotatedSize(notePage);
    const scale = (window.devicePixelRatio || 1) * this.zoom;
    canvas.width = Math.max(1, Math.round(display.width * scale));
    canvas.height = Math.max(1, Math.round(display.height * scale));
    canvas.setCssStyles({ width: "100%", height: "100%" });
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!notePage || notePage.sourceIndex === undefined || !this.pdfDoc) {
      // A blank note page: plain paper, ink only.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.textLayer?.empty();
      return;
    }
    try {
      const page = await this.pdfDoc.getPage(notePage.sourceIndex + 1);
      if (generation !== this.pdfRenderGeneration) return;
      const viewport = page.getViewport({ scale });
      const task = page.render({ canvasContext: ctx, viewport });
      this.pdfRenderTask = task;
      await task.promise;
      if (generation !== this.pdfRenderGeneration) return;
      this.pdfRenderTask = null;
    } catch (error) {
      if (this.pdfjs?.RenderingCancelledException && error instanceof this.pdfjs.RenderingCancelledException) return;
      if (generation === this.pdfRenderGeneration) this.setStatus(`Could not render this page: ${messageOf(error)}`, true);
      return;
    }
    if (this.mode === "reading") await this.renderTextLayer(notePage, generation);
  }

  private async renderTextLayer(notePage: PdfSidecarNotePage, generation: number): Promise<void> {
    const container = this.textLayer;
    const pdfjs = this.pdfjs;
    if (!container || !pdfjs || !this.pdfDoc || notePage.sourceIndex === undefined) return;
    container.empty();
    try {
      const page = await this.pdfDoc.getPage(notePage.sourceIndex + 1);
      if (generation !== this.pdfRenderGeneration) return;
      const viewport = page.getViewport({ scale: this.zoom });
      const textContent = await page.getTextContent?.();
      if (!textContent || generation !== this.pdfRenderGeneration) return;
      let task: PdfJsTextLayerTask | null = null;
      if (pdfjs.TextLayer) {
        task = await new pdfjs.TextLayer({ textContentSource: textContent, container, viewport }).render();
      } else if (pdfjs.renderTextLayer) {
        task = pdfjs.renderTextLayer({ textContentSource: textContent, container, viewport });
      }
      if (!task) return;
      this.textLayerTask = task;
      await task.promise;
      if (generation === this.pdfRenderGeneration) this.textLayerTask = null;
    } catch {
      // Text selection is progressive enhancement; rendering errors stay silent.
    }
  }

  private renderAll(): void {
    this.clampNoteIndex();
    this.updatePageIndicator();
    this.updateToolButtons();
    this.updateHistoryButtons();
    const page = this.sidecar?.notebook.pages[this.noteIndex];
    if (page && this.tiles) {
      this.tiles.setPage(page, this.canvasLogicalWidth, this.canvasLogicalHeight);
      this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    }
    this.drawSelection();
  }

  private clampNoteIndex(): void {
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 1;
    this.noteIndex = Math.max(0, Math.min(this.noteIndex, count - 1));
  }

  private resetViewState(): void {
    this.cancelPdfRender();
    this.finalizeInput();
    this.discardPendingInkPreview();
    this.mode = "reading";
    this.releaseWriter();
    this.pdfDoc = null;
    this.sourcePages = [];
    this.noteIndex = 0;
    this.zoom = 1;
    this.writeBlockedReason = null;
    this.pendingRecoveryCandidates = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.clearSaveTimer();
    this.root?.removeClass("ink-pdf-editing");
    this.root?.addClass("ink-pdf-reading");
    this.setStatus("Loading PDF…");
  }

  private setStatus(message: string, isError = false): void {
    if (!this.statusEl) return;
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
    this.statusEl.toggle(message.length > 0);
  }

}

function pointerSamplesOf(event: PointerEvent): InkPointerSample[] {
  const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
  const toSample = (sample: PointerEvent): InkPointerSample => ({
    pointerId: sample.pointerId,
    pointerType: sample.pointerType,
    clientX: sample.clientX,
    clientY: sample.clientY,
    pressure: sample.pressure,
    tiltX: sample.tiltX,
    tiltY: sample.tiltY,
    timeStamp: sample.timeStamp,
  });
  return coalesced.length > 0 ? [...coalesced.map(toSample), toSample(event)] : [toSample(event)];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RecoveryChoiceModal extends SuggestModal<TFile> {
  private chosen = false;

  constructor(app: App, private readonly candidates: TFile[], private readonly choose: (file: TFile | null) => Promise<void>) {
    super(app);
  }

  getSuggestions(query: string): TFile[] {
    const search = query.trim().toLowerCase();
    return this.candidates.filter((file) => !search || file.path.toLowerCase().includes(search));
  }

  renderSuggestion(file: TFile, element: HTMLElement): void {
    element.setText(file.path);
  }

  onChooseSuggestion(file: TFile): void {
    this.chosen = true;
    void this.choose(file);
  }

  onClose(): void {
    super.onClose();
    if (!this.chosen) void this.choose(null);
  }
}
