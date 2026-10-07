import { App, Menu, Notice, Scope, SuggestModal, TFile, WorkspaceLeaf, loadPdfJs, setIcon } from "obsidian";
import { InkNotebook, InkPage, InkTool, createNotebook } from "./model";
import { canvasResolution } from "./rendering";
import { BrushPopoverController } from "./brush-popover";
import { registerDocumentPointerEndEvents } from "./ink-input";
import { InkWritingView } from "./ink-writing";
import { TileRenderer } from "./tiles";
import { InkWorkerService } from "./worker-service";
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

const SAVE_CONFLICT_RETRIES = 3;
const PDF_ZOOM_MIN = 0.5;
const PDF_ZOOM_MAX = 3;
const PDF_ZOOM_STEP = 1.2;
const PDF_PAGE_PADDING = 24;
const SELECTION_OVERLAY_BUDGET = 4_000_000;

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

interface PdfJsLib {
  getDocument(options: { data: ArrayBuffer }): { promise: Promise<PdfJsDocument> };
  RenderingCancelledException?: new (...args: unknown[]) => Error;
}

let nextViewId = 1;

/** Fallback model when no sidecar is attached; keeps undo/redo seams safe. */
const EMPTY_NOTEBOOK = createNotebook();

/**
 * Handwriting view for PDF tabs. Opens in reading mode; editing unlocks only
 * after the user explicitly toggles edit mode and the sidecar passed its
 * fingerprint check. The PDF page renders with Obsidian's own pdf.js below
 * the shared ink tile pipeline, so strokes persist through the same
 * merge/tombstone machinery as .ink notebooks.
 *
 * The writing pipeline itself (pointer capture, stroke modeling, previews,
 * eraser, lasso, history, save scheduling) is the shared InkWritingView; this
 * class supplies the PDF seams: sidecar storage, page geometry, mode/writer
 * arbitration and the pdf.js canvas underneath the ink host.
 */
export class PdfInkView extends InkWritingView {
  readonly viewId = `pdf-view-${nextViewId++}`;

  private store!: PdfSidecarStore;
  private takeover!: PdfTabTakeover;
  private arbiter!: PdfWriterArbiter;

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
  private writerHeld = false;

  private sourcePages: PdfSourcePageGeometry[] = [];
  private noteIndex = 0;
  private pageBaseWidth = 700;
  private pageBaseHeight = 990;

  private dirty = false;
  private activeSave: Promise<SaveOutcome> | null = null;
  private saveRequested = false;
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
    root.addClass("ink-pdf-view", "ink-pdf-editing");
    this.root = root;
    this.renderToolbar(root);
    this.statusEl = root.createDiv({ cls: "ink-pdf-status" });
    const scroller = root.createDiv({ cls: "ink-pdf-scroller" });
    this.scroller = scroller;
    this.pageWrap = scroller.createDiv({ cls: "ink-pdf-page-wrap" });
    this.pdfCanvas = this.pageWrap.createEl("canvas", { cls: "ink-pdf-canvas" });
    this.buildInkHost();
    this.viewReady = true;
    this.registerDomEvent(scroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(scroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(scroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(scroller, "touchend", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(scroller, "touchcancel", (event) => {
      this.onStylusTouch(event);
      this.touchGesture = null;
    }, { passive: false });
    // Pane operations (splits, drags, sidebar toggles) resize this view
    // without a window resize; stale page geometry there overflowed the pane
    // and mis-mapped strokes for views opened before the split.
    const observer = new ResizeObserver(() => {
      this.brushPopover?.position();
      this.layoutPage();
      if (this.resizeRenderTimer !== undefined) window.clearTimeout(this.resizeRenderTimer);
      this.resizeRenderTimer = window.setTimeout(() => void this.renderPdfPage(), 100);
    });
    observer.observe(scroller);
    this.register(() => observer.disconnect());
  }

  async onClose(): Promise<void> {
    const outcome = await this.flushSaveNow();
    if (outcome.status !== "saved") {
      new Notice(`Ink Notes kept notes for ${this.file?.basename ?? "this PDF"} in a conflict copy: ${outcome.message}`);
    }
    this.releaseWriter();
    this.loadGeneration += 1;
    this.cancelPdfRender();
    this.finishPointerInput(false);
    this.discardPendingInkPreview();
    this.clearSaveTimers();
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    if (this.zoomTimer !== undefined) window.clearTimeout(this.zoomTimer);
    this.tiles?.dispose();
    this.tiles = null;
    this.workerSession?.dispose();
    this.workerSession = null;
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
    this.finishPointerInput(false);
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

  // ------------------------------------------------------------------ locks

  /** Exposed for tests and diagnostics: why handwriting is read-only, if so. */
  get writeBlocked(): string | null {
    return this.writeBlockedReason;
  }

  private canEdit(): boolean {
    return this.sidecar !== null && this.writeBlockedReason === null && this.file !== null;
  }

  /**
   * The view is always in editing shape; read-only behaviour is a lock state,
   * not a mode: blocked sidecars (fingerprint mismatch, corrupt notes file)
   * and the single-writer arbiter gate input via editingLocked().
   */
  private acquireWriter(): void {
    if (this.writerHeld || !this.canEdit()) return;
    if (this.file && !this.arbiter.acquire(this.file.path, this.viewId)) return;
    this.writerHeld = true;
  }

  private releaseWriter(): void {
    if (this.writerHeld && this.file) this.arbiter.release(this.file.path, this.viewId);
    this.writerHeld = false;
  }

  /** Hand the tab back to the built-in (possibly PDF++-enhanced) viewer. */
  async restoreBuiltinViewer(): Promise<void> {
    const outcome = await this.flushSaveNow();
    if (outcome.status === "failed") {
      new Notice(`Save failed, staying in the handwriting view: ${outcome.message}`);
      return;
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
    // Editable PDFs hold the writer from the moment their sidecar resolves.
    this.acquireWriter();
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

    // Far-left settings entry for both editors (the popover carries the
    // sample-stroke preview); tools no longer sit next to it.
    const settingsGroup = this.addToolbarSection(toolbar, "Settings");
    this.addBrushPopover(settingsGroup);

    const toolGroup = this.addToolbarSection(toolbar, "Draw");
    this.addToolButton(toolGroup, "pen-line", "Pen", "pen");
    this.addToolButton(toolGroup, "highlighter", "Highlight", "highlighter");
    this.addToolButton(toolGroup, "eraser", "Erase", "eraser");
    this.addToolButton(toolGroup, "lasso-select", "Select", "lasso");

    const historyGroup = this.addToolbarSection(toolbar, "History");
    this.addTrackedIconButton(historyGroup, "undo", "undo-2", "Undo", () => {
      if (!this.editingLocked()) this.undo();
    }, this.undoStack.length === 0);
    this.addTrackedIconButton(historyGroup, "redo", "redo-2", "Redo", () => {
      if (!this.editingLocked()) this.redo();
    }, this.redoStack.length === 0);

    const docGroup = this.addToolbarSection(toolbar, "Document");
    this.addTrackedIconButton(docGroup, "pages", "more-horizontal", "Page options", (event) => {
      if (!this.editingLocked()) this.openPageMenu(event);
    });
    this.addTrackedIconButton(docGroup, "export", "download", "Export PDF with handwriting", () => {
      if (!this.editingLocked()) void this.exportHandwrittenCopy();
    });

    const pagesGroup = this.addToolbarSection(toolbar, "Pages");
    const indicator = pagesGroup.createDiv({ cls: "ink-pdf-page-indicator" });
    indicator.setText("–");
    this.toolbarButtons.set("indicator", indicator);

    this.updateToolButtons();
    this.updateHistoryButtons();
    this.updatePageIndicator();
  }

  private addTrackedIconButton(parent: HTMLElement, key: string, icon: string, label: string, onClick: (event: MouseEvent) => void, disabled = false): void {
    const button = this.addIconButton(parent, icon, label, onClick, disabled);
    this.toolbarButtons.set(key, button);
  }

  private addBrushPopover(parent: HTMLElement): void {
    const button = parent.createEl("button", {
      cls: "ink-icon-button",
      attr: { type: "button", "aria-label": "Brush settings", "aria-haspopup": "dialog" },
    });
    setIcon(button.createSpan({ cls: "ink-button-icon" }), "sliders-horizontal");
    this.toolbarButtons.set("brush", button);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.brushPopover.toggle();
    });
    // Tap-outside closes — anywhere outside the popover itself, including the
    // paper: a fullscreen PDF pane has no "outside the view" to tap, and the
    // popover must close when the user starts writing again. The popover's own
    // controls and the toggle button are exempt (the button's click toggles).
    this.registerDomEvent(document, "pointerdown", (event) => {
      const target = event.target as HTMLElement | null;
      if (!this.brushPopover.isOpen) return;
      if (target && (this.brushPopover.root.contains(target) || button.contains(target))) return;
      this.brushPopover.close();
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && this.brushPopover.isOpen) {
        this.brushPopover.close();
        button.focus();
      }
    });
    this.registerDomEvent(window, "scroll", () => this.brushPopover.position(), true);
    // Mounted at the view root with fixed positioning (mainline parity):
    // nesting it inside the toolbar group exposed it to toolbar layout and
    // produced the mangled arc layout on iPad.
    this.brushPopover = new BrushPopoverController(this.root!, {
      // Extra class scopes the PDF-surface rules (paper canvases, spacing).
      extraClass: "ink-pdf-brush-popover",
      tools: this.brushToolConfigs(),
      getSettings: (tool) => this.brushSettings(tool),
      activeTool: () => this.state.tool,
      showPenDynamics: () => this.state.tool === "pen",
      buildExtras: (body, api) => this.buildEraserSettings(body, api.addRange),
      onControlsChanged: () => this.updateEraserControls(),
      anchor: () => this.toolbarButtons.get("brush") ?? null,
    });
    this.settingsPanel = this.brushPopover.root;
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

  private markSidecarChanged(): void {
    if (!this.sidecar) return;
    this.sidecar.updatedAt = Date.now();
    this.sidecar.notebook.updatedAt = this.sidecar.updatedAt;
    this.dirty = true;
    this.scheduleSave();
  }

  navigatePages(delta: number): void {
    const count = this.sidecar?.notePages.length ?? this.pdfDoc?.numPages ?? 1;
    const next = this.noteIndex + delta;
    if (next < 0 || next >= count) return;
    this.finishPointerInput(false);
    this.noteIndex = next;
    this.updatePageIndicator();
    this.layoutPage();
    this.renderAll();
    void this.renderPdfPage();
  }

  private setZoom(zoom: number, target?: { x: number; y: number }, anchor?: { x: number; y: number }): void {
    const clamped = Math.max(PDF_ZOOM_MIN, Math.min(PDF_ZOOM_MAX, zoom));
    if (clamped === this.zoom) return;
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
    this.layoutPage();
    const after = page.getBoundingClientRect();
    scroller.scrollLeft += after.left + anchor.x * after.width - target.x;
    scroller.scrollTop += after.top + anchor.y * after.height - target.y;
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
    this.resizePreview();
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
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
    this.eraserCursor = host.createDiv({ cls: "ink-eraser-cursor", attr: { "aria-hidden": "true" } });
    this.eraserCursor.createSpan({ cls: "ink-eraser-reference-point" });
    const tileLayer = host.createDiv({ cls: "ink-tile-layer" });
    this.tiles = new TileRenderer(tileLayer);
    this.canvas = host.createEl("canvas", { cls: "ink-canvas ink-selection-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.lassoCanvas = host.createEl("canvas", { cls: "ink-canvas ink-lasso-preview-canvas" });
    this.lassoCanvas.style.pointerEvents = "none";
    this.lassoCtx = this.lassoCanvas.getContext("2d");
    this.confirmedPreviewCanvas = host.createEl("canvas", { cls: "ink-canvas ink-confirmed-preview-canvas" });
    this.confirmedPreviewCanvas.style.pointerEvents = "none";
    this.confirmedPreviewCtx = this.confirmedPreviewCanvas.getContext("2d");
    this.previewCanvas = host.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCanvas.style.pointerEvents = "none";
    this.previewCtx = this.previewCanvas.getContext("2d");
    // The paper owns the gestures in editing mode (same as the notebook page).
    host.style.touchAction = "none";
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
    host.addEventListener("wheel", (event) => this.onWheel(event as WheelEvent), { passive: false });
    // Shared with the notebook editor: catches the stroke end when iPadOS
    // interrupts a Pencil (system gesture, haptic tick) or the pen lifts
    // outside an uncaptured host - otherwise the stroke stays preview-only
    // and the next render wipes it ("write a stroke, lose a stroke").
    registerDocumentPointerEndEvents(host, (cleanup) => this.register(cleanup), (event, cancelled) => {
      void cancelled;
      this.onDocumentPointerEnd(event);
    });
  }

  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY < 0 ? PDF_ZOOM_STEP : 1 / PDF_ZOOM_STEP), { x: event.clientX, y: event.clientY });
  }

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
    return this.editingLocked();
  }

  private editingLocked(): boolean {
    return !this.canEdit() || !this.writerHeld;
  }

  protected pagePixelSize(): { width: number; height: number } {
    return { width: this.canvasLogicalWidth, height: this.canvasLogicalHeight };
  }

  protected onModelMutated(): void {
    if (!this.sidecar) return;
    this.sidecar.updatedAt = Date.now();
    this.dirty = true;
  }

  protected onRenderResize(): void {
    this.layoutPage();
  }

  protected toolbarRoot(): HTMLElement { return this.root!; }
  protected inputScroller(): HTMLElement { return this.scroller!; }
  protected applyGestureZoom(value: number, focus: { x: number; y: number }, anchor: { x: number; y: number }): void {
    this.setZoom(value, focus, anchor);
  }

  protected swipeNavigate(delta: number): void {
    this.navigatePages(delta);
  }
  protected settingsOpen(): boolean { return this.brushPopover?.isOpen ?? false; }
  protected toggleToolSettings(): void {
    this.brushPopover.toggle();
  }
  protected reopenToolSettings(): void {
    this.brushPopover.open();
    this.brushPopover.position();
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
  }

  protected renderAll(): void {
    this.clampNoteIndex();
    this.updatePageIndicator();
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
    this.cancelPdfRender();
    this.finishPointerInput(false);
    this.discardPendingInkPreview();
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
    this.clearSaveTimers();
    this.setStatus("Loading PDF…");
  }

  private setStatus(message: string, isError = false): void {
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

  protected performScheduledSave(): void {
    void this.flushSaveNow().then((outcome) => {
      if (outcome.status === "saved") this.setStatus("");
      else this.setStatus(`Save ${outcome.status}: ${outcome.message}`, true);
    });
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
