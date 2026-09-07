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
var InkView = class extends import_obsidian.FileView {
  constructor(leaf, store) {
    super(leaf);
    this.notebook = createNotebook();
    this.pageIndex = 0;
    this.state = { tool: "pen", color: "#1b1b1b", width: 3, opacity: 1 };
    this.syncing = false;
    this.saveRequested = false;
    this.activeSave = null;
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
    this.root.setAttribute("aria-label", "Ink Notes");
    this.root.createDiv({ cls: "ink-toolbar", attr: { role: "toolbar", "aria-label": "Ink tools" } });
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
    if (this.syncing || !this.file) return;
    const latest = await this.store.read(this.file);
    this.notebook = mergeNotebooks(latest, this.notebook);
    this.pageIndex = Math.max(0, Math.min(this.pageIndex, this.notebook.pages.length - 1));
    this.renderAll();
  }
  renderToolbar() {
    const toolbar = this.root.querySelector(".ink-toolbar");
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
    this.addRange(group, "Width", 1, 24, 0.5, this.state.width, (value) => {
      this.state.width = value;
    });
    this.addRange(group, "Opacity", 0.1, 1, 0.05, this.state.opacity, (value) => {
      this.state.opacity = value;
    });
    this.addIconButton(group, "plus", "Add page", () => this.addPage());
    this.addIconButton(group, "more-horizontal", "Page options", (event) => this.openPageMenu(event));
  }
  renderCanvas() {
    const workspace = this.root.createDiv({ cls: "ink-workspace" });
    this.pageScroller = workspace.createDiv({ cls: "ink-page-scroller" });
    this.pageElement = this.pageScroller.createDiv({ cls: "ink-page" });
    this.canvas = this.pageElement.createEl("canvas", { cls: "ink-canvas" });
    this.ctx = this.canvas.getContext("2d");
    this.canvas.style.touchAction = "none";
    this.registerDomEvent(this.canvas, "pointerdown", (event) => this.onPointerDown(event));
    this.registerDomEvent(this.canvas, "pointermove", (event) => this.onPointerMove(event));
    this.registerDomEvent(this.canvas, "pointerup", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.canvas, "pointercancel", (event) => this.onPointerUp(event));
    this.registerDomEvent(this.canvas, "wheel", (event) => this.onWheel(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchstart", (event) => this.onTouchStart(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchmove", (event) => this.onTouchMove(event), { passive: false });
    this.registerDomEvent(this.pageScroller, "touchend", () => {
      this.pinchStart = null;
    });
    this.registerDomEvent(window, "resize", () => this.resizeCanvas());
  }
  renderPageRail() {
    let rail = this.root.querySelector(".ink-page-rail");
    if (!rail) rail = this.root.createDiv({ cls: "ink-page-rail" });
    rail.empty();
    this.notebook.pages.forEach((page, index) => {
      const button = rail.createEl("button", { cls: "ink-page-thumb", attr: { type: "button", title: page.title } });
      if (index === this.pageIndex) button.addClass("is-active");
      button.createDiv({ cls: `ink-page-thumb-paper ink-paper-${page.paper}` });
      button.createSpan({ text: String(index + 1), cls: "ink-page-thumb-number" });
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
    this.pageElement.className = `ink-page ink-paper-${page.paper}`;
    this.pageElement.style.aspectRatio = `${this.notebook.pageWidth} / ${this.notebook.pageHeight}`;
    this.resizeCanvas();
    this.drawStrokes(page.strokes);
    this.root.querySelectorAll(".ink-tool-button").forEach((el) => el.toggleClass("is-active", el.getAttribute("data-tool") === this.state.tool));
  }
  resizeCanvas() {
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
  drawStrokes(strokes) {
    if (!this.ctx || !this.pageElement) return;
    const rect = this.pageElement.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);
    for (const stroke of strokes) this.drawStroke(stroke, rect.width, rect.height);
    this.drawSelection(rect.width, rect.height);
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
    ctx.beginPath();
    let previous = stroke.points[0];
    ctx.moveTo(previous.x * width, previous.y * height);
    for (let i = 1; i < stroke.points.length; i++) {
      const point = stroke.points[i];
      const pressureWidth = stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + point.pressure * 0.75);
      ctx.lineWidth = pressureWidth;
      const midX = (previous.x + point.x) / 2 * width;
      const midY = (previous.y + point.y) / 2 * height;
      ctx.quadraticCurveTo(previous.x * width, previous.y * height, midX, midY);
      previous = point;
    }
    ctx.lineTo(previous.x * width, previous.y * height);
    ctx.stroke();
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
    var _a, _b, _c, _d;
    if (this.activePointerId !== event.pointerId || event.pointerType === "touch") return;
    const point = this.toPoint(event);
    if (this.state.tool === "eraser") {
      this.eraseAt(point);
      return;
    }
    if (this.state.tool === "lasso") {
      if (this.lassoDrag) {
        const bounds = boundsForPointSets([...this.lassoDrag.before.values()]);
        const dx = constrainDelta(point.x - this.lassoDrag.start.x, (_a = bounds == null ? void 0 : bounds.minX) != null ? _a : 0, (_b = bounds == null ? void 0 : bounds.maxX) != null ? _b : 1);
        const dy = constrainDelta(point.y - this.lassoDrag.start.y, (_c = bounds == null ? void 0 : bounds.minY) != null ? _c : 0, (_d = bounds == null ? void 0 : bounds.maxY) != null ? _d : 1);
        for (const stroke of this.selectedStrokes()) {
          const original = this.lassoDrag.before.get(stroke.id);
          if (original) stroke.points = translatePoints(original, dx, dy);
        }
      } else if (distance(point, this.lassoPath[this.lassoPath.length - 1]) >= 2e-3) {
        this.lassoPath.push(point);
      }
      this.drawStrokes(this.currentPage().strokes);
      return;
    }
    if (!this.activeStroke || !this.lastPoint) return;
    if (distance(point, this.lastPoint) < 1e-3) return;
    this.activeStroke.points.push(point);
    this.activeStroke.updatedAt = Date.now();
    this.lastPoint = point;
    this.drawStrokes(this.currentPage().strokes);
  }
  onPointerUp(event) {
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
    if (removed.length === 0) return;
    for (const stroke of removed) {
      this.erasedStrokeIds.add(stroke.id);
      this.erasedStrokes.push(cloneStroke(stroke));
    }
    this.deleteStrokes(page, removed.map((stroke) => stroke.id));
    this.markChanged(page);
    this.drawStrokes(page.strokes);
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
    this.scheduleSave();
  }
  addToolButton(parent, icon, label, tool) {
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: { type: "button", title: label, "aria-label": label, "data-tool": tool } });
    (0, import_obsidian.setIcon)(button, icon);
    button.addEventListener("click", () => {
      this.state.tool = tool;
      if (tool !== "lasso") this.clearSelection();
      this.renderToolbar();
      this.renderPage();
    });
  }
  addIconButton(parent, icon, label, callback, disabled = false) {
    const button = parent.createEl("button", { cls: "ink-icon-button", attr: { type: "button", title: label, "aria-label": label } });
    button.disabled = disabled;
    (0, import_obsidian.setIcon)(button, icon);
    button.addEventListener("click", callback);
  }
  addColorPicker(parent) {
    const label = parent.createEl("label", { cls: "ink-color-control", attr: { title: "Ink color" } });
    const input = label.createEl("input", { attr: { type: "color", value: this.state.color, "aria-label": "Ink color" } });
    input.addEventListener("input", () => {
      this.state.color = input.value;
    });
  }
  addRange(parent, name, min, max, step, value, onChange) {
    const label = parent.createEl("label", { cls: "ink-range-control", attr: { title: name } });
    const input = label.createEl("input", { attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": name } });
    input.addEventListener("input", () => onChange(Number(input.value)));
  }
  setZoom(value) {
    this.zoom = Math.max(0.5, Math.min(3, value));
    this.pageElement.style.transform = `scale(${this.zoom})`;
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
        this.notebook = mergeNotebooks(merged, this.notebook);
        this.renderAll();
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
    this.renderToolbar();
  }
  afterCommand() {
    this.clearSelection();
    this.renderToolbar();
    this.renderPage();
    this.scheduleSave();
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
