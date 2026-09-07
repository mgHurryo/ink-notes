var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => InkNotesPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/view.ts
var import_obsidian = require("obsidian");

// src/model.ts
var DEFAULT_PAGE_WIDTH = 1600;
var DEFAULT_PAGE_HEIGHT = 2200;
function newId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}
function createNotebook(title = "Ink Notebook") {
  const now = Date.now();
  return {
    schema: 1,
    title,
    pageWidth: DEFAULT_PAGE_WIDTH,
    pageHeight: DEFAULT_PAGE_HEIGHT,
    pages: [createPage("Page 1", "ruled", now)],
    updatedAt: now
  };
}
function createPage(title, paper = "ruled", now = Date.now()) {
  return { id: newId("page"), title, paper, strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
}
function normalizeNotebook(value) {
  if (!value || typeof value !== "object") return createNotebook();
  const raw = value;
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  return {
    schema: 1,
    title: typeof raw.title === "string" ? raw.title : "Ink Notebook",
    pageWidth: finitePositive(raw.pageWidth, DEFAULT_PAGE_WIDTH),
    pageHeight: finitePositive(raw.pageHeight, DEFAULT_PAGE_HEIGHT),
    pages: pages.map(normalizePage).filter((page) => page !== null),
    updatedAt: finitePositive(raw.updatedAt, Date.now())
  };
}
function mergeNotebooks(base, incoming) {
  const pages = /* @__PURE__ */ new Map();
  for (const page of base.pages) pages.set(page.id, page);
  for (const page of incoming.pages) {
    const existing = pages.get(page.id);
    pages.set(page.id, existing ? mergePages(existing, page) : page);
  }
  const ordered = [...pages.values()].sort((a, b) => a.createdAt - b.createdAt);
  return {
    ...incoming,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    pageWidth: incoming.pageWidth || base.pageWidth,
    pageHeight: incoming.pageHeight || base.pageHeight,
    pages: ordered.length ? ordered : [createPage("Page 1")],
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt)
  };
}
function mergePages(base, incoming) {
  var _a, _b;
  const strokes = /* @__PURE__ */ new Map();
  for (const stroke of base.strokes) strokes.set(stroke.id, stroke);
  for (const stroke of incoming.strokes) {
    const existing = strokes.get(stroke.id);
    if (!existing || stroke.updatedAt >= existing.updatedAt) strokes.set(stroke.id, stroke);
  }
  const deletedStrokeIds = [.../* @__PURE__ */ new Set([...(_a = base.deletedStrokeIds) != null ? _a : [], ...(_b = incoming.deletedStrokeIds) != null ? _b : []])];
  for (const id of deletedStrokeIds) strokes.delete(id);
  return {
    ...base,
    ...incoming,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    paper: incoming.updatedAt >= base.updatedAt ? incoming.paper : base.paper,
    strokes: [...strokes.values()].sort((a, b) => a.createdAt - b.createdAt),
    deletedStrokeIds,
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt)
  };
}
function normalizePage(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  const strokes = Array.isArray(raw.strokes) ? raw.strokes : [];
  const deletedStrokeIds = Array.isArray(raw.deletedStrokeIds) ? raw.deletedStrokeIds.filter((id) => typeof id === "string") : [];
  const deleted = new Set(deletedStrokeIds);
  return {
    id: typeof raw.id === "string" ? raw.id : newId("page"),
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    paper: isPaperStyle(raw.paper) ? raw.paper : "ruled",
    strokes: strokes.map(normalizeStroke).filter((stroke) => stroke !== null && !deleted.has(stroke.id)),
    deletedStrokeIds,
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now())
  };
}
function normalizeStroke(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  if (typeof raw.id !== "string" || typeof raw.pageId !== "string") return null;
  const points = Array.isArray(raw.points) ? raw.points : [];
  return {
    id: raw.id,
    pageId: raw.pageId,
    tool: raw.tool === "highlighter" ? "highlighter" : "pen",
    color: typeof raw.color === "string" ? raw.color : "#1b1b1b",
    width: finitePositive(raw.width, 3),
    opacity: clamp(finitePositive(raw.opacity, 1), 0.05, 1),
    points: points.map(normalizePoint).filter((point) => point !== null),
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now())
  };
}
function normalizePoint(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  if (typeof raw.x !== "number" || typeof raw.y !== "number") return null;
  return {
    x: clamp(raw.x, 0, 1),
    y: clamp(raw.y, 0, 1),
    pressure: clamp(typeof raw.pressure === "number" ? raw.pressure : 0.5, 0.05, 1),
    tiltX: typeof raw.tiltX === "number" ? raw.tiltX : void 0,
    tiltY: typeof raw.tiltY === "number" ? raw.tiltY : void 0,
    t: finitePositive(raw.t, Date.now())
  };
}
function finitePositive(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function isPaperStyle(value) {
  return value === "blank" || value === "ruled" || value === "grid" || value === "dot";
}

// src/view.ts
var VIEW_TYPE_INK = "ink-notes-view";
var INK_COLORS = [
  { value: "#1b1b1b", label: "Black" },
  { value: "#195bff", label: "Blue" },
  { value: "#f23c42", label: "Red" },
  { value: "#42c449", label: "Green" },
  { value: "#ffffff", label: "White" }
];
var InkView = class extends import_obsidian.FileView {
  constructor(leaf, store) {
    super(leaf);
    this.notebook = createNotebook();
    this.pageIndex = 0;
    this.state = { tool: "pen", color: "#1b1b1b", width: 3, opacity: 1 };
    this.canvasLogicalWidth = 1;
    this.canvasLogicalHeight = 1;
    this.canvasRenderScale = 1;
    this.syncing = false;
    this.saveRequested = false;
    this.activeSave = null;
    this.pendingMergedNotebook = null;
    this.activeStroke = null;
    this.activePointerId = null;
    this.lastPoint = null;
    this.pinchStart = null;
    this.zoom = 1;
    this.viewReady = false;
    this.undoStack = [];
    this.redoStack = [];
    this.erasedStrokeIds = /* @__PURE__ */ new Set();
    this.erasedStrokes = [];
    this.lassoPath = [];
    this.selectedStrokeIds = /* @__PURE__ */ new Set();
    this.lassoDrag = null;
    this.sizePopover = null;
    this.sizePopoverButton = null;
    this.sizePopoverOpen = false;
    this.store = store;
    this.scope = new import_obsidian.Scope(this.app.scope);
    this.scope.register(["Mod"], "z", () => {
      this.undo();
      return false;
    });
    this.scope.register(["Mod", "Shift"], "z", () => {
      this.redo();
      return false;
    });
  }
  getViewType() {
    return VIEW_TYPE_INK;
  }
  getDisplayText() {
    var _a, _b;
    return (_b = (_a = this.file) == null ? void 0 : _a.basename) != null ? _b : this.notebook.title;
  }
  getIcon() {
    return "pen-line";
  }
  async onOpen() {
    this.root = this.containerEl.children[1];
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
  async onClose() {
    if (this.saveTimer !== void 0 && this.file) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
      await this.save(this.file);
    }
    if (this.activeSave) await this.activeSave;
    this.viewReady = false;
  }
  async onLoadFile(file) {
    this.notebook = await this.store.read(file);
    this.pageIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.resetInteraction();
    this.renderAll();
  }
  async onUnloadFile(file) {
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
      await this.save(file);
    }
    if (this.activeSave) await this.activeSave;
  }
  async reloadFromDisk() {
    if (this.syncing || this.activePointerId !== null || !this.file) return;
    const file = this.file;
    const latest = await this.store.read(file);
    if (this.file !== file) return;
    this.receiveMergedNotebook(latest);
  }
  renderToolbar() {
    const documentBar = this.root.querySelector(".ink-document-bar");
    documentBar.empty();
    (0, import_obsidian.setIcon)(documentBar.createSpan({ cls: "ink-brand", attr: { "aria-label": "Ink Notes" } }), "notebook-pen");
    const tab = documentBar.createDiv({ cls: "ink-document-tab" });
    tab.createSpan({ cls: "ink-document-title", text: this.getDisplayText() });
    this.addIconButton(tab, "chevron-down", "Document options", (event) => this.openPageMenu(event));
    documentBar.createSpan({ cls: "ink-current-page-title", text: this.currentPage().title });
    const toolbar = this.root.querySelector(".ink-toolbar");
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
  renderBrushBar() {
    const bar = this.root.querySelector(".ink-brush-bar");
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
      button.addEventListener("click", () => {
        this.state.width = width;
        this.updateBrushControls();
      });
    }
    this.addColorPicker(brush);
    this.addSizePopover(brush);
  }
  addSizePopover(parent) {
    const container = parent.createDiv({ cls: "ink-size-popover-control" });
    const button = container.createEl("button", {
      cls: "ink-size-button",
      attr: {
        type: "button",
        "aria-label": "Brush size",
        "aria-haspopup": "dialog",
        "aria-expanded": "false"
      }
    });
    const icon = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(icon, "sliders-horizontal");
    button.title = "Brush size and opacity";
    const popover = container.createDiv({
      cls: "ink-size-popover",
      attr: { role: "dialog", "aria-label": "Brush size", "aria-hidden": "true" }
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
        "aria-label": "Brush size"
      }
    });
    this.addRange(popover, "Opacity", 0.1, 1, 0.05, this.state.opacity, (value) => {
      this.state.opacity = value;
    });
    const close = () => this.setSizePopoverOpen(false);
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
      if (this.sizePopoverOpen && !container.contains(event.target)) close();
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
  setSizePopoverOpen(open) {
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
  positionSizePopover() {
    if (!this.sizePopoverOpen || !this.sizePopover || !this.sizePopoverButton) return;
    const buttonRect = this.sizePopoverButton.getBoundingClientRect();
    const popoverRect = this.sizePopover.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, buttonRect.left + buttonRect.width / 2 - popoverRect.width / 2));
    const below = buttonRect.bottom + 10;
    const top = below + popoverRect.height <= window.innerHeight - margin ? below : Math.max(margin, buttonRect.top - popoverRect.height - 10);
    this.sizePopover.style.left = `${left}px`;
    this.sizePopover.style.top = `${top}px`;
  }
  addToolbarSection(parent, label) {
    const section = parent.createDiv({ cls: "ink-toolbar-section" });
    section.addClass(`ink-toolbar-section-${label.toLowerCase()}`);
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", label);
    return section.createDiv({ cls: "ink-toolbar-section-controls" });
  }
  updateBrushControls() {
    var _a, _b;
    this.root.querySelectorAll(".ink-width-preset").forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.width) === this.state.width));
    });
    const input = (_a = this.sizePopover) == null ? void 0 : _a.querySelector("input[aria-label='Brush size']");
    if (input) input.value = String(this.state.width);
    const value = (_b = this.sizePopover) == null ? void 0 : _b.querySelector(".ink-size-popover-header .ink-control-value");
    if (value) value.textContent = formatControlValue("Size", this.state.width);
  }
  renderCanvas() {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    workspace.createDiv({ cls: "ink-page-rail", attr: { "aria-label": "Notebook pages" } });
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageElement = this.pageScroller.createDiv({ cls: "ink-page" });
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas" });
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.touchAction = "none";
    this.canvas.setAttribute("aria-label", "Handwriting canvas");
    const footer = this.root.createDiv({ cls: "ink-statusbar" });
    footer.createSpan({ cls: "ink-page-status", attr: { "aria-live": "polite" } });
    const zoom = footer.createDiv({ cls: "ink-zoom-controls", attr: { role: "group", "aria-label": "Zoom" } });
    this.addIconButton(zoom, "minus", "Zoom out", () => this.setZoom(this.zoom - 0.1));
    const reset = zoom.createEl("button", { cls: "ink-zoom-value", text: "100%", attr: { type: "button", title: "Reset zoom", "aria-label": "Reset zoom" } });
    reset.addEventListener("click", () => this.setZoom(1));
    this.addIconButton(zoom, "plus", "Zoom in", () => this.setZoom(this.zoom + 0.1));
    this.registerDomEvent(this.canvas, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.canvas, "pointermove", (event) => this.onPointerMove(event));
    this.registerDomEvent(this.canvas, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.canvas, "pointercancel", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.canvas, "lostpointercapture", (event) => this.onLostPointerCapture(event));
    this.registerDomEvent(this.canvas, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", () => {
      this.pinchStart = null;
    });
    const observer = new ResizeObserver(() => this.resizeCanvas());
    observer.observe(this.pageElement);
    this.register(() => observer.disconnect());
  }
  renderPageRail() {
    let rail = this.root.querySelector(".ink-page-rail");
    if (!rail) return;
    rail.empty();
    rail.createDiv({ cls: "ink-rail-heading", text: "Pages" });
    this.notebook.pages.forEach((page, index) => {
      const button = rail.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.setAttribute("aria-label", String(index + 1) + ": " + page.title);
      button.setAttribute("aria-current", String(index === this.pageIndex));
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
      button.createSpan({ text: page.title, cls: "ink-page-thumb-title" });
      button.addEventListener("click", () => {
        this.pageIndex = index;
        this.renderPageRail();
        this.renderPage();
      });
    });
  }
  renderPage() {
    if (!this.viewReady || this.notebook.pages.length === 0) return;
    const page = this.currentPage();
    this.root.querySelector(".ink-document-title").textContent = this.getDisplayText();
    this.root.querySelector(".ink-current-page-title").textContent = page.title;
    this.root.querySelector(".ink-page-status").textContent = this.pageIndex + 1 + " / " + this.notebook.pages.length;
    this.root.querySelector("[aria-label='Previous']").disabled = this.pageIndex === 0;
    this.root.querySelector("[aria-label='Next']").disabled = this.pageIndex === this.notebook.pages.length - 1;
    this.pageElement.className = `ink-page ink-paper-${page.paper}`;
    this.pageElement.style.aspectRatio = `${this.notebook.pageWidth} / ${this.notebook.pageHeight}`;
    this.resizeCanvas();
    this.drawStrokes(page.strokes);
    this.root.querySelectorAll(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }
  resizeCanvas() {
    if (!this.canvas || !this.pageElement) return;
    const rect = this.pageElement.getBoundingClientRect();
    const logicalWidth = Math.max(1, this.pageElement.offsetWidth || Math.round(rect.width / this.zoom));
    const logicalHeight = Math.max(1, this.pageElement.offsetHeight || Math.round(rect.height / this.zoom));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const zoomDensity = Math.max(1, Math.min(this.zoom, 2));
    const renderScale = Math.min(4, dpr * zoomDensity);
    this.canvasLogicalWidth = logicalWidth;
    this.canvasLogicalHeight = logicalHeight;
    this.canvasRenderScale = renderScale;
    this.canvas.width = Math.max(1, Math.round(logicalWidth * renderScale));
    this.canvas.height = Math.max(1, Math.round(logicalHeight * renderScale));
    this.canvas.style.width = `${logicalWidth}px`;
    this.canvas.style.height = `${logicalHeight}px`;
    this.ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.drawStrokes(this.currentPage().strokes);
  }
  drawStrokes(strokes) {
    if (!this.ctx || !this.pageElement) return;
    this.ctx.clearRect(0, 0, this.canvasLogicalWidth, this.canvasLogicalHeight);
    for (const stroke of strokes) this.drawStroke(stroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
  }
  drawStroke(stroke, width, height) {
    if (stroke.points.length === 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = stroke.opacity;
    ctx.strokeStyle = stroke.color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (stroke.tool === "highlighter") ctx.globalCompositeOperation = "multiply";
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      ctx.fillStyle = stroke.color;
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, strokeWidth(stroke, point.pressure) / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    if (stroke.tool === "highlighter") {
      ctx.lineWidth = stroke.width;
      drawSmoothPath(ctx, stroke.points, width, height);
      ctx.stroke();
      ctx.restore();
      return;
    }
    for (let index = 1; index < stroke.points.length; index++) {
      const previous = stroke.points[index - 1];
      const point = stroke.points[index];
      const start = index === 1 ? previous : midpoint(stroke.points[index - 2], previous);
      const end = index === stroke.points.length - 1 ? point : midpoint(previous, point);
      ctx.lineWidth = (strokeWidth(stroke, previous.pressure) + strokeWidth(stroke, point.pressure)) / 2;
      ctx.beginPath();
      ctx.moveTo(start.x * width, start.y * height);
      ctx.quadraticCurveTo(previous.x * width, previous.y * height, end.x * width, end.y * height);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawSelection(width, height) {
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
  onPointerDown(event) {
    if (event.pointerType === "touch") return;
    if (this.activePointerId !== null) this.finishPointerInput();
    if (this.saveTimer !== void 0) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = void 0;
    }
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
          before: new Map(this.selectedStrokes().map((stroke) => [stroke.id, clonePoints(stroke.points)]))
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
      updatedAt: Date.now()
    };
    this.lastPoint = point;
    this.currentPage().strokes.push(this.activeStroke);
    this.drawStrokes(this.currentPage().strokes);
  }
  onPointerMove(event) {
    if (this.activePointerId !== event.pointerId || event.pointerType === "touch") return;
    this.applyPointerSamples(event);
  }
  onPointerUp(event) {
    if (this.activePointerId !== event.pointerId) return;
    this.applyPointerSamples(event);
    this.finishPointerInput();
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  }
  applyPointerSamples(event) {
    let changed = false;
    for (const sample of this.pointerSamples(event)) {
      const point = this.toPoint(sample);
      if (this.state.tool === "eraser") {
        changed = this.eraseAt(point) || changed;
      } else if (this.state.tool === "lasso") {
        changed = this.applyLassoPoint(point) || changed;
      } else if (this.activeStroke && this.lastPoint && distance(point, this.lastPoint) >= 2e-4) {
        this.activeStroke.points.push(point);
        this.activeStroke.updatedAt = Date.now();
        this.lastPoint = point;
        changed = true;
      }
    }
    if (changed) this.drawStrokes(this.currentPage().strokes);
  }
  pointerSamples(event) {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    return coalesced.length > 0 ? [...coalesced, event] : [event];
  }
  applyLassoPoint(point) {
    var _a, _b, _c, _d;
    if (this.lassoDrag) {
      const bounds = boundsForPointSets([...this.lassoDrag.before.values()]);
      const dx = constrainDelta(point.x - this.lassoDrag.start.x, (_a = bounds == null ? void 0 : bounds.minX) != null ? _a : 0, (_b = bounds == null ? void 0 : bounds.maxX) != null ? _b : 1);
      const dy = constrainDelta(point.y - this.lassoDrag.start.y, (_c = bounds == null ? void 0 : bounds.minY) != null ? _c : 0, (_d = bounds == null ? void 0 : bounds.maxY) != null ? _d : 1);
      for (const stroke of this.selectedStrokes()) {
        const original = this.lassoDrag.before.get(stroke.id);
        if (original) stroke.points = translatePoints(original, dx, dy);
      }
      return true;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance(point, previous) < 1e-3) return false;
    this.lassoPath.push(point);
    return true;
  }
  finishPointerInput() {
    const page = this.currentPage();
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
  applyPendingMergedNotebook() {
    if (!this.pendingMergedNotebook) return;
    const pageId = this.currentPage().id;
    this.notebook = mergeNotebooks(this.pendingMergedNotebook, this.notebook);
    this.pendingMergedNotebook = null;
    this.pageIndex = Math.max(0, this.notebook.pages.findIndex((page) => page.id === pageId));
    this.renderAll();
  }
  receiveMergedNotebook(notebook) {
    this.pendingMergedNotebook = this.pendingMergedNotebook ? mergeNotebooks(this.pendingMergedNotebook, notebook) : notebook;
    if (this.activePointerId === null) this.applyPendingMergedNotebook();
  }
  onLostPointerCapture(event) {
    if (this.activePointerId !== event.pointerId) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) return;
    this.finishPointerInput();
  }
  onWheel(event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    this.setZoom(this.zoom * (event.deltaY > 0 ? 0.92 : 1.08));
  }
  onTouchStart(event) {
    if (event.touches.length !== 2) return;
    event.preventDefault();
    const a = event.touches.item(0);
    const b = event.touches.item(1);
    if (!a || !b) return;
    this.pinchStart = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: this.zoom, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }
  onTouchMove(event) {
    if (event.touches.length !== 2 || !this.pinchStart) return;
    event.preventDefault();
    const a = event.touches.item(0);
    const b = event.touches.item(1);
    if (!a || !b) return;
    const distanceNow = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.setZoom(this.pinchStart.zoom * distanceNow / this.pinchStart.distance);
  }
  toPoint(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      pressure: event.pressure > 0 ? event.pressure : 0.5,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now()
    };
  }
  eraseAt(point) {
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
  addPage() {
    const now = Date.now();
    const page = { id: newId("page"), title: `Page ${this.notebook.pages.length + 1}`, paper: "ruled", strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
    this.notebook.pages.push(page);
    this.pageIndex = this.notebook.pages.length - 1;
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }
  changePage(delta) {
    this.pageIndex = Math.max(0, Math.min(this.notebook.pages.length - 1, this.pageIndex + delta));
    this.renderPageRail();
    this.renderPage();
  }
  openPageMenu(event) {
    const menu = new import_obsidian.Menu();
    for (const paper of ["blank", "ruled", "grid", "dot"]) menu.addItem((item) => item.setTitle(`Paper: ${paper}`).setChecked(this.currentPage().paper === paper).onClick(() => {
      this.currentPage().paper = paper;
      this.currentPage().updatedAt = Date.now();
      this.renderPageRail();
      this.renderPage();
      this.scheduleSave();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Rename page").onClick(() => this.renamePage()));
    menu.showAtMouseEvent(event);
  }
  renamePage() {
    var _a;
    const title = (_a = window.prompt("Page title", this.currentPage().title)) == null ? void 0 : _a.trim();
    if (!title) return;
    this.currentPage().title = title;
    this.currentPage().updatedAt = Date.now();
    this.renderPageRail();
    this.renderPage();
    this.scheduleSave();
  }
  addToolButton(parent, icon, label, tool) {
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: { type: "button", title: label, "aria-label": label, "aria-pressed": String(this.state.tool === tool), "data-tool": tool } });
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", () => {
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      this.updateToolButtons();
      this.renderPage();
    });
  }
  addIconButton(parent, icon, label, callback, disabled = false) {
    const button = parent.createEl("button", { cls: "ink-icon-button", attr: { type: "button", title: label, "aria-label": label } });
    button.disabled = disabled;
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    (0, import_obsidian.setIcon)(iconHolder, icon);
    button.createSpan({ cls: "ink-button-text", text: label });
    button.addEventListener("click", callback);
    return button;
  }
  addColorPicker(parent) {
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
    (0, import_obsidian.setIcon)(custom.createSpan({ cls: "ink-button-icon" }), "plus");
    const input = custom.createEl("input", { attr: { type: "color", value: this.state.color, "aria-label": "Custom color" } });
    input.addEventListener("input", () => {
      this.state.color = input.value;
      this.updateColorSwatches();
    });
  }
  addRange(parent, name, min, max, step, value, onChange) {
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
  setZoom(value) {
    this.zoom = Math.max(0.5, Math.min(3, value));
    this.root.querySelector(".ink-zoom-value").textContent = Math.round(this.zoom * 100) + "%";
    this.root.querySelector("[aria-label='Zoom out']").disabled = this.zoom <= 0.5;
    this.root.querySelector("[aria-label='Zoom in']").disabled = this.zoom >= 3;
    this.pageElement.style.transform = `scale(${this.zoom})`;
    this.resizeCanvas();
  }
  scheduleSave() {
    if (this.saveTimer !== void 0) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = void 0;
      void this.save();
    }, 250);
  }
  async save(file = this.file) {
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
      new import_obsidian.Notice(`Ink Notes could not save: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.activeSave = null;
    }
  }
  async performSave(file) {
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
  undo() {
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.afterCommand();
  }
  redo() {
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo();
    this.undoStack.push(command);
    this.afterCommand();
  }
  pushCommand(command) {
    this.undoStack.push(command);
    this.redoStack = [];
    this.updateHistoryButtons();
  }
  afterCommand() {
    this.clearSelection();
    this.updateHistoryButtons();
    this.renderPage();
    this.scheduleSave();
  }
  updateHistoryButtons() {
    const undo = this.root.querySelector("[aria-label='Undo']");
    const redo = this.root.querySelector("[aria-label='Redo']");
    if (undo) undo.disabled = this.undoStack.length === 0;
    if (redo) redo.disabled = this.redoStack.length === 0;
  }
  updateToolButtons() {
    this.root.querySelectorAll(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }
  updateColorSwatches() {
    const custom = this.root.querySelector('input[type="color"]');
    if (custom) custom.value = this.state.color;
    this.root.querySelectorAll(".ink-color-swatch").forEach((swatch) => {
      const active = swatch.dataset.color === this.state.color.toLowerCase();
      swatch.toggleClass("is-active", active);
      swatch.setAttribute("aria-pressed", String(active));
    });
  }
  addedStrokeCommand(pageId, original) {
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
      }
    };
  }
  deletedStrokesCommand(pageId, originals) {
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
      }
    };
  }
  finishLasso(page) {
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
          redo: () => this.applyStrokePoints(pageId, after)
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
  applyStrokePoints(pageId, pointsById) {
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
  deleteStrokes(page, ids) {
    const deleted = new Set(ids);
    page.strokes = page.strokes.filter((stroke) => !deleted.has(stroke.id));
    page.deletedStrokeIds = [.../* @__PURE__ */ new Set([...page.deletedStrokeIds, ...ids])];
  }
  markChanged(page) {
    const now = Date.now();
    page.updatedAt = now;
    this.notebook.updatedAt = now;
  }
  selectedStrokes() {
    return this.currentPage().strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id));
  }
  isPointInSelection(point) {
    const bounds = selectionBounds(this.selectedStrokes());
    const padding = 8e-3;
    return bounds !== null && point.x >= bounds.minX - padding && point.x <= bounds.maxX + padding && point.y >= bounds.minY - padding && point.y <= bounds.maxY + padding;
  }
  clearSelection() {
    this.selectedStrokeIds.clear();
    this.lassoPath = [];
    this.lassoDrag = null;
  }
  resetInteraction() {
    this.pendingMergedNotebook = null;
    this.activeStroke = null;
    this.activePointerId = null;
    this.lastPoint = null;
    this.erasedStrokeIds.clear();
    this.erasedStrokes = [];
    this.clearSelection();
  }
  renderAll() {
    if (!this.viewReady) return;
    this.renderPageRail();
    this.renderPage();
    this.updateHistoryButtons();
  }
  pageById(id) {
    return this.notebook.pages.find((page) => page.id === id);
  }
  currentPage() {
    return this.notebook.pages[this.pageIndex];
  }
};
function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function cloneNotebook(notebook) {
  return {
    ...notebook,
    pages: notebook.pages.map((page) => ({
      ...page,
      strokes: page.strokes.map(cloneStroke),
      deletedStrokeIds: [...page.deletedStrokeIds]
    }))
  };
}
function cloneStroke(stroke) {
  return { ...stroke, points: clonePoints(stroke.points) };
}
function clonePoints(points) {
  return points.map((point) => ({ ...point }));
}
function restoredStroke(stroke) {
  const now = Date.now();
  return { ...cloneStroke(stroke), id: newId("stroke"), createdAt: now, updatedAt: now };
}
function translatePoints(points, dx, dy) {
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy, t: Date.now() }));
}
function selectionBounds(strokes) {
  return boundsForPointSets(strokes.map((stroke) => stroke.points));
}
function boundsForPointSets(pointSets) {
  const points = pointSets.flat();
  if (points.length === 0) return null;
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = a.y > point.y !== b.y > point.y && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}
function samePoints(left, right) {
  return left !== void 0 && left.length === right.length && left.every((point, index) => point.x === right[index].x && point.y === right[index].y);
}
function constrainDelta(delta, minimum, maximum) {
  return Math.max(-minimum, Math.min(1 - maximum, delta));
}
function formatControlValue(name, value) {
  return name === "Opacity" ? `${Math.round(value * 100)}%` : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} px`;
}
function strokeWidth(stroke, pressure) {
  return stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + pressure * 0.75);
}
function midpoint(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    pressure: (a.pressure + b.pressure) / 2,
    t: (a.t + b.t) / 2
  };
}
function drawSmoothPath(ctx, points, width, height) {
  const first = points[0];
  ctx.beginPath();
  ctx.moveTo(first.x * width, first.y * height);
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const end = index === points.length - 1 ? point : midpoint(previous, point);
    ctx.quadraticCurveTo(previous.x * width, previous.y * height, end.x * width, end.y * height);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x * width, last.y * height);
}

// src/storage.ts
var import_obsidian2 = require("obsidian");
var INK_EXTENSION = "ink";
var INK_FOLDER = "Ink Notes";
var NotebookStore = class {
  constructor(app) {
    this.app = app;
    this.vault = app.vault;
  }
  async create(title) {
    await this.ensureFolder();
    const safeTitle = title.trim().replace(/[\\/:*?"<>|#^\[\]]/g, "-").slice(0, 80) || "Ink Notebook";
    let path = `${INK_FOLDER}/${safeTitle}.${INK_EXTENSION}`;
    let count = 2;
    while (this.vault.getAbstractFileByPath(path)) path = `${INK_FOLDER}/${safeTitle} ${count++}.${INK_EXTENSION}`;
    const notebook = createNotebook(safeTitle);
    return this.vault.create(path, serialize(notebook));
  }
  async read(file) {
    const raw = await this.vault.read(file);
    return normalizeNotebook(JSON.parse(raw));
  }
  async save(file, notebook) {
    const next = { ...notebook, updatedAt: Date.now() };
    let merged = next;
    await this.vault.process(file, (raw) => {
      let latest;
      try {
        latest = normalizeNotebook(JSON.parse(raw));
      } catch (e) {
        latest = createNotebook(next.title);
      }
      merged = mergeNotebooks(latest, next);
      return serialize(merged);
    });
    return merged;
  }
  async list() {
    return this.vault.getFiles().filter((file) => file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`));
  }
  observe(onChange) {
    const handler = (file) => {
      if (file instanceof import_obsidian2.TFile && file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`)) onChange(file);
    };
    const ref = this.vault.on("modify", handler);
    return () => this.vault.offref(ref);
  }
  async ensureFolder() {
    if (!this.vault.getAbstractFileByPath(INK_FOLDER)) await this.vault.createFolder(INK_FOLDER);
  }
};
function serialize(notebook) {
  return `${JSON.stringify(notebook, null, 2)}
`;
}

// src/main.ts
var InkNotesPlugin = class extends import_obsidian3.Plugin {
  async onload() {
    this.store = new NotebookStore(this.app);
    this.registerView(VIEW_TYPE_INK, (leaf) => this.createView(leaf));
    this.registerExtensions([INK_EXTENSION], VIEW_TYPE_INK);
    this.addRibbonIcon("pen-line", "Open Ink Notes", () => void this.openNotebook());
    this.addCommand({ id: "open-ink-notebook", name: "Open Ink Notebook", callback: () => void this.openNotebook() });
    this.addCommand({ id: "create-ink-notebook", name: "Create Ink Notebook", callback: () => void this.createNotebook() });
    this.registerInterval(window.setInterval(() => void this.refreshViews(), 2500));
  }
  createView(leaf) {
    return new InkView(leaf, this.store);
  }
  async openNotebook() {
    const files = await this.store.list();
    if (files.length === 0) {
      await this.createNotebook();
      return;
    }
    await this.openFile(files[0]);
  }
  async createNotebook() {
    const file = await this.store.create("Ink Notebook");
    await this.openFile(file);
  }
  async openFile(file) {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }
  async refreshViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      if (leaf.view instanceof InkView) await leaf.view.reloadFromDisk();
    }
  }
};
//# sourceMappingURL=main.js.map
