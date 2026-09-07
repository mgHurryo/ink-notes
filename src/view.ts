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

export class InkView extends FileView {
  private readonly store: NotebookStore;
  private notebook: InkNotebook = createNotebook();
  private pageIndex = 0;
  private state: ToolState = { tool: "pen", color: "#1b1b1b", width: 3, opacity: 1 };
  private root!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private pageElement!: HTMLElement;
  private pageScroller!: HTMLElement;
  private syncing = false;
  private saveRequested = false;
  private activeSave: Promise<void> | null = null;
  private saveTimer: number | undefined;
  private activeStroke: InkStroke | null = null;
  private activePointerId: number | null = null;
  private lastPoint: InkPoint | null = null;
  private pinchStart: { distance: number; zoom: number; x: number; y: number } | null = null;
  private zoom = 1;
  private viewReady = false;
  private undoStack: EditCommand[] = [];
  private redoStack: EditCommand[] = [];
  private erasedStrokeIds = new Set<string>();
  private erasedStrokes: InkStroke[] = [];
  private lassoPath: InkPoint[] = [];
  private selectedStrokeIds = new Set<string>();
  private lassoDrag: { start: InkPoint; before: Map<string, InkPoint[]> } | null = null;

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
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
    this.renderToolbar();
    this.renderCanvas();
    this.viewReady = true;
    this.renderAll();
  }

  async onClose(): Promise<void> {
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
    if (this.syncing || !this.file) return;
    const latest = await this.store.read(this.file);
    this.notebook = mergeNotebooks(latest, this.notebook);
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, this.notebook.pages.length - 1));
    this.renderAll();
  }

  private renderToolbar(): void {
    const toolbar = this.root.querySelector<HTMLElement>(".ink-toolbar")!;
    toolbar.empty();
    const group = toolbar.createDiv({ cls: "ink-toolbar-group" });
    this.addIconButton(group, "arrow-left", "Previous page", () => this.changePage(-1));
    this.addIconButton(group, "arrow-right", "Next page", () => this.changePage(1));
    this.addIconButton(group, "panel-left", "Show pages", () => this.root.toggleClass("ink-rail-hidden", !this.root.hasClass("ink-rail-hidden")));
    this.addIconButton(group, "undo-2", "Undo", () => this.undo(), this.undoStack.length === 0);
    this.addIconButton(group, "redo-2", "Redo", () => this.redo(), this.redoStack.length === 0);
    const divider = group.createSpan({ cls: "ink-toolbar-divider" });
    divider.setAttribute("aria-hidden", "true");
    this.addToolButton(group, "pen-line", "Pen", "pen");
    this.addToolButton(group, "highlighter", "Highlighter", "highlighter");
    this.addToolButton(group, "eraser", "Eraser", "eraser");
    this.addToolButton(group, "lasso", "Lasso", "lasso");
    this.addColorPicker(group);
    this.addRange(group, "Width", 1, 24, 0.5, this.state.width, (value) => { this.state.width = value; });
    this.addRange(group, "Opacity", 0.1, 1, 0.05, this.state.opacity, (value) => { this.state.opacity = value; });
    this.addIconButton(group, "plus", "Add page", () => this.addPage());
    this.addIconButton(group, "more-horizontal", "Page options", (event) => this.openPageMenu(event));
  }

  private renderCanvas(): void {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageElement = this.pageScroller.createDiv({ cls: "ink-page" });
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas" });
    this.ctx = this.canvas.getContext("2d")!;
    this.canvas.style.touchAction = "none";
    this.registerDomEvent(this.canvas, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.canvas, "pointermove", (event) => this.onPointerMove(event));
    this.registerDomEvent(this.canvas, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.canvas, "pointercancel", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.canvas, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", () => { this.pinchStart = null; });
    this.registerDomEvent(window, "resize", () => this.resizeCanvas());
  }

  private renderPageRail(): void {
    let rail = this.root.querySelector<HTMLElement>(".ink-page-rail");
    if (!rail) rail = this.root.createDiv({ cls: "ink-page-rail" });
    rail.empty();
    this.notebook.pages.forEach((page, index) => {
      const button = rail!.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.addEventListener("click", () => { this.pageIndex = index; this.renderPageRail(); this.renderPage(); });
    });
  }

  private renderPage(): void {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    this.pageElement.className = `ink-page ink-paper-${page.paper}`;
    this.pageElement.style.aspectRatio = `${this.notebook.pageWidth} / ${this.notebook.pageHeight}`;
    this.resizeCanvas();
    this.drawStrokes(page.strokes);
    this.root.querySelectorAll(".ink-tool-button").forEach((el) => el.toggleClass("is-active", el.getAttribute("data-tool") === this.state.tool));
  }

  private resizeCanvas(): void {
    if (!this.canvas || !this.pageElement) return;
    const rect = this.pageElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawStrokes(this.currentPage().strokes);
  }

  private drawStrokes(strokes: InkStroke[]): void {
    if (!this.ctx || !this.pageElement) return;
    const rect = this.pageElement.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    for (const stroke of strokes) this.drawStroke(stroke, rect.width, rect.height);
    this.drawSelection(rect.width, rect.height);
  }

  private drawStroke(stroke: InkStroke, width: number, height: number): void {
    if (stroke.points.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = stroke.opacity;
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (stroke.tool === "highlighter") ctx.globalCompositeOperation = "multiply";
    ctx.beginPath();
    let previous = stroke.points[0];
    ctx.moveTo(previous.x * width, previous.y * height);
    for (let i = 1; i < stroke.points.length; i++) {
      const point = stroke.points[i];
      const pressureWidth = stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + point.pressure * 0.75);
      ctx.lineWidth = pressureWidth;
      const midX = ((previous.x + point.x) / 2) * width;
      const midY = ((previous.y + point.y) / 2) * height;
      ctx.quadraticCurveTo(previous.x * width, previous.y * height, midX, midY);
      previous = point;
    }
    ctx.lineTo(previous.x * width, previous.y * height);
    ctx.stroke();
    ctx.restore();
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
    this.activePointerId = event.pointerId;
    this.canvas.setPointerCapture(event.pointerId);
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
    this.drawStrokes(this.currentPage().strokes);
  }

  private onPointerMove(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId || event.pointerType === "touch") return;
    const point = this.toPoint(event);
    if (this.state.tool === "eraser") { this.eraseAt(point); return; }
    if (this.state.tool === "lasso") {
      if (this.lassoDrag) {
        const bounds = boundsForPointSets([...this.lassoDrag.before.values()]);
        const dx = constrainDelta(point.x - this.lassoDrag.start.x, bounds?.minX ?? 0, bounds?.maxX ?? 1);
        const dy = constrainDelta(point.y - this.lassoDrag.start.y, bounds?.minY ?? 0, bounds?.maxY ?? 1);
        for (const stroke of this.selectedStrokes()) {
          const original = this.lassoDrag.before.get(stroke.id);
          if (original) stroke.points = translatePoints(original, dx, dy);
        }
      } else if (distance(point, this.lassoPath[this.lassoPath.length - 1]) >= 0.002) {
        this.lassoPath.push(point);
      }
      this.drawStrokes(this.currentPage().strokes);
      return;
    }
    if (!this.activeStroke || !this.lastPoint) return;
    if (distance(point, this.lastPoint) < 0.001) return;
    this.activeStroke.points.push(point);
    this.activeStroke.updatedAt = Date.now();
    this.lastPoint = point;
    this.drawStrokes(this.currentPage().strokes);
  }

  private onPointerUp(event: PointerEvent): void {
    if (this.activePointerId !== event.pointerId) return;
    const page = this.currentPage();
    if (this.state.tool === "lasso") {
      this.finishLasso(page);
      this.activePointerId = null;
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
    this.scheduleSave();
  }

  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.92 : 1.08));
  }

  private onTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    const a = event.touches.item(0);
    const b = event.touches.item(1);
    if (!a || !b) return;
    this.pinchStart = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: this.zoom, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  private onTouchMove(event: TouchEvent): void {
    if (event.touches.length !== 2 || !this.pinchStart) return;
    event.preventDefault();
    const a = event.touches.item(0);
    const b = event.touches.item(1);
    if (!a || !b) return;
    const distanceNow = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.setZoom(this.pinchStart.zoom * distanceNow / this.pinchStart.distance);
  }

  private toPoint(event: PointerEvent): InkPoint {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now(),
    };
  }

  private eraseAt(point: InkPoint): void {
    const page = this.currentPage();
    const removed = page.strokes.filter((stroke) => !this.erasedStrokeIds.has(stroke.id) && stroke.points.some((candidate) => distance(candidate, point) < this.state.width / 500));
    if (removed.length === 0) return;
    for (const stroke of removed) {
      this.erasedStrokeIds.add(stroke.id);
      this.erasedStrokes.push(cloneStroke(stroke));
    }
    this.deleteStrokes(page, removed.map((stroke) => stroke.id));
    this.markChanged(page);
    this.drawStrokes(page.strokes);
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
    this.scheduleSave();
  }

  private addToolButton(parent: HTMLElement, icon: string, label: string, tool: InkTool): void {
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: { type: "button", title: label, "aria-label": label, "data-tool": tool } });
    setIcon(button, icon);
    button.addEventListener("click", () => {
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      this.renderToolbar();
      this.renderPage();
    });
  }

  private addIconButton(parent: HTMLElement, icon: string, label: string, callback: (event: MouseEvent) => void, disabled = false): void {
    const button = parent.createEl("button", { cls: "ink-icon-button", attr: { type: "button", title: label, "aria-label": label } });
    button.disabled = disabled;
    setIcon(button, icon);
    button.addEventListener("click", callback);
  }

  private addColorPicker(parent: HTMLElement): void {
    const label = parent.createEl("label", { cls: "ink-color-control", attr: { title: "Ink color" } });
    const input = label.createEl("input", { attr: { type: "color", value: this.state.color, "aria-label": "Ink color" } });
    input.addEventListener("input", () => { this.state.color = input.value; });
  }

  private addRange(parent: HTMLElement, name: string, min: number, max: number, step: number, value: number, onChange: (value: number) => void): void {
    const label = parent.createEl("label", { cls: "ink-range-control", attr: { title: name } });
    const input = label.createEl("input", { attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": name } });
    input.addEventListener("input", () => onChange(Number(input.value)));
  }

  private setZoom(value: number): void {
    this.zoom = Math.max(0.5, Math.min(3, value));
    this.pageElement.style.transform = `scale(${this.zoom})`;
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
        this.notebook = mergeNotebooks(merged, this.notebook);
        this.renderAll();
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
    this.renderToolbar();
  }

  private afterCommand(): void {
    this.clearSelection();
    this.renderToolbar();
    this.renderPage();
    this.scheduleSave();
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
