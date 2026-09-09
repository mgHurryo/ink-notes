import { FileView, Menu, Notice, Scope, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import {
  InkNotebook,
  InkPage,
  InkPoint,
  InkStroke,
  InkTool,
  PaperStyle,
  createNotebook,
  mergeNotebooks,
  newId,
} from "./model";
import { NotebookStore } from "./storage";
import { canvasResolution, drawInkStroke } from "./rendering";
import { Rect, TileRenderer } from "./tiles";

export const VIEW_TYPE_INK = "ink-notes-view";

interface ToolState {
  tool: InkTool;
  color: string;
  width: number;
  opacity: number;
  smoothing: number;
  eraserMode: EraserMode;
  eraserSize: number;
}

type EraserMode = "stroke" | "circle" | "square";

interface EditCommand {
  undo: () => void;
  redo: () => void;
}

interface InteractionContext {
  generation: number;
  pointerId: number;
  pageId: string;
  tool: InkTool;
  eraserMode?: EraserMode;
  eraserSize?: number;
  smoothing?: number;
}

const STROKE_ERASER_HIT_RADIUS = 10;

const INK_COLORS = [
  { value: "#1b1b1b", label: "Black" },
  { value: "#195bff", label: "Blue" },
  { value: "#f23c42", label: "Red" },
  { value: "#42c449", label: "Green" },
  { value: "#f2c94c", label: "Yellow" },
];

export class InkView extends FileView {
  private readonly store: NotebookStore;
  private notebook: InkNotebook = createNotebook();
  private pageIndex = 0;
  private state: ToolState = { tool: "pen", color: "#1b1b1b", width: 3, opacity: 1, smoothing: 0.7, eraserMode: "stroke", eraserSize: 32 };
  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private previewCanvas!: HTMLCanvasElement;
  private previewCtx!: CanvasRenderingContext2D;
  private lassoCanvas!: HTMLCanvasElement;
  private lassoCtx!: CanvasRenderingContext2D;
  private tiles!: TileRenderer;
  private viewport: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private overlayScaleX = 1;
  private overlayScaleY = 1;
  private canvasLogicalWidth = 1;
  private canvasLogicalHeight = 1;
  private pageElement!: HTMLElement;
  private pageExtent!: HTMLElement;
  private pageScroller!: HTMLElement;
  private eraserCursor!: HTMLElement;
  private eraserHoverPoint: InkPoint | null = null;
  private eraserPointerInside = false;
  private syncing = false;
  private saveRequested = false;
  private activeSave: Promise<void> | null = null;
  private dirtyRevision = 0;
  private savedRevision = 0;
  private pendingMergedNotebook: InkNotebook | null = null;
  private externalRefreshPending = false;
  private saveTimer: number | undefined;
  private activeStroke: InkStroke | null = null;
  private activePointerId: number | null = null;
  private interaction: InteractionContext | null = null;
  private interactionGeneration = 0;
  private lastPoint: InkPoint | null = null;
  private touchGesture: {
    ids: number[];
    distance: number;
    zoom: number;
    x: number;
    y: number;
    pageX: number;
    pageY: number;
  } | null = null;
  private pendingLassoPoint: InkPoint | null = null;
  private zoom = 1;
  private viewReady = false;
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];
  private erasedStrokeIds = new Set<string>();
  private erasedCandidateIds = new Set<string>();
  private erasedStrokes: InkStroke[] = [];
  private eraserReplacementIds = new Set<string>();
  private eraserReplacements: InkStroke[] = [];
  private lassoPath: InkPoint[] = [];
  private selectedStrokeIds = new Set<string>();
  private lassoDrag: {
    start: InkPoint;
    pageId: string;
    bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
    strokes: InkStroke[];
    before: Map<string, InkPoint[]>;
    dx: number;
    dy: number;
  } | null = null;
  private sizePopover: HTMLElement | null = null;
  private sizePopoverButton: HTMLButtonElement | null = null;
  private sizePopoverOpen = false;
  private renderFrame: number | null = null;
  private resizeRequested = false;
  private zoomRenderTimer: number | undefined;

  constructor(leaf: WorkspaceLeaf, store: NotebookStore) {
    super(leaf);
    this.store = store;
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "z", () => { this.undo(); return false; });
    this.scope.register(["Mod", "Shift"], "z", () => { this.redo(); return false; });
  }

  getViewType(): string { return VIEW_TYPE_INK; }
  getDisplayText(): string { return this.file?.basename ?? this.notebook.title; }
  getIcon(): string { return "pen-line"; }

  revealPage(pageId: string): void {
    this.finishPointerInput(false);
    const index = this.notebook.pages.findIndex((page) => page.id === pageId);
    if (index < 0) return;
    this.pageIndex = index;
    this.renderPageRail();
    this.renderPage();
  }

  async onOpen(): Promise<void> {
    this.root = this.containerEl.children[1] as HTMLElement;
    this.root.empty();
    this.root.addClass("ink-notes-view");
    this.root.addClass("ink-rail-hidden");
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
    this.root.createDiv({ cls: "ink-tool-popover-host" });
    this.root.createSpan({ cls: "ink-page-status", attr: { "aria-live": "polite" } });
    this.renderToolbar();
    this.renderCanvas();
    this.viewReady = true;
    this.renderAll();
  }

  async onClose(): Promise<void> {
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
    this.finishPointerInput(false);
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.file && (this.dirtyRevision > this.savedRevision || this.activeSave)) await this.save(this.file);
    this.tiles?.dispose();
    this.viewReady = false;
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.notebook = await this.store.read(file);
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.resetInteraction();
    this.dirtyRevision = 0;
    this.savedRevision = 0;
    this.renderAll();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.finishPointerInput(false);
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    if (this.dirtyRevision > this.savedRevision || this.activeSave) await this.save(file);
  }

  async reloadFromDisk(): Promise<void> {
    if (this.syncing || this.activePointerId !== null) { this.externalRefreshPending = true; return; }
    if (!this.file) return;
    const file = this.file;
    const latest = await this.store.read(file);
    if (this.file !== file) return;
    if (notebooksEqual(latest, this.notebook)) return;
    this.receiveMergedNotebook(latest);
  }

  private renderToolbar(): void {
    const toolbar = this.root.querySelector<HTMLElement>(".ink-toolbar")!;
    toolbar.empty();
    const group = toolbar;
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
    this.renderToolPopover();
    this.updateToolButtons();
  }

  private renderToolPopover(): void {
    const host = this.root.querySelector<HTMLElement>(".ink-tool-popover-host")!;
    host.empty();
    this.addSizePopover(host);
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
    button.title = "Brush size and opacity";

    const popover = container.createDiv({
      cls: "ink-size-popover",
      attr: { role: "dialog", "aria-label": "Tool settings", "aria-hidden": "true" },
    });
    const header = popover.createDiv({ cls: "ink-size-popover-header" });
    header.createSpan({ cls: "ink-size-popover-title", text: "Tool settings" });
    header.createSpan({ cls: "ink-control-value", text: formatControlValue("Size", this.state.width) });
    const input = popover.createEl("input", {
      attr: {
        type: "range",
        min: "1",
        max: "24",
        step: "0.5",
        value: String(this.state.width),
        "aria-label": "Brush size",
      },
    });
    const widths = this.addToolbarSection(popover, "Widths");
    for (const width of [2, 4, 8]) {
      const preset = widths.createEl("button", { cls: "ink-width-preset", attr: { type: "button", title: width + " px", "aria-label": width + " px", "data-width": String(width), "aria-pressed": String(this.state.width === width) } });
      preset.createSpan({ cls: "ink-width-line" }).style.height = width + "px";
      preset.addEventListener("click", () => { this.state.width = width; this.updateBrushControls(); });
    }
    this.addColorPicker(popover);
    this.addRange(popover, "Opacity", 0.1, 1, 0.05, this.state.opacity, (value) => { this.state.opacity = value; });
    this.addRange(popover, "Smoothing", 0, 1, 0.05, this.state.smoothing, (value) => { this.state.smoothing = value; });
    const eraser = popover.createDiv({ cls: "ink-eraser-settings" });
    eraser.createDiv({ cls: "ink-size-popover-title", text: "Eraser" });
    const modes = eraser.createDiv({ cls: "ink-eraser-modes", attr: { role: "radiogroup", "aria-label": "Eraser mode" } });
    for (const [mode, label, iconName] of [["stroke", "Stroke eraser", "eraser"], ["circle", "Circle eraser", "circle"], ["square", "Square eraser", "square"]] as const) {
      const modeButton = modes.createEl("button", { cls: "ink-eraser-mode", attr: { type: "button", role: "radio", title: label, "aria-label": label, "aria-checked": String(this.state.eraserMode === mode), "data-eraser-mode": mode } });
      setIcon(modeButton.createSpan({ cls: "ink-button-icon" }), iconName);
      modeButton.addEventListener("click", () => {
        this.state.eraserMode = mode;
        this.updateEraserControls();
      });
    }
    eraser.createDiv({ cls: "ink-stroke-eraser-hint", text: "Erases the entire touched stroke. Size is fixed." });
    this.addRange(eraser, "Eraser size", 8, 160, 2, this.state.eraserSize, (value) => {
      this.state.eraserSize = value;
      this.refreshEraserCursor();
    });

    const close = (): void => this.setSizePopoverOpen(false);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.setSizePopoverOpen(!this.sizePopoverOpen);
    });
    input.addEventListener("input", () => {
      const next = Number(input.value);
      this.state.width = next;
      this.updateBrushControls();
    });
    this.registerDomEvent(document, "pointerdown", (event) => {
      if (this.sizePopoverOpen && !container.contains(event.target as Node)) close();
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && this.sizePopoverOpen) {
        close();
        this.activeToolButton()?.focus();
      }
    });
    this.registerDomEvent(window, "resize", () => this.positionSizePopover());
    this.registerDomEvent(window, "scroll", () => this.positionSizePopover(), true);

    this.sizePopover = popover;
    this.sizePopoverButton = button;
  }

  private setSizePopoverOpen(open: boolean): void {
    if (!this.sizePopover || !this.sizePopoverButton) return;
    this.sizePopoverOpen = open;
    this.sizePopover.toggleClass("is-open", open);
    this.sizePopover.setAttribute("aria-hidden", String(!open));
    this.root.querySelectorAll<HTMLElement>(".ink-tool-button[aria-haspopup='dialog']").forEach((button) => {
      button.setAttribute("aria-expanded", String(open && button.dataset.tool === this.state.tool));
    });
    if (open) {
      this.positionSizePopover();
      window.requestAnimationFrame(() => this.positionSizePopover());
      window.requestAnimationFrame(() => this.sizePopover?.querySelector<HTMLElement>(this.state.tool === "eraser" ? ".ink-eraser-mode" : "input, button")?.focus());
    }
  }

  private positionSizePopover(): void {
    if (!this.sizePopoverOpen || !this.sizePopover || !this.sizePopoverButton) return;
    const anchor = this.activeToolButton() ?? this.sizePopoverButton;
    const buttonRect = anchor.getBoundingClientRect();
    const popoverRect = this.sizePopover.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2));
    const below = buttonRect.bottom + 10;
    const top = below + popoverRect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, buttonRect.top - popoverRect.height - 10);
    this.sizePopover.style.left = `${left}px`;
    this.sizePopover.style.top = `${top}px`;
  }

  private activeToolButton(): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>(`.ink-toolbar [data-tool="${this.state.tool}"]`);
  }

  private addToolbarSection(parent: HTMLElement, label: string): HTMLElement {
    const section = parent.createDiv({ cls: "ink-toolbar-section" });
    section.addClass(`ink-toolbar-section-${label.toLowerCase()}`);
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", label);
    return section.createDiv({ cls: "ink-toolbar-section-controls" });
  }

  private updateBrushControls(): void {
    this.root.querySelectorAll<HTMLElement>(".ink-width-preset").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.width) === this.state.width));
    });
    const input = this.sizePopover?.querySelector<HTMLInputElement>("input[aria-label='Brush size']");
    if (input) input.value = String(this.state.width);
    const value = this.sizePopover?.querySelector<HTMLElement>(".ink-size-popover-header .ink-control-value");
    if (value) value.textContent = this.state.tool === "eraser"
      ? formatControlValue("Size", this.state.eraserSize)
      : formatControlValue("Size", this.state.width);
    this.updateEraserControls();
  }

  private updateEraserControls(): void {
    if (!this.sizePopover) return;
    this.sizePopover.toggleClass("is-stroke-eraser", this.state.eraserMode === "stroke");
    this.sizePopover.querySelectorAll<HTMLElement>(".ink-eraser-mode").forEach((button) => {
      button.setAttribute("aria-checked", String(button.dataset.eraserMode === this.state.eraserMode));
    });
    this.refreshEraserCursor();
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
    this.previewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCanvas.style.pointerEvents = "none";
    this.previewCtx = this.previewCanvas.getContext("2d")!;
    this.canvas.style.pointerEvents = "none";
    this.pageElement.style.touchAction = "none";
    this.registerDomEvent(this.pageElement, "pointerenter", (event) => this.onPointerEnter(event));
    this.registerDomEvent(this.pageElement, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.pageElement, "pointermove", (event) => this.onPointerMove(event));
    this.registerDomEvent(this.pageElement, "pointerleave", () => {
      this.eraserPointerInside = false;
      this.refreshEraserCursor();
    });
    this.registerDomEvent(this.pageElement, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.pageElement, "pointercancel", (event) => this.onPointerCancel(event));
    this.registerDomEvent(this.pageElement, "lostpointercapture", (event) => this.onLostPointerCapture(event));
    this.registerDomEvent(this.pageElement, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "scroll", () => this.onViewportMotion(), { passive: true });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", (event) => this.onTouchStart(event));
    this.registerDomEvent(this.pageScroller, "touchcancel", () => { this.touchGesture = null; });
    const observer = new ResizeObserver(() => this.resizeCanvas());
    observer.observe(this.pageScroller);
    this.register(() => observer.disconnect());
  }

  private renderPageRail(): void {
    let rail = this.root.querySelector<HTMLElement>(".ink-page-rail");
    if (!rail) return;
    rail.empty();
    rail.createDiv({ cls: "ink-rail-heading", text: "Pages" });
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
      button.addEventListener("click", () => { this.finishPointerInput(false); this.pageIndex = index; this.renderPageRail(); this.renderPage(); });
    });
    rail.querySelector<HTMLElement>(".ink-page-thumb.is-active")?.scrollIntoView?.({ block: "nearest" });
  }

  private renderPage(): void {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    this.root.querySelector<HTMLElement>(".ink-page-status")!.textContent = (this.pageIndex + 1) + " / " + this.notebook.pages.length;
    this.pageElement.className = `ink-page ink-paper-${page.paper}`;
    this.pageElement.style.aspectRatio = `${this.notebook.pageWidth} / ${this.notebook.pageHeight}`;
    this.resizeCanvas();
    this.root.querySelectorAll<HTMLElement>(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }

  private resizeCanvas(): void {
    if (!this.canvas || !this.pageElement) return;
    this.layoutPage();
    const rect = this.pageElement.getBoundingClientRect();
    this.canvasLogicalWidth = Math.max(1, Math.round(rect.width / this.zoom * 64) / 64);
    this.canvasLogicalHeight = Math.max(1, Math.round(rect.height / this.zoom * 64) / 64);
    this.refreshEraserCursor();
    this.tiles.setPage(this.currentPage(), this.canvasLogicalWidth, this.canvasLogicalHeight, this.activeStroke);
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
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    if (refine || this.activeStroke) {
      this.resizeOverlay(this.canvas, this.ctx);
      this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
      this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
      if (this.activeStroke) { this.resizePreview(); this.drawPreview(); }
    }
    if (refine) this.tiles.prewarm(this.notebook.pages.filter((_, index) => Math.abs(index - this.pageIndex) === 1));
  }

  private drawStrokes(strokes: InkStroke[]): void {
    if (!this.ctx || !this.pageElement) return;
    this.tiles.sync(strokes, this.activeStroke);
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.drawPreview();
  }

  private drawInteractiveStrokes(strokes: InkStroke[], refine = false): void {
    if (!this.ctx || !this.pageElement) return;
    this.tiles.sync(strokes);
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
  }

  private onViewportMotion(): void {
    this.updateViewport(false);
    if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
    this.zoomRenderTimer = window.setTimeout(() => {
      this.zoomRenderTimer = undefined;
      this.updateViewport(true);
    }, 100);
  }


  private requestRender(resize = false): void {
    this.resizeRequested ||= resize;
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.flushPendingLassoPoint();
      const shouldResize = this.resizeRequested;
      this.resizeRequested = false;
      if (shouldResize) this.resizeCanvas();
      else if (this.lassoDrag) this.drawLassoInteraction();
      else if (this.interaction?.tool === "eraser") this.drawInteractiveStrokes(this.currentPage().strokes);
      else if (this.activeStroke) this.drawPreview();
      else this.drawStrokes(this.currentPage().strokes);
    });
  }

  private resizeOverlay(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): void {
    const { x, y, width, height } = this.viewport;
    const resolution = canvasResolution(width, height, window.devicePixelRatio || 1, this.zoom, 4_000_000);
    if (canvas.width !== resolution.width) canvas.width = resolution.width;
    if (canvas.height !== resolution.height) canvas.height = resolution.height;
    canvas.style.left = x + "px"; canvas.style.top = y + "px";
    canvas.style.width = width + "px"; canvas.style.height = height + "px";
    canvas.style.right = "auto"; canvas.style.bottom = "auto";
    this.overlayScaleX = resolution.width / width; this.overlayScaleY = resolution.height / height;
    ctx.setTransform(this.overlayScaleX, 0, 0, this.overlayScaleY, -x * this.overlayScaleX, -y * this.overlayScaleY);
  }

  private resizePreview(): void { this.resizeOverlay(this.previewCanvas, this.previewCtx); }

  private drawPreview(): void {
    if (!this.activeStroke || this.activeStroke.tool !== "pen" && this.activeStroke.tool !== "highlighter") return;
    this.previewCanvas.classList.toggle("is-highlighter-preview", this.activeStroke.tool === "highlighter");
    this.previewCtx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    drawInkStroke(this.previewCtx, this.activeStroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
  }

  private beginLassoPreview(page: InkPage): void {
    const drag = this.lassoDrag;
    if (!drag || !this.lassoCanvas) return;
    const selected = new Set(drag.strokes.map((stroke) => stroke.id));
    this.tiles.sync(page.strokes, selected);
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, false);
    const resolution = canvasResolution(this.canvasLogicalWidth, this.canvasLogicalHeight,
      window.devicePixelRatio || 1, this.zoom, 4_000_000);
    this.lassoCanvas.width = resolution.width;
    this.lassoCanvas.height = resolution.height;
    this.lassoCanvas.style.left = "0";
    this.lassoCanvas.style.top = "0";
    this.lassoCanvas.style.width = `${this.canvasLogicalWidth}px`;
    this.lassoCanvas.style.height = `${this.canvasLogicalHeight}px`;
    this.lassoCtx.setTransform(resolution.width / this.canvasLogicalWidth, 0, 0,
      resolution.height / this.canvasLogicalHeight, 0, 0);
    this.lassoCtx.clearRect(0, 0, this.canvasLogicalWidth, this.canvasLogicalHeight);
    for (const stroke of drag.strokes) drawInkStroke(this.lassoCtx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.lassoCanvas.style.transform = "translate(0px, 0px)";
    this.lassoCanvas.style.display = "block";
  }

  private drawLassoInteraction(): void {
    const drag = this.lassoDrag;
    if (!drag) return;
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    const bounds = drag.bounds;
    if (!bounds) return;
    this.ctx.save();
    this.ctx.strokeStyle = "#2f80ed";
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([6, 4]);
    this.ctx.strokeRect(
      (bounds.minX + drag.dx) * this.canvasLogicalWidth,
      (bounds.minY + drag.dy) * this.canvasLogicalHeight,
      (bounds.maxX - bounds.minX) * this.canvasLogicalWidth,
      (bounds.maxY - bounds.minY) * this.canvasLogicalHeight,
    );
    this.ctx.restore();
  }

  private commitLassoPreview(page: InkPage): void {
    this.tiles.sync(page.strokes);
    // Commit a complete 1x fallback before dropping the moving preview. The
    // high-density tiles can then refine progressively without visible holes.
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom);
    this.hideLassoPreview();
    this.drawStrokes(page.strokes);
  }

  private hideLassoPreview(): void {
    if (!this.lassoCanvas) return;
    this.lassoCanvas.style.display = "none";
    this.lassoCanvas.style.transform = "none";
    this.lassoCanvas.width = this.lassoCanvas.height = 1;
  }

  private commitPreview(page = this.currentPage()): void {
    if (!this.activeStroke || this.activeStroke.tool !== "pen" && this.activeStroke.tool !== "highlighter") return;
    this.tiles.sync(page.strokes);
    // Commit a complete bounded-density frame before dropping the transient
    // stroke. High-density tiles can refine later without a pen-up flash.
    this.tiles.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom);
    this.previewCanvas.width = this.previewCanvas.height = 1;
    this.previewCanvas.classList.remove("is-highlighter-preview");
  }

  private drawSelection(width: number, height: number): void {
    const ctx = this.ctx;
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
    const bounds = selectionBounds(this.selectedStrokes());
    if (bounds) ctx.strokeRect(bounds.minX * width, bounds.minY * height, (bounds.maxX - bounds.minX) * width, (bounds.maxY - bounds.minY) * height);
    ctx.restore();
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    if (this.activePointerId !== null) this.finishPointerInput(false);
    this.updateViewport(true);
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.activePointerId = event.pointerId;
    const page = this.currentPage();
    const tool = this.state.tool;
    this.interaction = {
      generation: ++this.interactionGeneration,
      pointerId: event.pointerId,
      pageId: page.id,
      tool,
      eraserMode: tool === "eraser" ? this.state.eraserMode : undefined,
      eraserSize: tool === "eraser" ? this.state.eraserSize : undefined,
      smoothing: tool === "pen" || tool === "highlighter" ? this.state.smoothing : undefined,
    };
    this.pageElement.setPointerCapture(event.pointerId);
    const point = this.toPoint(event);
    this.erasedStrokeIds.clear();
    this.erasedCandidateIds.clear();
    this.erasedStrokes = [];
    this.eraserReplacementIds.clear();
    this.eraserReplacements = [];
    if (tool === "eraser") {
      this.updateEraserHover(point, true);
      if (this.eraseAt(point, page)) this.requestRender();
      return;
    }
    if (tool === "lasso") {
      if (this.isPointInSelection(point)) {
        const strokes = this.selectedStrokes();
        const before = new Map(strokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
        this.lassoDrag = {
          start: point,
          pageId: page.id,
          strokes,
          before,
          bounds: boundsForPointSets([...before.values()]),
          dx: 0,
          dy: 0,
        };
        this.beginLassoPreview(page);
      } else {
        this.selectedStrokeIds.clear();
        this.lassoPath = [point];
        this.drawStrokes(page.strokes);
      }
      return;
    }
    this.activeStroke = {
      id: newId("stroke"),
      pageId: page.id,
      tool,
      color: this.state.color,
      width: this.state.width,
      opacity: this.state.opacity,
      points: [point],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.lastPoint = point;
    page.strokes.push(this.activeStroke);
    this.resizePreview();
    this.drawPreview();
  }

  private onPointerEnter(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    const rect = this.pageElement.getBoundingClientRect();
    this.updateEraserHover(this.toPoint(event, rect), pointInsideRect(event, rect));
  }

  private onPointerMove(event: PointerEvent): void {
    if (event.pointerType === "touch") return;
    const rect = this.pageElement.getBoundingClientRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    if (this.activePointerId === null) {
      this.updateEraserHover(point, inside);
      return;
    }
    if (this.activePointerId !== event.pointerId) return;
    if (this.interaction?.tool === "eraser") this.updateEraserHover(point, inside);
    this.applyPointerSamples(event, rect);
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    const rect = this.pageElement.getBoundingClientRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    this.applyPointerSamples(event, rect);
    this.finishPointerInput(true);
    if (this.pageElement.hasPointerCapture(event.pointerId)) this.pageElement.releasePointerCapture(event.pointerId);
    this.updateEraserHover(point, inside);
  }

  private onPointerCancel(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    this.eraserPointerInside = false;
    this.finishPointerInput(false);
  }

  private applyPointerSamples(event: PointerEvent, rect = this.pageElement.getBoundingClientRect()): void {
    const interaction = this.interaction;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const page = this.pageById(interaction.pageId);
    if (!page) return;
    const samples = this.pointerSamples(event);
    if (interaction.tool === "lasso") {
      this.pendingLassoPoint = this.toPoint(samples[samples.length - 1], rect);
      this.requestRender();
      return;
    }
    let changed = false;
    for (const sample of samples) {
      const point = this.toPoint(sample, rect);
      if (interaction.tool === "eraser") {
        changed = this.eraseAt(point, page, interaction.eraserMode, interaction.eraserSize) || changed;
      } else if (this.activeStroke && this.lastPoint) {
        const stabilized = stabilizeInkPoint(point, this.lastPoint, this.canvasLogicalWidth, this.canvasLogicalHeight, interaction.smoothing ?? this.state.smoothing);
        if (!stabilized) continue;
        this.activeStroke.points.push(stabilized);
        beautifyStrokeTail(this.activeStroke.points, this.canvasLogicalWidth, this.canvasLogicalHeight, interaction.smoothing ?? this.state.smoothing);
        this.activeStroke.updatedAt = Date.now();
        this.lastPoint = stabilized;
        changed = true;
      }
    }
    if (changed) this.requestRender();
  }

  private pointerSamples(event: PointerEvent): PointerEvent[] {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    return coalesced.length > 0 ? [...coalesced, event] : [event];
  }

  private applyLassoPoint(point: InkPoint): boolean {
    if (this.lassoDrag) {
      const bounds = this.lassoDrag.bounds;
      const dx = constrainDelta(point.x - this.lassoDrag.start.x, bounds?.minX ?? 0, bounds?.maxX ?? 1);
      const dy = constrainDelta(point.y - this.lassoDrag.start.y, bounds?.minY ?? 0, bounds?.maxY ?? 1);
      if (dx === this.lassoDrag.dx && dy === this.lassoDrag.dy) return false;
      this.lassoDrag.dx = dx;
      this.lassoDrag.dy = dy;
      this.lassoCanvas.style.transform = `translate(${dx * this.canvasLogicalWidth}px, ${dy * this.canvasLogicalHeight}px)`;
      return true;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance(point, previous) < 0.001) return false;
    this.lassoPath.push(point);
    return true;
  }

  private flushPendingLassoPoint(): void {
    const point = this.pendingLassoPoint;
    this.pendingLassoPoint = null;
    if (point) this.applyLassoPoint(point);
  }

  private finishPointerInput(_includeFinalSample = false): void {
    const interaction = this.interaction;
    if (!interaction) return;
    const page = this.pageById(interaction.pageId);
    this.interaction = null;
    this.refreshEraserCursor();
    if (!page) { this.activePointerId = null; return; }
    this.flushPendingLassoPoint();
    this.commitPreview(page);
    if (this.activeStroke && this.renderFrame !== null && !this.resizeRequested) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    if (interaction.tool === "lasso") {
      this.finishLasso(page);
      this.activePointerId = null;
      this.applyPendingMergedNotebook();
      return;
    }
    if (interaction.tool === "eraser" && this.erasedStrokes.length > 0) {
      this.markChanged(page);
      this.pushCommand(this.erasedStrokesCommand(page.id, this.erasedStrokes, this.eraserReplacements));
      this.drawInteractiveStrokes(page.strokes, true);
    } else if (this.activeStroke) {
      this.markChanged(page);
      this.pushCommand(this.addedStrokeCommand(page.id, this.activeStroke));
    }
    this.activePointerId = null;
    this.activeStroke = null;
    this.lastPoint = null;
    this.pendingLassoPoint = null;
    this.applyPendingMergedNotebook();
    this.scheduleSave();
    if (this.externalRefreshPending) {
      this.externalRefreshPending = false;
      void this.reloadFromDisk().catch((error) => new Notice(`Ink Notes could not reload: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private applyPendingMergedNotebook(): void {
    if (!this.pendingMergedNotebook) return;
    const pageId = this.currentPage().id;
    this.notebook = mergeNotebooks(this.pendingMergedNotebook, this.notebook);
    this.pendingMergedNotebook = null;
    this.pageIndex = Math.max(0, this.notebook.pages.findIndex((page) => page.id === pageId));
    this.renderAll();
  }

  private receiveMergedNotebook(notebook: InkNotebook): void {
    this.pendingMergedNotebook = this.pendingMergedNotebook
      ? mergeNotebooks(this.pendingMergedNotebook, notebook)
      : notebook;
    // Reads and saves can finish after the next pointerdown. Apply only between strokes.
    if (this.activePointerId === null) this.applyPendingMergedNotebook();
  }

  private onLostPointerCapture(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    // A delayed release from the previous stroke must not finish a recaptured pen.
    if (this.pageElement.hasPointerCapture(event.pointerId)) return;
    this.finishPointerInput(false);
  }

  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.92 : 1.08), { x: event.clientX, y: event.clientY });
  }

  private onTouchStart(event: TouchEvent): void {
    this.touchGesture = null;
    if (this.activePointerId !== null || event.touches.length < 1 || event.touches.length > 2) return;
    event.preventDefault();
    const a = event.touches.item(0);
    const b = event.touches.item(1);
    if (!a) return;
    const x = b ? (a.clientX + b.clientX) / 2 : a.clientX;
    const y = b ? (a.clientY + b.clientY) / 2 : a.clientY;
    const rect = this.pageElement.getBoundingClientRect();
    this.touchGesture = {
      ids: b ? [a.identifier, b.identifier] : [a.identifier],
      distance: b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0,
      zoom: this.zoom, x, y,
      pageX: (x - rect.left) / rect.width,
      pageY: (y - rect.top) / rect.height,
    };
  }

  private onTouchMove(event: TouchEvent): void {
    if (this.activePointerId !== null) {
      this.touchGesture = null;
      return;
    }
    const gesture = this.touchGesture;
    if (!gesture) return;
    const touches = Array.from(event.touches);
    const a = touches.find((touch) => touch.identifier === gesture.ids[0]);
    const b = touches.find((touch) => touch.identifier === gesture.ids[1]);
    if (touches.length !== gesture.ids.length || !a || (gesture.ids.length === 2 && !b)) {
      this.onTouchStart(event);
      return;
    }
    event.preventDefault();
    if (!b) {
      this.pageScroller.scrollLeft += gesture.x - a.clientX;
      this.pageScroller.scrollTop += gesture.y - a.clientY;
      gesture.x = a.clientX;
      gesture.y = a.clientY;
      return;
    }
    if (gesture.distance < 1) {
      this.onTouchStart(event);
      return;
    }
    const distanceNow = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.setZoom(gesture.zoom * distanceNow / gesture.distance,
      { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      { x: gesture.pageX, y: gesture.pageY });
  }

  private toPoint(event: PointerEvent, rect = this.pageElement.getBoundingClientRect()): InkPoint {
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now(),
    };
  }

  private eraseAt(point: InkPoint, page = this.currentPage(), mode = this.state.eraserMode, size = this.state.eraserSize): boolean {
    const radius = mode === "stroke" ? STROKE_ERASER_HIT_RADIUS : size / 2;
    const indexed = this.tiles?.queryNear ? this.tiles.queryNear(point, radius) : page.strokes;
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
      if (this.eraserReplacementIds.delete(stroke.id)) this.eraserReplacements = this.eraserReplacements.filter((candidate) => candidate.id !== stroke.id);
    }
    this.deleteStrokes(page, removed.map((stroke) => stroke.id));
    if (mode !== "stroke") {
      const now = Date.now();
      for (const stroke of removed) {
        const segments = eraseStrokeSegments(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight);
        for (const points of segments) {
          const replacement = { ...cloneStroke(stroke), id: newId("stroke"), points, createdAt: now, updatedAt: now };
          page.strokes.push(replacement);
          this.eraserReplacementIds.add(replacement.id);
          this.eraserReplacements.push(cloneStroke(replacement));
        }
      }
      page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    }
    return true;
  }

  private updateEraserHover(point: InkPoint, inside: boolean): void {
    this.eraserHoverPoint = point;
    this.eraserPointerInside = inside;
    this.refreshEraserCursor();
  }

  private refreshEraserCursor(): void {
    if (!this.eraserCursor) return;
    const mode = this.interaction?.tool === "eraser" ? this.interaction.eraserMode ?? this.state.eraserMode : this.state.eraserMode;
    const eraserSize = this.interaction?.tool === "eraser" ? this.interaction.eraserSize ?? this.state.eraserSize : this.state.eraserSize;
    this.eraserCursor.toggleClass("is-visible", this.state.tool === "eraser" && this.eraserPointerInside && this.eraserHoverPoint !== null);
    this.eraserCursor.toggleClass("is-square", mode === "square");
    this.eraserCursor.toggleClass("is-stroke", mode === "stroke");
    const size = mode === "stroke" ? STROKE_ERASER_HIT_RADIUS * 2 : eraserSize;
    this.eraserCursor.style.width = `${size}px`;
    this.eraserCursor.style.height = `${size}px`;
    if (!this.eraserHoverPoint) return;
    this.eraserCursor.style.left = `${this.eraserHoverPoint.x * this.canvasLogicalWidth}px`;
    this.eraserCursor.style.top = `${this.eraserHoverPoint.y * this.canvasLogicalHeight}px`;
  }

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
    this.pageIndex = this.notebook.pages.length - 1;
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), beforePageId, page.id);
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }

  private changePage(delta: number): void {
    this.finishPointerInput(false);
    this.pageIndex = Math.max(0, Math.min(this.notebook.pages.length - 1, this.pageIndex + delta));
    this.renderPageRail();
    this.renderPage();
  }

  private openPageMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const paper of ["blank", "ruled", "grid", "dot"] as PaperStyle[]) menu.addItem((item) => item.setTitle(`Paper: ${paper}`).setChecked(this.currentPage().paper === paper).onClick(() => {
      const page = this.currentPage();
      const before = page.paper;
      page.paper = paper;
      this.markChanged(page);
      this.pushCommand({
        undo: () => this.setPagePaper(page.id, before),
        redo: () => this.setPagePaper(page.id, paper),
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
    this.pushCommand({
      undo: () => this.setPageTitle(page.id, before),
      redo: () => this.setPageTitle(page.id, title),
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
    this.finishPageOrderChange(now);
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
    this.finishPageOrderChange(now);
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
    this.finishPageOrderChange(Date.now());
    this.pushNotebookCommand(before, cloneNotebook(this.notebook), pageId, pageId);
    this.renderAll();
    this.scheduleSave();
  }

  private finishPageOrderChange(now: number): void {
    this.notebook.pageOrder = this.notebook.pages.map((page) => page.id);
    this.notebook.pageOrderUpdatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
  }

  private pushNotebookCommand(before: InkNotebook, after: InkNotebook, beforePageId: string, afterPageId: string): void {
    this.pushCommand({
      undo: () => this.restoreNotebookState(before, beforePageId),
      redo: () => this.restoreNotebookState(after, afterPageId),
    });
  }

  private restoreNotebookState(snapshot: InkNotebook, selectedPageId: string): void {
    const current = this.notebook;
    const next = cloneNotebook(snapshot);
    const now = Date.now();
    const nextIds = new Set(next.pages.map((page) => page.id));
    const deletedPages = { ...current.deletedPages, ...next.deletedPages };
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
  }

  private setPagePaper(pageId: string, paper: PaperStyle): void {
    const page = this.pageById(pageId);
    if (!page) return;
    page.paper = paper;
    this.markChanged(page);
  }

  private setPageTitle(pageId: string, title: string): void {
    const page = this.pageById(pageId);
    if (!page) return;
    page.title = title;
    this.markChanged(page);
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

  private addToolButton(parent: HTMLElement, icon: string, label: string, tool: InkTool): void {
    const hasSettings = tool === "pen" || tool === "highlighter" || tool === "eraser";
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: {
      type: "button", title: label, "aria-label": label, "aria-pressed": String(this.state.tool === tool), "data-tool": tool,
      ...(hasSettings ? { "aria-haspopup": "dialog", "aria-expanded": "false" } : {}),
    } });
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    setIcon(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", () => {
      this.finishPointerInput(false);
      if (this.state.tool === tool && (tool === "pen" || tool === "highlighter" || tool === "eraser")) {
        this.setSizePopoverOpen(!this.sizePopoverOpen);
        return;
      }
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      this.sizePopover?.toggleClass("is-eraser-tool", tool === "eraser");
      this.updateBrushControls();
      this.updateToolButtons();
      this.renderPage();
      this.refreshEraserCursor();
      if (this.sizePopoverOpen) {
        this.setSizePopoverOpen(true);
        this.positionSizePopover();
      }
    });
  }

  private addIconButton(parent: HTMLElement, icon: string, label: string, callback: (event: MouseEvent) => void, disabled = false): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "ink-icon-button", attr: { type: "button", title: label, "aria-label": label } });
    button.disabled = disabled;
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    setIcon(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", callback);
    return button;
  }

  private addColorPicker(parent: HTMLElement): void {
    const control = parent.createDiv({ cls: "ink-color-control" });
    const swatches = control.createDiv({ cls: "ink-color-swatches" });
    for (const color of INK_COLORS) {
      const swatch = swatches.createEl("button", { cls: "ink-color-swatch", attr: { type: "button", title: color.label, "aria-label": color.label, "aria-pressed": String(this.state.color.toLowerCase() === color.value), "data-color": color.value } });
      swatch.style.backgroundColor = color.value;
      if (this.state.color.toLowerCase() === color.value) swatch.addClass("is-active");
      swatch.addEventListener("click", () => {
        this.state.color = color.value;
        this.updateColorSwatches();
      });
    }
    const custom = control.createEl("label", { cls: "ink-custom-color", attr: { title: "Custom color" } });
    setIcon(custom.createSpan({ cls: "ink-button-icon" }), "plus");
    const input = custom.createEl("input", { attr: { type: "color", value: this.state.color, "aria-label": "Custom color" } });
    input.addEventListener("input", () => {
      this.state.color = input.value;
      this.updateColorSwatches();
    });
  }

  private addRange(parent: HTMLElement, name: string, min: number, max: number, step: number, value: number, onChange: (value: number) => void): void {
    const label = parent.createEl("label", { cls: "ink-range-control", attr: { title: name } });
    label.addClass(`ink-range-${name.toLowerCase().replace(/\s+/g, "-")}`);
    const header = label.createDiv({ cls: "ink-range-header" });
    header.createSpan({ text: name });
    const valueText = header.createSpan({ cls: "ink-control-value", text: formatControlValue(name, value) });
    const input = label.createEl("input", { attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": name } });
    input.addEventListener("input", () => {
      const next = Number(input.value);
      onChange(next);
      valueText.textContent = formatControlValue(name, next);
    });
  }

  private layoutPage(): void {
    const style = getComputedStyle(this.pageScroller);
    const width = Math.max(1, Math.min(980, this.pageScroller.clientWidth
      - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)));
    const height = width * this.notebook.pageHeight / this.notebook.pageWidth;
    this.pageElement.style.width = width + "px";
    this.pageElement.style.height = height + "px";
    this.pageElement.style.transform = "scale(" + this.zoom + ")";
    // Transforms do not grow layout boxes. Reserve the full scaled page for scrolling.
    this.pageExtent.style.width = width * this.zoom + "px";
    this.pageExtent.style.height = height * this.zoom + "px";
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

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 250);
  }

  private async save(file = this.file): Promise<void> {
    if (!file) return;
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
        const snapshot = cloneNotebook(this.notebook);
        try {
          const merged = await this.store.save(file, snapshot);
          this.savedRevision = Math.max(this.savedRevision, revision);
          if (this.file === file) this.receiveMergedNotebook(merged);
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
    }
  }

  private undo(): void {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.afterCommand();
  }

  private redo(): void {
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo();
    this.undoStack.push(command);
    this.afterCommand();
  }

  private pushCommand(command: EditCommand): void {
    this.undoStack.push(command);
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  private afterCommand(): void {
    this.clearSelection();
    this.updateHistoryButtons();
    this.renderAll();
    this.scheduleSave();
  }

  private updateHistoryButtons(): void {
    const undo = this.root.querySelector<HTMLButtonElement>("[aria-label='Undo']");
    const redo = this.root.querySelector<HTMLButtonElement>("[aria-label='Redo']");
    if (undo) undo.disabled = this.undoStack.length === 0;
    if (redo) redo.disabled = this.redoStack.length === 0;
  }

  private updateToolButtons(): void {
    this.root.querySelectorAll<HTMLElement>(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }

  private updateColorSwatches(): void {
    const custom = this.root.querySelector<HTMLInputElement>('input[type="color"]');
    if (custom) custom.value = this.state.color;
    this.root.querySelectorAll<HTMLElement>(".ink-color-swatch").forEach((swatch) => {
      const active = swatch.dataset.color === this.state.color.toLowerCase();
      swatch.toggleClass("is-active", active);
      swatch.setAttribute("aria-pressed", String(active));
    });
  }

  private addedStrokeCommand(pageId: string, original: InkStroke): EditCommand {
    let currentId = original.id;
    const template = cloneStroke(original);
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, [currentId]);
        this.markChanged(page);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        const restored = restoredStroke(template);
        currentId = restored.id;
        page.strokes.push(restored);
        this.markChanged(page);
      },
    };
  }

  private erasedStrokesCommand(pageId: string, originals: InkStroke[], replacements: InkStroke[]): EditCommand {
    let currentOriginals = originals.map(cloneStroke);
    let currentReplacements = replacements.map(cloneStroke);
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, currentReplacements.map((stroke) => stroke.id));
        currentOriginals = originals.map(restoredStroke);
        page.strokes.push(...currentOriginals.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        this.markChanged(page);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, currentOriginals.map((stroke) => stroke.id));
        currentReplacements = replacements.map(restoredStroke);
        page.strokes.push(...currentReplacements.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        this.markChanged(page);
      },
    };
  }

  private finishLasso(page: InkPage): void {
    if (this.lassoDrag) {
      const drag = this.lassoDrag;
      const before = drag.before;
      const movedStrokes = drag.strokes;
      const moved = drag.dx !== 0 || drag.dy !== 0;
      if (moved) for (const stroke of movedStrokes) {
        const points = before.get(stroke.id);
        if (points) stroke.points = translatePoints(points, drag.dx, drag.dy);
      }
      const after = new Map(movedStrokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
      if (moved) {
        const now = Date.now();
        for (const stroke of movedStrokes) stroke.updatedAt = now;
        const pageId = drag.pageId;
        this.pushCommand({
          undo: () => this.applyStrokePoints(pageId, before),
          redo: () => this.applyStrokePoints(pageId, after),
        });
        this.markChanged(page, false);
        this.scheduleSave();
      }
      this.lassoDrag = null;
      this.commitLassoPreview(page);
      return;
    }
    if (this.lassoPath.length >= 3) {
      this.selectedStrokeIds = new Set(page.strokes.filter((stroke) => stroke.points.some((point) => pointInPolygon(point, this.lassoPath))).map((stroke) => stroke.id));
    }
    this.lassoPath = [];
    this.drawStrokes(page.strokes);
  }

  private applyStrokePoints(pageId: string, pointsById: Map<string, InkPoint[]>): void {
    const page = this.pageById(pageId);
    if (!page) return;
    for (const stroke of page.strokes) {
      const points = pointsById.get(stroke.id);
      if (points) {
        stroke.points = clonePoints(points);
        stroke.updatedAt = Date.now();
      }
    }
    this.markChanged(page);
  }

  private deleteStrokes(page: InkPage, ids: string[]): void {
    const deleted = new Set(ids);
    page.strokes = page.strokes.filter((stroke) => !deleted.has(stroke.id));
    page.deletedStrokeIds = [...new Set([...page.deletedStrokeIds, ...ids])];
  }

  private markChanged(page: InkPage, syncTiles = true): void {
    const now = Date.now();
    page.updatedAt = now;
    this.notebook.updatedAt = now;
    this.dirtyRevision += 1;
    if (syncTiles && page === this.currentPage()) this.tiles?.sync(page.strokes);
  }

  private selectedStrokes(): InkStroke[] {
    return this.currentPage().strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id));
  }

  private isPointInSelection(point: InkPoint): boolean {
    const bounds = selectionBounds(this.selectedStrokes());
    const padding = 0.008;
    return bounds !== null && point.x >= bounds.minX - padding && point.x <= bounds.maxX + padding
      && point.y >= bounds.minY - padding && point.y <= bounds.maxY + padding;
  }

  private clearSelection(): void {
    this.selectedStrokeIds.clear();
    this.lassoPath = [];
    this.lassoDrag = null;
    this.hideLassoPreview();
  }

  private resetInteraction(): void {
    if (this.previewCanvas) this.previewCanvas.width = this.previewCanvas.height = 1;
    this.touchGesture = null;
    this.pendingMergedNotebook = null;
    this.externalRefreshPending = false;
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
    this.clearSelection();
  }

  private renderAll(): void {
    if (!this.viewReady) return;
    this.renderPageRail();
    this.renderPage();
    this.updateHistoryButtons();
  }

  private pageById(id: string): InkPage | undefined { return this.notebook.pages.find((page) => page.id === id); }
  private currentPage(): InkPage { return this.notebook.pages[this.pageIndex]; }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointInsideRect(point: { clientX: number; clientY: number }, rect: DOMRect): boolean {
  return point.clientX >= rect.left && point.clientX <= rect.right
    && point.clientY >= rect.top && point.clientY <= rect.bottom;
}

function stabilizeInkPoint(point: InkPoint, previous: InkPoint, width: number, height: number, smoothing: number): InkPoint | null {
  if (width <= 1 || height <= 1) return distance(point, previous) >= 0.0002 ? point : null;
  const dx = (point.x - previous.x) * width;
  const dy = (point.y - previous.y) * height;
  const pixels = Math.hypot(dx, dy);
  const strength = Math.max(0, Math.min(1, smoothing));
  if (pixels < 0.35 + strength * 0.65) return null;
  // Slow input exposes sensor and pressure noise most strongly. Blend only
  // short moves; quick strokes and deliberate corners remain responsive.
  const minimumWeight = 0.78 - strength * 0.48;
  const mediumWeight = 0.92 - strength * 0.27;
  const weight = pixels < 4 ? minimumWeight : pixels < 8 ? mediumWeight : 1;
  const pressureDelta = point.pressure - previous.pressure;
  const pressureWeight = Math.max(0.2, 0.82 - strength * 0.52);
  return {
    ...point,
    x: previous.x + (point.x - previous.x) * weight,
    y: previous.y + (point.y - previous.y) * weight,
    pressure: Math.abs(pressureDelta) < 0.025 * strength
      ? previous.pressure
      : previous.pressure + pressureDelta * Math.max(pressureWeight, Math.min(1, pixels / 12)),
  };
}

function beautifyStrokeTail(points: InkPoint[], width: number, height: number, smoothing: number): void {
  if (points.length < 3 || smoothing <= 0 || width <= 1 || height <= 1) return;
  const start = points[points.length - 3];
  const middle = points[points.length - 2];
  const end = points[points.length - 1];
  const incomingX = (middle.x - start.x) * width, incomingY = (middle.y - start.y) * height;
  const outgoingX = (end.x - middle.x) * width, outgoingY = (end.y - middle.y) * height;
  const incomingLength = Math.hypot(incomingX, incomingY), outgoingLength = Math.hypot(outgoingX, outgoingY);
  if (incomingLength < 0.001 || outgoingLength < 0.001) return;
  const direction = (incomingX * outgoingX + incomingY * outgoingY) / (incomingLength * outgoingLength);
  // Only polish continuous motion. A turn of roughly 60 degrees or sharper is
  // treated as intentional handwriting structure and remains untouched.
  const continuity = Math.max(0, Math.min(1, (direction - 0.5) / 0.5));
  if (continuity === 0) return;
  const targetX = (start.x + end.x) / 2, targetY = (start.y + end.y) / 2;
  const correctionX = (targetX - middle.x) * width, correctionY = (targetY - middle.y) * height;
  const correctionLength = Math.hypot(correctionX, correctionY);
  if (correctionLength < 0.01) return;
  const maximumCorrection = 1.25 * smoothing * continuity;
  const scale = correctionLength > maximumCorrection && correctionLength > 0 ? maximumCorrection / correctionLength : 1;
  middle.x += correctionX * scale / width;
  middle.y += correctionY * scale / height;
  middle.pressure += ((start.pressure + end.pressure) / 2 - middle.pressure) * smoothing * continuity * 0.35;
}

function strokeIntersectsEraser(stroke: InkStroke, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  if (stroke.points.some((point) => pointInsideEraser(point, center, radius, mode, width, height))) return true;
  for (let index = 1; index < stroke.points.length; index++) {
    if (segmentIntersectsEraser(stroke.points[index - 1], stroke.points[index], center, radius, mode, width, height)) return true;
  }
  return false;
}

function eraseStrokeSegments(stroke: InkStroke, center: InkPoint, radius: number, mode: Exclude<EraserMode, "stroke">, width: number, height: number): InkPoint[][] {
  const segments: InkPoint[][] = [];
  let segment: InkPoint[] = [];
  const flush = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  for (const point of sampleStrokeForEraser(stroke.points, radius, width, height)) {
    if (pointInsideEraser(point, center, radius, mode, width, height)) flush();
    else segment.push({ ...point });
  }
  flush();
  return segments;
}

function pointInsideEraser(point: InkPoint, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  const dx = (point.x - center.x) * width;
  const dy = (point.y - center.y) * height;
  return mode === "square" ? Math.abs(dx) <= radius && Math.abs(dy) <= radius : Math.hypot(dx, dy) <= radius;
}

function segmentIntersectsEraser(start: InkPoint, end: InkPoint, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  const ax = (start.x - center.x) * width;
  const ay = (start.y - center.y) * height;
  const bx = (end.x - center.x) * width;
  const by = (end.y - center.y) * height;
  if (mode === "square") return segmentIntersectsBox(ax, ay, bx, by, radius);
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + dx * t, ay + dy * t) <= radius;
}

function segmentIntersectsBox(ax: number, ay: number, bx: number, by: number, radius: number): boolean {
  let minimum = 0, maximum = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [origin, delta] of [[ax, dx], [ay, dy]] as const) {
    if (delta === 0) { if (origin < -radius || origin > radius) return false; continue; }
    const near = (-radius - origin) / delta;
    const far = (radius - origin) / delta;
    minimum = Math.max(minimum, Math.min(near, far));
    maximum = Math.min(maximum, Math.max(near, far));
    if (minimum > maximum) return false;
  }
  return true;
}

function sampleStrokeForEraser(points: InkPoint[], radius: number, width: number, height: number): InkPoint[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const sampled: InkPoint[] = [{ ...points[0] }];
  const step = Math.max(1, radius / 3);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1], end = points[index];
    const pixels = Math.hypot((end.x - start.x) * width, (end.y - start.y) * height);
    const count = Math.max(1, Math.ceil(pixels / step));
    for (let sample = 1; sample <= count; sample++) sampled.push(interpolateInkPoint(start, end, sample / count));
  }
  return sampled;
}

function interpolateInkPoint(start: InkPoint, end: InkPoint, amount: number): InkPoint {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    pressure: start.pressure + (end.pressure - start.pressure) * amount,
    tiltX: start.tiltX === undefined || end.tiltX === undefined ? end.tiltX : start.tiltX + (end.tiltX - start.tiltX) * amount,
    tiltY: start.tiltY === undefined || end.tiltY === undefined ? end.tiltY : start.tiltY + (end.tiltY - start.tiltY) * amount,
    t: start.t + (end.t - start.t) * amount,
  };
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

function cloneStroke(stroke: InkStroke): InkStroke {
  return { ...stroke, points: clonePoints(stroke.points) };
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

function clonePoints(points: InkPoint[]): InkPoint[] {
  return points.map((point) => ({ ...point }));
}

function restoredStroke(stroke: InkStroke): InkStroke {
  const now = Date.now();
  return { ...cloneStroke(stroke), id: newId("stroke"), createdAt: now, updatedAt: now };
}

function translatePoints(points: InkPoint[], dx: number, dy: number): InkPoint[] {
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy, t: Date.now() }));
}

function selectionBounds(strokes: InkStroke[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  return boundsForPointSets(strokes.map((stroke) => stroke.points));
}

function boundsForPointSets(pointSets: InkPoint[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const points of pointSets) for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function notebooksEqual(left: InkNotebook, right: InkNotebook): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pointInPolygon(point: InkPoint, polygon: InkPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function constrainDelta(delta: number, minimum: number, maximum: number): number {
  return Math.max(-minimum, Math.min(1 - maximum, delta));
}

function formatControlValue(name: string, value: number): string {
  return name === "Opacity" || name === "Smoothing" ? `${Math.round(value * 100)}%` : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} px`;
}
