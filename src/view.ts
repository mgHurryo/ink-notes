import { Menu, Notice, Scope, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { intervalStats } from "./diagnostics";
import {
  InkNotebook,
  InkPage,
  InkStroke,
  PaperStyle,
  createNotebook,
  mergeNotebooks,
  newId,
} from "./model";
import { NotebookStore } from "./storage";
import { registerDocumentPointerEndEvents } from "./ink-input";
import { InkWritingView, InkPointerSample, cloneStroke, SPARSE_SAMPLE_INTERVAL_MS } from "./ink-writing";
export { BrushSettings, BrushTool, INK_COLORS, isBrushTool } from "./brush-popover";
export {
  ToolState,
  EraserMode,
  InkPointerSample,
  clampLiftPressure,
  penSampleTimeMillis,
  strokeIntersectsEraser,
  eraseStrokeSegments,
  cloneStroke,
  clonePoints,
  packStrokePoints,
  translatePoints,
  selectionBounds,
  boundsForPointSets,
  pointInPolygon,
  constrainDelta,
  distance,
} from "./ink-writing";
import { canvasResolution } from "./rendering";
import { BrushPopoverController, BrushSettings } from "./brush-popover";
import { TileRenderer } from "./tiles";
import type { NotebookOperation } from "./worker-protocol";
import { InkWorkerRequestError, InkWorkerService, InkWorkerSession } from "./worker-service";

export const VIEW_TYPE_INK = "ink-notes-view";

const SAVE_CONFLICT_RETRIES = 3;

interface NotebookReconciliation {
  pageIndex: number;
  pageRailChanged: boolean;
  currentPageChanged: boolean;
  currentInkChanged: boolean;
  currentPaperChanged: boolean;
  dimensionsChanged: boolean;
}

const OVERLAY_RESIZE_BUDGET = 4_000_000;

class SaveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SaveConflictError";
  }
}

export class InkView extends InkWritingView {
  private readonly store: NotebookStore;
  private notebook: InkNotebook = createNotebook();
  private pageIndex = 0;
  private root!: HTMLElement;
  private pageBaseWidth = 1;
  private pageBaseHeight = 1;
  private pageElement!: HTMLElement;
  private pageExtent!: HTMLElement;
  private pageScroller!: HTMLElement;
  private syncing = false;
  private saveRequested = false;
  private activeSave: Promise<void> | null = null;
  private dirtyRevision = 0;
  private savedRevision = 0;
  private pendingMergedNotebook: InkNotebook | null = null;
  private pendingMergedNotebookIsFinal = false;
  private externalRefreshPending = false;
  /** Reading mode: view-only. Ink tools, the popover and eraser tracking are
   *  disabled and the page restores native panning/scrolling. */
  private readingMode = false;
  private sizePopover: HTMLElement | null = null;
  private sizePopoverButton: HTMLButtonElement | null = null;
  private sizePopoverOpen = false;
  private zoomRenderTimer: number | undefined;
  private pageNavigationGeneration = 0;
  private devPanel: HTMLElement | null = null;
  private devPanelRefreshTimer: number | undefined;

  constructor(leaf: WorkspaceLeaf, store: NotebookStore, workers?: InkWorkerService) {
    super(leaf);
    this.store = store;
    this.workers = workers;
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", () => { this.undo(); return false; });
    this.scope.register(["Mod", "Shift"], "z", () => { this.redo(); return false; });
  }

  getViewType(): string { return VIEW_TYPE_INK; }
  getDisplayText(): string { return this.file?.basename ?? this.notebook.title; }
  getIcon(): string { return "pen-line"; }

  revealPage(pageId: string): void {
    this.navigateToPage(pageId);
  }

  async onOpen(): Promise<void> {
    this.root = this.containerEl.children[1] as HTMLElement;
    this.root.empty();
    this.root.addClass("ink-notes-view");
    this.root.addClass("ink-rail-hidden");
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
    this.root.createSpan({ cls: "ink-page-status", attr: { "aria-live": "polite" } });
    this.renderToolbar();
    this.renderCanvas();
    this.viewReady = true;
    this.renderAll();
  }

  async onClose(): Promise<void> {
    this.pageNavigationGeneration += 1;
    this.closeDevPanel();
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
    this.finishPointerInput(false);
    this.cancelPendingInkCommitTimer();
    this.clearSaveTimers();
    if (this.file && (this.dirtyRevision > this.savedRevision || this.activeSave)) await this.save(this.file);
    this.tiles?.setBackend?.(null);
    this.workerSession?.dispose();
    this.workerSession = null;
    this.tiles?.dispose();
    this.viewReady = false;
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.pageNavigationGeneration += 1;
    this.tiles?.setBackend?.(null);
    this.workerSession?.dispose();
    this.workerSession = null;
    this.workerRevision = 0;
    if (this.workers) {
      // The Worker revision includes transient start/append operations that do
      // not advance the persisted dirty revision until pointerup.
      const session = this.workers.createSession(() => ({ notebook: this.notebook, revision: this.workerRevision }));
      try {
        this.notebook = await session.initializeRaw(await this.store.readRaw(file), 0);
        this.workerSession = session;
        this.workerRevision = 0;
        if (session.canRenderTiles()) this.tiles?.setBackend(session, (error) => {
          if (this.workerSession === session) this.disableWorkerSession(error);
        });
      } catch {
        session.dispose();
        this.notebook = await this.store.read(file);
      }
    } else {
      this.notebook = await this.store.read(file);
    }
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.resetInteraction();
    this.dirtyRevision = 0;
    this.savedRevision = 0;
    this.workerRevision = 0;
    this.renderAll();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.pageNavigationGeneration += 1;
    this.finishPointerInput(false);
    this.cancelPendingInkCommitTimer();
    this.clearSaveTimers();
    if (this.dirtyRevision > this.savedRevision || this.activeSave) await this.save(file);
    this.tiles?.setBackend?.(null);
    this.workerSession?.dispose();
    this.workerSession = null;
  }

  async reloadFromDisk(): Promise<void> {
    if (this.syncing || this.activePointerId !== null || this.pendingInkStrokes.length > 0) { this.externalRefreshPending = true; return; }
    if (!this.file) return;
    const file = this.file;
    if (this.workerSession) {
      const latest = await this.workerSession.mergeExternal(await this.store.readRaw(file));
      if (this.file !== file) return;
      if (!latest) return;
      this.receiveMergedNotebook(latest, true);
      return;
    }
    const latest = await this.store.read(file);
    if (this.file !== file) return;
    if (notebooksEqual(latest, this.notebook)) return;
    this.receiveMergedNotebook(latest);
  }

  private renderToolbar(): void {
    const toolbar = this.root.querySelector<HTMLElement>(".ink-toolbar")!;
    toolbar.empty();
    const group = toolbar;
    // Far-left settings entry for both editors (the popover carries the
    // sample-stroke preview); tools no longer sit next to it.
    const settings = this.addToolbarSection(group, "Settings");
    this.addSizePopover(settings);
    const navigation = this.addToolbarSection(group, "Pages");
    const toggle = this.addIconButton(navigation, "panel-left", "Pages", () => {
      const hidden = !this.root.hasClass("ink-rail-hidden");
      this.root.toggleClass("ink-rail-hidden", hidden);
      toggle.setAttribute("aria-pressed", String(!hidden));
      this.resizeCanvas();
    });
    toggle.setAttribute("aria-pressed", String(!this.root.hasClass("ink-rail-hidden")));

    const tools = this.addToolbarSection(group, "Draw");
    this.addToolButton(tools, "pen-line", "Pen", "pen");
    this.addToolButton(tools, "highlighter", "Highlight", "highlighter");
    this.addToolButton(tools, "eraser", "Erase", "eraser");
    this.addToolButton(tools, "lasso-select", "Select", "lasso");

    const history = this.addToolbarSection(group, "History");
    this.addIconButton(history, "undo-2", "Undo", () => this.undo(), this.undoStack.length === 0);
    this.addIconButton(history, "redo-2", "Redo", () => this.redo(), this.redoStack.length === 0);
    const pages = this.addToolbarSection(group, "Document");
    this.addIconButton(pages, "more-horizontal", "Page options", (event) => this.openPageMenu(event));
    this.updateToolButtons();
  }

  private addSizePopover(parent: HTMLElement): void {
    const container = parent.createDiv({ cls: "ink-size-popover-control" });
    const button = container.createEl("button", {
      cls: "ink-size-button",
      attr: {
        type: "button",
        "aria-label": "Brush size",
        "aria-hidden": "true",
        tabindex: "-1",
      },
    });
    const icon = button.createSpan({ cls: "ink-button-icon" });
    setIcon(icon, "sliders-horizontal");
    void icon;
    button.title = "Brush size and opacity";

    // Shared brush settings popover (same controller as the PDF view): pinned
    // preview header, vertical-only scroll body, gesture shield included.
    const brushPopover = new BrushPopoverController(container, {
      tools: this.brushToolConfigs(),
      getSettings: (tool) => this.brushSettings(tool),
      activeTool: () => this.state.tool,
      showPenDynamics: () => this.state.tool === "pen",
      buildExtras: (body, api) => this.buildEraserSettings(body, api.addRange),
      onControlsChanged: () => this.updateEraserControls(),
      anchor: () => this.activeToolButton() ?? this.sizePopoverButton,
    });
    this.sizePopover = brushPopover.root;
    this.settingsPanel = brushPopover.root;
    this.sizePopoverButton = button;
    this.brushPopover = brushPopover;

    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSizePopoverOpen(!this.sizePopoverOpen);
    });
    this.registerDomEvent(document, "pointerdown", (event) => {
      const target = event.target as HTMLElement | null;
      const switchingSettingsTool = target?.closest?.(".ink-tool-button[aria-haspopup='dialog']");
      if (this.sizePopoverOpen && !container.contains(target) && !switchingSettingsTool) this.setSizePopoverOpen(false);
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && this.sizePopoverOpen) {
        this.setSizePopoverOpen(false);
        this.activeToolButton()?.focus();
      }
    });
    this.registerDomEvent(window, "resize", () => this.brushPopover.position());
    this.registerDomEvent(window, "scroll", () => this.brushPopover.position(), true);
  }

  private setSizePopoverOpen(open: boolean): void {
    this.sizePopoverOpen = open;
    open ? this.brushPopover.open() : this.brushPopover.close();
    this.root.querySelectorAll<HTMLElement>(".ink-tool-button[aria-haspopup='dialog']").forEach((button) => {
      button.setAttribute("aria-expanded", String(open && button.dataset.tool === this.state.tool));
    });
    if (open) {
      window.requestAnimationFrame(() => {
        const focusTarget = this.state.tool === "eraser"
          ? ".ink-eraser-mode"
          : `.ink-brush-settings[data-brush-tool="${this.state.tool}"] input, .ink-brush-settings[data-brush-tool="${this.state.tool}"] button`;
        this.sizePopover?.querySelector<HTMLElement>(focusTarget)?.focus();
      });
    }
  }

  private activeToolButton(): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>(`.ink-toolbar [data-tool="${this.state.tool}"]`);
  }



  private renderCanvas(): void {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    workspace.createDiv({ cls: "ink-page-rail", attr: { "aria-label": "Notebook pages" } });
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageExtent = this.pageScroller.createDiv({ cls: "ink-page-extent" });
    this.pageElement = this.pageExtent.createDiv({ cls: "ink-page" });
    this.eraserCursor = this.pageElement.createDiv({ cls: "ink-eraser-cursor", attr: { "aria-hidden": "true" } });
    this.eraserCursor.createSpan({ cls: "ink-eraser-reference-point" });
    const tileHost = this.pageElement.createDiv({ cls: "ink-tile-layer" });
    tileHost.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.tiles = new TileRenderer(tileHost);
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-selection-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.setAttribute("aria-label", "Handwriting canvas");
    this.lassoCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-lasso-preview-canvas" });
    this.lassoCanvas.style.display = "none";
    this.lassoCanvas.style.pointerEvents = "none";
    this.lassoCtx = this.lassoCanvas.getContext("2d")!;
    this.confirmedPreviewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-confirmed-preview-canvas" });
    this.confirmedPreviewCanvas.style.pointerEvents = "none";
    this.confirmedPreviewCtx = this.confirmedPreviewCanvas.getContext("2d")!;
    this.previewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCanvas.style.pointerEvents = "none";
    this.previewCtx = this.previewCanvas.getContext("2d")!;
    this.canvas.style.pointerEvents = "none";
    this.pageElement.style.touchAction = "none";
    this.registerDomEvent(this.pageElement, "pointerenter", (event) => this.onPointerEnter(event));
    this.registerDomEvent(this.pageElement, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.pageElement, "pointermove", (event) => this.onPointerMove(event));
    // Chromium hosts (Obsidian desktop) stream every hardware pen sample as it
    // arrives instead of batching it into the next frame's pointermove. WebKit
    // (iPad) never exposes the event, so the gate keeps iPad behavior unchanged.
    if ("onpointerrawupdate" in window) {
      this.registerDomEvent(this.pageElement, "pointerrawupdate" as keyof HTMLElementEventMap, (event) => this.onPointerRawUpdate(event as InkPointerSample));
    }
    this.registerDomEvent(this.pageElement, "pointerleave", () => {
      this.eraserPointerInside = false;
      this.refreshEraserCursor();
    });
    this.registerDomEvent(this.pageElement, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.pageElement, "pointercancel", (event) => this.onPointerCancel(event));
    this.registerDomEvent(this.pageElement, "lostpointercapture", (event) => this.onLostPointerCapture(event));
    registerDocumentPointerEndEvents(this.pageElement, (cleanup) => this.register(cleanup), (event) => this.onDocumentPointerEnd(event));
    this.registerDomEvent(this.pageElement, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchcancel", (event) => {
      this.onStylusTouch(event);
      this.touchGesture = null;
    }, { passive: false });
    const observer = new ResizeObserver(() => this.resizeCanvas());
    observer.observe(this.pageScroller);
    this.register(() => observer.disconnect());
  }

  private renderPageRail(): void {
    let rail = this.root.querySelector<HTMLElement>(".ink-page-rail");
    if (!rail) return;
    rail.empty();
    const header = rail.createDiv({ cls: "ink-rail-header" });
    header.createDiv({ cls: "ink-rail-heading", text: "Pages" });
    header.createSpan({ cls: "ink-rail-count", text: `${this.pageIndex + 1} / ${this.notebook.pages.length}` });
    const actions = rail.createDiv({ cls: "ink-rail-actions", attr: { role: "group", "aria-label": "Current page actions" } });
    this.addIconButton(actions, "chevron-up", "Move current page up", () => this.moveCurrentPage(-1), this.pageIndex === 0);
    this.addIconButton(actions, "chevron-down", "Move current page down", () => this.moveCurrentPage(1), this.pageIndex === this.notebook.pages.length - 1);
    this.addIconButton(actions, "copy", "Duplicate current page", () => this.duplicateCurrentPage());
    this.addIconButton(actions, "trash-2", "Delete current page", () => this.deleteCurrentPage(), this.notebook.pages.length <= 1);
    this.notebook.pages.forEach((page, index) => {
      const button = rail!.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.setAttribute("aria-label", String(index + 1) + ": " + page.title);
      button.setAttribute("aria-current", String(index === this.pageIndex));
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.createSpan({ text: page.title, cls: "ink-page-thumb-title" });
      button.addEventListener("click", () => this.navigateToPage(page.id));
    });
    rail.querySelector<HTMLElement>(".ink-page-thumb.is-active")?.scrollIntoView?.({ block: "nearest" });
  }

  private renderPage(): void {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    if (this.pendingInkPageId && this.pendingInkPageId !== page.id) this.discardPendingInkPreview();
    this.updatePageStatus();
    this.pageElement.className = `ink-page ink-paper-${page.paper}`;
    this.pageElement.style.aspectRatio = `${this.notebook.pageWidth} / ${this.notebook.pageHeight}`;
    this.resizeCanvas();
    this.root.querySelectorAll<HTMLElement>(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }

  private updatePageStatus(): void {
    const status = this.root?.querySelector<HTMLElement>(".ink-page-status");
    if (status) status.textContent = (this.pageIndex + 1) + " / " + this.notebook.pages.length;
  }

  private resizeCanvas(): void {
    if (!this.canvas || !this.pageElement) return;
    this.layoutPage();
    const rect = this.pageElement.getBoundingClientRect();
    this.canvasLogicalWidth = Math.max(1, Math.round(this.pageBaseWidth * 64) / 64);
    this.canvasLogicalHeight = Math.max(1, Math.round(this.pageBaseHeight * 64) / 64);
    this.refreshEraserCursor();
    this.tiles!.setDisplayScale(this.zoom);
    this.tiles!.setPage(this.currentPage(), this.canvasLogicalWidth, this.canvasLogicalHeight, this.tileExclusion());
    this.updateViewport(true);
  }

  private updateViewport(refine: boolean): void {
    const page = this.pageElement.getBoundingClientRect();
    const screen = this.pageScroller.getBoundingClientRect();
    const x = Math.max(0, (screen.left - page.left) / this.zoom);
    const y = Math.max(0, (screen.top - page.top) / this.zoom);
    this.viewport = { x, y,
      width: Math.max(1, Math.min(this.canvasLogicalWidth - x, (screen.right - page.left) / this.zoom - x)),
      height: Math.max(1, Math.min(this.canvasLogicalHeight - y, (screen.bottom - page.top) / this.zoom - y)) };
    this.tiles!.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    if (refine || this.hasInkPreview()) {
      this.resizeOverlay(this.canvas, this.ctx);
      this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
      this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
      if (this.hasInkPreview()) { this.resizePreview(); this.drawPreview(); }
    }
    if (refine) this.tiles!.prewarm(this.notebook.pages.filter((_, index) => Math.abs(index - this.pageIndex) === 1));
  }




  private onViewportMotion(): void {
    this.updateViewport(false);
    if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
    this.zoomRenderTimer = window.setTimeout(() => {
      this.zoomRenderTimer = undefined;
      this.updateViewport(true);
    }, 100);
  }

  protected onRenderResize(): void {
    this.resizeCanvas();
  }


  protected resizeOverlay(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, maxPixels = OVERLAY_RESIZE_BUDGET): boolean {
    const { x, y, width, height } = this.viewport;
    const resolution = canvasResolution(width, height, window.devicePixelRatio || 1, this.zoom, maxPixels);
    const left = x * this.zoom + "px", top = y * this.zoom + "px";
    const displayWidth = width * this.zoom + "px", displayHeight = height * this.zoom + "px";
    const changed = canvas.width !== resolution.width || canvas.height !== resolution.height
      || canvas.style.left !== left || canvas.style.top !== top
      || canvas.style.width !== displayWidth || canvas.style.height !== displayHeight;
    if (canvas.width !== resolution.width) canvas.width = resolution.width;
    if (canvas.height !== resolution.height) canvas.height = resolution.height;
    canvas.style.left = left; canvas.style.top = top;
    canvas.style.width = displayWidth; canvas.style.height = displayHeight;
    canvas.style.right = "auto"; canvas.style.bottom = "auto";
    ctx.setTransform(resolution.width / width, 0, 0, resolution.height / height, -x * (resolution.width / width), -y * (resolution.height / height));
    return changed;
  }






  // ------------------------------------------------------ writing-layer seams

  protected currentNotebook(): InkNotebook { return this.notebook; }
  protected currentPage(): InkPage { return this.notebook.pages[this.pageIndex]; }
  protected inputRect(): DOMRect { return this.pageElement.getBoundingClientRect(); }
  protected inputHost(): HTMLElement { return this.pageElement; }
  protected inputLocked(): boolean { return this.readingMode; }
  protected pagePixelSize(): { width: number; height: number } {
    return { width: this.notebook.pageWidth, height: this.notebook.pageHeight };
  }
  protected onModelMutated(): void {
    this.dirtyRevision += 1;
  }
  protected onInputStarting(): void {
    this.pageNavigationGeneration += 1;
  }
  protected afterInputFullySettled(): void {
    if (this.externalRefreshPending && this.pendingInkStrokes.length === 0) {
      this.externalRefreshPending = false;
      void this.reloadFromDisk().catch((error) => new Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  protected diagnosticsCaptureRawPoints(): boolean { return this.devPanel !== null; }
  protected performScheduledSave(): void { void this.save(); }
  protected toolbarRoot(): HTMLElement { return this.root; }
  protected inputScroller(): HTMLElement { return this.pageScroller; }
  protected applyGestureZoom(value: number, focus: { x: number; y: number }, anchor: { x: number; y: number }): void {
    this.setZoom(value, focus, anchor);
  }

  protected swipeNavigate(delta: number): void {
    this.changePage(delta);
  }
  protected settingsOpen(): boolean { return this.sizePopoverOpen; }
  protected toggleToolSettings(): void {
    this.setSizePopoverOpen(!this.sizePopoverOpen);
  }
  protected reopenToolSettings(): void {
    this.setSizePopoverOpen(true);
    this.brushPopover.position();
  }

  private receiveMergedNotebook(notebook: InkNotebook, alreadyMerged = false): void {
    this.pendingMergedNotebook = this.pendingMergedNotebook
      ? mergeNotebooks(this.pendingMergedNotebook, notebook)
      : notebook;
    this.pendingMergedNotebookIsFinal ||= alreadyMerged;
    // Reads and saves can finish after the next pointerdown. Apply only between strokes.
    if (this.activePointerId === null && this.pendingInkStrokes.length === 0) this.applyPendingMergedNotebook();
  }

  protected applyPendingMergedNotebook(): void {
    if (!this.pendingMergedNotebook || this.activePointerId !== null || this.pendingInkStrokes.length > 0) return;
    const pageId = this.currentPage().id;
    const previousPageIndex = this.pageIndex;
    const merged = this.pendingMergedNotebookIsFinal
      ? this.pendingMergedNotebook
      : mergeNotebooks(this.pendingMergedNotebook, this.notebook);
    this.pendingMergedNotebook = null;
    this.pendingMergedNotebookIsFinal = false;
    const changes = reconcileNotebook(this.notebook, merged, pageId, previousPageIndex);
    this.pageIndex = changes.pageIndex;

    // A save result usually differs only in merge metadata. Keep the current
    // page and TileRenderer state alive instead of rebuilding the whole view.
    if (changes.pageRailChanged) this.renderPageRail();
    if (changes.currentPageChanged || changes.currentPaperChanged || changes.dimensionsChanged) {
      this.renderPage();
    } else {
      if (changes.pageRailChanged) this.updatePageStatus();
      if (changes.currentInkChanged) this.drawStrokes(this.currentPage().strokes);
    }
  }

  // ------------------------------------------------------------ dev panel

  /** Developer diagnostics overlay: live capture telemetry plus per-stroke
   *  records, exportable as JSON. Read-only; never mutates ink state. */
  toggleDevPanel(): void {
    if (this.devPanel) { this.closeDevPanel(); return; }
    const panel = this.root.createDiv({ cls: "ink-dev-panel" });
    const actions = panel.createDiv({ cls: "ink-dev-panel-actions" });
    const exportButton = actions.createEl("button", { text: "Export JSON", attr: { type: "button" } });
    exportButton.addEventListener("click", () => this.exportDiagnosticsJson(false));
    const copyButton = actions.createEl("button", { text: "Copy JSON", attr: { type: "button" } });
    copyButton.addEventListener("click", () => this.exportDiagnosticsJson(true));
    panel.createDiv({ cls: "ink-dev-panel-output" });
    this.devPanel = panel;
    this.devPanelRefreshTimer = window.setInterval(() => this.refreshDevPanel(), 250);
    this.refreshDevPanel();
  }

  private closeDevPanel(): void {
    if (this.devPanelRefreshTimer !== undefined) {
      window.clearInterval(this.devPanelRefreshTimer);
      this.devPanelRefreshTimer = undefined;
    }
    this.devPanel?.remove();
    this.devPanel = null;
  }

  private devVersion(): string {
    const plugins = (this.app as unknown as { plugins?: { getPlugin?(id: string): { manifest?: { version?: string } } } }).plugins;
    return plugins?.getPlugin?.("ink-notes")?.manifest?.version ?? "unknown";
  }

  private hasPointerApi(name: string): boolean {
    return typeof PointerEvent !== "undefined" && typeof (PointerEvent.prototype as unknown as Record<string, unknown>)[name] === "function";
  }

  private refreshDevPanel(): void {
    const output = this.devPanel?.querySelector<HTMLElement>(".ink-dev-panel-output");
    if (!output) return;
    const rate = intervalStats(this.penSampleIntervals);
    const lines: string[] = [];
    lines.push(`Ink Notes dev — build ${this.devVersion()}`);
    lines.push(`ENV pointer=${this.devLastPointerType ?? "-"} coalesced=${this.hasPointerApi("getCoalescedEvents") ? "yes" : "no"} rawupdate=${"onpointerrawupdate" in window ? "yes" : "no"} predicted=${this.hasPointerApi("getPredictedEvents") ? "yes" : "no"} touch=${navigator.maxTouchPoints ?? 0} dpr=${(window.devicePixelRatio || 1).toFixed(2)} zoom=${this.zoom.toFixed(2)}`);
    lines.push(`INPUT events=${this.devPointerEvents} rawupdates=${this.devRawUpdates} coalescedPts=${this.devCoalescedSamples} samplesFed=${this.devSamplesFed} predicted=${this.devPredictedSamples}`);
    lines.push(`RATE n=${rate.count}${rate.min !== null ? ` min=${rate.min.toFixed(1)}ms median=${rate.median?.toFixed(1)}ms mean=${rate.mean?.toFixed(1)}ms max=${rate.max?.toFixed(1)}ms` : ""}${rate.mean !== null && rate.mean > 0 ? ` (~${(1000 / rate.mean).toFixed(0)} Hz)` : ""}`);
    lines.push(`SPARSE threshold=${SPARSE_SAMPLE_INTERVAL_MS}ms flagged=${this.penInputSparse() ? "YES" : "no"}`);
    lines.push(`MODE tool=${this.state.tool} smooth=${this.state.pen.smooth ?? 0} (${(this.state.pen.smooth ?? 0) === 0 ? "Direct" : "modeler strength"})`);
    const current = this.currentStrokeRecord;
    if (current) {
      lines.push(`ACTIVE #${current.index} engaged=${current.engaged ? current.reason : "no"} raw=${current.rawSamples} stored=${this.activeStroke?.points.length ?? 0} fallback=${current.fallback ? "YES" : "no"}`);
    }
    if (this.strokeRecords.length > 0) lines.push("STROKES (most recent last):");
    for (const record of this.strokeRecords) {
      const intervals = record.intervals.median !== null ? ` median=${record.intervals.median.toFixed(1)}ms` : "";
      const lift = record.liftDistancePx !== null ? ` liftΔ=${record.liftDistancePx.toFixed(2)}px` : "";
      lines.push(`#${record.index} ${record.engaged ? record.reason : "direct"} raw=${record.rawSamples} stored=${record.pointsStored} ${record.durationMs ?? "-"}ms fallback=${record.fallback ? "YES" : "no"}${intervals}${lift}${record.smooth > 0 ? ` smooth=${record.smooth}` : ""}`);
    }
    output.setText(lines.join("\n"));
  }

  exportDiagnosticsJson(toClipboard: boolean): void {
    const environment = {
      version: this.devVersion(),
      lastPointerType: this.devLastPointerType,
      coalescedApi: this.hasPointerApi("getCoalescedEvents"),
      rawUpdateApi: "onpointerrawupdate" in window,
      predictedApi: this.hasPointerApi("getPredictedEvents"),
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      devicePixelRatio: window.devicePixelRatio || 1,
      zoom: this.zoom,
    };
    const report = {
      format: "ink-notes-diagnostics",
      version: environment.version,
      generatedAt: new Date().toISOString(),
      environment,
      counters: {
        pointerEvents: this.devPointerEvents,
        rawUpdates: this.devRawUpdates,
        coalescedSamples: this.devCoalescedSamples,
        samplesFed: this.devSamplesFed,
      },
      sampleIntervals: intervalStats(this.penSampleIntervals),
      sampleIntervalsRaw: [...this.penSampleIntervals],
      sparse: { thresholdMs: SPARSE_SAMPLE_INTERVAL_MS, flagged: this.penInputSparse() },
      mode: { tool: this.state.tool, smooth: this.state.pen.smooth ?? 0 },
      strokes: this.strokeRecords,
    };
    const text = JSON.stringify(report, null, 2);
    if (toClipboard) {
      void navigator.clipboard.writeText(text)
        .then(() => new Notice("Ink diagnostics copied to the clipboard."))
        .catch((error) => new Notice(`Ink Notes could not copy diagnostics: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ink-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    new Notice(`Exported ${report.strokes.length} stroke records.`);
  }

  // ------------------------------------------------------------ page tools

  private addPage(): void {
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const now = Date.now();
    const page: InkPage = { id: newId("page"), title: `Page ${this.notebook.pages.length + 1}`, paper: "ruled", strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
    this.notebook.pages.push(page);
    this.notebook.pageOrder.push(page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    this.queueWorkerOperation({ type: "page-operation", action: "add", page: clonePage(page),
      pageOrder: [...this.notebook.pageOrder], pageOrderUpdatedAt: now, notebookUpdatedAt: now });
    this.pageIndex = this.notebook.pages.length - 1;
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }

  private changePage(delta: number): void {
    const index = Math.max(0, Math.min(this.notebook.pages.length - 1, this.pageIndex + delta));
    const page = this.notebook.pages[index];
    if (page) this.navigateToPage(page.id);
  }

  private navigateToPage(pageId: string): void {
    if (this.currentPage().id === pageId || !this.pageById(pageId)) return;
    this.finishPointerInput(false);
    this.clearSaveTimers();
    const navigationGeneration = ++this.pageNavigationGeneration;
    const file = this.file;
    const session = this.workerSession;
    const workerRevision = this.workerRevision;
    void (async () => {
      if (file && (this.dirtyRevision > this.savedRevision || this.activeSave)) {
        await this.save(file);
      } else if (session) {
        // A page can be selected while non-persistent Worker work is still in
        // flight. Do not tear down the old page's render context before every
        // operation through this point has been acknowledged.
        try {
          await session.barrier(workerRevision);
        } catch (error) {
          if (this.workerSession === session) this.disableWorkerSession(error);
        }
      }
      if (navigationGeneration !== this.pageNavigationGeneration || !this.viewReady || file !== this.file) return;
      const index = this.notebook.pages.findIndex((page) => page.id === pageId);
      if (index < 0) return;
      this.pageIndex = index;
      this.renderPageRail();
      this.renderPage();
    })().catch((error) => new Notice(`Ink Notes could not switch pages: ${error instanceof Error ? error.message : String(error)}`));
  }

  private openPageMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const paper of ["blank", "ruled", "grid", "dot"] as PaperStyle[]) menu.addItem((item) => item.setTitle(`Paper: ${paper}`).setChecked(this.currentPage().paper === paper).onClick(() => {
      const page = this.currentPage();
      const before = page.paper;
      page.paper = paper;
      this.markChanged(page);
      this.queueWorkerOperation({ type: "set-page", pageId: page.id, paper,
        pageUpdatedAt: page.updatedAt, notebookUpdatedAt: this.notebook.updatedAt });
      this.pushCommand({
        undo: () => this.setPagePaper(page.id, before),
        redo: () => this.setPagePaper(page.id, paper),
        rebuild: true,
      });
      this.renderPageRail(); this.renderPage(); this.scheduleSave();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Add page").onClick(() => this.addPage()));
    menu.addItem((item) => item.setTitle("Rename page").onClick(() => this.renamePage()));
    menu.addItem((item) => item.setTitle("Duplicate page").onClick(() => this.duplicateCurrentPage()));
    menu.addItem((item) => item.setTitle("Move page up").setDisabled(this.pageIndex === 0).onClick(() => this.moveCurrentPage(-1)));
    menu.addItem((item) => item.setTitle("Move page down").setDisabled(this.pageIndex === this.notebook.pages.length - 1).onClick(() => this.moveCurrentPage(1)));
    menu.addItem((item) => item.setTitle("Delete page").setDisabled(this.notebook.pages.length <= 1).onClick(() => this.deleteCurrentPage()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Copy page embed syntax").onClick(() => void this.copyCurrentPageEmbed()));
    menu.addItem((item) => item.setTitle("Zoom out").setDisabled(this.zoom <= 0.5).onClick(() => this.setZoom(this.zoom - 0.1)));
    menu.addItem((item) => item.setTitle("Reset zoom").setDisabled(this.zoom === 1).onClick(() => this.setZoom(1)));
    menu.addItem((item) => item.setTitle("Zoom in").setDisabled(this.zoom >= 3).onClick(() => this.setZoom(this.zoom + 0.1)));
    menu.showAtMouseEvent(event);
  }

  private renamePage(): void {
    const title = window.prompt("Page title", this.currentPage().title)?.trim();
    if (!title) return;
    const page = this.currentPage();
    const before = page.title;
    page.title = title;
    this.markChanged(page);
    this.queueWorkerOperation({ type: "set-page", pageId: page.id, title,
      pageUpdatedAt: page.updatedAt, notebookUpdatedAt: this.notebook.updatedAt });
    this.pushCommand({
      undo: () => this.setPageTitle(page.id, before),
      redo: () => this.setPageTitle(page.id, title),
      rebuild: true,
    });
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }

  private duplicateCurrentPage(): void {
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const source = clonePage(this.currentPage());
    const insertionIndex = this.pageIndex + 1;
    const now = Date.now();
    const page = clonePageAsNew(source, `${source.title} copy`, now);
    this.notebook.pages.splice(insertionIndex, 0, page);
    this.pageIndex += 1;
    this.finishPageOrderChange(now, { type: "page-operation", action: "duplicate", page: clonePage(page),
      pageOrder: this.notebook.pages.map((candidate) => candidate.id), pageOrderUpdatedAt: now, notebookUpdatedAt: now });
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderAll();
    this.scheduleSave();
  }

  private deleteCurrentPage(): void {
    if (this.notebook.pages.length <= 1) return;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const deletedIndex = this.pageIndex;
    const [deleted] = this.notebook.pages.splice(this.pageIndex, 1);
    const now = Date.now();
    this.notebook.deletedPages[deleted.id] = now;
    this.pageIndex = Math.min(this.pageIndex, this.notebook.pages.length - 1);
    this.finishPageOrderChange(now, { type: "page-operation", action: "delete", pageId: deleted.id, deletedAt: now,
      pageOrder: this.notebook.pages.map((candidate) => candidate.id), pageOrderUpdatedAt: now, notebookUpdatedAt: now });
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, this.currentPage().id);
    this.clearSelection();
    this.renderAll();
    this.scheduleSave();
  }

  private moveCurrentPage(delta: number): void {
    const target = this.pageIndex + delta;
    if (target < 0 || target >= this.notebook.pages.length) return;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const pageId = this.currentPage().id;
    const [page] = this.notebook.pages.splice(this.pageIndex, 1);
    this.notebook.pages.splice(target, 0, page);
    this.pageIndex = target;
    const now = Date.now();
    this.finishPageOrderChange(now, { type: "page-operation", action: "reorder",
      pageOrder: this.notebook.pages.map((candidate) => candidate.id), pageOrderUpdatedAt: now, notebookUpdatedAt: now });
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), pageId, pageId);
    this.renderAll();
    this.scheduleSave();
  }

  private finishPageOrderChange(now: number, operation?: NotebookOperation): void {
    this.notebook.pageOrder = this.notebook.pages.map((page) => page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    this.queueWorkerOperation(operation ?? { type: "page-operation", action: "reorder",
      pageOrder: [...this.notebook.pageOrder], pageOrderUpdatedAt: now, notebookUpdatedAt: now });
  }

  private pushNotebookCommand(before: InkNotebook, after: InkNotebook, beforePageId: string, afterPageId: string): void {
    this.pushCommand({
      undo: () => this.restoreNotebookState(before, beforePageId),
      redo: () => this.restoreNotebookState(after, afterPageId),
      rebuild: true,
    });
  }

  private restoreNotebookState(snapshot: InkNotebook, selectedPageId: string): void {
    const current = this.notebook;
    const next = cloneNotebook(snapshot);
    const now = Date.now();
    const nextIds = new Set(next.pages.map((page) => page.id));
    const deletedPages = { ...current.deletedPages };
    for (const [pageId, deletedAt] of Object.entries(next.deletedPages)) {
      deletedPages[pageId] = Math.max(deletedPages[pageId] ?? 0, deletedAt);
    }
    for (const page of current.pages) {
      if (!nextIds.has(page.id)) deletedPages[page.id] = Math.max(deletedPages[page.id] ?? 0, now);
    }
    let selectedId = selectedPageId;
    next.pages = next.pages.map((page) => {
      if (!(page.id in deletedPages)) return page;
      const restored = clonePageAsNew(page, page.title, now);
      if (page.id === selectedPageId) selectedId = restored.id;
      return restored;
    });
    next.deletedPages = deletedPages;
    next.pageOrder = next.pages.map((page) => page.id);
    next.updatedAt = now;
    next.pageOrderUpdatedAt = now;
    this.notebook = next;
    this.pageIndex = Math.max(0, next.pages.findIndex((page) => page.id === selectedId));
    this.dirtyRevision += 1;
    this.queueWorkerOperation({ type: "history-restore", notebook: cloneNotebook(this.notebook) });
  }

  private setPagePaper(pageId: string, paper: PaperStyle): void {
    const page = this.pageById(pageId);
    if (!page) return;
    page.paper = paper;
    this.markChanged(page);
    this.queueWorkerOperation({
      type: "set-page", pageId, paper,
      pageUpdatedAt: page.updatedAt, notebookUpdatedAt: this.notebook.updatedAt,
    });
  }

  private setPageTitle(pageId: string, title: string): void {
    const page = this.pageById(pageId);
    if (!page) return;
    page.title = title;
    this.markChanged(page);
    this.queueWorkerOperation({
      type: "set-page", pageId, title,
      pageUpdatedAt: page.updatedAt, notebookUpdatedAt: this.notebook.updatedAt,
    });
  }

  private async copyCurrentPageEmbed(): Promise<void> {
    if (!this.file) return;
    const syntax = `\`\`\`ink\n${this.file.path}\npage: ${this.currentPage().id}\n\`\`\``;
    try {
      await navigator.clipboard.writeText(syntax);
      new Notice("Copied Ink page embed syntax");
    } catch (error) {
      new Notice(`Could not copy embed syntax: ${error instanceof Error ? error.message : String(error)}`);
    }
  }



  /**
   * 2D multi-point pressure mapping editor: drag points (endpoints move
   * vertically), click empty space to add one, double-click a point to
   * remove it. The curve maps raw pen pressure to the response input and is
   * captured per stroke; the sample preview re-renders on every change.
   */

  /** Renders the pressure mapping editor: grid, identity guide, curve and
   *  control points. Skipped while the popover has no layout (it is built
   *  display:none and drawn when opened). */
  private drawPressureCurveEditor(settings: BrushSettings): void {
    const canvas = this.sizePopover?.querySelector<HTMLCanvasElement>(`.ink-brush-settings[data-brush-tool="pen"] .ink-curve-editor-canvas`);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 10 || h < 10) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
    if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#8a8f98";
    ctx.globalAlpha = 0.35;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const points = settings.pressureCurve ? settings.pressureCurve.map((point) => [...point]) : [[0, 0], [1, 1]];
    const sampleY = (x: number): number => {
      if (x <= points[0][0]) return points[0][1];
      if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
      let index = 1;
      while (points[index][0] < x) index++;
      const span = points[index][0] - points[index - 1][0];
      const amount = span > 0 ? (x - points[index - 1][0]) / span : 0;
      return points[index - 1][1] + (points[index][1] - points[index - 1][1]) * amount;
    };
    ctx.strokeStyle = settings.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let step = 0; step <= 48; step++) {
      const x = step / 48;
      const sx = x * w, sy = (1 - sampleY(x)) * h;
      if (step === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    for (const point of points) {
      ctx.fillStyle = settings.color;
      ctx.beginPath();
      ctx.arc(point[0] * w, (1 - point[1]) * h, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  private layoutPage(): void {
    const style = getComputedStyle(this.pageScroller);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const availableWidth = Math.max(1, this.pageScroller.clientWidth - paddingLeft - paddingRight);
    const width = Math.min(980, availableWidth);
    const horizontalGutter = Math.max(0, (availableWidth - width) / 2);
    const height = width * this.notebook.pageHeight / this.notebook.pageWidth;
    this.pageBaseWidth = width;
    this.pageBaseHeight = height;
    const displayWidth = width * this.zoom;
    const displayHeight = height * this.zoom;
    // Use real layout dimensions instead of CSS zoom/transform. WebKit applies
    // CSS zoom inconsistently to absolute descendants and hit testing, which
    // displaced Pencil coordinates and clipped right-hand tiles on iPad.
    this.pageElement.style.left = horizontalGutter + "px";
    this.pageElement.style.width = displayWidth + "px";
    this.pageElement.style.height = displayHeight + "px";
    if (typeof this.pageElement.style.setProperty === "function") {
      this.pageElement.style.setProperty("--ink-page-scale", String(this.zoom));
    }
    this.pageElement.style.zoom = "";
    this.pageElement.style.transform = "none";
    // Keep the initial centering space inside the scrollable track. Without
    // these gutters, a capped wide-screen page loses its auto margins as soon
    // as it grows and edge pinch anchors are clamped toward the center.
    this.pageExtent.style.width = displayWidth + horizontalGutter * 2 + "px";
    this.pageExtent.style.height = displayHeight + "px";
  }

  private setZoom(value: number, target?: { x: number; y: number }, anchor?: { x: number; y: number }): void {
    if (!Number.isFinite(value)) return;
    const viewport = this.pageScroller.getBoundingClientRect();
    target ??= { x: viewport.left + this.pageScroller.clientWidth / 2, y: viewport.top + this.pageScroller.clientHeight / 2 };
    const before = this.pageElement.getBoundingClientRect();
    anchor ??= { x: (target.x - before.left) / before.width, y: (target.y - before.top) / before.height };
    const nextZoom = Math.max(0.5, Math.min(3, value));
    if (nextZoom !== this.zoom) {
      this.zoom = nextZoom;
      this.layoutPage();
      this.tiles!.setDisplayScale(this.zoom);
    }
    const after = this.pageElement.getBoundingClientRect();
    this.pageScroller.scrollLeft += after.left + anchor.x * after.width - target.x;
    this.pageScroller.scrollTop += after.top + anchor.y * after.height - target.y;
    const readout = this.root.querySelector<HTMLElement>(".ink-zoom-value");
    if (readout) readout.textContent = Math.round(this.zoom * 100) + "%";
    const zoomOut = this.root.querySelector<HTMLButtonElement>("[aria-label='Zoom out']");
    const zoomIn = this.root.querySelector<HTMLButtonElement>("[aria-label='Zoom in']");
    if (zoomOut) zoomOut.disabled = this.zoom <= 0.5;
    if (zoomIn) zoomIn.disabled = this.zoom >= 3;
    this.onViewportMotion();
  }

  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.92 : 1.08), { x: event.clientX, y: event.clientY });
  }



  // ------------------------------------------------------- notebook saving

  private async save(file = this.file): Promise<void> {
    if (!file) return;
    this.maxSaveDue = false;
    this.clearSaveTimers();
    if (this.activeSave) {
      this.saveRequested = true;
      try {
        await this.activeSave;
      } catch (error) {
        this.reportSaveFailure(file, error);
      }
      return;
    }
    const saving = this.performSave(file);
    this.activeSave = saving;
    try {
      await saving;
    } catch (error) {
      this.reportSaveFailure(file, error);
    }
    if (this.activeSave === saving) this.activeSave = null;
  }

  private reportSaveFailure(file: TFile, error: unknown): void {
    // Keep lifecycle and autosave callers settled even if a future store
    // implementation throws outside the normal handled save path.
    new Notice(`Ink Notes could not save ${file.path || "notebook"}: ${error instanceof Error ? error.message : String(error)}`);
  }

  private async performSave(file: TFile): Promise<void> {
    this.syncing = true;
    try {
      do {
        this.saveRequested = false;
        const revision = this.dirtyRevision;
        try {
          const result = await this.saveRevision(file, revision);
          this.savedRevision = Math.max(this.savedRevision, result.revision);
          if (result.merged && this.file === file) this.receiveMergedNotebook(result.merged);
        } catch (error) {
          new Notice(`Ink Notes could not save ${file.path || "notebook"}: ${error instanceof Error ? error.message : String(error)}`);
          break;
        }
      } while (this.saveRequested || this.dirtyRevision > this.savedRevision);
    } finally {
      this.syncing = false;
      if (this.externalRefreshPending && this.activePointerId === null) {
        this.externalRefreshPending = false;
        void this.reloadFromDisk().catch((error) => new Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
      }
      if (this.dirtyRevision > this.savedRevision && this.saveRequested) this.scheduleSave();
    }
  }

  private async saveRevision(file: TFile, minimumRevision: number): Promise<{ revision: number; merged?: InkNotebook }> {
    const session = this.workerSession;
    if (session) {
      try {
        return await this.saveRevisionWithWorker(file, session, minimumRevision);
      } catch (error) {
        if (error instanceof InkWorkerRequestError && error.code === "invalid-format") throw error;
        if (error instanceof SaveConflictError) throw error;
        if (this.workerSession === session) this.disableWorkerSession(error);
      }
    }
    const snapshot = cloneNotebook(this.notebook);
    return { revision: minimumRevision, merged: await this.store.save(file, snapshot) };
  }

  private async saveRevisionWithWorker(file: TFile, session: InkWorkerSession,
    minimumRevision: number): Promise<{ revision: number; merged?: InkNotebook }> {
    await session.barrier(this.workerRevision);
    let raw = await this.store.readRaw(file);
    for (let attempt = 0; attempt < SAVE_CONFLICT_RETRIES; attempt++) {
      const prepared = await session.prepareSave(raw, minimumRevision);
      if (await this.store.writeIfUnchanged(file, raw, prepared.content)) {
        try {
          await session.commitSave(prepared.token);
          return { revision: minimumRevision };
        } catch (error) {
          if (this.workerSession === session) this.disableWorkerSession(error);
          return { revision: minimumRevision, merged: await this.store.read(file) };
        }
      }
      await session.abortSave(prepared.token);
      raw = await this.store.readRaw(file);
    }
    throw new SaveConflictError(`Cannot save ${file.path || "notebook"}: the file kept changing`);
  }



  private resetInteraction(): void {
    this.cancelPendingInkCommitTimer();
    this.committingInkStrokes = null;
    this.pendingInkStrokes = [];
    this.pendingInkPageId = null;
    this.tiles?.cancelInkCommit();
    if (this.previewCanvas) this.previewCanvas.width = this.previewCanvas.height = 1;
    if (this.confirmedPreviewCanvas) this.confirmedPreviewCanvas.width = this.confirmedPreviewCanvas.height = 1;
    this.touchGesture = null;
    this.pendingMergedNotebook = null;
    this.pendingMergedNotebookIsFinal = false;
    this.externalRefreshPending = false;
    this.maxSaveDue = false;
    this.eraserHoverPoint = null;
    this.eraserPointerInside = false;
    this.activeStroke = null;
    this.activePointerId = null;
    this.lastPoint = null;
    this.erasedStrokeIds.clear();
    this.erasedCandidateIds.clear();
    this.erasedStrokes = [];
    this.eraserReplacementIds.clear();
    this.eraserReplacements = [];
    this.confirmedStrokeOutlines.clear();
    this.clearSelection();
  }

  protected renderAll(): void {
    if (!this.viewReady) return;
    this.renderPageRail();
    this.renderPage();
    this.updateHistoryButtons();
  }
}

function cloneNotebook(notebook: InkNotebook): InkNotebook {
  return {
    ...notebook,
    pageOrder: [...notebook.pageOrder],
    deletedPages: { ...notebook.deletedPages },
    pages: notebook.pages.map((page) => ({
      ...page,
      strokes: page.strokes.map(cloneStroke),
      deletedStrokeIds: [...page.deletedStrokeIds],
    })),
  };
}

function clonePage(page: InkPage): InkPage {
  return { ...page, strokes: page.strokes.map(cloneStroke), deletedStrokeIds: [...page.deletedStrokeIds] };
}

function clonePageAsNew(page: InkPage, title: string, now = Date.now()): InkPage {
  const pageId = newId("page");
  return {
    ...clonePage(page),
    id: pageId,
    title,
    strokes: page.strokes.map((stroke) => ({ ...cloneStroke(stroke), id: newId("stroke"), pageId, createdAt: now, updatedAt: now })),
    deletedStrokeIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function notebooksEqual(left: InkNotebook, right: InkNotebook): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function reconcileNotebook(target: InkNotebook, incoming: InkNotebook, selectedPageId: string,
  previousPageIndex: number): NotebookReconciliation {
  const dimensionsChanged = target.pageWidth !== incoming.pageWidth || target.pageHeight !== incoming.pageHeight;
  const previousPages = target.pages;
  const previousById = new Map(previousPages.map((page) => [page.id, page]));
  const pageChanges = new Map<string, { ink: boolean; paper: boolean; rail: boolean }>();

  const pages = incoming.pages.map((incomingPage) => {
    const page = previousById.get(incomingPage.id);
    if (!page) {
      pageChanges.set(incomingPage.id, { ink: true, paper: true, rail: true });
      return incomingPage;
    }

    const paperChanged = page.paper !== incomingPage.paper;
    const railChanged = page.title !== incomingPage.title || paperChanged;
    const inkChanged = reconcilePage(page, incomingPage);
    pageChanges.set(page.id, { ink: inkChanged, paper: paperChanged, rail: railChanged });
    return page;
  });

  const pageListChanged = previousPages.length !== pages.length
    || previousPages.some((page, index) => page.id !== pages[index]?.id);
  const selectedIndex = pages.findIndex((page) => page.id === selectedPageId);
  const pageIndex = selectedIndex >= 0 ? selectedIndex : Math.min(previousPageIndex, pages.length - 1);
  const currentPage = pages[pageIndex];
  const currentPageChanged = currentPage.id !== selectedPageId;
  const currentChanges = pageChanges.get(currentPage.id);

  target.schema = incoming.schema;
  target.title = incoming.title;
  target.pageWidth = incoming.pageWidth;
  target.pageHeight = incoming.pageHeight;
  target.pages = pageListChanged ? pages : previousPages;
  target.pageOrder = arraysEqual(target.pageOrder, incoming.pageOrder) ? target.pageOrder : [...incoming.pageOrder];
  target.deletedPages = recordsEqual(target.deletedPages, incoming.deletedPages)
    ? target.deletedPages : { ...incoming.deletedPages };
  target.pageOrderUpdatedAt = incoming.pageOrderUpdatedAt;
  target.updatedAt = incoming.updatedAt;

  return {
    pageIndex,
    pageRailChanged: pageListChanged || [...pageChanges.values()].some((change) => change.rail),
    currentPageChanged,
    currentInkChanged: currentPageChanged || currentChanges?.ink === true,
    currentPaperChanged: !currentPageChanged && currentChanges?.paper === true,
    dimensionsChanged,
  };
}

function reconcilePage(target: InkPage, incoming: InkPage): boolean {
  const previousStrokes = target.strokes;
  const previousById = new Map(previousStrokes.map((stroke) => [stroke.id, stroke]));
  const strokes = incoming.strokes.map((incomingStroke) => {
    const stroke = previousById.get(incomingStroke.id);
    if (!stroke || !strokeAppearanceEqual(stroke, incomingStroke)) return incomingStroke;
    // updatedAt participates in conflict resolution but not in rendering.
    stroke.updatedAt = incomingStroke.updatedAt;
    return stroke;
  });
  const inkChanged = previousStrokes.length !== strokes.length
    || previousStrokes.some((stroke, index) => stroke !== strokes[index]);

  target.title = incoming.title;
  target.paper = incoming.paper;
  if (inkChanged) target.strokes = strokes;
  target.deletedStrokeIds = arraysEqual(target.deletedStrokeIds, incoming.deletedStrokeIds)
    ? target.deletedStrokeIds : [...incoming.deletedStrokeIds];
  target.createdAt = incoming.createdAt;
  target.updatedAt = incoming.updatedAt;
  return inkChanged;
}

function strokeAppearanceEqual(left: InkStroke, right: InkStroke): boolean {
  if (left.id !== right.id || left.pageId !== right.pageId || left.tool !== right.tool
    || left.color !== right.color || left.width !== right.width || left.opacity !== right.opacity
    || left.createdAt !== right.createdAt || left.points.length !== right.points.length) return false;
  for (let index = 0; index < left.points.length; index++) {
    const a = left.points[index];
    const b = right.points[index];
    if (a.x !== b.x || a.y !== b.y || a.pressure !== b.pressure || a.t !== b.t
      || a.tiltX !== b.tiltX || a.tiltY !== b.tiltY) return false;
  }
  return true;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
