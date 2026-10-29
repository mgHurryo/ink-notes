import { Notice, Scope, TFile, WorkspaceLeaf, setIcon } from "obsidian";
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
import { reconcileNotebook } from "./notebook-reconciliation";
import { exportNotebookPdf, exportPathFor, notebookHasInk } from "./pdf-export";
import { paintPageImages } from "./image-library";
import { registerDocumentPointerEndEvents } from "./ink-input";
import { InkWritingView, InkPointerSample, cloneStroke, QUEUED_PAGE_SWIPE_DURATION_MS, SPARSE_SAMPLE_INTERVAL_MS } from "./ink-writing";
import type { EditCommand } from "./ink-writing";
import type { SharedToolState } from "./tool-state";
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
import { canvasResolution, drawInkStroke, scaledStroke, STROKE_WIDTH_REFERENCE } from "./rendering";
import { applyStoredRailWidth, mountRailResizer } from "./rail-resizer";
import { cloneSticky } from "./sticky-model";
import { BrushPopoverController, BrushSettings } from "./brush-popover";
import { TileRenderer, cellKeys } from "./tiles";
import type { NotebookOperation } from "./worker-protocol";
import { InkWorkerRequestError, InkWorkerService, InkWorkerSession } from "./worker-service";

export const VIEW_TYPE_INK = "ink-notes-view";

const SAVE_CONFLICT_RETRIES = 3;

const OVERLAY_RESIZE_BUDGET = 4_000_000;
/** Swipe previews must match live tile density (dpr x zoom): the 4M overlay
 *  budget downsamples Retina iPad pages (980px x dpr2 = ~5.4M pixels), so the
 *  incoming page reads blurry for the whole flip and only sharpens when the
 *  real tiles replace it. 16M is the WebKit-safe ceiling canvasResolution
 *  defaults to. */
const SWIPE_PREVIEW_RESIZE_BUDGET = 16_000_000;

/** Rail width persistence. localStorage (not the plugin data file) is enough
 *  here: the width is per-device window chrome, not notebook content. */
const RAIL_WIDTH_STORAGE_KEY = "ink-notes-page-rail-width";
/** Keep in sync with the 200ms expand/collapse transition on .ink-page-rail. */
const RAIL_TRANSITION_MS = 200;
/** Fallback for the CSS aspect-ratio(.73) thumb box when clientHeight is 0. */
const THUMB_ASPECT = 0.73;
const SWIPE_PREVIEW_IDLE_DELAY_MS = 120;
const SWIPE_PREVIEW_RETRY_MS = 50;

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
  private zoomRenderTimer: number | undefined;
  /** Debounces desktop wheel/keyboard zoom before committing a new tile raster. */
  private desktopZoomTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
  /** Freeze the page's raster/layout scale while a pinch composites the whole sheet. */
  private pinchRenderZoom: number | undefined;
  private pageNavigationGeneration = 0;
  private devPanel: HTMLElement | null = null;
  private devPanelRefreshTimer: number | undefined;
  /** Deferred thumbnail redraw while the rail's expand transition runs. */
  private railRevealTimer: number | undefined;
  private thumbnailRefreshFrame: number | null = null;
  private thumbObserver: IntersectionObserver | null = null;
  private pendingThumbs = new WeakMap<HTMLCanvasElement, InkPage>();
  private pageManagement = false;
  private selectedPageIds = new Set<string>();

  constructor(leaf: WorkspaceLeaf, store: NotebookStore, workers?: InkWorkerService, toolState?: SharedToolState) {
    super(leaf);
    this.store = store;
    this.workers = workers;
    if (toolState) this.useSharedToolState(toolState);
    this.scope = new Scope(this.app.scope);
  }

  getViewType(): string { return VIEW_TYPE_INK; }
  getDisplayText(): string { return this.file?.basename ?? this.notebook.title; }
  getIcon(): string { return "pen-line"; }

  revealPage(pageId: string): void {
    this.navigateToPage(pageId);
  }
  protected revealStickyPage(pageId: string): Promise<void> { return this.navigateToPage(pageId); }

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
    this.registerDesktopInput();
    this.buildZoomHud(this.root.querySelector<HTMLElement>(".ink-workspace")!);
    this.register(() => this.closeEraserPopover());
    this.viewReady = true;
    this.renderAll();
  }

  async onClose(): Promise<void> {
    this.disposeZoomHud();
    this.closePageOptionsMenu();
    this.pageNavigationGeneration += 1;
    this.closeDevPanel();
    this.clearFastPagingRail();
    if (this.railRevealTimer !== undefined) window.clearTimeout(this.railRevealTimer);
    this.railRevealTimer = undefined;
    if (this.thumbnailRefreshFrame !== null) window.cancelAnimationFrame(this.thumbnailRefreshFrame);
    this.thumbnailRefreshFrame = null;
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
    if (this.desktopZoomTimer !== undefined) globalThis.clearTimeout(this.desktopZoomTimer);
    this.finishPointerInput(false);
    this.clearSelection();
    this.closeLassoSettings();
    this.cancelPendingInkCommitTimer();
    this.clearSaveTimers();
    this.destroySwipeStage();
    if (this.file && (this.dirtyRevision > this.savedRevision || this.activeSave)) await this.save(this.file);
    this.tiles?.setBackend?.(null);
    this.workerSession?.dispose();
    this.workerSession = null;
    this.tiles?.dispose();
    this.viewReady = false;
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.pageNavigationGeneration += 1;
    this.destroySwipeStage();
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
    this.disposeStickyNotes();
    this.pageNavigationGeneration += 1;
    this.destroySwipeStage();
    this.finishPointerInput(false);
    this.clearSelection();
    this.closeLassoSettings();
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
    const start = toolbar.createDiv({ cls: "ink-toolbar-start" });
    const navigation = this.addToolbarSection(start, "Pages");
    const toggle = this.addIconButton(navigation, "panel-left", "Pages", () => {
      const hidden = !this.root.hasClass("ink-rail-hidden");
      this.root.toggleClass("ink-rail-hidden", hidden);
      // An explicit toggle reclaims the rail, so a pending fast-paging burst
      // must not hand it back to the state the user just overrode.
      this.fastPagingRailBorrowed = false;
      toggle.setAttribute("aria-pressed", String(!hidden));
      this.resizeCanvas();
      // Thumbnails skipped painting while the rail was collapsed (zero
      // width); repaint once the expand transition has revealed them.
      if (!hidden) this.scheduleRailThumbnailRefresh();
    });
    toggle.setAttribute("aria-pressed", String(!this.root.hasClass("ink-rail-hidden")));
    this.buildWritingSections(toolbar, start);
    const document_ = this.addToolbarSection(toolbar, "Document");
    this.buildReadingModeButton(document_);
    this.addIconButton(document_, "plus", "Add page", (event) => this.openPageInsertMenu(event,
      this.pageIndex, this.notebook.pages.length, (index) => this.addPage(index))).classList.add("ink-edit-only");
    this.addIconButton(document_, "download", "Export as PDF", () => void this.exportNotebookCopy());
    this.addIconButton(document_, "more-horizontal", "Page options", (event) => this.openPageMenu(event)).classList.add("ink-edit-only");
    this.updateToolButtons();
  }

  /** Vector-exports the whole notebook as a PDF next to the notebook file. */
  private async exportNotebookCopy(): Promise<void> {
    if (!this.file) return;
    if (!notebookHasInk(this.notebook)) {
      new Notice("This notebook has no handwriting to export yet");
      return;
    }
    try {
      const output = await exportNotebookPdf(this.notebook, this.file.basename, this.canvasLogicalWidth, this.imageLibrary?.bytes, { app: this.app, source: this.file.path });
      const target = exportPathFor(this.file.path, (candidate) => this.app.vault.getAbstractFileByPath(candidate) !== null);
      await this.app.vault.createBinary(target, output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
      new Notice(`Exported ${target}`);
    } catch (error) {
      new Notice(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private activeToolButton(): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>(`.ink-toolbar [data-tool="${this.state.tool}"]`);
  }



  private renderCanvas(): void {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    const rail = workspace.createDiv({ cls: "ink-page-rail", attr: { "aria-label": "Notebook pages" } });
    applyStoredRailWidth(rail, RAIL_WIDTH_STORAGE_KEY);
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageExtent = this.pageScroller.createDiv({ cls: "ink-page-extent" });
    this.pageElement = this.pageExtent.createDiv({ cls: "ink-page" });
    this.eraserCursor = this.pageElement.createDiv({ cls: "ink-eraser-cursor", attr: { "aria-hidden": "true" } });
    this.eraserCursor.createSpan({ cls: "ink-eraser-reference-point" });
    const tileHost = this.pageElement.createDiv({ cls: "ink-tile-layer" });
    this.tiles = new TileRenderer(tileHost);
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-selection-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.setAttribute("aria-label", "Handwriting canvas");
    this.lassoCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-lasso-preview-canvas" });
    this.lassoCanvas.setCssStyles({ display: "none" });
    this.lassoCtx = this.lassoCanvas.getContext("2d")!;
    this.confirmedPreviewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-confirmed-preview-canvas" });
    this.confirmedPreviewCtx = this.confirmedPreviewCanvas.getContext("2d")!;
    this.previewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCtx = this.previewCanvas.getContext("2d")!;
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
    this.registerDomEvent(this.pageScroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchcancel", (event) => {
      this.finishPinchRender();
      this.onTouchCancel(event);
    }, { passive: false });
    const observer = new ResizeObserver(() => { this.resizeCanvas(); this.revealInlineEditor(); });
    observer.observe(this.pageScroller);
    this.register(() => observer.disconnect());
  }

  private renderPageRail(): void {
    let rail = this.root.querySelector<HTMLElement>(".ink-page-rail");
    if (!rail) return;
    const pageIds = new Set(this.notebook.pages.map((page) => page.id));
    this.selectedPageIds.forEach((pageId) => { if (!pageIds.has(pageId)) this.selectedPageIds.delete(pageId); });
    rail.empty();
    const header = rail.createDiv({ cls: "ink-rail-header" });
    header.createDiv({ cls: "ink-rail-heading", text: "Pages" });
    header.createSpan({ cls: "ink-rail-count", text: this.pageManagement
      ? `${this.selectedPageIds.size} selected` : `${this.pageIndex + 1} / ${this.notebook.pages.length}` });
    const actions = rail.createDiv({ cls: "ink-rail-actions", attr: { role: "group", "aria-label": "Current page actions" } });
    if (this.pageManagement) {
      this.addIconButton(actions, "trash-2", "Delete selected pages", () => this.deleteSelectedPages(),
        this.selectedPageIds.size === 0 || this.selectedPageIds.size >= this.notebook.pages.length);
      this.addIconButton(actions, "x", "Done managing pages", () => this.setPageManagement(false));
    } else {
      this.addIconButton(actions, "chevron-up", "Move current page up", () => this.moveCurrentPage(-1), this.pageIndex === 0);
      this.addIconButton(actions, "chevron-down", "Move current page down", () => this.moveCurrentPage(1), this.pageIndex === this.notebook.pages.length - 1);
      this.addIconButton(actions, "copy", "Duplicate current page", () => this.duplicateCurrentPage());
      this.addIconButton(actions, "trash-2", "Delete current page", () => this.deleteCurrentPage(), this.notebook.pages.length <= 1);
      this.addIconButton(actions, "list-checks", "Manage pages", () => this.setPageManagement(true), this.readingMode);
    }
    const thumbs = rail.createDiv({ cls: "ink-rail-thumbs" });
    this.notebook.pages.forEach((page, index) => {
      const button = thumbs.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      if (this.pageManagement && this.selectedPageIds.has(page.id)) button.addClass("is-selected");
      button.setAttribute("aria-label", String(index + 1) + ": " + page.title);
      button.setAttribute("aria-current", String(index === this.pageIndex));
      button.setAttribute("aria-pressed", String(this.pageManagement && this.selectedPageIds.has(page.id)));
      if (this.pageManagement) button.setAttribute("aria-selected", String(this.selectedPageIds.has(page.id)));
      // Paper class stays on the background layer; the canvas above it carries
      // a vector snapshot of the page's ink (transparent where unwritten).
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      const canvas = button.createEl("canvas", { cls: "ink-page-thumb-canvas", attr: { "aria-hidden": "true" } });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.createSpan({ text: page.title, cls: "ink-page-thumb-title" });
      button.addEventListener("click", () => this.pageManagement
        ? this.togglePageSelection(page.id) : this.navigateToPage(page.id));
      this.scheduleThumbnail(canvas, page);
    });
    mountRailResizer(rail, { storageKey: RAIL_WIDTH_STORAGE_KEY, onDragEnd: () => this.redrawPageThumbnails() });
    this.scheduleSwipePreviewPaint();
    // Fast paging keeps the current page under the user's eye: center the
    // active thumb instead of the usual nearest-visibility nudge.
    if (this.isFastPagingRailOpen()) this.followWheelPageThumb();
    else rail.querySelector<HTMLElement>(".ink-page-thumb.is-active")?.scrollIntoView?.({ block: "nearest" });
  }

  private scheduleSwipePreviewPaint(): void {
    const rail = this.root.querySelector<HTMLElement>(".ink-page-rail");
    if (!rail) return;
    const paint = () => {
      if (!this.viewReady || !rail.isConnected) return;
      if (this.flipSettling) {
        window.setTimeout(paint, SWIPE_PREVIEW_RETRY_MS);
        return;
      }
      for (const index of [this.pageIndex - 1, this.pageIndex + 1]) {
        const page = this.notebook.pages[index];
        const canvas = rail.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb-canvas")[index];
        if (!page || !canvas?.isConnected || canvas.dataset.previewReady === "true") continue;
        this.drawPageThumbnail(canvas, page, 120);
      }
    };
    window.setTimeout(paint, SWIPE_PREVIEW_IDLE_DELAY_MS);
  }

  /** Paints a thumbnail now when it is on screen, defers offscreen ones to
   *  the intersection observer. The synchronous probe keeps the common cases
   *  (short page lists, the active thumb after a rebuild) painted in the same
   *  tick as before — no flash between a rail rebuild and the observer's
   *  async first report — while a long scrolled list only paints what the
   *  user can actually see. Hosts without IntersectionObserver (tests) and
   *  any geometry the probe cannot judge fall back to immediate painting. */
  private scheduleThumbnail(canvas: HTMLCanvasElement, page: InkPage): void {
    let onScreen = true;
    const scroller = canvas.closest(".ink-page-rail");
    if (scroller && typeof IntersectionObserver === "function") {
      const box = scroller.getBoundingClientRect();
      const rect = canvas.getBoundingClientRect();
      onScreen = rect.width > 0 && rect.bottom > box.top && rect.top < box.bottom;
    }
    if (onScreen || typeof IntersectionObserver !== "function") {
      this.drawPageThumbnail(canvas, page);
      return;
    }
    this.pendingThumbs.set(canvas, page);
    this.thumbObserver ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.thumbObserver?.unobserve(entry.target);
        const thumb = entry.target as HTMLCanvasElement;
        const deferred = this.pendingThumbs.get(thumb);
        if (deferred) {
          this.pendingThumbs.delete(thumb);
          this.drawPageThumbnail(thumb, deferred);
        }
      }
    });
    this.thumbObserver.observe(canvas);
  }

  /**
   * Paints one page's strokes into its rail thumbnail as a small vector
   * snapshot. Guarded end to end: a failed thumbnail render must never break
   * the rail build or touch the main canvas, so the thumb just stays on its
   * paper background. Skipped while the rail has no width (collapsed): the
   * redraw scheduled by the expand toggle repaints at the real size.
   */
  private drawPageThumbnail(canvas: HTMLCanvasElement, page: InkPage, widthHint?: number): void {
    try {
      const width = widthHint ?? canvas.clientWidth;
      if (width <= 0) return;
      const height = canvas.clientHeight || Math.round(width / THUMB_ASPECT);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      // Draw as a true miniature of the page: strokes (already normalized to
      // the page box) keep their size relative to the paper, so a 4 px nib is
      // 4/980ths of the thumbnail width, not 4 hair-unfriendly pixels.
      const scale = width / Math.max(1, this.pageBaseWidth);
      // The paper ruling lives in the same document space; scale the
      // background cells so the thumbnail shows the page's real line count
      // instead of a sparse re-flow.
      const paper = canvas.closest(".ink-page-thumb")?.querySelector<HTMLElement>(".ink-page-thumb-paper");
      if (paper) paper.style.setProperty("--ink-page-scale", String(scale));
      paintPageImages(this.imageLibrary, canvas, page, (context) => context.clearRect(0, 0, canvas.width, canvas.height), (context) => {
        context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
        for (const stroke of page.strokes) drawInkStroke(context, scaledStroke(stroke, scale), width, height);
        context.setTransform(1, 0, 0, 1, 0, 0);
      });
      canvas.dataset.previewReady = "true";
    } catch (error) {
      console.warn("Ink Notes could not render a page thumbnail", error);
    }
  }

  /** Repaints every thumbnail from the live model (expand settle, drag end). */
  private redrawPageThumbnails(): void {
    const rail = this.root?.querySelector<HTMLElement>(".ink-page-rail");
    if (!rail) return;
    rail.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb canvas").forEach((canvas, index) => {
      const page = this.notebook.pages[index];
      if (page) this.drawPageThumbnail(canvas, page);
    });
  }

  /** Repaints only the current page's thumbnail after its content changed
   *  (stroke added/removed, undo/redo, external merge) — never per frame.
   *  Pointerup and the tile ink commit both land here a few frames apart;
   *  coalescing them onto one animation frame halves full-page thumbnail
   *  repaints while writing, which redraws every stroke of the page. */
  private refreshCurrentPageThumbnail(): void {
    if (this.thumbnailRefreshFrame !== null) return;
    this.thumbnailRefreshFrame = window.requestAnimationFrame(() => {
      this.thumbnailRefreshFrame = null;
      const rail = this.root?.querySelector<HTMLElement>(".ink-page-rail");
      const canvas = rail?.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb canvas")[this.pageIndex];
      if (canvas) this.drawPageThumbnail(canvas, this.currentPage());
    });
  }

  /** Thumbnails blank-paint while the expand transition starts from 0; once
   *  the rail reached its width, repaint them at full resolution. */
  private scheduleRailThumbnailRefresh(): void {
    if (this.railRevealTimer !== undefined) window.clearTimeout(this.railRevealTimer);
    this.railRevealTimer = window.setTimeout(() => {
      this.railRevealTimer = undefined;
      if (this.viewReady && !this.root.hasClass("ink-rail-hidden")) this.redrawPageThumbnails();
    }, RAIL_TRANSITION_MS + 30);
  }

  /** Fast paging borrows a collapsed rail: expand with the same side effects
   *  as the toolbar toggle, remembering to hand it back afterwards. A rail
   *  the user already expanded stays open after the burst. */
  protected onFastPagingRailExpanded(): void {
    if (!this.viewReady || !this.root.hasClass("ink-rail-hidden")) return;
    this.fastPagingRailBorrowed = true;
    this.root.removeClass("ink-rail-hidden");
    this.resizeCanvas();
    this.scheduleRailThumbnailRefresh();
  }

  protected onFastPagingRailCollapsed(): void {
    if (!this.fastPagingRailBorrowed) return;
    this.fastPagingRailBorrowed = false;
    this.root.addClass("ink-rail-hidden");
    this.resizeCanvas();
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
    if (this.pinchRenderZoom !== undefined) return;
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
    this.tiles!.update(this.viewport, (window.devicePixelRatio || 1) * (this.pinchRenderZoom ?? this.zoom), refine);
    if (this.pinchRenderZoom === undefined && (refine || this.hasInkPreview()
      || this.selectedStrokeIds.size > 0 || this.lassoPath.length > 0)) {
      this.resizeOverlay(this.canvas, this.ctx);
      this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
      this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
      if (this.hasInkPreview()) { this.resizePreview(); this.drawPreview(); }
    }
    if (refine) this.tiles!.prewarm(this.notebook.pages.filter((_, index) => Math.abs(index - this.pageIndex) === 1));
  }




  private onViewportMotion(): void {
    this.updateViewport(false);
    if (this.pinchRenderZoom !== undefined) return;
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
    canvas.setCssStyles({ right: "auto", bottom: "auto" });
    ctx.setTransform(resolution.width / width, 0, 0, resolution.height / height, -x * (resolution.width / width), -y * (resolution.height / height));
    return changed;
  }






  // ------------------------------------------------------ writing-layer seams

  protected currentNotebook(): InkNotebook { return this.notebook; }
  protected currentPage(): InkPage { return this.notebook.pages[this.pageIndex]; }
  protected inputRect(): DOMRect { return this.pageElement.getBoundingClientRect(); }
  protected inputHost(): HTMLElement { return this.pageElement; }
  protected inputLocked(): boolean { return this.readingMode || this.flipSettling; }
  protected onReadingModeChanged(): void {
    this.destroySwipeStage();
    this.touchGesture = null;
    if (this.readingMode) {
      this.pageManagement = false;
      this.selectedPageIds.clear();
      if (this.root) this.renderPageRail();
    }
  }
  protected pagePixelSize(): { width: number; height: number } {
    return { width: this.notebook.pageWidth, height: this.notebook.pageHeight };
  }
  protected onModelMutated(): void {
    this.dirtyRevision += 1;
  }
  protected onInputStarting(): void {
    this.finishPinchRender();
    this.pageNavigationGeneration += 1;
  }
  protected afterInputFullySettled(): void {
    // Runs at pointerup and again after the tile ink commit, so the current
    // page's thumbnail tracks both the raw and the finalized stroke.
    this.refreshCurrentPageThumbnail();
    if (this.externalRefreshPending && this.pendingInkStrokes.length === 0) {
      this.externalRefreshPending = false;
      void this.reloadFromDisk().catch((error) => new Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  protected afterCommand(command: EditCommand): void {
    super.afterCommand(command);
    // Rebuild commands already re-rendered the rail through renderAll();
    // the cheap stroke-level undo/redo path only redraws the canvas.
    if (!command.rebuild) this.refreshCurrentPageThumbnail();
  }
  protected diagnosticsCaptureRawPoints(): boolean { return this.devPanel !== null; }
  protected performScheduledSave(): void { void this.save(); }
  protected toolbarRoot(): HTMLElement { return this.root; }
  protected inputScroller(): HTMLElement { return this.pageScroller; }
  protected onZoomLockChanged(): void { this.finishPinchRender(); this.updateZoomControls(); }

  protected desktopNavigate(destination: "previous" | "next" | "first" | "last"): void {
    if (destination === "previous" || destination === "next") {
      if (this.queuePageSwipeDelta(destination === "next" ? 1 : -1)) return;
    }
    const index = destination === "first" ? 0 : destination === "last" ? this.notebook.pages.length - 1
      : this.pageIndex + (destination === "next" ? 1 : -1);
    if (this.queuePageSwipeTarget(index)) return;
    const page = this.notebook.pages[index];
    if (page) void this.navigateToPage(page.id);
  }
  protected desktopZoom(factor: number, target?: { x: number; y: number }): void {
    if (this.zoomLocked) return;
    if (this.pinchRenderZoom === undefined) {
      this.pinchRenderZoom = this.zoom;
      if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
      this.zoomRenderTimer = undefined;
      this.tiles?.beginInput?.();
    }
    this.setZoom(this.zoom * factor, target);
    if (this.desktopZoomTimer !== undefined) globalThis.clearTimeout(this.desktopZoomTimer);
    this.desktopZoomTimer = globalThis.setTimeout(() => {
      this.desktopZoomTimer = undefined;
      this.finishPinchRender();
    }, 180);
  }
  protected desktopResetZoom(): void {
    if (this.zoomLocked) return;
    this.desktopZoom(1 / this.zoom);
  }
  protected onTouchStart(event: TouchEvent): void {
    // Commit before the base handler captures the next gesture's page anchor.
    this.finishPinchRender();
    super.onTouchStart(event);
  }

  private finishPinchRender(): void {
    if (this.desktopZoomTimer !== undefined) globalThis.clearTimeout(this.desktopZoomTimer);
    this.desktopZoomTimer = undefined;
    if (this.pinchRenderZoom === undefined) return;
    this.pinchRenderZoom = undefined;
    this.resizeCanvas();
  }

  protected applyGestureZoom(value: number, focus: { x: number; y: number }, anchor: { x: number; y: number }): void {
    if (this.zoomLocked) return;
    if (Number.isFinite(value) && value !== this.zoom && this.pinchRenderZoom === undefined) {
      this.pinchRenderZoom = this.zoom;
      if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
      this.zoomRenderTimer = undefined;
      this.tiles?.beginInput?.();
    }
    this.setZoom(value, focus, anchor);
  }

  private swipeStage: HTMLElement | null = null;
  private swipeLayer: HTMLElement | null = null;

  protected swipeDrag(offset: number): void {
    const extent = this.pageExtent;
    if (!extent || this.flipSettling) return;
    this.ensureSwipeStage(offset);
    this.updatePageInsertPreview(this.swipeStage, offset);
    const pitch = this.swipePitch();
    offset = this.swipeStage ? Math.max(-pitch, Math.min(pitch, offset)) : offset / (1 + Math.abs(offset) / 80);
    this.swipeDragOffset = offset;
    extent.setCssStyles({ transition: "none" });
    extent.style.transform = `translateX(${offset}px)`;
    if (this.swipeStage) {
      this.swipeStage.setCssStyles({ transition: "none" });
      this.swipeStage.style.transform = `translateX(${offset}px)`;
    }
  }

  /** Slides a cheap vector snapshot of the neighbouring page in beside the
   *  current one while dragging (tiles stay on the live page). */
  private ensureSwipeStage(offset: number): void {
    const extent = this.pageExtent;
    if (!extent) return;
    const side = offset > 0 ? -1 : 1;
    const neighborIndex = this.pageIndex + side;
    if (this.swipeStage) {
      if (Number(this.swipeStage.dataset.neighbor) === neighborIndex) return;
      this.destroySwipeStage();
    }
    const insert = neighborIndex < 0 || neighborIndex >= this.notebook.pages.length;
    if (insert && this.readingMode) return;
    const neighbor = insert ? null : this.notebook.pages[neighborIndex];
    const page = this.pageElement;
    const pitch = this.swipePitch();
    // Clip previews separately: offscreen pages must not enlarge scrollWidth.
    this.swipeLayer = this.pageScroller.createDiv({ cls: "ink-swipe-layer" });
    this.swipeLayer.setCssStyles({ left: `${this.pageScroller.scrollLeft}px`, top: `${this.pageScroller.scrollTop}px`,
      width: `${this.pageScroller.clientWidth}px`, height: `${this.pageScroller.clientHeight}px`, right: "auto", bottom: "auto" });
    const stage = this.swipeLayer.createDiv({ cls: `ink-page ink-paper-${neighbor?.paper ?? "blank"} ink-swipe-stage` });
    const previewZoom = this.zoomLocked ? this.zoom : 1;
    stage.dataset.neighbor = String(neighborIndex);
    stage.setCssStyles({
      position: "absolute", margin: "0", overflow: "hidden",
      left: `${extent.offsetLeft + page.offsetLeft - this.pageScroller.scrollLeft + side * pitch}px`,
      top: `${extent.offsetTop + page.offsetTop - this.pageScroller.scrollTop}px`,
      width: `${this.pageBaseWidth * previewZoom}px`,
      height: `${this.pageBaseHeight * previewZoom}px`,
      transform: "translateX(0px)",
    });
    stage.style.setProperty("--ink-page-scale", String(previewZoom));
    this.swipeStage = stage;
    if (insert) { this.showPageInsertPreview(stage, side); return; }
    const canvas = stage.createEl("canvas", { cls: "ink-swipe-canvas" });
    const resolution = canvasResolution(this.canvasLogicalWidth, this.canvasLogicalHeight, window.devicePixelRatio || 1, previewZoom, SWIPE_PREVIEW_RESIZE_BUDGET);
    canvas.width = resolution.width;
    canvas.height = resolution.height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(canvas.width / this.canvasLogicalWidth, 0, 0, canvas.height / this.canvasLogicalHeight, 0, 0);
      const width = this.canvasLogicalWidth, height = this.canvasLogicalHeight;
      paintPageImages(this.imageLibrary, canvas, neighbor!, (context) => context.clearRect(0, 0, canvas.width, canvas.height), (context) => {
        context.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
        for (const stroke of neighbor!.strokes) drawInkStroke(context, stroke, width, height);
        context.setTransform(1, 0, 0, 1, 0, 0);
      });
    }
    this.swipeStage = stage;
  }

  /** Last drag offset; settle animations continue from it. */
  private swipeDragOffset = 0;

  private swipePitch(): number {
    return Math.max(this.pageScroller.clientWidth, this.pageElement.offsetWidth) + 16;
  }

  private animateQueuedPageSwipe(direction: number): Promise<void> {
    const extent = this.pageExtent;
    if (!extent) return Promise.resolve();
    this.ensureSwipeStage(-direction * 24);
    const stage = this.swipeStage;
    return new Promise((resolve) => this.animatePageSwipe(stage ? [extent, stage] : [extent], 0,
      -direction * this.swipePitch(), () => {
        this.cancelPageSwipeAnimations();
        extent.setCssStyles({ transform: "", visibility: stage ? "hidden" : "" });
        resolve();
      }, QUEUED_PAGE_SWIPE_DURATION_MS));
  }

  private revealQueuedPage(): void {
    this.swipeLayer?.remove();
    this.swipeStage?.remove();
    this.swipeLayer = this.swipeStage = null;
    this.pageExtent?.setCssStyles({ transform: "", visibility: "" });
    this.swipeDragOffset = 0;
  }

  protected swipeSettle(delta: number, travel = 0, scrollEdge?: "top" | "bottom"): void {
    // Guard every settle path, including cancellation and a second touchend.
    if (this.flipSettling) return;
    const extent = this.pageExtent;
    if (!extent) { this.destroySwipeStage(); return; }
    const stage = this.swipeStage;
    const side = stage ? Number(stage.dataset.neighbor) - this.pageIndex : 0;
    const insert = !!stage?.dataset.insert;
    const create = insert && !this.readingMode && Math.sign(travel) === -side && Math.abs(travel) >= this.pageInsertThreshold();
    const flip = create || (!insert && delta !== 0 && side === delta);
    const from = this.swipeDragOffset;
    const to = flip ? -side * this.swipePitch() : 0;
    const isCurrent = this.beginPageSwipe(this.pageIndex + (flip ? delta : 0), this.notebook.pages.length, scrollEdge);
    this.flipSettling = true;
    this.animatePageSwipe(stage ? [extent, stage] : [extent], from, to, () => {
      if (!isCurrent()) return;
      // Reset geometry before rendering, while the incoming snapshot covers it.
      this.cancelPageSwipeAnimations();
      extent.setCssStyles({ transform: "" });
      if (create) {
        this.addPage(side < 0 ? 0 : this.notebook.pages.length);
        this.destroySwipeStage();
        this.resumePageSwipeDrag();
        return;
      }
      if (flip && stage) extent.setCssStyles({ visibility: "hidden" });
      void this.navigatePageSwipe((index) => {
        const page = this.notebook.pages[index];
        return page ? this.navigateToPage(page.id) : Promise.resolve();
      }, () => this.pageIndex, isCurrent, (direction) => this.animateQueuedPageSwipe(direction),
      () => this.revealQueuedPage()).finally(() => {
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
    if (this.pageExtent) {
      this.pageExtent.setCssStyles({ transform: "", visibility: "" });
    }
    this.swipeDragOffset = 0;
    this.flipSettling = false;
  }
  protected settingsOpen(): boolean {
    if (this.state.tool === "pointer" || this.state.tool === "shape") return false;
    if (this.state.tool === "lasso") return this.lassoSettingsPopover !== null;
    return this.state.tool === "eraser" ? this.eraserPopover !== null : this.brushPopover?.isOpen ?? false;
  }
  protected toggleToolSettings(anchor: HTMLElement): void {
    if (this.state.tool === "shape") { this.showShapeMenu(anchor); return; }
    if (this.state.tool === "lasso") { this.toggleLassoSettings(anchor); return; }
    if (this.state.tool === "eraser") { this.toggleEraserPopover(anchor); return; }
    this.ensureBrushSettingsPopover();
    if (!this.brushPopover) return;
    if (this.brushPopover?.isOpen) this.brushPopover.close();
    else this.brushPopover?.open();
  }
  protected reopenToolSettings(): void {
    if (this.state.tool === "lasso") { if (!this.lassoSettingsPopover) this.toggleLassoSettings(this.activeSettingsAnchor()); return; }
    if (this.state.tool === "eraser") {
      if (!this.eraserPopover) this.toggleEraserPopover(this.activeToolButton());
      return;
    }
    this.ensureBrushSettingsPopover();
    this.brushPopover?.open();
    this.brushPopover?.position();
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
    for (const { stroke, previousUpdatedAt } of changes.metadataOnlyChanges) this.tiles?.acknowledgeStrokeMetadata(stroke, previousUpdatedAt);
    this.pageIndex = changes.pageIndex;

    // A save result usually differs only in merge metadata. Keep the current
    // page and TileRenderer state alive instead of rebuilding the whole view.
    if (changes.pageRailChanged) this.renderPageRail();
    if (changes.currentPageChanged || changes.currentPaperChanged || changes.dimensionsChanged) {
      this.renderPage();
    } else {
      if (changes.pageRailChanged) this.updatePageStatus();
      if (changes.currentInkChanged) {
        this.drawStrokes(this.currentPage().strokes);
        this.refreshCurrentPageThumbnail();
      }
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
    lines.push(`ENV pointer=${this.devLastPointerType ?? "-"} coalesced=${this.hasPointerApi("getCoalescedEvents") ? "yes" : "no"} rawupdate=${"onpointerrawupdate" in window ? "yes" : "no"} predicted=${this.hasPointerApi("getPredictedEvents") ? "yes" : "no"} touch=${navigator.maxTouchPoints ?? 0} dpr=${(window.devicePixelRatio || 1).toFixed(2)} zoom=${this.zoom.toFixed(2)} pinch=${this.pinchRenderZoom?.toFixed(2) ?? "-"} tileDensity=${this.tiles?.currentDensity?.toFixed(2) ?? "-"} tileScale=${this.tiles?.currentDisplayScale?.toFixed(2) ?? "-"}`);
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
      pinchRenderZoom: this.pinchRenderZoom ?? null,
      tileDensity: this.tiles?.currentDensity ?? null,
      tileDisplayScale: this.tiles?.currentDisplayScale ?? null,
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

  private addPage(index = this.notebook.pages.length): void {
    if (this.readingMode) return;
    this.destroySwipeStage();
    this.pageNavigationGeneration += 1;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const now = Date.now();
    index = Math.max(0, Math.min(index, this.notebook.pages.length));
    const page: InkPage = { id: newId("page"), title: `Page ${this.notebook.pages.length + 1}`, paper: "blank", strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
    this.notebook.pages.splice(index, 0, page);
    this.notebook.pageOrder.splice(index, 0, page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    this.queueWorkerOperation({ type: "page-operation", action: "add", page: clonePage(page),
      pageOrder: [...this.notebook.pageOrder], pageOrderUpdatedAt: now, notebookUpdatedAt: now });
    this.pageIndex = index;
    this.resetPageView();
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }

  private navigateToPage(pageId: string): Promise<void> {
    if (this.currentPage().id === pageId || !this.pageById(pageId)) return Promise.resolve();
    this.finishPointerInput(false);
    this.clearSaveTimers();
    const navigationGeneration = ++this.pageNavigationGeneration;
    const file = this.file;
    const session = this.workerSession;
    const workerRevision = this.workerRevision;
    return (async () => {
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
      this.resetPageView();
      this.renderPageRail();
      this.renderPage();
      if (this.flipSettling) this.tiles?.previewInteractiveCells(
        cellKeys(this.viewport, this.canvasLogicalWidth, this.canvasLogicalHeight), this.viewport, (window.devicePixelRatio || 1) * this.zoom);
    })().catch((error) => { new Notice(`Ink Notes could not switch pages: ${error instanceof Error ? error.message : String(error)}`); });
  }

  private openPageMenu(event: MouseEvent): void {
    if (this.readingMode) return;
    const menu = this.beginPageOptionsMenu(event);
    if (!menu) return;
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
    menu.addItem((item) => item.setTitle("Rename page").onClick(() => this.renamePage()));
    menu.addItem((item) => item.setTitle("Duplicate page").onClick(() => this.duplicateCurrentPage()));
    menu.addItem((item) => item.setTitle("Move page up").setDisabled(this.pageIndex === 0).onClick(() => this.moveCurrentPage(-1)));
    menu.addItem((item) => item.setTitle("Move page down").setDisabled(this.pageIndex === this.notebook.pages.length - 1).onClick(() => this.moveCurrentPage(1)));
    menu.addItem((item) => item.setTitle("Delete page").setDisabled(this.notebook.pages.length <= 1).onClick(() => this.deleteCurrentPage()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Copy page embed syntax").onClick(() => void this.copyCurrentPageEmbed()));
    menu.addItem((item) => item.setTitle("Zoom out").setDisabled(this.zoomLocked || this.zoom <= 0.5).onClick(() => this.setZoom(this.zoom - 0.1)));
    menu.addItem((item) => item.setTitle("Reset zoom").setDisabled(this.zoomLocked || this.zoom === 1).onClick(() => this.setZoom(1)));
    menu.addItem((item) => item.setTitle("Zoom in").setDisabled(this.zoomLocked || this.zoom >= 3).onClick(() => this.setZoom(this.zoom + 0.1)));
    menu.showAtMouseEvent(event);
  }

  private renamePage(): void {
    if (this.readingMode) return;
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
    if (this.readingMode) return;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const source = clonePage(this.currentPage());
    const insertionIndex = this.pageIndex + 1;
    const now = Date.now();
    const page = clonePageAsNew(source, `${source.title} copy`, now);
    this.notebook.pages.splice(insertionIndex, 0, page);
    this.pageIndex += 1;
    this.resetPageView();
    this.finishPageOrderChange(now, { type: "page-operation", action: "duplicate", page: clonePage(page),
      pageOrder: this.notebook.pages.map((candidate) => candidate.id), pageOrderUpdatedAt: now, notebookUpdatedAt: now });
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderAll();
    this.scheduleSave();
  }

  private deleteCurrentPage(): void {
    if (this.readingMode) return;
    if (this.notebook.pages.length <= 1) return;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const deletedIndex = this.pageIndex;
    const [deleted] = this.notebook.pages.splice(this.pageIndex, 1);
    const now = Date.now();
    this.notebook.deletedPages[deleted.id] = now;
    this.pageIndex = Math.min(this.pageIndex, this.notebook.pages.length - 1);
    this.resetPageView();
    this.finishPageOrderChange(now, { type: "page-operation", action: "delete", pageId: deleted.id, deletedAt: now,
      pageOrder: this.notebook.pages.map((candidate) => candidate.id), pageOrderUpdatedAt: now, notebookUpdatedAt: now });
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, this.currentPage().id);
    this.clearSelection();
    this.renderAll();
    this.scheduleSave();
  }

  private setPageManagement(enabled: boolean): void {
    this.pageManagement = enabled && !this.readingMode;
    this.selectedPageIds.clear();
    this.renderPageRail();
  }

  private togglePageSelection(pageId: string): void {
    if (!this.pageManagement || this.readingMode) return;
    if (this.selectedPageIds.has(pageId)) this.selectedPageIds.delete(pageId);
    else this.selectedPageIds.add(pageId);
    this.renderPageRail();
  }

  private deleteSelectedPages(): void {
    if (this.readingMode || !this.pageManagement) return;
    const selected = new Set(this.selectedPageIds);
    if (selected.size === 0 || selected.size >= this.notebook.pages.length) return;
    this.finishPointerInput(false);
    const before = cloneNotebook(this.notebook);
    const beforePageId = this.currentPage().id;
    const removedBeforeCurrent = this.notebook.pages
      .slice(0, this.pageIndex).filter((page) => selected.has(page.id)).length;
    const now = Date.now();
    this.notebook.pages = this.notebook.pages.filter((page) => {
      if (!selected.has(page.id)) return true;
      this.notebook.deletedPages[page.id] = now;
      return false;
    });
    this.pageIndex = this.notebook.pages.some((page) => page.id === beforePageId)
      ? this.notebook.pages.findIndex((page) => page.id === beforePageId)
      : Math.max(0, Math.min(this.pageIndex - removedBeforeCurrent, this.notebook.pages.length - 1));
    this.notebook.pageOrder = this.notebook.pages.map((page) => page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    this.queueWorkerOperation({ type: "history-restore", notebook: cloneNotebook(this.notebook) });
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, this.currentPage().id);
    this.selectedPageIds.clear();
    this.pageManagement = false;
    this.resetPageView();
    this.clearSelection();
    this.renderAll();
    this.scheduleSave();
  }

  private moveCurrentPage(delta: number): void {
    if (this.readingMode) return;
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
    this.destroySwipeStage();
    this.pageNavigationGeneration += 1;
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
    const previousPageId = this.currentPage().id;
    this.notebook = next;
    this.pageIndex = Math.max(0, next.pages.findIndex((page) => page.id === selectedId));
    if (this.currentPage().id !== previousPageId) this.resetPageView();
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
   * vertically), click empty space to add one, select a point and use
   * Remove point to delete it. The curve maps raw pen pressure to the response input and is
   * captured per stroke; the sample preview re-renders on every change.
   */

  /** Renders the pressure mapping editor: grid, identity guide, curve and
   *  control points. Skipped while the popover has no layout (it is built
   *  display:none and drawn when opened). */

  private layoutPage(): void {
    const style = getComputedStyle(this.pageScroller);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    const availableWidth = Math.max(1, this.pageScroller.clientWidth - paddingLeft - paddingRight);
    // The page box cap IS the stroke-width reference: brush sizes are authored
    // against this canvas width (STROKE_WIDTH_REFERENCE), so changing one
    // changes the on-screen meaning of a stored nib. Keep them one constant.
    const width = Math.min(STROKE_WIDTH_REFERENCE, availableWidth);
    const horizontalGutter = Math.max(0, (availableWidth - width) / 2);
    const height = width * this.notebook.pageHeight / this.notebook.pageWidth;
    this.pageBaseWidth = width;
    this.pageBaseHeight = height;
    const displayWidth = width * this.zoom;
    const displayHeight = height * this.zoom;
    const renderZoom = this.pinchRenderZoom ?? this.zoom;
    // Keep settled writing in explicit layout units for WebKit hit testing;
    // only the navigation gesture uses a temporary whole-page transform.
    this.pageElement.style.left = horizontalGutter + "px";
    this.pageElement.style.width = width * renderZoom + "px";
    this.pageElement.style.height = height * renderZoom + "px";
    if (typeof this.pageElement.style.setProperty === "function") {
      // The ruling is part of the page, not of the screen: the cell size is
      // exactly 32 page px scaled by zoom, so zooming reads like zooming an
      // image - every line, dot and grid cell grows with the paper and the
      // line count never changes. (An earlier fix snapped the scale to whole
      // device pixels to still the lines while zooming; that kept the cells
      // near-constant on screen while the page box grew, so zooming visibly
      // re-flowed the ruling to a different line count.)
      this.pageElement.style.setProperty("--ink-page-scale", String(renderZoom));
    }
    this.pageElement.setCssStyles({ zoom: "" });
    // Scale ink and ruling as one image during the gesture. Repainting each
    // fractional line spacing and replacing tile densities causes shimmer.
    this.pageElement.style.transform = this.pinchRenderZoom === undefined ? "none" : `scale(${this.zoom / renderZoom})`;
    this.pageElement.style.willChange = this.pinchRenderZoom === undefined ? "" : "transform";
    // Keep the initial centering space inside the scrollable track. Without
    // these gutters, a capped wide-screen page loses its auto margins as soon
    // as it grows and edge pinch anchors are clamped toward the center.
    this.pageExtent.style.width = displayWidth + horizontalGutter * 2 + "px";
    this.pageExtent.style.height = displayHeight + "px";
  }

  private updateZoomControls(): void {
    this.updateZoomHud();
    const readout = this.root?.querySelector<HTMLElement>(".ink-zoom-value");
    if (readout) readout.textContent = Math.round(this.zoom * 100) + "%";
    const zoomOut = this.root?.querySelector<HTMLButtonElement>("[aria-label='Zoom out']");
    const zoomIn = this.root?.querySelector<HTMLButtonElement>("[aria-label='Zoom in']");
    if (zoomOut) zoomOut.disabled = this.zoomLocked || this.zoom <= 0.5;
    if (zoomIn) zoomIn.disabled = this.zoomLocked || this.zoom >= 3;
  }

  private resetPageView(): void {
    this.clearSelection();
    this.closeLassoSettings();
    if (this.desktopZoomTimer !== undefined) globalThis.clearTimeout(this.desktopZoomTimer);
    this.desktopZoomTimer = undefined;
    this.pinchRenderZoom = undefined;
    if (!this.zoomLocked) this.zoom = 1;
    if (this.pageScroller) {
      this.pageScroller.scrollLeft = 0;
      this.pageScroller.scrollTop = 0;
    }
    this.updateZoomControls();
  }

  private setZoom(value: number, target?: { x: number; y: number }, anchor?: { x: number; y: number }): void {
    if (this.zoomLocked || !Number.isFinite(value)) return;
    const viewport = this.pageScroller.getBoundingClientRect();
    target ??= { x: viewport.left + this.pageScroller.clientWidth / 2, y: viewport.top + this.pageScroller.clientHeight / 2 };
    const before = this.pageElement.getBoundingClientRect();
    anchor ??= { x: (target.x - before.left) / before.width, y: (target.y - before.top) / before.height };
    const nextZoom = Math.max(0.5, Math.min(3, value));
    if (nextZoom !== this.zoom) {
      this.zoom = nextZoom;
      this.layoutPage();
      if (this.pinchRenderZoom === undefined) this.tiles!.setDisplayScale(this.zoom);
    }
    const after = this.pageElement.getBoundingClientRect();
    this.pageScroller.scrollLeft += after.left + anchor.x * after.width - target.x;
    this.pageScroller.scrollTop += after.top + anchor.y * after.height - target.y;
    this.updateZoomControls();
    this.onViewportMotion();
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
      images: page.images?.map((image) => ({ ...image })),
      stickyNotes: page.stickyNotes?.map(cloneSticky), deletedStickyNotes: { ...page.deletedStickyNotes },
      deletedImageIds: [...(page.deletedImageIds ?? [])],
      deletedStrokeIds: [...page.deletedStrokeIds],
    })),
  };
}

function clonePage(page: InkPage): InkPage {
  return { ...page, stickyNotes: page.stickyNotes?.map(cloneSticky), deletedStickyNotes: { ...page.deletedStickyNotes }, images: page.images?.map((image) => ({ ...image })), deletedImageIds: [...(page.deletedImageIds ?? [])], strokes: page.strokes.map(cloneStroke), deletedStrokeIds: [...page.deletedStrokeIds] };
}

function clonePageAsNew(page: InkPage, title: string, now = Date.now()): InkPage {
  const pageId = newId("page");
  return {
    ...clonePage(page),
    id: pageId,
    title,
    images: page.images?.map((image) => ({ ...image, id: newId("placed-image"), pageId, createdAt: now, updatedAt: now })),
    deletedImageIds: [],
    stickyNotes: page.stickyNotes?.map((note) => {
      const copy = cloneSticky(note), id = newId("sticky");
      return { ...copy, id, pageId, createdAt: now, updatedAt: now,
        strokes: copy.strokes.map((stroke) => ({ ...stroke, id: newId("sticky-ink"), pageId: id })) };
    }),
    deletedStickyNotes: {},
    strokes: page.strokes.map((stroke) => ({ ...cloneStroke(stroke), id: newId("stroke"), pageId, createdAt: now, updatedAt: now })),
    deletedStrokeIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

function notebooksEqual(left: InkNotebook, right: InkNotebook): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
