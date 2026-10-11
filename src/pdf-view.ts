import { App, Notice, Scope, SuggestModal, TFile, WorkspaceLeaf, loadPdfJs, setIcon } from "obsidian";
import { InkNotebook, InkPage, InkTool, createNotebook } from "./model";
import { canvasResolution, drawInkStroke, scaledStroke } from "./rendering";
import { registerDocumentPointerEndEvents } from "./ink-input";
import { InkWritingView } from "./ink-writing";
import type { SharedToolState } from "./tool-state";
import { TileRenderer, cellKeys } from "./tiles";
import { InkWorkerService } from "./worker-service";
import {
  PdfSidecar,
  PdfSidecarFormatError,
  PdfSidecarNotePage,
  PdfSourcePageGeometry,
  deleteBlankNotePage,
  deleteNotePage,
  insertBlankNotePageAt,
  mergeSidecars,
  moveBlankNotePage,
  normalizeSidecar,
  sidecarPathFor,
} from "./pdf-sidecar";
import { PdfSidecarStore, serializeSidecar } from "./pdf-store";
import { PdfExportError, exportHandwrittenPdf, exportPathFor, sidecarHasInk } from "./pdf-export";
import { PdfTabTakeover, hasNativeNavigation } from "./pdf-takeover";
import { paintPageImages } from "./image-library";

export const VIEW_TYPE_PDF_INK = "ink-notes-pdf-view";

const SAVE_CONFLICT_RETRIES = 3;

const PDF_ZOOM_MAX = 3;
const PDF_ZOOM_STEP = 1.2;
const PDF_PAGE_PADDING = 24;
const SELECTION_OVERLAY_BUDGET = 4_000_000;
/** Thumbnail bitmap width in CSS pixels; on a portrait A4 page the pdf.js
 *  render scale for this lands around 0.2. */
const RAIL_THUMB_WIDTH = 120;
/** Coalesces thumbnail repaints while the rail scrolls. */
const RAIL_SWEEP_THROTTLE_MS = 120;
/** After the rail's expand transition (200ms), repaint the visible range at
 *  full resolution; thumbnails skip painting while collapsed. */
const RAIL_REVEAL_DELAY_MS = 230;

export type SaveOutcome = { status: "saved" } | { status: "conflict"; message: string } | { status: "failed"; message: string };

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

interface PdfJsLib {
  getDocument(options: { data: ArrayBuffer }): { promise: Promise<PdfJsDocument> };
  RenderingCancelledException?: new (...args: unknown[]) => Error;
}

/** Fallback model when no sidecar is attached; keeps undo/redo seams safe. */
const EMPTY_NOTEBOOK = createNotebook();

/**
 * Handwriting view for PDF tabs. Reading mode locks editing independently
 * of sidecar fingerprint checks. The PDF page renders
 * with Obsidian's own pdf.js below
 * the shared ink tile pipeline, so strokes persist through the same
 * merge/tombstone machinery as .ink notebooks.
 *
 * The writing pipeline itself (pointer capture, stroke modeling, previews,
 * eraser, lasso, history, save scheduling) is the shared InkWritingView; this
 * class supplies the PDF seams: sidecar storage, page geometry, editing mode
 * and the pdf.js canvas underneath the ink host.
 */
export class PdfInkView extends InkWritingView {
  private store!: PdfSidecarStore;
  private takeover!: PdfTabTakeover;

  private root: HTMLElement | null = null;
  private scroller: HTMLElement | null = null;
  private pageWrap: HTMLElement | null = null;
  private pdfCanvas: HTMLCanvasElement | null = null;
  private inkHost: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private toolbarButtons = new Map<string, HTMLElement>();

  private pdfjs: PdfJsLib | null = null;
  private pdfDoc: PdfJsDocument | null = null;
  private pdfRenderTask: PdfJsRenderTask | null = null;
  private pdfRenderGeneration = 0;
  private loadGeneration = 0;
  private resizeRenderTimer: number | undefined;

  private sidecar: PdfSidecar | null = null;
  private sidecarRaw = "";
  private sidecarFile: TFile | null = null;
  /** Set when fingerprint mismatch or an unreadable sidecar blocks writing. */
  private writeBlockedReason: string | null = null;
  private pendingMergedSidecar: PdfSidecar | null = null;

  private sourcePages: PdfSourcePageGeometry[] = [];
  private noteIndex = 0;
  private pageBaseWidth = 700;
  private pageBaseHeight = 990;
  /** The "smart fit" zoom: width-fill for portrait pages, height-fill when
   *  width-fill would leave the page floating with vertical slack. */
  private fitZoom = 1;
  /** Manual zoom applies only to the currently selected note page. */
  private zoomTouched = false;
  /** Offscreen renders of the neighbouring pages for instant flips. */
  private neighbourCache = new Map<number, HTMLCanvasElement>();
  private prewarmToken = 0;
  private pdfRenderTimer: number | undefined;

  // Page preview rail (behaviour parity with the notebook editor's rail).
  private pageRail: HTMLElement | null = null;
  private railThumbs: HTMLElement | null = null;
  private railCount: HTMLElement | null = null;
  private railActions: HTMLElement | null = null;
  private thumbButtons = new Map<number, HTMLButtonElement>();
  /** Rendered thumbnail bitmaps by note-page index. Deliberately tiny:
   *  entries further than one page from the current page are evicted
   *  (same policy as the neighbour cache), so a hundred-page document
   *  never hoards a hundred thumbnail canvases. */
  private thumbCache = new Map<number, HTMLCanvasElement>();
  private thumbPaintTokens = new Map<number, number>();
  private pendingThumbRenders = new Set<number>();
  /** Note-page id sequence the rail buttons were built for; a mismatch
   *  (page insert/delete/move, new document) triggers a rebuild. */
  private railBuiltIds = "";
  private railSweepTimer: number | undefined;
  private pageManagement = false;
  private selectedPageIds = new Set<string>();

  private dirty = false;
  private editRevision = 0;
  private activeSave: Promise<SaveOutcome> | null = null;
  private zoomTimer: number | undefined;
  private desktopZoomTimer: number | undefined;
  private desktopRenderDensity: number | undefined;
  private pendingRecoveryCandidates: TFile[] | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.scope = new Scope(this.app.scope);
  }

  /** Wired by the plugin right after construction. */
  configure(deps: { store: PdfSidecarStore; workers: InkWorkerService; takeover: PdfTabTakeover; toolState?: SharedToolState }): void {
    this.store = deps.store;
    this.workers = deps.workers;
    this.takeover = deps.takeover;
    if (deps.toolState) this.useSharedToolState(deps.toolState);
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
    // The page rail starts collapsed (like the notebook editor's); the
    // toolbar's Pages toggle reveals it.
    root.addClass("ink-pdf-view", "ink-pdf-editing", "ink-rail-hidden");
    this.root = root;
    this.renderToolbar(root);
    this.statusEl = root.createDiv({ cls: "ink-pdf-status" });
    // The page rail rides left of the page scroller for the whole life of
    // the view (no toggle button - same as the notebook editor's rail).
    const body = root.createDiv({ cls: "ink-pdf-body" });
    this.buildPageRail(body);
    const scroller = body.createDiv({ cls: "ink-pdf-scroller" });
    this.scroller = scroller;
    this.buildZoomHud(body);
    this.pageWrap = scroller.createDiv({ cls: "ink-pdf-page-wrap" });
    this.pdfCanvas = this.pageWrap.createEl("canvas", { cls: "ink-pdf-canvas" });
    this.buildInkHost();
    this.registerDesktopInput();
    this.viewReady = true;
    this.registerDomEvent(scroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(scroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(scroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(scroller, "touchend", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(scroller, "touchcancel", (event) => {
      this.onTouchCancel(event);
    }, { passive: false });
    // Pane operations (splits, drags, sidebar toggles) resize this view
    // without a window resize; stale page geometry there overflowed the pane
    // and mis-mapped strokes for views opened before the split.
    const observer = new ResizeObserver(() => {
      this.brushPopover?.position();
      this.prewarmToken += 1;
      this.neighbourCache.clear();
      this.layoutPage();
      if (this.resizeRenderTimer !== undefined) window.clearTimeout(this.resizeRenderTimer);
      this.resizeRenderTimer = window.setTimeout(() => void this.renderPdfPage(), 100);
    });
    observer.observe(scroller);
    this.register(() => observer.disconnect());
  }

  async onClose(): Promise<void> {
    this.disposeZoomHud();
    this.closePageOptionsMenu();
    this.finishPointerInput(false);
    this.clearSelection();
    this.closeLassoSettings();
    let outcome = await this.flushSaveNow();
    if (outcome.status === "failed" && this.sidecar && this.sidecarFile) {
      outcome = await this.saveConflictCopy(this.sidecarRaw, outcome.message);
    }
    if (outcome.status === "failed") new Notice(`Ink Notes could not save this PDF's latest notes: ${outcome.message}`);
    if (outcome.status === "conflict") new Notice(`Ink Notes kept a conflict copy: ${outcome.message}`);
    this.pendingMergedSidecar = null;
    this.loadGeneration += 1;
    this.cancelPdfRender();
    if (this.pdfRenderTimer !== undefined) { window.clearTimeout(this.pdfRenderTimer); this.pdfRenderTimer = undefined; }
    this.neighbourCache.clear();
    this.clearRailState();
    this.destroySwipeStage();
    this.discardPendingInkPreview();
    this.clearSaveTimers();
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    if (this.zoomTimer !== undefined) window.clearTimeout(this.zoomTimer);
    this.finishDesktopZoom(false);
    this.tiles?.dispose();
    this.tiles = null;
    this.workerSession?.dispose();
    this.workerSession = null;
    void this.pdfDoc?.destroy().catch(() => undefined);
    this.pdfDoc = null;
    this.root = null;
  }

  async onLoadFile(file: TFile): Promise<void> {
    const sourceMtime = file.stat?.mtime;
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
    if (generation === this.loadGeneration && file.stat?.mtime !== sourceMtime) await this.checkSourcePdfRevision();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.finishPointerInput(false);
    this.clearSelection();
    this.closeLassoSettings();
    let outcome: SaveOutcome = { status: "saved" };
    try {
      outcome = await this.flushSaveNow();
      if (outcome.status === "failed" && this.sidecar && this.sidecarFile) {
        outcome = await this.saveConflictCopy(this.sidecarRaw, outcome.message);
      }
      if (outcome.status === "conflict") new Notice(`Ink Notes kept a conflict copy: ${outcome.message}`);
    } catch (error) {
      outcome = { status: "failed", message: messageOf(error) };
    } finally {
      this.clearSaveTimers();
      this.loadGeneration += 1;
      this.cancelPdfRender();
      this.discardPendingInkPreview();
      this.disposeWorkerSession();
      void this.pdfDoc?.destroy().catch(() => undefined);
      this.pdfDoc = null;
      this.sidecar = null;
      this.sidecarFile = null;
      this.writeBlockedReason = null;
      this.pendingMergedSidecar = null;
    }
    if (outcome.status === "failed") throw new Error(`Could not save PDF handwriting: ${outcome.message}`);
  }

  /**
   * Adopt an externally modified sidecar (another device synced new ink).
   * Merge dirty panes too, but defer model replacement until pointer input and
   * tile commits settle. The save path also includes queued peer state.
   */
  async reloadExternalSidecar(changedPath: string): Promise<void> {
    if (!this.sidecar || !this.sidecarFile || this.sidecarFile.path !== changedPath) return;
    const file = this.sidecarFile;
    const generation = this.loadGeneration;
    const raw = await this.store.readRaw(file).catch(() => null);
    if (generation !== this.loadGeneration || this.sidecarFile !== file || !this.sidecar) return;
    if (raw === null || raw === this.sidecarRaw) return;
    try {
      const sidecar = normalizeSidecar(JSON.parse(raw));
      this.receiveMergedSidecar(sidecar);
    } catch {
      // Corrupt external state: keep the in-memory sidecar, never write over it.
    }
  }

  private receiveMergedSidecar(sidecar: PdfSidecar): void {
    if (!this.sidecar || this.writeBlockedReason) return;
    if (sidecar.source.sha256 !== this.sidecar.source.sha256
      || sidecar.source.byteLength !== this.sidecar.source.byteLength) return;
    this.pendingMergedSidecar = this.pendingMergedSidecar
      ? mergeSidecars(this.pendingMergedSidecar, sidecar) : sidecar;
    this.applyPendingMergedNotebook();
  }

  protected applyPendingMergedNotebook(): void {
    if (!this.sidecar || !this.pendingMergedSidecar || this.activePointerId !== null
      || this.pendingInkStrokes.length > 0) return;
    const previous = this.sidecar;
    const selectedId = previous.notePages[this.noteIndex]?.id;
    const merged = mergeSidecars(this.pendingMergedSidecar, previous);
    this.pendingMergedSidecar = null;
    const geometryChanged = JSON.stringify(previous.notePages) !== JSON.stringify(merged.notePages);
    const inkChanged = JSON.stringify(previous.notebook) !== JSON.stringify(merged.notebook);
    this.sidecar = merged;
    if (!geometryChanged && !inkChanged) return;
    this.editRevision += 1; // An older in-flight save cannot mark this model clean.
    const selected = merged.notePages.findIndex((page) => page.id === selectedId);
    this.noteIndex = selected >= 0 ? selected : Math.min(this.noteIndex, merged.notePages.length - 1);
    // Snapshot page commands may include the other pane's ink. Retain the
    // existing external-refresh policy: history restarts at the merged model.
    this.undoStack = [];
    this.redoStack = [];
    this.syncNotebookToWorker();
    this.invalidateThumbnails();
    if (geometryChanged) {
      this.destroySwipeStage();
      this.prewarmToken += 1;
      this.neighbourCache.clear();
      this.layoutPage();
      void this.renderPdfPage();
    }
    this.renderAll();
  }

  // ------------------------------------------------------------------ locks

  /** Exposed for tests and diagnostics: why handwriting is read-only, if so. */
  get writeBlocked(): string | null {
    return this.writeBlockedReason;
  }

  private canEdit(): boolean {
    return this.sidecar !== null && this.writeBlockedReason === null && this.file !== null;
  }

  /** Hand the tab back to the built-in (possibly PDF++-enhanced) viewer. */
  async restoreBuiltinViewer(eState?: unknown): Promise<void> {
    this.finishPointerInput(false);
    const outcome = await this.flushSaveNow();
    if (outcome.status === "failed") {
      new Notice(`Save failed, staying in the handwriting view: ${outcome.message}`);
      return;
    }
    if (!this.file) return;
    this.takeover.suppressLeaf(this.leaf);
    try {
      const sourceIndex = this.sidecar?.notePages[this.noteIndex]?.sourceIndex;
      await this.leaf.setViewState({ type: "pdf", state: { file: this.file.path } },
        eState ?? (sourceIndex === undefined ? undefined : { subpath: `#page=${sourceIndex + 1}` }));
    } catch (error) {
      this.takeover.releaseLeaf(this.leaf);
      new Notice(`Could not return to the PDF viewer: ${messageOf(error)}`);
    }
  }

  setEphemeralState(state: unknown): void {
    // openLinkText can reuse an existing ink leaf without another setViewState call.
    // Host focus delivery on open/refocus must not return the tab to native PDF.
    if (hasNativeNavigation(state)) {
      void this.restoreBuiltinViewer(state);
    }
  }

  async checkSourcePdfRevision(): Promise<void> {
    const file = this.file;
    const sidecar = this.sidecar;
    const generation = this.loadGeneration;
    if (!file || !sidecar) return;
    try {
      const bytes = await this.app.vault.readBinary(file);
      const fingerprint = await this.store.computeFingerprint(bytes);
      if (generation !== this.loadGeneration || this.file?.path !== file.path) return;
      if (fingerprint.sha256 !== sidecar.source.sha256 || fingerprint.byteLength !== sidecar.source.byteLength) this.sourcePdfModified();
    } catch (error) {
      if (generation === this.loadGeneration) this.setStatus(`Could not check the updated PDF: ${messageOf(error)}`, true);
    }
  }

  /** An external editor changed the source; old ink coordinates belong to the old revision. */
  sourcePdfModified(): void {
    if (!this.sidecar) return;
    this.finishPointerInput(false);
    this.writeBlockedReason = `The source PDF changed. Reopen it to check the notes against the new revision.${
      this.dirty ? " Unsaved notes will be kept in a conflict copy if you close this tab." : ""}`;
    this.updateToolButtons();
    this.setStatus(this.writeBlockedReason, true);
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
    this.pendingMergedSidecar = null;
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
    const session = this.workers!.createSession(() => ({ notebook: this.sidecar!.notebook, revision: this.workerRevision }));
    this.workerSession = session;
    if (session.canRenderTiles()) this.tiles?.setBackend(session, (error) => {
      if (this.workerSession === session) this.disableWorkerSession(error);
    });
    void session.initializeRaw(JSON.stringify(this.sidecar.notebook), this.workerRevision).catch((error) => this.disableWorkerSession(error));
  }

  private disposeWorkerSession(): void {
    this.tiles?.setBackend(null);
    this.workerSession?.dispose();
    this.workerSession = null;
  }

  private syncNotebookToWorker(): void {
    if (!this.sidecar) return;
    this.workerRevision += 1;
    void this.workerSession?.apply(this.workerRevision, { type: "replace-notebook", notebook: this.sidecar.notebook }).catch((error) => this.disableWorkerSession(error));
  }

  // -------------------------------------------------------------- toolbar

  private renderToolbar(root: HTMLElement): void {
    const toolbar = root.createDiv({ cls: "ink-pdf-toolbar" });

    const start = toolbar.createDiv({ cls: "ink-toolbar-start" });
    const pagesGroup = this.addToolbarSection(start, "Pages");
    const toggle = this.addIconButton(pagesGroup, "panel-left", "Pages", () => {
      const hidden = !this.root?.hasClass("ink-rail-hidden");
      this.root?.toggleClass("ink-rail-hidden", hidden);
      toggle.setAttribute("aria-pressed", String(!hidden));
      // Thumbnails skip painting while the rail is collapsed; repaint the
      // visible range once the expand transition has revealed them.
      if (!hidden) window.setTimeout(() => this.paintVisibleThumbnails(), RAIL_REVEAL_DELAY_MS);
    });
    toggle.setAttribute("aria-pressed", String(!this.root?.hasClass("ink-rail-hidden")));
    this.buildWritingSections(toolbar, start);
    const indicator = start.createDiv({ cls: "ink-pdf-page-indicator" });
    indicator.setText("–");
    this.toolbarButtons.set("indicator", indicator);

    const docGroup = this.addToolbarSection(toolbar, "Document");
    this.buildReadingModeButton(docGroup);
    this.addTrackedIconButton(docGroup, "add-page", "plus", "Add page", (event) => {
      if (this.sidecar) this.openPageInsertMenu(event, this.noteIndex, this.sidecar.notePages.length,
        (index) => this.addBlankPage(index));
    });
    // Menu and export respond regardless of editing availability: the menu's
    // mutating items fail with a notice when read-only, and export only
    // reads. A silently dead button is indistinguishable from a broken one.
    this.addTrackedIconButton(docGroup, "export", "download", "Export PDF with handwriting", () => void this.exportHandwrittenCopy());
    this.addTrackedIconButton(docGroup, "pages", "more-horizontal", "Page options", (event) => this.openPageMenu(event));
    this.toolbarButtons.get("add-page")?.classList.add("ink-edit-only");
    this.toolbarButtons.get("pages")?.classList.add("ink-edit-only");

    this.updateToolButtons();
    this.updateHistoryButtons();
    this.updatePageIndicator();
  }

  private addTrackedIconButton(parent: HTMLElement, key: string, icon: string, label: string, onClick: (event: MouseEvent) => void, disabled = false): void {
    const button = this.addIconButton(parent, icon, label, onClick, disabled);
    this.toolbarButtons.set(key, button);
  }
  /** Scopes the PDF-surface popover rules (paper canvases, spacing). */
  protected brushPopoverExtraClass(): string {
    return "ink-pdf-brush-popover";
  }

  private updatePageIndicator(): void {
    const indicator = this.toolbarButtons.get("indicator");
    if (!indicator) return;
    indicator.setText(this.sidecar
      ? `${this.noteIndex + 1} / ${this.sidecar.notePages.length}`
      : this.pdfDoc ? `${this.noteIndex + 1} / ?` : "–");
  }

  // ---------------------------------------------------------- page preview rail

  /**
   * The always-on page rail: one thumbnail per note page, the current page
   * highlighted, click to jump (behaviour parity with the notebook editor's
   * page rail). Thumbnails render the underlying pdf.js page at thumbnail
   * scale on demand - the visible range first - so opening a fifty-page
   * document does not render fifty pages.
   */
  private buildPageRail(body: HTMLElement): void {
    const rail = body.createDiv({ cls: "ink-page-rail", attr: { "aria-label": "PDF pages" } });
    this.pageRail = rail;
    const header = rail.createDiv({ cls: "ink-rail-header" });
    header.createDiv({ cls: "ink-rail-heading", text: "Pages" });
    this.railCount = header.createSpan({ cls: "ink-rail-count" });
    this.railActions = rail.createDiv({ cls: "ink-rail-actions", attr: { role: "group", "aria-label": "Page management" } });
    this.renderPageRailActions();
    this.railThumbs = rail.createDiv({ cls: "ink-rail-thumbs" });
    // Scrolling long documents brings new thumbnails into view; repaint the
    // fresh range (throttled) instead of pre-rendering every page.
    this.registerDomEvent(rail, "scroll", () => this.scheduleRailSweep(), { passive: true });
  }

  /** Re-syncs the rail with the model: rebuilds the buttons when the page
   *  sequence changed, moves the highlight, and repaints what is on screen. */
  private refreshPageRail(): void {
    const thumbs = this.railThumbs;
    if (!thumbs) return;
    const pages = this.sidecar?.notePages;
    const count = pages?.length ?? this.pdfDoc?.numPages ?? 0;
    if (count <= 0) {
      thumbs.empty();
      this.thumbButtons.clear();
      this.railBuiltIds = "";
      if (this.railCount) this.railCount.textContent = "–";
      return;
    }
    // Page ids are stable across reorders, so an id-sequence mismatch catches
    // exactly the changes that shift thumbnails between indexes.
    const ids = pages
      ? pages.map((page) => page.id).join(",")
      : Array.from({ length: count }, (_, index) => `src${index}`).join(",");
    if (ids !== this.railBuiltIds) {
      if (this.railBuiltIds) {
        // Index-based rasters and prewarms belong to the previous page order.
        this.prewarmToken += 1;
        this.neighbourCache.clear();
        this.destroySwipeStage();
      }
      this.rebuildRailButtons(count);
      this.railBuiltIds = ids;
    }
    const pageIds = new Set(pages?.map((page) => page.id) ?? []);
    this.selectedPageIds.forEach((pageId) => { if (!pageIds.has(pageId)) this.selectedPageIds.delete(pageId); });
    this.renderPageRailActions();
    this.thumbButtons.forEach((button, index) => {
      const pageId = pages?.[index]?.id;
      const active = index === this.noteIndex;
      const selected = pageId !== undefined && this.selectedPageIds.has(pageId);
      button.toggleClass("is-active", active);
      button.toggleClass("is-selected", this.pageManagement && selected);
      button.setAttribute("aria-current", String(active));
      button.setAttribute("aria-pressed", String(this.pageManagement && selected));
      button.setAttribute("aria-disabled", String(!pages || this.editingLocked()));
    });
    if (this.railCount) this.railCount.textContent = this.pageManagement
      ? `${this.selectedPageIds.size} selected` : `${this.noteIndex + 1} / ${count}`;
    this.thumbButtons.get(this.noteIndex)?.scrollIntoView?.({ block: "nearest" });
    this.evictDistantThumbnails();
    this.paintVisibleThumbnails();
  }

  private rebuildRailButtons(count: number): void {
    const thumbs = this.railThumbs;
    if (!thumbs) return;
    thumbs.empty();
    this.thumbButtons.clear();
    // Indexes shift with the rebuild, so cached thumbnails die too.
    this.invalidateThumbnails();
    const pages = this.sidecar?.notePages;
    for (let index = 0; index < count; index++) {
      const display = this.rotatedSize(pages?.[index] ?? null);
      const button = thumbs.createEl("button", {
        cls: "ink-page-thumb",
        attr: { type: "button", "aria-label": `Page ${index + 1}` },
      });
      const pageId = pages?.[index]?.id;
      if (pageId) button.dataset.pageId = pageId;
      button.style.aspectRatio = `${Math.max(1, display.width)} / ${Math.max(1, display.height)}`;
      button.createEl("canvas", { cls: "ink-page-thumb-canvas", attr: { "aria-hidden": "true" } });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.addEventListener("click", () => {
        if (this.pageManagement) {
          if (pageId) this.toggleManagedPage(pageId);
          return;
        }
        void this.navigatePages(index - this.noteIndex);
      });
      this.thumbButtons.set(index, button);
    }
  }

  private renderPageRailActions(): void {
    const actions = this.railActions;
    if (!actions) return;
    actions.empty();
    const add = (icon: string, label: string, callback: () => void, disabled = false): void => {
      const button = actions.createEl("button", { cls: "ink-icon-button", attr: { type: "button", "aria-label": label } });
      setIcon(button, icon);
      button.disabled = disabled;
      button.addEventListener("click", callback);
    };
    if (this.pageManagement) {
      add("trash-2", "Delete selected pages", () => this.deleteSelectedPages(),
        this.selectedPageIds.size === 0 || this.selectedPageIds.size >= (this.sidecar?.notePages.length ?? 0) || this.editingLocked());
      add("x", "Done managing pages", () => this.setPageManagement(false));
    } else {
      add("list-checks", "Manage pages", () => this.setPageManagement(true), this.editingLocked() || !this.sidecar);
    }
  }

  private setPageManagement(enabled: boolean): void {
    this.pageManagement = enabled && !this.editingLocked() && this.sidecar !== null;
    this.selectedPageIds.clear();
    this.refreshPageRail();
  }

  private toggleManagedPage(pageId: string): void {
    if (!this.pageManagement || this.editingLocked() || !this.sidecar?.notePages.some((page) => page.id === pageId)) return;
    if (this.selectedPageIds.has(pageId)) this.selectedPageIds.delete(pageId);
    else this.selectedPageIds.add(pageId);
    this.refreshPageRail();
  }

  private deleteSelectedPages(): void {
    if (!this.pageManagement || this.editingLocked() || !this.sidecar) return;
    const selected = new Set(this.selectedPageIds);
    if (selected.size === 0 || selected.size >= this.sidecar.notePages.length) return;
    const currentId = this.sidecar.notePages[this.noteIndex]?.id;
    const deletedBeforeCurrent = this.sidecar.notePages.slice(0, this.noteIndex).filter((page) => selected.has(page.id)).length;
    this.withPageUndo(() => {
      const ids = this.sidecar!.notePages.filter((page) => selected.has(page.id)).map((page) => page.id);
      if (ids.length !== selected.size || ids.some((id) => !deleteNotePage(this.sidecar!, id))) return false;
      const retainedIndex = currentId ? this.sidecar!.notePages.findIndex((page) => page.id === currentId) : -1;
      this.noteIndex = retainedIndex >= 0
        ? retainedIndex : Math.max(0, Math.min(this.noteIndex - deletedBeforeCurrent, this.sidecar!.notePages.length - 1));
      return true;
    }, "delete selected pages");
    this.selectedPageIds.clear();
    this.pageManagement = false;
    this.refreshPageRail();
  }

  private invalidateThumbnails(): void {
    this.thumbCache.clear();
    this.thumbPaintTokens.clear();
    this.pendingThumbRenders.clear();
    this.railBuiltIds = "";
  }

  private clearRailState(): void {
    if (this.railSweepTimer !== undefined) { window.clearTimeout(this.railSweepTimer); this.railSweepTimer = undefined; }
    this.invalidateThumbnails();
    this.thumbButtons.clear();
    this.pageRail = null;
    this.railThumbs = null;
    this.railCount = null;
  }

  /** Thumbnail bitmaps only stay for the current page and its direct
   *  neighbours - the same eviction policy as the neighbour prewarm cache. */
  private evictDistantThumbnails(): void {
    for (const key of [...this.thumbCache.keys()]) {
      if (Math.abs(key - this.noteIndex) > 1) this.thumbCache.delete(key);
    }
  }

  private scheduleRailSweep(): void {
    if (this.railSweepTimer !== undefined) window.clearTimeout(this.railSweepTimer);
    this.railSweepTimer = window.setTimeout(() => {
      this.railSweepTimer = undefined;
      this.paintVisibleThumbnails();
    }, RAIL_SWEEP_THROTTLE_MS);
  }

  /** Note-page indexes whose thumbnail intersects the rail viewport, the
   *  current page first. Without layout yet (just opened, collapsed pane,
   *  tests) the current page and its neighbours stand in for the range. */
  private visibleThumbIndexes(): number[] {
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 0;
    const nearby = Array.from({ length: count }, (_, index) => index)
      .filter((index) => Math.abs(index - this.noteIndex) <= 1);
    const railRect = this.pageRail?.getBoundingClientRect();
    if (!railRect || this.pageRail!.clientHeight <= 0) return nearby;
    const visible: number[] = [];
    for (const [index, button] of this.thumbButtons) {
      const rect = button.getBoundingClientRect();
      if (rect.bottom > railRect.top && rect.top < railRect.bottom) visible.push(index);
    }
    return (visible.length > 0 ? visible : nearby)
      .sort((left, right) => Math.abs(left - this.noteIndex) - Math.abs(right - this.noteIndex));
  }

  private paintVisibleThumbnails(): void {
    // Collapsed rail: nothing visible to paint; the expand toggle schedules
    // the repaint for when the transition has revealed the thumbnails.
    if (this.root?.hasClass("ink-rail-hidden")) return;
    for (const index of this.visibleThumbIndexes()) this.paintThumbnail(index);
  }

  /**
   * Paints one thumbnail: from the thumbnail cache, else downscaled from the
   * neighbour prewarm raster (a free first frame next to the current page),
   * else a fresh small pdf.js render. Best-effort end to end - a failed
   * thumbnail keeps its blank paper and can never touch the main canvas.
   */
  private paintThumbnail(index: number): void {
    const button = this.thumbButtons.get(index);
    const canvas = button?.querySelector<HTMLCanvasElement>("canvas");
    if (!button || !canvas) return;
    const cached = this.thumbCache.get(index);
    if (cached) { this.paintThumbBitmap(canvas, cached, index); return; }
    if (this.pendingThumbRenders.has(index)) return;
    const notePage = this.sidecar?.notePages[index];
    const display = this.rotatedSize(notePage ?? null);
    const neighbour = notePage?.sourceIndex !== undefined ? this.neighbourCache.get(index) : undefined;
    if (neighbour) {
      const thumb = document.createElement("canvas");
      thumb.width = this.thumbPixelWidth();
      thumb.height = Math.max(1, Math.round(thumb.width * display.height / display.width));
      thumb.getContext("2d")?.drawImage(neighbour, 0, 0, thumb.width, thumb.height);
      this.thumbCache.set(index, thumb);
      this.paintThumbBitmap(canvas, thumb, index);
      return;
    }
    if (!notePage || notePage.sourceIndex === undefined || !this.pdfDoc) {
      // A blank note page: plain paper, ink only - no pdf.js involved.
      const blank = document.createElement("canvas");
      blank.width = this.thumbPixelWidth();
      blank.height = Math.max(1, Math.round(blank.width * display.height / display.width));
      const ctx = blank.getContext("2d");
      if (ctx) { ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, blank.width, blank.height); }
      this.thumbCache.set(index, blank);
      this.paintThumbBitmap(canvas, blank, index);
      return;
    }
    const token = (this.thumbPaintTokens.get(index) ?? 0) + 1;
    this.thumbPaintTokens.set(index, token);
    this.pendingThumbRenders.add(index);
    void this.renderThumbnail(canvas, index, notePage, display, token)
      .finally(() => {
        if (token === this.thumbPaintTokens.get(index)
          && this.thumbButtons.get(index)?.querySelector("canvas") === canvas) {
          this.pendingThumbRenders.delete(index);
        }
      });
  }

  private thumbPixelWidth(): number {
    return Math.max(1, Math.round(RAIL_THUMB_WIDTH * (window.devicePixelRatio || 1)));
  }

  private async renderThumbnail(canvas: HTMLCanvasElement, index: number,
    notePage: PdfSidecarNotePage, display: { width: number; height: number }, token: number): Promise<void> {
    const generation = this.loadGeneration;
    const isCurrent = () => token === this.thumbPaintTokens.get(index)
      && generation === this.loadGeneration
      && this.sidecar?.notePages[index]?.id === notePage.id
      && this.thumbButtons.get(index)?.querySelector("canvas") === canvas;
    try {
      const page = await this.pdfDoc!.getPage(notePage.sourceIndex! + 1);
      if (!isCurrent()) return;
      const scale = this.thumbPixelWidth() / display.width;
      const viewport = page.getViewport({ scale });
      const thumb = document.createElement("canvas");
      thumb.width = Math.max(1, Math.round(display.width * scale));
      thumb.height = Math.max(1, Math.round(display.height * scale));
      await page.render({ canvasContext: thumb.getContext("2d")!, viewport }).promise;
      if (!isCurrent()) return;
      this.thumbCache.set(index, thumb);
      if (canvas.isConnected) this.paintThumbBitmap(canvas, thumb, index);
    } catch (error) {
      if (this.pdfjs?.RenderingCancelledException && error instanceof this.pdfjs.RenderingCancelledException) return;
      // Thumbnail renders are best-effort; the button stays on blank paper.
    }
  }

  private paintThumbBitmap(canvas: HTMLCanvasElement, bitmap: HTMLCanvasElement, index: number): void {
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    this.overlayThumbInk(ctx, canvas, index);
  }

  /**
   * Draws the note page's handwriting over the rendered thumbnail, strokes
   * scaled to the thumbnail exactly like the notebook editor's snapshots -
   * the rail reads as a miniature of the annotated page, not of the bare
   * PDF underneath.
   */
  private overlayThumbInk(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, index: number): void {
    const page = this.sidecar?.notebook.pages[index];
    if (!page) return;
    if ((page.images?.length ?? 0) > 0) {
      const background = document.createElement("canvas"); background.width = canvas.width; background.height = canvas.height;
      background.getContext("2d")?.drawImage(canvas, 0, 0);
      const width = this.canvasLogicalWidth, height = this.canvasLogicalHeight;
      const scale = canvas.width / Math.max(1, width);
      paintPageImages(this.imageLibrary, canvas, page, (context) => { context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(background, 0, 0); }, (context) => {
        context.setTransform(scale, 0, 0, scale, 0, 0);
        for (const stroke of page.strokes) drawInkStroke(context, scaledStroke(stroke, scale), width, height);
        context.setTransform(1, 0, 0, 1, 0, 0);
      });
      return;
    }
    const scale = canvas.width / Math.max(1, this.canvasLogicalWidth);
    // Even an image-free repaint invalidates pending paints from an older
    // revision, otherwise a slow image load can resurrect a deleted image.
    paintPageImages(this.imageLibrary, canvas, page, () => undefined, (context) => {
      context.setTransform(scale, 0, 0, scale, 0, 0);
      for (const stroke of page.strokes) drawInkStroke(context, scaledStroke(stroke, scale), this.canvasLogicalWidth, this.canvasLogicalHeight);
      context.setTransform(1, 0, 0, 1, 0, 0);
    });
  }

  private openPageMenu(event: MouseEvent): void {
    if (this.readingMode || !this.sidecar) return;
    const menu = this.beginPageOptionsMenu(event);
    if (!menu) return;
    const current = this.sidecar.notePages[this.noteIndex];
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
    // The notebook menu has had zoom entries forever; the PDF view had none,
    // so a manual pinch left no way back to the fit (the manual zoom latches
    // until the document changes - which read as "the fit is huge").
    menu.addItem((item) => item.setTitle("Zoom out").setDisabled(this.zoomLocked || this.zoom <= this.fitZoom)
      .onClick(() => this.setZoom(this.zoom / PDF_ZOOM_STEP)));
    menu.addItem((item) => item.setTitle("Reset zoom").setDisabled(this.zoomLocked || !this.zoomTouched)
      .onClick(() => this.resetZoom()));
    menu.addItem((item) => item.setTitle("Zoom in").setDisabled(this.zoomLocked || this.zoom >= PDF_ZOOM_MAX)
      .onClick(() => this.setZoom(this.zoom * PDF_ZOOM_STEP)));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Open with the built-in viewer").setIcon("book-open")
      .onClick(() => void this.restoreBuiltinViewer()));
    menu.showAtMouseEvent(event);
  }

  /** Back to the fit: clears the manual-zoom latch so layout re-fits. */
  private resetZoom(): void {
    if (this.zoomLocked) return;
    this.zoomTouched = false;
    // Neighbour previews carry the old scale; re-rendering refills them.
    this.neighbourCache.clear();
    this.layoutPage();
    this.schedulePdfRender();
  }

  // ------------------------------------------------------------- page ops

  private addBlankPage(index: number): void {
    this.destroySwipeStage();
    this.withPageUndo(() => {
      const id = insertBlankNotePageAt(this.sidecar!, index);
      this.noteIndex = this.sidecar!.notePages.findIndex((page) => page.id === id);
      this.zoomTouched = this.zoomLocked;
      if (this.scroller) this.scroller.scrollLeft = this.scroller.scrollTop = 0;
      return true;
    }, "insert a blank page");
  }

  /** Apply a note page sequence change, sync the worker, and record undo. */
  private withPageUndo(change: () => boolean, label: string): void {
    if (!this.sidecar || this.editingLocked()) {
      new Notice(`Ink Notes could not ${label}: this view is read-only`);
      return;
    }
    this.finishPointerInput(false);
    const before = serializeSidecar(this.sidecar);
    const beforePageId = this.sidecar.notePages[this.noteIndex]?.id;
    if (!change()) {
      new Notice(`Ink Notes could not ${label}: source PDF pages are permanent`);
      return;
    }
    const after = serializeSidecar(this.sidecar);
    const afterPageId = this.sidecar.notePages[this.noteIndex]?.id;
    this.markSidecarChanged();
    this.syncNotebookToWorker();
    this.layoutPage();
    this.renderAll();
    void this.renderPdfPage();
    this.pushCommand({
      undo: () => this.restoreSidecarSnapshot(before, beforePageId),
      redo: () => this.restoreSidecarSnapshot(after, afterPageId),
    });
  }

  private restoreSidecarSnapshot(snapshot: string, pageId?: string): void {
    if (!this.sidecar) return;
    this.destroySwipeStage();
    try {
      this.sidecar = normalizeSidecar(JSON.parse(snapshot));
      const selected = this.sidecar.notePages.findIndex((page) => page.id === pageId);
      this.noteIndex = selected < 0 ? Math.min(this.noteIndex, this.sidecar.notePages.length - 1) : selected;
      this.markSidecarChanged();
      this.syncNotebookToWorker();
      this.layoutPage();
      this.renderAll();
      void this.renderPdfPage();
    } catch (error) {
      new Notice(`Ink Notes could not restore the previous page state: ${messageOf(error)}`);
    }
  }

  private markSidecarChanged(): void {
    if (!this.sidecar) return;
    this.sidecar.updatedAt = Date.now();
    this.sidecar.notebook.updatedAt = this.sidecar.updatedAt;
    this.dirty = true;
    this.editRevision += 1;
    this.scheduleSave();
  }

  async navigatePages(delta: number): Promise<void> {
    this.finishDesktopZoom(false);
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 1;
    const next = this.noteIndex + delta;
    if (next < 0 || next >= count) return;
    this.finishPointerInput(false);
    this.noteIndex = next;
    this.clearSelection();
    this.closeLassoSettings();
    this.zoomTouched = this.zoomLocked;
    if (this.scroller) {
      this.scroller.scrollLeft = 0;
      this.scroller.scrollTop = 0;
    }
    this.updatePageIndicator();
    this.layoutPage();
    this.renderAll();
    await this.renderPdfPage();
    if (this.flipSettling) this.tiles?.previewInteractiveCells(
      cellKeys(this.viewport, this.canvasLogicalWidth, this.canvasLogicalHeight), this.viewport,
      (window.devicePixelRatio || 1) * this.zoom);
  }

  private setZoom(zoom: number, target?: { x: number; y: number }, anchor?: { x: number; y: number }): void {
    if (this.zoomLocked || !Number.isFinite(zoom)) return;
    const clamped = Math.max(this.fitZoom, Math.min(PDF_ZOOM_MAX, zoom));
    if (clamped === this.zoom) return;
    this.zoomTouched = true;
    // Neighbour previews carry the old scale; re-rendering refills them.
    this.prewarmToken += 1;
    this.neighbourCache.clear();
    const scroller = this.scroller;
    const page = this.pageWrap;
    if (!scroller || !page) {
      this.zoom = clamped;
      this.layoutPage();
      void this.renderPdfPage();
      return;
    }
    // Notebook anchor semantics: keep the content under the target point
    // stable across the scale change. Buttons and reset aim at the viewport
    // centre, the wheel at the cursor, a pinch at the gesture midpoint.
    const viewport = scroller.getBoundingClientRect();
    target ??= { x: viewport.left + scroller.clientWidth / 2, y: viewport.top + scroller.clientHeight / 2 };
    const before = page.getBoundingClientRect();
    anchor ??= { x: (target.x - before.left) / before.width, y: (target.y - before.top) / before.height };
    this.zoom = clamped;
    this.layoutPage(this.desktopRenderDensity === undefined);
    const after = page.getBoundingClientRect();
    scroller.scrollLeft += after.left + anchor.x * after.width - target.x;
    scroller.scrollTop += after.top + anchor.y * after.height - target.y;
    // Full-page pdf.js rasters at high zoom are far too heavy per pinch
    // step; the old bitmap stays on screen (CSS-scaled) and the real render
    // follows once the gesture pauses.
    this.schedulePdfRender();
  }

  /** Coalesces bitmap re-renders: at most one per 160ms of settled zoom. */
  private schedulePdfRender(): void {
    if (this.pdfRenderTimer !== undefined) window.clearTimeout(this.pdfRenderTimer);
    this.pdfRenderTimer = window.setTimeout(() => {
      this.pdfRenderTimer = undefined;
      void this.renderPdfPage();
    }, 160);
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

  private layoutPage(refine = true): void {
    if (!this.scroller || !this.pageWrap) return;
    const lockedLevel = this.zoomLocked ? this.zoomLevel() : null;
    const display = this.rotatedSize(this.currentNotePage());
    this.pageBaseWidth = Math.max(200, this.scroller.clientWidth - PDF_PAGE_PADDING * 2) || 700;
    this.pageBaseHeight = this.pageBaseWidth * display.height / display.width;
    // The page BOX at zoom 1 already spans the pane width; the fit only
    // decides whether zoom 1 holds (landscape pages: width-fill, the tall
    // axis scrolls if ever needed) or the height axis must win (portrait
    // pages shrink until they fit the pane height). beta.29/30 multiplied
    // the box width by paneWidth/pageWidth AGAIN - a units mix-up that blew
    // every page up ~1.4x past the pane, and Reset recomputed the same
    // broken value.
    const contentHeight = Math.max(1, this.scroller.clientHeight - PDF_PAGE_PADDING * 2);
    this.fitZoom = Math.max(0.05, Math.min(1, contentHeight / this.pageBaseHeight));
    if (lockedLevel !== null) this.zoom = this.fitZoom * lockedLevel;
    else if (!this.zoomTouched) this.zoom = this.fitZoom;
    this.updateZoomHud();
    this.pageWrap.setCssStyles({
      width: `${this.pageBaseWidth * this.zoom}px`,
      height: `${this.pageBaseHeight * this.zoom}px`,
    });
    // The overlay/tile coordinate space must be the PAGE BOX at zoom 1, not
    // the PDF's point size: every ink mapping (viewport crop, overlay
    // transforms, tiles, modeler) assumes one logical unit == one box pixel,
    // exactly like the notebook editor derives its logical size from its
    // layout. Point-size units compressed all ink toward the top-left.
    this.canvasLogicalWidth = Math.max(1, Math.round(this.pageBaseWidth * 64) / 64);
    this.canvasLogicalHeight = Math.max(1, Math.round(this.pageBaseHeight * 64) / 64);
    this.tiles?.setDisplayScale(this.zoom);
    const page = this.sidecar?.notebook.pages[this.noteIndex];
    if (page) this.tiles?.setPage(page, this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.updateViewport(refine);
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
    this.tiles?.update(this.viewport, this.desktopRenderDensity ?? (window.devicePixelRatio || 1) * this.zoom,
      refine && this.desktopRenderDensity === undefined);
    this.resizeSelectionCanvas();
    this.resizePreview();
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
    if (this.activeStroke) this.drawPreview();
  }

  private onViewportMotion(): void {
    this.updateViewport(false);
    if (this.desktopRenderDensity !== undefined) return;
    if (this.zoomTimer !== undefined) window.clearTimeout(this.zoomTimer);
    this.zoomTimer = window.setTimeout(() => this.updateViewport(true), 100);
  }

  private buildInkHost(): void {
    const host = this.pageWrap!.createDiv({ cls: "ink-page ink-pdf-ink-host" });
    this.inkHost = host;
    this.eraserCursor = host.createDiv({ cls: "ink-eraser-cursor", attr: { "aria-hidden": "true" } });
    this.eraserCursor.createSpan({ cls: "ink-eraser-reference-point" });
    const tileLayer = host.createDiv({ cls: "ink-tile-layer" });
    this.tiles = new TileRenderer(tileLayer);
    this.canvas = host.createEl("canvas", { cls: "ink-canvas ink-selection-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.lassoCanvas = host.createEl("canvas", { cls: "ink-canvas ink-lasso-preview-canvas" });
    this.lassoCtx = this.lassoCanvas.getContext("2d");
    this.confirmedPreviewCanvas = host.createEl("canvas", { cls: "ink-canvas ink-confirmed-preview-canvas" });
    this.confirmedPreviewCtx = this.confirmedPreviewCanvas.getContext("2d");
    this.previewCanvas = host.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCtx = this.previewCanvas.getContext("2d");
    // The paper owns the gestures in editing mode (same as the notebook page).
    host.addEventListener("pointerenter", (event) => this.onPointerEnter(event));
    host.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    host.addEventListener("pointermove", (event) => this.onPointerMove(event));
    // Chromium hosts (Obsidian desktop) stream every hardware pen sample as it
    // arrives; the notebook editor has consumed these for ages and the PDF
    // view now shares that pipeline wholesale.
    if ("onpointerrawupdate" in window) {
      host.addEventListener("pointerrawupdate", (event) => this.onPointerRawUpdate(event as PointerEvent));
    }
    host.addEventListener("pointerup", (event) => this.onPointerUp(event));
    host.addEventListener("pointercancel", (event) => this.onPointerCancel(event));
    host.addEventListener("lostpointercapture", (event) => this.onLostPointerCapture(event));
    host.addEventListener("pointerleave", () => {
      this.eraserPointerInside = false;
      this.refreshEraserCursor();
    });
    // Shared with the notebook editor: catches the stroke end when iPadOS
    // interrupts a Pencil (system gesture, haptic tick) or the pen lifts
    // outside an uncaptured host - otherwise the stroke stays preview-only
    // and the next render wipes it ("write a stroke, lose a stroke").
    registerDocumentPointerEndEvents(host, (cleanup) => this.register(cleanup), (event, cancelled) => {
      void cancelled;
      this.onDocumentPointerEnd(event);
    });
  }

  protected desktopNavigate(destination: "previous" | "next" | "first" | "last"): void {
    if (destination === "previous" || destination === "next") {
      if (this.queuePageSwipeDelta(destination === "next" ? 1 : -1)) return;
    }
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 1;
    const next = destination === "first" ? 0 : destination === "last" ? count - 1
      : this.noteIndex + (destination === "next" ? 1 : -1);
    if (this.queuePageSwipeTarget(next)) return;
    void this.navigatePages(next - this.noteIndex).catch((error) => this.setStatus(`Could not switch pages: ${messageOf(error)}`, true));
  }
  protected desktopZoom(factor: number, target?: { x: number; y: number }): void {
    if (this.zoomLocked) return;
    if (this.desktopRenderDensity === undefined) {
      this.desktopRenderDensity = (window.devicePixelRatio || 1) * this.zoom;
      if (this.zoomTimer !== undefined) window.clearTimeout(this.zoomTimer);
      this.zoomTimer = undefined;
      this.tiles?.beginInput();
    }
    this.setZoom(this.zoom * factor, target);
    if (this.desktopZoomTimer !== undefined) window.clearTimeout(this.desktopZoomTimer);
    this.desktopZoomTimer = window.setTimeout(() => this.finishDesktopZoom(), 180);
  }
  private finishDesktopZoom(refine = true): void {
    if (this.desktopZoomTimer !== undefined) window.clearTimeout(this.desktopZoomTimer);
    this.desktopZoomTimer = undefined;
    if (this.desktopRenderDensity === undefined) return;
    this.desktopRenderDensity = undefined;
    if (refine) this.updateViewport(true);
  }
  protected desktopResetZoom(): void { this.resetZoom(); }

  // ------------------------------------------------------ writing-layer seams

  protected currentNotebook(): InkNotebook {
    return this.sidecar?.notebook ?? EMPTY_NOTEBOOK;
  }

  protected currentPage(): InkPage {
    return this.sidecar?.notebook.pages[this.noteIndex] ?? EMPTY_NOTEBOOK.pages[0]!;
  }

  protected inputRect(): DOMRect {
    return this.inkHost!.getBoundingClientRect();
  }

  protected inputHost(): HTMLElement | undefined {
    return this.inkHost ?? undefined;
  }

  protected inputLocked(): boolean {
    return this.editingLocked() || this.flipSettling;
  }

  private editingLocked(): boolean {
    return this.readingMode || !this.canEdit();
  }

  protected onReadingModeChanged(): void {
    this.destroySwipeStage();
    this.touchGesture = null;
    this.root?.toggleClass("ink-pdf-editing", !this.readingMode);
    if (this.readingMode) {
      this.pageManagement = false;
      this.selectedPageIds.clear();
      this.refreshPageRail();
    }
  }

  protected pagePixelSize(): { width: number; height: number } {
    return { width: this.canvasLogicalWidth, height: this.canvasLogicalHeight };
  }

  protected onModelMutated(): void {
    if (!this.sidecar) return;
    this.sidecar.updatedAt = Date.now();
    this.dirty = true;
    this.editRevision += 1;
  }

  protected afterInputFullySettled(): void {
    // Parity with the notebook editor: the current page's rail thumbnail
    // tracks committed ink (pointerup and post-commit). Skipped while the
    // rail is collapsed - the reveal toggle repaints the range instead.
    if (this.root?.hasClass("ink-rail-hidden")) return;
    this.paintThumbnail(this.noteIndex);
  }

  protected onRenderResize(): void {
    this.layoutPage();
  }

  protected onInputStarting(): void { this.finishDesktopZoom(); }

  protected toolbarRoot(): HTMLElement { return this.root!; }
  protected inputScroller(): HTMLElement { return this.scroller!; }
  protected zoomLevel(): number { return this.zoom / this.fitZoom; }
  protected onZoomLockChanged(): void { this.finishDesktopZoom(); this.zoomTouched = true; }
  protected applyGestureZoom(value: number, focus: { x: number; y: number }, anchor: { x: number; y: number }): void {
    this.setZoom(value, focus, anchor);
  }

  private swipeStage: HTMLElement | null = null;
  private swipeLayer: HTMLElement | null = null;

  protected swipeDrag(offset: number): void {
    const wrap = this.pageWrap;
    if (!wrap || this.flipSettling) return;
    this.ensureSwipeStage(offset);
    this.updatePageInsertPreview(this.swipeStage, offset);
    const pitch = this.swipePitch();
    offset = this.swipeStage ? Math.max(-pitch, Math.min(pitch, offset)) : offset / (1 + Math.abs(offset) / 80);
    this.swipeDragOffset = offset;
    wrap.setCssStyles({ transition: "none", transform: `translateX(${offset}px)` });
    if (this.swipeStage) this.swipeStage.setCssStyles({ transition: "none", transform: `translateX(${offset}px)` });
  }

  /** Use the neighbour's own fit: mixed portrait/landscape pages have different zooms. */
  private swipePageSize(notePage: PdfSidecarNotePage | null): { width: number; height: number; baseWidth: number; zoom: number } {
    const display = this.rotatedSize(notePage);
    const baseWidth = Math.max(200, this.scroller!.clientWidth - PDF_PAGE_PADDING * 2);
    const fit = Math.max(0.05, Math.min(1, Math.max(1, this.scroller!.clientHeight - PDF_PAGE_PADDING * 2)
      / (baseWidth * display.height / display.width)));
    const zoom = this.zoomLocked ? fit * this.zoomLevel() : fit;
    const width = baseWidth * zoom;
    return { width, height: width * display.height / display.width, baseWidth, zoom };
  }

  /** Slides the neighbouring page in beside the current one while dragging. */
  private ensureSwipeStage(offset: number): void {
    const wrap = this.pageWrap;
    const scroller = this.scroller;
    if (!wrap || !scroller) return;
    const side = offset > 0 ? -1 : 1; // dragging right reveals the previous page on the left
    const neighborIndex = this.noteIndex + side;
    if (this.swipeStage) {
      if (Number(this.swipeStage.dataset.neighbor) === neighborIndex) return;
      this.destroySwipeStage();
    }
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 0;
    const insert = neighborIndex < 0 || neighborIndex >= count;
    if (insert && this.editingLocked()) return;
    const pitch = this.swipePitch();
    const note = this.sidecar?.notePages[insert ? this.noteIndex : neighborIndex] ?? null;
    const display = this.rotatedSize(note);
    const { width, height, baseWidth, zoom } = this.swipePageSize(note);
    this.swipeLayer = scroller.createDiv({ cls: "ink-swipe-layer" });
    this.swipeLayer.setCssStyles({ left: `${scroller.scrollLeft}px`, top: `${scroller.scrollTop}px`,
      width: `${scroller.clientWidth}px`, height: `${scroller.clientHeight}px`, right: "auto", bottom: "auto" });
    const stage = this.swipeLayer.createDiv({ cls: "ink-swipe-stage" });
    stage.dataset.neighbor = String(neighborIndex);
    stage.setCssStyles({
      position: "absolute", margin: "0", overflow: "hidden", background: "#fff",
      borderRadius: "2px", boxShadow: "var(--ink-shadow-paper)",
      left: `${Math.max(PDF_PAGE_PADDING, (scroller.clientWidth - width) / 2) - scroller.scrollLeft + side * pitch}px`,
      top: `${Math.max(PDF_PAGE_PADDING, (scroller.clientHeight - height) / 2) - scroller.scrollTop}px`,
      width: `${width}px`,
      height: `${height}px`,
      transform: "translateX(0px)",
    });
    this.swipeStage = stage;
    if (insert) { this.showPageInsertPreview(stage, side); return; }
    void this.renderSwipeStagePage(stage, neighborIndex);
    const ink = stage.createEl("canvas", { cls: "ink-swipe-canvas" });
    const logicalHeight = baseWidth * display.height / display.width;
    const resolution = canvasResolution(baseWidth, logicalHeight, window.devicePixelRatio || 1, zoom, SELECTION_OVERLAY_BUDGET);
    ink.width = resolution.width; ink.height = resolution.height;
    const ctx = ink.getContext("2d");
    if (ctx) {
      ctx.setTransform(ink.width / baseWidth, 0, 0, ink.height / logicalHeight, 0, 0);
      const page = this.sidecar?.notebook.pages[neighborIndex];
      if (page) paintPageImages(this.imageLibrary, ink, page, (context) => context.clearRect(0, 0, ink.width, ink.height), (context) => {
        context.setTransform(ink.width / baseWidth, 0, 0, ink.height / logicalHeight, 0, 0);
        for (const stroke of page.strokes) drawInkStroke(context, stroke, baseWidth, logicalHeight);
        context.setTransform(1, 0, 0, 1, 0, 0);
      });
    }
  }

  private async renderSwipeStagePage(stage: HTMLElement, index: number): Promise<void> {
    const notePage = this.sidecar?.notePages[index];
    const canvas = stage.createEl("canvas");
    canvas.setCssStyles({ position: "absolute", inset: "0", width: "100%", height: "100%" });
    if (!notePage || notePage.sourceIndex === undefined || !this.pdfDoc) return;
    // The prewarm cache makes the flip instant when it holds the page.
    const resolution = canvasResolution(parseFloat(stage.style.width), parseFloat(stage.style.height), window.devicePixelRatio || 1, 1);
    const cached = this.neighbourCache.get(index);
    if (cached && cached.width === resolution.width && cached.height === resolution.height) {
      canvas.width = cached.width;
      canvas.height = cached.height;
      canvas.getContext("2d")?.drawImage(cached, 0, 0);
      return;
    }
    try {
      const page = await this.pdfDoc.getPage(notePage.sourceIndex + 1);
      if (!stage.isConnected) return;
      const scale = resolution.width / page.getViewport({ scale: 1 }).width;
      canvas.width = resolution.width;
      canvas.height = resolution.height;
      const viewport = page.getViewport({ scale });
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
      if (stage.isConnected && canvas.width > 0) this.neighbourCache.set(index, canvas);
    } catch {
      // The neighbour preview is best-effort; a blank page is fine.
    }
  }

  /** Renders the neighbouring pages offscreen so flips never wait. */
  private prewarmNeighbours(): void {
    this.prewarmToken += 1;
    const token = this.prewarmToken;
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 0;
    for (const delta of [-1, 1]) {
      const index = this.noteIndex + delta;
      if (index < 0 || index >= count || this.neighbourCache.has(index)) continue;
      void this.prewarmNeighbour(index, token);
    }
    for (const key of [...this.neighbourCache.keys()]) {
      if (Math.abs(key - this.noteIndex) > 1) this.neighbourCache.delete(key);
    }
  }

  private async prewarmNeighbour(index: number, token: number): Promise<void> {
    const notePage = this.sidecar?.notePages[index];
    if (!notePage || notePage.sourceIndex === undefined || !this.pdfDoc) return;
    try {
      const page = await this.pdfDoc.getPage(notePage.sourceIndex + 1);
      if (token !== this.prewarmToken || this.neighbourCache.has(index)) return;
      const size = this.swipePageSize(notePage);
      const resolution = canvasResolution(size.width, size.height, window.devicePixelRatio || 1, 1);
      const scale = resolution.width / page.getViewport({ scale: 1 }).width;
      const buffer = document.createElement("canvas");
      buffer.width = resolution.width;
      buffer.height = resolution.height;
      const viewport = page.getViewport({ scale });
      await page.render({ canvasContext: buffer.getContext("2d")!, viewport }).promise;
      if (token !== this.prewarmToken) return;
      this.neighbourCache.set(index, buffer);
    } catch {
      // Best-effort prewarm.
    }
  }

  /** Last drag offset; settle animations continue from it. */
  private swipeDragOffset = 0;

  private swipePitch(): number {
    return Math.max(this.scroller?.clientWidth ?? 0, this.pageWrap?.offsetWidth ?? 0) + 16;
  }

  protected swipeSettle(delta: number, travel = 0): void {
    if (this.flipSettling) return;
    const wrap = this.pageWrap;
    if (!wrap) { this.destroySwipeStage(); return; }
    const stage = this.swipeStage;
    const side = stage ? Number(stage.dataset.neighbor) - this.noteIndex : 0;
    const insert = !!stage?.dataset.insert;
    const create = insert && !this.editingLocked() && Math.sign(travel) === -side && Math.abs(travel) >= this.pageInsertThreshold();
    const flip = create || (!insert && delta !== 0 && side === delta);
    const from = this.swipeDragOffset;
    const to = flip ? -side * this.swipePitch() : 0;
    const isCurrent = this.beginPageSwipe(this.noteIndex + (flip ? delta : 0),
      this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 1);
    this.flipSettling = true;
    this.animatePageSwipe(stage ? [wrap, stage] : [wrap], from, to, () => {
      if (!isCurrent()) return;
      this.cancelPageSwipeAnimations();
      wrap.setCssStyles({ transform: "" });
      if (create) {
        this.addBlankPage(side < 0 ? 0 : this.sidecar!.notePages.length);
        this.destroySwipeStage();
        this.resumePageSwipeDrag();
        return;
      }
      if (flip && stage) wrap.setCssStyles({ visibility: "hidden" });
      void this.navigatePageSwipe((index) => this.navigatePages(index - this.noteIndex),
        () => this.noteIndex, isCurrent).catch((error) => {
        this.setStatus(`Could not switch pages: ${messageOf(error)}`, true);
      }).finally(() => {
        if (isCurrent()) {
          this.destroySwipeStage();
          this.resumePageSwipeDrag();
        }
      });
    });
  }

  private destroySwipeStage(): void {
    this.clearPageSwipeTarget();
    this.cancelPageSwipeAnimations();
    this.swipeLayer?.remove();
    this.swipeStage?.remove();
    this.swipeLayer = this.swipeStage = null;
    if (this.pageWrap) {
      this.pageWrap.setCssStyles({ transform: "", visibility: "" });
    }
    this.swipeDragOffset = 0;
    this.flipSettling = false;
  }
  protected settingsOpen(): boolean {
    if (this.state.tool === "pointer") return false;
    if (this.state.tool === "lasso") return this.lassoSettingsPopover !== null;
    return this.state.tool === "eraser" ? this.eraserPopover !== null : this.brushPopover?.isOpen ?? false;
  }
  protected toggleToolSettings(anchor: HTMLElement): void {
    if (this.state.tool === "lasso") { this.toggleLassoSettings(anchor); return; }
    if (this.state.tool === "eraser") { this.toggleEraserPopover(anchor); return; }
    this.ensureBrushSettingsPopover();
    this.brushPopover?.toggle();
  }
  protected reopenToolSettings(): void {
    if (this.state.tool === "lasso") { if (!this.lassoSettingsPopover) this.toggleLassoSettings(this.activeSettingsAnchor()); return; }
    if (this.state.tool === "eraser") {
      if (!this.eraserPopover) this.toggleEraserPopover(this.toolbarButtons.get(`tool-${this.state.tool}`) ?? null);
      return;
    }
    this.ensureBrushSettingsPopover();
    this.brushPopover?.open();
    this.brushPopover?.position();
  }

  protected resizeOverlay(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, maxPixels: number): boolean {
    const { x, y, width, height } = this.viewport;
    const resolution = canvasResolution(width, height, window.devicePixelRatio || 1, this.zoom, maxPixels);
    const left = `${x * this.zoom}px`;
    const top = `${y * this.zoom}px`;
    const displayWidth = `${width * this.zoom}px`;
    const displayHeight = `${height * this.zoom}px`;
    const changed = canvas.width !== resolution.width || canvas.height !== resolution.height
      || canvas.style.left !== left || canvas.style.top !== top
      || canvas.style.width !== displayWidth || canvas.style.height !== displayHeight;
    if (canvas.width !== resolution.width) canvas.width = resolution.width;
    if (canvas.height !== resolution.height) canvas.height = resolution.height;
    canvas.setCssStyles({ left, top, width: displayWidth, height: displayHeight });
    const scaleX = resolution.width / width;
    const scaleY = resolution.height / height;
    ctx.setTransform(scaleX, 0, 0, scaleY, -x * scaleX, -y * scaleY);
    return changed;
  }

  private resizeSelectionCanvas(): void {
    if (!this.canvas || !this.ctx) return;
    this.resizeOverlay(this.canvas, this.ctx, SELECTION_OVERLAY_BUDGET);
  }

  // ------------------------------------------------------------- rendering

  private cancelPdfRender(): void {
    this.pdfRenderTask?.cancel();
    this.pdfRenderTask = null;
  }

  private async renderPdfPage(): Promise<void> {
    const canvas = this.pdfCanvas;
    if (!canvas) return;
    const generation = ++this.pdfRenderGeneration;
    this.cancelPdfRender();
    const notePage = this.currentNotePage();
    // Layout's 100% is the pane-wide page box, not a PDF point. Rasterize at
    // its actual screen density instead of enlarging a point-sized bitmap.
    const { width: targetWidth, height: targetHeight } = canvasResolution(
      this.pageBaseWidth, this.pageBaseHeight, window.devicePixelRatio || 1, this.zoom);
    canvas.setCssStyles({ width: "100%", height: "100%" });
    if (!notePage || notePage.sourceIndex === undefined || !this.pdfDoc) {
      // A blank note page: plain paper, ink only.
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    try {
      const page = await this.pdfDoc.getPage(notePage.sourceIndex + 1);
      if (generation !== this.pdfRenderGeneration) return;
      // Double-buffer: render offscreen and only swap onto the visible
      // canvas once the frame is complete. Assigning the visible canvas
      // dimensions wipes it, which flashed the page blank on every zoom
      // step and on every pane resize.
      const scale = targetWidth / page.getViewport({ scale: 1 }).width;
      const viewport = page.getViewport({ scale });
      const buffer = document.createElement("canvas");
      buffer.width = targetWidth;
      buffer.height = targetHeight;
      const task = page.render({ canvasContext: buffer.getContext("2d")!, viewport });
      this.pdfRenderTask = task;
      await task.promise;
      if (generation !== this.pdfRenderGeneration) return;
      this.pdfRenderTask = null;
      if (canvas.width !== targetWidth) canvas.width = targetWidth;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      canvas.getContext("2d")?.drawImage(buffer, 0, 0);
      if (!this.touchGesture) this.prewarmNeighbours();
    } catch (error) {
      if (this.pdfjs?.RenderingCancelledException && error instanceof this.pdfjs.RenderingCancelledException) return;
      if (generation === this.pdfRenderGeneration) this.setStatus(`Could not render this page: ${messageOf(error)}`, true);
      return;
    }
  }

  protected renderAll(): void {
    this.clampNoteIndex();
    this.updatePageIndicator();
    this.refreshPageRail();
    this.updateToolButtons();
    this.updateHistoryButtons();
    const page = this.sidecar?.notebook.pages[this.noteIndex];
    if (page && this.tiles) {
      this.tiles.setPage(page, this.canvasLogicalWidth, this.canvasLogicalHeight);
      this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    }
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
  }

  private clampNoteIndex(): void {
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 1;
    this.noteIndex = Math.max(0, Math.min(this.noteIndex, count - 1));
  }

  private resetViewState(): void {
    this.finishDesktopZoom(false);
    this.destroySwipeStage();
    this.cancelPdfRender();
    this.finishPointerInput(false);
    this.discardPendingInkPreview();
    this.pendingMergedSidecar = null;
    this.pdfDoc = null;
    this.sourcePages = [];
    this.noteIndex = 0;
    this.zoom = 1;
    this.writeBlockedReason = null;
    this.pendingRecoveryCandidates = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    this.zoomTouched = false;
    this.neighbourCache.clear();
    // Thumbnail bitmaps and rail buttons belong to the previous document.
    this.invalidateThumbnails();
    this.clearSaveTimers();
    this.setStatus("Loading PDF…");
  }

  private setStatus(message: string, isError = false): void {
    if (!message && this.writeBlockedReason) { message = this.writeBlockedReason; isError = true; }
    if (!this.statusEl) return;
    this.statusEl.setText(message);
    this.statusEl.toggleClass("is-error", isError);
    this.statusEl.toggle(message.length > 0);
  }

  // --------------------------------------------------------------- saving

  /**
   * Sidecar save: CAS write with bounded merge retries. Callers gate mode
   * switches and view close on the returned outcome; a save in flight is
   * awaited, and newer changes trigger a follow-up flush.
   */
  async flushSaveNow(): Promise<SaveOutcome> {
    if (this.activeSave) {
      const previous = await this.activeSave;
      if (previous.status !== "saved") return previous;
      return this.flushSaveNow();
    }
    if (this.writeBlockedReason && this.dirty) return { status: "failed", message: this.writeBlockedReason };
    if (!this.dirty || !this.sidecar || !this.sidecarFile) return { status: "saved" };
    const save = this.performSave()
      .catch((error): SaveOutcome => ({ status: "failed", message: messageOf(error) }))
      .finally(() => { this.activeSave = null; });
    this.activeSave = save;
    const outcome = await save;
    if (outcome.status === "saved" && this.dirty) return this.flushSaveNow();
    return outcome;
  }

  protected performScheduledSave(): void {
    void this.flushSaveNow().then((outcome) => {
      if (outcome.status === "saved") this.setStatus("");
      else this.setStatus(`Save ${outcome.status}: ${outcome.message}`, true);
    });
  }

  private async performSave(): Promise<SaveOutcome> {
    let latestRaw = this.sidecarRaw;
    for (let attempt = 0; attempt <= SAVE_CONFLICT_RETRIES; attempt++) {
      if (this.writeBlockedReason) return { status: "failed", message: this.writeBlockedReason };
      const revision = this.editRevision;
      // Pending peer state must also reach disk when a save finishes mid-stroke.
      const snapshot = this.pendingMergedSidecar ? mergeSidecars(this.pendingMergedSidecar, this.sidecar!) : this.sidecar!;
      const next = { ...snapshot, updatedAt: Date.now() };
      const nextRaw = serializeSidecar(next);
      if (await this.store.writeIfUnchanged(this.sidecarFile!, this.sidecarRaw, nextRaw)) {
        this.sidecarRaw = nextRaw;
        this.dirty = this.editRevision !== revision;
        if (this.pendingMergedSidecar) this.receiveMergedSidecar(next);
        return { status: "saved" };
      }
      // CAS mismatch: re-read, merge, retry. Unreadable or foreign content
      // stops the overwrite and produces a conflict copy with the local ink.
      try {
        latestRaw = await this.store.readRaw(this.sidecarFile!);
      } catch (error) {
        return { status: "failed", message: messageOf(error) };
      }
      // A source change while awaiting disk must stop the next CAS attempt.
      if (this.writeBlockedReason) return { status: "failed", message: this.writeBlockedReason };
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
        const mergeRevision = this.editRevision;
        const merged = mergeSidecars(latest, this.pendingMergedSidecar
          ? mergeSidecars(this.pendingMergedSidecar, this.sidecar!) : this.sidecar!);
        const mergedRaw = serializeSidecar(merged);
        if (await this.store.writeIfUnchanged(this.sidecarFile!, latestRaw, mergedRaw)) {
          this.sidecarRaw = mergedRaw;
          this.dirty = this.editRevision !== mergeRevision;
          this.receiveMergedSidecar(merged);
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
      const revision = this.editRevision;
      const conflictPath = `${this.sidecarFile!.path.replace(/\.pdfink\.json$/, "")}.conflict-${Date.now()}.pdfink.json`;
      const snapshot = this.pendingMergedSidecar
        ? mergeSidecars(this.pendingMergedSidecar, this.sidecar!) : this.sidecar!;
      const sidecar = { ...snapshot, updatedAt: Date.now() };
      await this.app.vault.create(conflictPath, serializeSidecar(sidecar));
      this.sidecarRaw = diskRaw;
      this.dirty = this.editRevision !== revision;
      new Notice(`Ink Notes kept your notes in ${conflictPath}`);
      return { status: "conflict", message: reason };
    } catch (error) {
      return { status: "failed", message: `${reason}; writing the conflict copy failed: ${messageOf(error)}` };
    }
  }

  // ---------------------------------------------------------------- export

  async exportHandwrittenCopy(): Promise<void> {
    if (!this.file || !this.sidecar) return;
    this.finishPointerInput(false);
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
      const fingerprint = await this.store.computeFingerprint(bytes);
      if (fingerprint.sha256 !== this.sidecar.source.sha256 || fingerprint.byteLength !== this.sidecar.source.byteLength) {
        this.sourcePdfModified();
        new Notice("Export cancelled: the source PDF changed. Your notes still belong to the previous revision.");
        return;
      }
      const output = await exportHandwrittenPdf(bytes, this.sidecar, this.file.basename, this.canvasLogicalWidth, this.imageLibrary?.bytes);
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
