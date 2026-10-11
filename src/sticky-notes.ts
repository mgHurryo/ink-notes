import { App, Modal, Notice, setIcon } from "obsidian";
import { InkPage, InkPoint, InkStroke, newId } from "./model";
import { cloneSticky, StickyNote, stickyLink, STICKY_UNIT } from "./sticky-model";
import { paintStickyBoard } from "./sticky-rendering";

interface StickyContext {
  page: () => InkPage; geometry: () => { width: number; height: number };
  editable: () => boolean; pointer: () => boolean;
  change: (before: StickyNote | undefined, after: StickyNote | undefined) => void;
  link: (note: StickyNote) => string; brush: () => { color: string; width: number; opacity: number };
}
function button(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement {
  const el = parent.createEl("button", { text, attr: { type: "button" } }); el.onclick = run; return el;
}
function movedNote(note: StickyNote, dx: number, dy: number, resize: boolean): StickyNote {
  return resize ? { ...note, width: Math.max(.05, Math.min(1 - note.x, note.width + dx)), height: Math.max(.05, Math.min(1 - note.y, note.height + dy)) }
    : { ...note, x: Math.max(0, Math.min(1 - note.width, note.x + dx)), y: Math.max(0, Math.min(1 - note.height, note.y + dy)) };
}

export class StickyNoteLayer {
  private layer: HTMLElement;
  private events = new AbortController();
  private cards = new AbortController();
  private last?: { page: string; notes: StickyNote[] | undefined; editable: boolean; width: number };
  private editor?: StickyEditor;
  private drag?: { pointer: number; touch: boolean; page: string; note: StickyNote; rect: DOMRect; x: number; y: number; resize: boolean; element: HTMLElement };
  constructor(readonly host: HTMLElement, private app: App, private context: StickyContext) {
    this.layer = host.createDiv({ cls: "ink-sticky-layer" });
    const signal = this.events.signal, doc = host.ownerDocument;
    doc.addEventListener("touchstart", (event) => {
      if (this.drag && event.touches.length > 1) { this.drag = undefined; this.last = undefined; this.sync(); }
    }, { signal, capture: true });
    doc.addEventListener("pointermove", (event) => {
      const drag = this.drag; if (!drag || drag.touch || drag.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      const dx = (event.clientX - drag.x) / drag.rect.width, dy = (event.clientY - drag.y) / drag.rect.height;
      const note = movedNote(drag.note, dx, dy, drag.resize);
      this.position(drag.element, note);
    }, { signal, passive: false });
    const finish = (event: PointerEvent) => {
      const drag = this.drag; if (!drag || drag.touch || drag.pointer !== event.pointerId) return; this.drag = undefined;
      if (event.type === "pointerup" && this.context.editable() && this.context.page().id === drag.page) {
        const dx = (event.clientX - drag.x) / drag.rect.width, dy = (event.clientY - drag.y) / drag.rect.height;
        const after = movedNote(drag.note, dx, dy, drag.resize);
        this.context.change(drag.note, after);
      }
      this.last = undefined; this.sync(); event.stopPropagation();
    };
    doc.addEventListener("pointerup", finish, { signal }); doc.addEventListener("pointercancel", finish, { signal });
    doc.addEventListener("touchmove", (event) => {
      const drag = this.drag; if (!drag?.touch) return;
      const touch = Array.from(event.touches).find((t) => t.identifier === drag.pointer);
      if (!touch || event.touches.length !== 1) { this.drag = undefined; this.last = undefined; this.sync(); return; }
      event.preventDefault(); event.stopPropagation();
      const dx = (touch.clientX - drag.x) / drag.rect.width, dy = (touch.clientY - drag.y) / drag.rect.height;
      const note = movedNote(drag.note, dx, dy, drag.resize);
      this.position(drag.element, note);
    }, { signal, passive: false });
    doc.addEventListener("touchend", (event) => {
      const drag = this.drag; if (!drag?.touch) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === drag.pointer); if (!touch) return;
      this.drag = undefined;
      if (this.context.editable() && this.context.page().id === drag.page) {
        const dx = (touch.clientX - drag.x) / drag.rect.width, dy = (touch.clientY - drag.y) / drag.rect.height;
        this.context.change(drag.note, movedNote(drag.note, dx, dy, drag.resize));
      }
      this.last = undefined; this.sync(); event.stopPropagation();
    }, { signal });
    doc.addEventListener("touchcancel", () => { this.drag = undefined; this.last = undefined; this.sync(); }, { signal });
    doc.defaultView?.addEventListener("blur", () => { this.drag = undefined; this.last = undefined; this.sync(); }, { signal });
  }
  dispose(): void { this.events.abort(); this.cards.abort(); this.editor?.close(); this.layer.remove(); }
  private position(el: HTMLElement, note: StickyNote): void {
    el.style.left = `${note.x * 100}%`; el.style.top = `${note.y * 100}%`; el.style.width = `${note.width * 100}%`;
    el.style.height = note.collapsed ? `${(note.preview ? 132 : 32) * this.host.clientWidth / note.boardPageWidth}px` : `${note.height * 100}%`;
    el.style.backgroundColor = note.color;
  }
  open(id: string): void {
    const note = this.context.page().stickyNotes?.find((note) => note.id === id); if (!note) return;
    this.editor?.close(); const page = this.context.page();
    const editor = new StickyEditor(this.app, note, this.context.editable(), this.context.brush(), this.context.link(note), (after) => {
      if (this.context.page() !== page || !this.context.editable()) { new Notice("The page changed; reopen the sticky note to edit it"); return false; }
      const current = page.stickyNotes?.find((candidate) => candidate.id === note.id);
      if (!current || current.updatedAt !== note.updatedAt) { new Notice("This sticky note changed in another pane. Copy your draft and reopen it before saving."); return false; }
      this.context.change(note, after); return true;
    });
    this.editor = editor; editor.open();
  }
  sync(): void {
    const page = this.context.page(), editable = this.context.editable(), width = this.host.clientWidth;
    if (this.drag && (!editable || !this.context.pointer() || this.drag.page !== page.id)) { this.drag = undefined; this.last = undefined; }
    if (this.last?.page === page.id && this.last.notes === page.stickyNotes && this.last.editable === editable && this.last.width === width) return;
    if (this.last && this.last.page !== page.id) { this.editor?.close(); this.drag = undefined; }
    this.last = { page: page.id, notes: page.stickyNotes, editable, width }; this.cards.abort(); this.cards = new AbortController(); this.layer.empty();
    const geometry = this.context.geometry();
    for (const note of page.stickyNotes ?? []) {
      const card = this.layer.createDiv({ cls: "ink-sticky-note", attr: { "data-sticky-id": note.id, "aria-label": note.title || "Sticky note" } }); this.position(card, note);
      for (const type of ["pointerdown", "touchstart", "touchmove", "wheel"] as const) card.addEventListener(type, (e) => e.stopPropagation(), { signal: this.cards.signal });
      const header = card.createDiv({ cls: "ink-sticky-header" }); header.createSpan({ text: note.title || "Sticky note" });
      header.style.height = `${32 * width / note.boardPageWidth}px`;
      const bindDrag = (element: HTMLElement, resize: boolean) => element.addEventListener("pointerdown", (e) => {
        if (!editable || !this.context.pointer() || e.pointerType === "pen" || e.button !== 0 || (!resize && (e.target as HTMLElement).closest("button"))) return;
        e.preventDefault(); e.stopPropagation();
        this.drag = { pointer: e.pointerId, touch: false, page: page.id, note: cloneSticky(note), rect: this.host.getBoundingClientRect(), x: e.clientX, y: e.clientY, resize, element: card };
      }, { signal: this.cards.signal });
      const bindTouch = (element: HTMLElement, resize: boolean) => element.addEventListener("touchstart", (e) => {
        if (this.drag || !editable || !this.context.pointer() || e.touches.length !== 1 || (!resize && (e.target as HTMLElement).closest("button"))) return;
        const t = e.touches[0]; if ((t as Touch & { touchType?: string }).touchType === "stylus") return;
        e.preventDefault(); e.stopPropagation();
        this.drag = { pointer: t.identifier, touch: true, page: page.id, note: cloneSticky(note), rect: this.host.getBoundingClientRect(), x: t.clientX, y: t.clientY, resize, element: card };
      }, { signal: this.cards.signal, passive: false });
      bindDrag(header, false);
      bindTouch(header, false);
      const fold = button(header, "", () => { if (this.context.editable()) this.context.change(note, { ...note, collapsed: !note.collapsed }); });
      fold.setAttribute("aria-label", note.collapsed ? "Expand" : "Fold"); setIcon(fold, note.collapsed ? "chevron-down" : "chevron-up"); fold.disabled = !editable;
      const edit = button(header, "", () => this.open(note.id)); edit.setAttribute("aria-label", editable ? "Edit note" : "Read note"); setIcon(edit, "square-pen");
      if (!note.collapsed || note.preview) {
        const canvas = card.createEl("canvas", { attr: { "aria-label": "Sticky note content" } });
        const viewScale = width / note.boardPageWidth;
        // The accessible header keeps a 32px minimum when a pane narrows.
        // Account for its actual height instead of squeezing the board raster.
        const headerHeight = Math.max(32, 32 * viewScale);
        const frameHeight = note.collapsed ? 132 * viewScale : note.height * geometry.height;
        const logicalWidth = note.width * note.boardPageWidth,
          logicalHeight = Math.max(1, (frameHeight - headerHeight) / Math.max(.001, viewScale));
        const scale = Math.min(2, 2048 / Math.max(1, logicalWidth, logicalHeight));
        canvas.width = Math.max(1, Math.round(logicalWidth * scale)); canvas.height = Math.max(1, Math.round(logicalHeight * scale));
        const ctx = canvas.getContext("2d"); if (ctx) paintStickyBoard(ctx, note, canvas.width, canvas.height, scale);
        canvas.onclick = () => this.open(note.id);
      }
      if (editable && !note.collapsed && note.height * this.host.clientHeight >= 76 && note.width * width >= 72) {
        const handle = button(card, "Resize note", () => undefined); handle.className = "ink-sticky-resize"; bindDrag(handle, true);
        bindTouch(handle, true);
      }
    }
  }
}

class StickyEditor extends Modal {
  private draft: StickyNote;
  private events = new AbortController();
  constructor(app: App, note: StickyNote, private editable: boolean, private brush: { color: string; width: number; opacity: number }, private link: string,
    private save: (after: StickyNote) => boolean) { super(app); this.draft = cloneSticky(note); }
  onOpen(): void {
    this.setTitle(this.editable ? "Edit sticky note" : "Read sticky note"); this.modalEl.addClass("ink-sticky-editor");
    const el = this.contentEl, tools = el.createDiv({ cls: "ink-sticky-tools" }), note = this.draft;
    const textInput = (label: string, value: string, run: (value: string) => void) => {
      const wrap = tools.createEl("label", { text: label }); const input = wrap.createEl("input", { value, attr: { "aria-label": label } });
      input.disabled = !this.editable; input.oninput = () => run(input.value); return input;
    };
    textInput("Note title", note.title, (value) => note.title = value);
    textInput("Note keywords", note.keywords, (value) => note.keywords = value);
    const color = textInput("Note color", note.color, (value) => { note.color = value; paint(); }); color.type = "color";
    for (const key of ["x", "y", "width", "height"] as const) {
      const input = textInput(`Note ${key} percent`, String(Math.round(note[key] * 1000) / 10), (value) => {
        const n = Number(value) / 100; if (!Number.isFinite(n)) return;
        note[key] = Math.max(key === "x" || key === "y" ? 0 : .05, Math.min(1, n));
        note.x = Math.min(note.x, 1 - note.width); note.y = Math.min(note.y, 1 - note.height);
      }); input.type = "number"; input.min = key === "x" || key === "y" ? "0" : "5"; input.max = "100";
    }
    const previewLabel = tools.createEl("label", { text: "Preview when folded" }), preview = previewLabel.createEl("input", { type: "checkbox" });
    preview.checked = note.preview; preview.disabled = !this.editable; preview.onchange = () => note.preview = preview.checked;
    el.createEl("p", { text: "Frame size changes only the visible window. Content stays at its original size. Scroll inside the board; add space to continue writing. Save applies your edits." });
    const modes = el.createDiv({ cls: "ink-sticky-tools" }); let mode = this.editable ? "Write" : "Pan";
    const modeButtons: HTMLButtonElement[] = [];
    for (const name of ["Write", "Erase", "Pan"]) {
      const btn = button(modes, name, () => { mode = name; modeButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.textContent === mode))); });
      btn.disabled = !this.editable && name !== "Pan"; btn.setAttribute("aria-pressed", String(name === mode)); modeButtons.push(btn);
    }
    const frame = el.createDiv({ cls: "ink-sticky-viewport" }), scroll = frame.createDiv({ cls: "ink-sticky-scroll", attr: { tabindex: "0", "aria-label": "Sticky handwriting board" } });
    const spacer = scroll.createDiv(), canvas = frame.createEl("canvas");
    let extraWidth = 0, extraHeight = 0, active: InkStroke | undefined, pointer: number | undefined;
    const history: StickyNote[] = [], redo: StickyNote[] = [];
    const checkpoint = () => { history.push(cloneSticky(note)); redo.length = 0; };
    const paint = () => {
      note.scrollX = scroll.scrollLeft; note.scrollY = scroll.scrollTop;
      const w = scroll.clientWidth, h = scroll.clientHeight, ratio = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.ceil(w * ratio)); canvas.height = Math.max(1, Math.ceil(h * ratio));
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d"); if (ctx) paintStickyBoard(ctx, { ...note, strokes: active ? [...note.strokes, active] : note.strokes }, canvas.width, canvas.height, ratio);
    };
    const extent = () => {
      let w = Math.max(1000, extraWidth, note.scrollX + scroll.clientWidth + 200),
        h = Math.max(1000, extraHeight, note.scrollY + scroll.clientHeight + 200, note.text.split("\n").length * 28 + 200);
      for (const stroke of note.strokes) for (const p of stroke.points) { w = Math.max(w, p.x * STICKY_UNIT + 300); h = Math.max(h, p.y * STICKY_UNIT + 300); }
      for (const line of note.text.split("\n")) w = Math.max(w, Array.from(line).length * 24 + 40);
      spacer.style.width = `${w}px`; spacer.style.height = `${h}px`;
    };
    button(modes, "More space right", () => { extraWidth = scroll.scrollWidth + 1000; extent(); });
    button(modes, "More space below", () => { extraHeight = scroll.scrollHeight + 1000; extent(); });
    const restore = (value: StickyNote) => { const copy = cloneSticky(value); note.strokes = copy.strokes; note.deletedStrokeIds = copy.deletedStrokeIds; extent(); paint(); };
    button(modes, "Undo ink", () => { if (!active && history.length) { redo.push(cloneSticky(note)); restore(history.pop()!); } }).disabled = !this.editable;
    button(modes, "Redo ink", () => { if (!active && redo.length) { history.push(cloneSticky(note)); restore(redo.pop()!); } }).disabled = !this.editable;
    const signal = this.events.signal;
    scroll.addEventListener("scroll", paint, { signal });
    let frameRequest = 0;
    const queuePaint = () => { if (!frameRequest) frameRequest = requestAnimationFrame(() => { frameRequest = 0; paint(); }); };
    const sample = (x: number, y: number, pressure: number): InkPoint => {
      const r = scroll.getBoundingClientRect(); return { x: Math.max(0, x - r.left + scroll.scrollLeft) / STICKY_UNIT,
        y: Math.max(0, y - r.top + scroll.scrollTop) / STICKY_UNIT, pressure: Math.max(.05, pressure || .5), t: Date.now() };
    };
    const erase = (point: InkPoint) => {
      const hit = (stroke: InkStroke) => stroke.points.some((p, index) => {
        const q = stroke.points[Math.max(0, index - 1)], dx = p.x - q.x, dy = p.y - q.y;
        const t = Math.max(0, Math.min(1, ((point.x - q.x) * dx + (point.y - q.y) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(point.x - q.x - t * dx, point.y - q.y - t * dy) * STICKY_UNIT < 12 + stroke.width / 2;
      });
      const removed = note.strokes.filter(hit); note.deletedStrokeIds = [...new Set([...note.deletedStrokeIds, ...removed.map((s) => s.id)])];
      note.strokes = note.strokes.filter((s) => !hit(s));
    };
    const start = (id: number, p: InkPoint) => {
      if (pointer !== undefined || !this.editable || mode === "Pan") return false;
      checkpoint(); pointer = id;
      if (mode === "Erase") erase(p);
      else { const now = Date.now(); active = { id: newId("sticky-ink"), pageId: note.id, tool: "pen", ...this.brush, points: [p], createdAt: now, updatedAt: now }; }
      paint(); return true;
    };
    const move = (p: InkPoint) => { if (active) active.points.push(p); else if (mode === "Erase") erase(p); queuePaint(); };
    const finish = (cancel: boolean) => {
      if (pointer === undefined) return;
      if (cancel) { active = undefined; if (history.length) restore(history.pop()!); }
      else if (active) note.strokes.push(active);
      active = undefined; pointer = undefined; extent(); paint();
    };
    scroll.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch" || e.button !== 0) return;
      if (start(e.pointerId, sample(e.clientX, e.clientY, e.pressure))) { e.preventDefault(); scroll.setPointerCapture?.(e.pointerId); }
    }, { signal });
    scroll.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pointer) return; e.preventDefault();
      for (const p of e.getCoalescedEvents?.().length ? e.getCoalescedEvents() : [e]) move(sample(p.clientX, p.clientY, p.pressure));
    }, { signal });
    scroll.addEventListener("pointerup", (e) => { if (e.pointerId === pointer) finish(false); }, { signal });
    scroll.addEventListener("pointercancel", () => finish(true), { signal });
    // Older iPad WebViews deliver Pencil as native stylus Touch instead of Pointer.
    const stylus = (e: TouchEvent) => Array.from(e.changedTouches).find((t) => (t as Touch & { touchType?: string }).touchType === "stylus");
    scroll.addEventListener("touchstart", (e) => { const t = stylus(e); if (t && start(t.identifier, sample(t.clientX, t.clientY, t.force))) e.preventDefault(); }, { signal, passive: false });
    scroll.addEventListener("touchmove", (e) => { const t = stylus(e); if (t && t.identifier === pointer) { move(sample(t.clientX, t.clientY, t.force)); e.preventDefault(); } }, { signal, passive: false });
    scroll.addEventListener("touchend", (e) => { const t = stylus(e); if (t?.identifier === pointer) finish(false); }, { signal });
    scroll.addEventListener("touchcancel", () => finish(true), { signal });
    const text = el.createEl("textarea", { attr: { "aria-label": "Sticky note text", placeholder: "Type text (each line keeps its position on the board)" } });
    text.value = note.text; text.readOnly = !this.editable;
    text.oninput = () => { note.text = text.value; extent(); paint(); };
    const link = el.createEl("input", { value: this.link, attr: { readonly: "", "aria-label": "Sticky note Markdown link" } });
    button(el, "Copy Markdown link", () => { link.select(); void navigator.clipboard.writeText(this.link).catch(() => new Notice("Select and copy the link above")); });
    const actions = el.createDiv({ cls: "ink-sticky-tools" });
    button(actions, "Cancel", () => this.close());
    if (this.editable) button(actions, "Save note", () => { finish(false); if (this.save(note)) this.close(); });
    extent(); scroll.scrollLeft = note.scrollX; scroll.scrollTop = note.scrollY; paint();
    const observer = new ResizeObserver(paint); observer.observe(scroll); this.events.signal.addEventListener("abort", () => { observer.disconnect(); cancelAnimationFrame(frameRequest); });
  }
  onClose(): void { this.events.abort(); this.contentEl.empty(); }
}

export function markdownStickyLink(file: string, note: StickyNote, vault: string): string {
  return `[${(note.title || "Sticky note").replace(/[\[\]\\\n]/g, " ")}](${stickyLink(file, note.pageId, note.id, vault)})`;
}
