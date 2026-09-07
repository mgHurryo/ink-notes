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
}

interface EditCommand {
  undo: () => void;
  redo: () => void;
}

const INK_COLORS = [
  { value: "#1b1b1b", label: "Black" },
  { value: "#195bff", label: "Blue" },
  { value: "#f23c42", label: "Red" },
  { value: "#42c449", label: "Green" },
  { value: "#ffffff", label: "White" },
];

export class InkView extends FileView {
  private readonly store: NotebookStore;
  private notebook: InkNotebook = createNotebook();
  private pageIndex = 0;
  private state: ToolState = { tool: "pen", color: "#1b1b1b", width: 3, opacity: 1 };
  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private previewCanvas!: HTMLCanvasElement;
  private previewCtx!: CanvasRenderingContext2D;
  private tiles!: TileRenderer;
  private viewport: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private overlayScaleX = 1;
  private overlayScaleY = 1;
  private canvasLogicalWidth = 1;
  private canvasLogicalHeight = 1;
  private pageElement!: HTMLElement;
  private pageExtent!: HTMLElement;
  private pageScroller!: HTMLElement;
  private syncing = false;
  private saveRequested = false;
  private activeSave: Promise<void> | null = null;
  private pendingMergedNotebook: InkNotebook | null = null;
  private saveTimer: number | undefined;
  private activeStroke: InkStroke | null = null;
  private activePointerId: number | null = null;
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
  private zoom = 1;
  private viewReady = false;
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];
  private erasedStrokeIds = new Set<string>();
  private erasedStrokes: InkStroke[] = [];
  private lassoPath: InkPoint[] = [];
  private selectedStrokeIds = new Set<string>();
  private lassoDrag: { start: InkPoint; before: Map<string, InkPoint[]> } | null = null;
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

  async onOpen(): Promise<void> {
    this.root = this.containerEl.children[1] as HTMLElement;
    this.root.empty();
    this.root.addClass("ink-notes-view");
    this.root.addClass("ink-rail-hidden");
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-document-bar" });
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
    this.root.createDiv({ cls: "ink-brush-bar" });
    this.renderToolbar();
    this.renderCanvas();
    this.viewReady = true;
    this.renderAll();
  }

  async onClose(): Promise<void> {
    if (this.renderFrame !== null) window.cancelAnimationFrame(this.renderFrame);
    this.renderFrame = null;
    if (this.zoomRenderTimer !== undefined) window.clearTimeout(this.zoomRenderTimer);
    this.tiles?.dispose();
    if (this.saveTimer !== undefined && this.file) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      await this.save(this.file);
    }
    if (this.activeSave) await this.activeSave;
    this.viewReady = false;
  }

  async onLoadFile(file: TFile): Promise<void> {
    this.notebook = await this.store.read(file);
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.resetInteraction();
    this.renderAll();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      await this.save(file);
    }
    if (this.activeSave) await this.activeSave;
  }

  async reloadFromDisk(): Promise<void> {
    if (this.syncing || this.activePointerId !== null || !this.file) return;
    const file = this.file;
    const latest = await this.store.read(file);
    if (this.file !== file) return;
    this.receiveMergedNotebook(latest);
  }

  private renderToolbar(): void {
    const documentBar = this.root.querySelector<HTMLElement>(".ink-document-bar")!;
    documentBar.empty();
    setIcon(documentBar.createSpan({ cls: "ink-brand", attr: { "aria-label": "Ink Notes" } }), "notebook-pen");
    const tab = documentBar.createDiv({ cls: "ink-document-tab" });
    tab.createSpan({ cls: "ink-document-title", text: this.getDisplayText() });
    this.addIconButton(tab, "chevron-down", "Document options", (event) => this.openPageMenu(event));
    documentBar.createSpan({ cls: "ink-current-page-title", text: this.currentPage().title });
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
    this.addIconButton(navigation, "arrow-left", "Previous", () => this.changePage(-1));
    this.addIconButton(navigation, "arrow-right", "Next", () => this.changePage(1));

    const tools = this.addToolbarSection(group, "Draw");
    this.addToolButton(tools, "pen-line", "Pen", "pen");
    this.addToolButton(tools, "highlighter", "Highlight", "highlighter");
    this.addToolButton(tools, "eraser", "Erase", "eraser");
    this.addToolButton(tools, "lasso-select", "Select", "lasso");

    const pages = this.addToolbarSection(group, "Document");
    this.addIconButton(pages, "file-plus-2", "Add page", () => this.addPage());
    this.addIconButton(pages, "more-horizontal", "Options", (event) => this.openPageMenu(event));
    this.renderBrushBar();
    this.updateToolButtons();
  }

  private renderBrushBar(): void {
    const bar = this.root.querySelector<HTMLElement>(".ink-brush-bar")!;
    bar.empty();
    const history = this.addToolbarSection(bar, "History");
    this.addIconButton(history, "undo-2", "Undo", () => this.undo(), this.undoStack.length === 0);
    this.addIconButton(history, "redo-2", "Redo", () => this.redo(), this.redoStack.length === 0);
    const brush = bar.createDiv({ cls: "ink-brush-palette", attr: { role: "toolbar", "aria-label": "Brush settings" } });
    const tips = this.addToolbarSection(brush, "Tips");
    this.addToolButton(tips, "pen-tool", "Pen tip", "pen");
    this.addToolButton(tips, "highlighter", "Highlighter tip", "highlighter");
    this.addToolButton(tips, "eraser", "Eraser tip", "eraser");
    const widths = this.addToolbarSection(brush, "Widths");
    for (const width of [2, 4, 8]) {
      const button = widths.createEl("button", { cls: "ink-width-preset", attr: { type: "button", title: width + " px", "aria-label": width + " px", "data-width": String(width), "aria-pressed": String(this.state.width === width) } });
      button.createSpan({ cls: "ink-width-line" }).style.height = width + "px";
      button.addEventListener("click", () => { this.state.width = width; this.updateBrushControls(); });
    }
    this.addColorPicker(brush);
    this.addSizePopover(brush);
  }

  private addSizePopover(parent: HTMLElement): void {
    const container = parent.createDiv({ cls: "ink-size-popover-control" });
    const button = container.createEl("button", {
      cls: "ink-size-button",
      attr: {
        type: "button",
        "aria-label": "Brush size",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
      },
    });
    const icon = button.createSpan({ cls: "ink-button-icon" });
    setIcon(icon, "sliders-horizontal");
    button.title = "Brush size and opacity";

    const popover = container.createDiv({
      cls: "ink-size-popover",
      attr: { role: "dialog", "aria-label": "Brush size", "aria-hidden": "true" },
    });
    const header = popover.createDiv({ cls: "ink-size-popover-header" });
    header.createSpan({ cls: "ink-size-popover-title", text: "Brush size" });
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
    this.addRange(popover, "Opacity", 0.1, 1, 0.05, this.state.opacity, (value) => { this.state.opacity = value; });

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
        button.focus();
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
    this.sizePopoverButton.setAttribute("aria-expanded", String(open));
    if (open) {
      this.positionSizePopover();
      window.requestAnimationFrame(() => this.positionSizePopover());
    }
  }

  private positionSizePopover(): void {
    if (!this.sizePopoverOpen || !this.sizePopover || !this.sizePopoverButton) return;
    const buttonRect = this.sizePopoverButton.getBoundingClientRect();
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
    if (value) value.textContent = formatControlValue("Size", this.state.width);
  }

  private renderCanvas(): void {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    workspace.createDiv({ cls: "ink-page-rail", attr: { "aria-label": "Notebook pages" } });
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageExtent = this.pageScroller.createDiv({ cls: "ink-page-extent" });
    this.pageElement = this.pageExtent.createDiv({ cls: "ink-page" });
    const tileHost = this.pageElement.createDiv({ cls: "ink-tile-layer" });
    tileHost.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.tiles = new TileRenderer(tileHost);
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.setAttribute("aria-label", "Handwriting canvas");
    const footer = this.root.createDiv({ cls: "ink-statusbar" });
    footer.createSpan({ cls: "ink-page-status", attr: { "aria-live": "polite" } });
    const zoom = footer.createDiv({ cls: "ink-zoom-controls", attr: { role: "group", "aria-label": "Zoom" } });
    this.addIconButton(zoom, "minus", "Zoom out", () => this.setZoom(this.zoom - 0.1));
    const reset = zoom.createEl("button", { cls: "ink-zoom-value", text: "100%", attr: { type: "button", title: "Reset zoom", "aria-label": "Reset zoom" } });
    reset.addEventListener("click", () => this.setZoom(1));
    this.addIconButton(zoom, "plus", "Zoom in", () => this.setZoom(this.zoom + 0.1));
    this.previewCanvas = this.pageElement.createEl("canvas", { cls: "ink-canvas ink-preview-canvas" });
    this.previewCanvas.style.pointerEvents = "none";
    this.previewCtx = this.previewCanvas.getContext("2d")!;
    this.canvas.style.pointerEvents = "none";
    this.pageElement.style.touchAction = "none";
    this.registerDomEvent(this.pageElement, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.pageElement, "pointermove", (event) => this.onPointerMove(event));
    this.registerDomEvent(this.pageElement, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.pageElement, "pointercancel", (event) => this.onPointerUp(event));
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
    this.notebook.pages.forEach((page, index) => {
      const button = rail!.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.setAttribute("aria-label", String(index + 1) + ": " + page.title);
      button.setAttribute("aria-current", String(index === this.pageIndex));
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.createSpan({ text: page.title, cls: "ink-page-thumb-title" });
      button.addEventListener("click", () => { this.pageIndex = index; this.renderPageRail(); this.renderPage(); });
    });
  }

  private renderPage(): void {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    this.root.querySelector<HTMLElement>(".ink-document-title")!.textContent = this.getDisplayText();
    this.root.querySelector<HTMLElement>(".ink-current-page-title")!.textContent = page.title;
    this.root.querySelector<HTMLElement>(".ink-page-status")!.textContent = (this.pageIndex + 1) + " / " + this.notebook.pages.length;
    this.root.querySelector<HTMLButtonElement>("[aria-label='Previous']")!.disabled = this.pageIndex === 0;
    this.root.querySelector<HTMLButtonElement>("[aria-label='Next']")!.disabled = this.pageIndex === this.notebook.pages.length - 1;
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
      if (this.activeStroke?.tool === "pen") { this.resizePreview(); this.drawPreview(); }
    }
    if (refine) this.tiles.prewarm(this.notebook.pages.filter((_, index) => Math.abs(index - this.pageIndex) === 1));
  }

  private drawStrokes(strokes: InkStroke[]): void {
    if (!this.ctx || !this.pageElement) return;
    this.tiles.sync(strokes, this.activeStroke?.tool === "pen" ? this.activeStroke : null);
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.drawPreview();
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
      const shouldResize = this.resizeRequested;
      this.resizeRequested = false;
      if (shouldResize) this.resizeCanvas();
      else if (this.activeStroke?.tool === "pen") this.drawPreview();
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
    if (this.activeStroke?.tool !== "pen") return;
    this.previewCtx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    drawInkStroke(this.previewCtx, this.activeStroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
  }

  private commitPreview(): void {
    if (this.activeStroke?.tool !== "pen") return;
    this.tiles.sync(this.currentPage().strokes);
    this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    // Resolve dirty visible tiles before dropping the transient stroke, avoiding a pen-up flash.
    this.tiles.flushVisible();
    this.previewCanvas.width = this.previewCanvas.height = 1;
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
    if (this.activePointerId !== null) this.finishPointerInput();
    this.updateViewport(true);
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.activePointerId = event.pointerId;
    this.pageElement.setPointerCapture(event.pointerId);
    const point = this.toPoint(event);
    this.erasedStrokeIds.clear();
    this.erasedStrokes = [];
    if (this.state.tool === "eraser") {
      this.eraseAt(point);
      return;
    }
    if (this.state.tool === "lasso") {
      if (this.isPointInSelection(point)) {
        this.lassoDrag = {
          start: point,
          before: new Map(this.selectedStrokes().map((stroke) => [stroke.id, clonePoints(stroke.points)])),
        };
      } else {
        this.selectedStrokeIds.clear();
        this.lassoPath = [point];
        this.drawStrokes(this.currentPage().strokes);
      }
      return;
    }
    this.activeStroke = {
      id: newId("stroke"),
      pageId: this.currentPage().id,
      tool: this.state.tool,
      color: this.state.color,
      width: this.state.width,
      opacity: this.state.opacity,
      points: [point],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.lastPoint = point;
    this.currentPage().strokes.push(this.activeStroke);
    if (this.activeStroke.tool === "pen") {
      this.resizePreview();
      this.drawPreview();
    } else this.drawStrokes(this.currentPage().strokes);
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId || event.pointerType === "touch") return;
    this.applyPointerSamples(event);
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    this.applyPointerSamples(event);
    this.finishPointerInput();
    if (this.pageElement.hasPointerCapture(event.pointerId)) this.pageElement.releasePointerCapture(event.pointerId);
  }

  private applyPointerSamples(event: PointerEvent): void {
    let changed = false;
    for (const sample of this.pointerSamples(event)) {
      const point = this.toPoint(sample);
      if (this.state.tool === "eraser") {
        changed = this.eraseAt(point) || changed;
      } else if (this.state.tool === "lasso") {
        changed = this.applyLassoPoint(point) || changed;
      } else if (this.activeStroke && this.lastPoint && distance(point, this.lastPoint) >= 0.0002) {
        this.activeStroke.points.push(point);
        this.activeStroke.updatedAt = Date.now();
        this.lastPoint = point;
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
      const bounds = boundsForPointSets([...this.lassoDrag.before.values()]);
      const dx = constrainDelta(point.x - this.lassoDrag.start.x, bounds?.minX ?? 0, bounds?.maxX ?? 1);
      const dy = constrainDelta(point.y - this.lassoDrag.start.y, bounds?.minY ?? 0, bounds?.maxY ?? 1);
      for (const stroke of this.selectedStrokes()) {
        const original = this.lassoDrag.before.get(stroke.id);
        if (original) stroke.points = translatePoints(original, dx, dy);
      }
      return true;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance(point, previous) < 0.001) return false;
    this.lassoPath.push(point);
    return true;
  }

  private finishPointerInput(): void {
    const page = this.currentPage();
    this.commitPreview();
    if (this.activeStroke?.tool === "pen" && this.renderFrame !== null && !this.resizeRequested) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    if (this.state.tool === "lasso") {
      this.finishLasso(page);
      this.activePointerId = null;
      this.applyPendingMergedNotebook();
      return;
    }
    if (this.state.tool === "eraser" && this.erasedStrokes.length > 0) {
      this.pushCommand(this.deletedStrokesCommand(page.id, this.erasedStrokes));
    } else if (this.activeStroke) {
      this.markChanged(page);
      this.pushCommand(this.addedStrokeCommand(page.id, this.activeStroke));
    }
    this.activePointerId = null;
    this.activeStroke = null;
    this.lastPoint = null;
    this.applyPendingMergedNotebook();
    this.scheduleSave();
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
    this.finishPointerInput();
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

  private toPoint(event: PointerEvent): InkPoint {
    const rect = this.pageElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now(),
    };
  }

  private eraseAt(point: InkPoint): boolean {
    const page = this.currentPage();
    const removed = page.strokes.filter((stroke) => !this.erasedStrokeIds.has(stroke.id) && stroke.points.some((candidate) => distance(candidate, point) < this.state.width / 500));
    if (removed.length === 0) return false;
    for (const stroke of removed) {
      this.erasedStrokeIds.add(stroke.id);
      this.erasedStrokes.push(cloneStroke(stroke));
    }
    this.deleteStrokes(page, removed.map((stroke) => stroke.id));
    this.markChanged(page);
    return true;
  }

  private addPage(): void {
    const now = Date.now();
    const page: InkPage = { id: newId("page"), title: `Page ${this.notebook.pages.length + 1}`, paper: "ruled", strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
    this.notebook.pages.push(page);
    this.pageIndex = this.notebook.pages.length - 1;
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }

  private changePage(delta: number): void {
    this.pageIndex = Math.max(0, Math.min(this.notebook.pages.length - 1, this.pageIndex + delta));
    this.renderPageRail();
    this.renderPage();
  }

  private openPageMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const paper of ["blank", "ruled", "grid", "dot"] as PaperStyle[]) menu.addItem((item) => item.setTitle(`Paper: ${paper}`).setChecked(this.currentPage().paper === paper).onClick(() => { this.currentPage().paper = paper; this.currentPage().updatedAt = Date.now(); this.renderPageRail(); this.renderPage(); this.scheduleSave(); }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Rename page").onClick(() => this.renamePage()));
    menu.showAtMouseEvent(event);
  }

  private renamePage(): void {
    const title = window.prompt("Page title", this.currentPage().title)?.trim();
    if (!title) return;
    this.currentPage().title = title;
    this.currentPage().updatedAt = Date.now();
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }

  private addToolButton(parent: HTMLElement, icon: string, label: string, tool: InkTool): void {
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: { type: "button", title: label, "aria-label": label, "aria-pressed": String(this.state.tool === tool), "data-tool": tool } });
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    setIcon(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", () => {
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      this.updateToolButtons();
      this.renderPage();
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
      await this.activeSave;
      return;
    }
    this.activeSave = this.performSave(file);
    try {
      await this.activeSave;
    } catch (error) {
      new Notice(`Ink Notes could not save: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeSave = null;
    }
  }

  private async performSave(file: TFile): Promise<void> {
    this.syncing = true;
    try {
      do {
        this.saveRequested = false;
        const snapshot = cloneNotebook(this.notebook);
        const merged = await this.store.save(file, snapshot);
        if (this.file === file) this.receiveMergedNotebook(merged);
      } while (this.saveRequested);
    } finally {
      this.syncing = false;
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
    this.renderPage();
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

  private deletedStrokesCommand(pageId: string, originals: InkStroke[]): EditCommand {
    let current = originals.map(cloneStroke);
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        current = originals.map(restoredStroke);
        page.strokes.push(...current.map(cloneStroke));
        this.markChanged(page);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, current.map((stroke) => stroke.id));
        this.markChanged(page);
      },
    };
  }

  private finishLasso(page: InkPage): void {
    if (this.lassoDrag) {
      const before = this.lassoDrag.before;
      const movedStrokes = this.selectedStrokes();
      const after = new Map(movedStrokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
      const moved = [...after].some(([id, points]) => !samePoints(before.get(id), points));
      this.lassoDrag = null;
      if (moved) {
        const now = Date.now();
        for (const stroke of movedStrokes) stroke.updatedAt = now;
        const pageId = page.id;
        this.pushCommand({
          undo: () => this.applyStrokePoints(pageId, before),
          redo: () => this.applyStrokePoints(pageId, after),
        });
        this.markChanged(page);
        this.scheduleSave();
      }
      this.drawStrokes(page.strokes);
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

  private markChanged(page: InkPage): void {
    const now = Date.now();
    page.updatedAt = now;
    this.notebook.updatedAt = now;
    if (page === this.currentPage()) this.tiles?.sync(page.strokes);
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
  }

  private resetInteraction(): void {
    if (this.previewCanvas) this.previewCanvas.width = this.previewCanvas.height = 1;
    this.touchGesture = null;
    this.pendingMergedNotebook = null;
    this.activeStroke = null;
    this.activePointerId = null;
    this.lastPoint = null;
    this.erasedStrokeIds.clear();
    this.erasedStrokes = [];
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

function cloneNotebook(notebook: InkNotebook): InkNotebook {
  return {
    ...notebook,
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
  const points = pointSets.flat();
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
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

function samePoints(left: InkPoint[] | undefined, right: InkPoint[]): boolean {
  return left !== undefined && left.length === right.length
    && left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
}

function constrainDelta(delta: number, minimum: number, maximum: number): number {
  return Math.max(-minimum, Math.min(1 - maximum, delta));
}

function formatControlValue(name: string, value: number): string {
  return name === "Opacity" ? `${Math.round(value * 100)}%` : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} px`;
}
