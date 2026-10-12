import { App, Component, MarkdownRenderer, Menu, Notice, setIcon } from "obsidian";
import { InkPage } from "./model";
import { cloneSticky, StickyNote, stickyLink } from "./sticky-model";
import { paintStickyBoard, stickyFrameHeight, stickyFrameWidth } from "./sticky-rendering";
import { STICKY_HEADER } from "./sticky-ink";

interface StickyContext {
  page: () => InkPage;
  editable: () => boolean; pointer: () => boolean;
  fingerAsPen: () => boolean;
  change: (before: StickyNote | undefined, after: StickyNote | undefined) => void;
  link: (note: StickyNote, block?: string) => string; source: () => string;
  busy: () => boolean;
}
function button(parent: HTMLElement, label: string, icon: string, run: () => void): HTMLButtonElement {
  const el = parent.createEl("button", { attr: { type: "button", "aria-label": label, title: label } });
  setIcon(el, icon); el.onclick = run; return el;
}
function movedNote(note: StickyNote, dx: number, dy: number, resize: boolean, rect: DOMRect, pan = 0): StickyNote {
  if (pan) return { ...note, scrollX: Math.max(0, note.scrollX - dx * note.boardPageWidth), scrollY: Math.max(0, note.scrollY - dy * pan * note.boardPageWidth) };
  return resize ? { ...note, width: Math.max(.12, Math.min(1 - note.x, note.width + dx)), height: Math.max(.10, Math.min(1 - note.y, note.height + dy)) }
    : { ...note, x: Math.max(0, Math.min(1 - stickyFrameWidth(note, rect.width) / rect.width, note.x + dx)),
      y: Math.max(0, Math.min(1 - stickyFrameHeight(note, rect.width, rect.height) / rect.height, note.y + dy)) };
}

/** Cards own only chrome and text editing. The board bubbles input to the
 * document's shared Pencil/touch/tool pipeline. */
export class StickyNoteLayer {
  private layer: HTMLElement;
  private events = new AbortController();
  private cards = new AbortController();
  private markdown = new Component();
  private menu?: Menu;
  private hold?: ReturnType<typeof setTimeout>;
  private suppressTap = false;
  private menuNote?: string;
  private closeMenuTarget?: HTMLElement;
  private pendingTextRefresh = false;
  private readFrames = new Map<string, boolean>();
  private target?: { id: string; block: string };
  private editing?: { id: string; field: "title" | "text" | "keywords"; base: StickyNote; input: HTMLInputElement | HTMLTextAreaElement };
  private last?: { page: string; notes: StickyNote[] | undefined; editable: boolean; width: number };
  private drag?: { pointer: number; touch: boolean; page: string; note: StickyNote; rect: DOMRect; x: number; y: number; resize: boolean; element: HTMLElement; pan?: number; moved?: boolean };
  constructor(readonly host: HTMLElement, private app: App, private context: StickyContext) {
    this.layer = host.createDiv({ cls: "ink-sticky-layer" }); this.markdown.load();
    const signal = this.events.signal, doc = host.ownerDocument;
    const commitOutside = (event: Event) => {
      if (event.type === "touchstart") this.suppressTap = false;
      const target = event.target as HTMLElement;
      const toggle = target.closest?.('.ink-sticky-header button[aria-label="Sticky note options"]');
      // Host menus dismiss in document capture, before the button click.
      // Remember that this contact closes the menu rather than reopening it.
      if (toggle && this.menuNote && this.menuNote === toggle.closest<HTMLElement>(".ink-sticky-note")?.dataset.stickyId) {
        this.closeMenuTarget = toggle as HTMLElement; this.menu?.hide();
      } else if (!this.closeMenuTarget?.contains(target)) this.closeMenuTarget = undefined;
      if (this.editing && !this.editing.input.contains(event.target as Node)) {
        this.pendingTextRefresh = true; this.commitText();
      }
      if (!this.layer.contains(event.target as Node)) {
        this.layer.querySelector(".is-active")?.classList.remove("is-active");
      }
    };
    doc.addEventListener("pointerdown", commitOutside, { signal, capture: true });
    doc.addEventListener("touchstart", commitOutside, { signal, capture: true });
    const refreshText = () => {
      if (!this.pendingTextRefresh) return;
      // Let the native click complete before replacing its button target.
      setTimeout(() => { if (!signal.aborted) { this.pendingTextRefresh = false; this.last = undefined; this.sync(); } }, 0);
    };
    doc.addEventListener("pointerup", (event) => { if (event.pointerType !== "touch") refreshText(); }, { signal, capture: true });
    doc.addEventListener("touchend", () => { clearTimeout(this.hold); refreshText(); }, { signal, capture: true });
    doc.addEventListener("click", refreshText, { signal });
    doc.addEventListener("touchstart", (event) => {
      if (this.drag && event.touches.length > 1) { clearTimeout(this.hold); this.drag = undefined; this.last = undefined; this.sync(); }
    }, { signal, capture: true });
    doc.addEventListener("pointermove", (event) => {
      const drag = this.drag; if (!drag || drag.touch || drag.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.moved = true;
      const dx = (event.clientX - drag.x) / drag.rect.width, dy = (event.clientY - drag.y) / drag.rect.height;
      const note = movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan);
      if (drag.pan) this.preview([note]); else { this.position(drag.element, note); if (drag.resize) this.preview([note]); }
    }, { signal, passive: false, capture: true });
    const finish = (event: PointerEvent) => {
      const drag = this.drag; if (!drag || drag.touch || drag.pointer !== event.pointerId) return; this.drag = undefined;
      const moved = drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 6;
      if (event.type === "pointerup" && this.context.editable() && this.context.page().id === drag.page) {
        const dx = (event.clientX - drag.x) / drag.rect.width, dy = (event.clientY - drag.y) / drag.rect.height;
        const after = movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan);
        if (moved && (dx || dy)) this.context.change(drag.note, after);
        else { this.position(drag.element, drag.note); if (drag.pan || drag.resize) this.preview([drag.note]); }
      }
      if (event.type !== "pointerup") { this.last = undefined; this.sync(); }
      refreshText(); if (moved || event.type === "pointercancel") event.stopPropagation();
    };
    doc.addEventListener("pointerup", finish, { signal, capture: true }); doc.addEventListener("pointercancel", finish, { signal, capture: true });
    doc.addEventListener("touchmove", (event) => {
      const drag = this.drag; if (!drag?.touch) return;
      const touch = Array.from(event.touches).find((t) => t.identifier === drag.pointer);
      if (!touch || event.touches.length !== 1) { this.drag = undefined; this.last = undefined; this.sync(); return; }
      event.preventDefault(); event.stopPropagation();
      if (!drag.moved && Math.hypot(touch.clientX - drag.x, touch.clientY - drag.y) < 6) return;
      drag.moved = true; clearTimeout(this.hold);
      const dx = (touch.clientX - drag.x) / drag.rect.width, dy = (touch.clientY - drag.y) / drag.rect.height;
      const note = movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan);
      if (drag.pan) this.preview([note]); else { this.position(drag.element, note); if (drag.resize) this.preview([note]); }
    }, { signal, passive: false, capture: true });
    doc.addEventListener("touchend", (event) => {
      const drag = this.drag; if (!drag?.touch) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === drag.pointer); if (!touch) return;
      this.drag = undefined;
      const moved = drag.moved || Math.hypot(touch.clientX - drag.x, touch.clientY - drag.y) >= 6;
      if (this.context.editable() && this.context.page().id === drag.page) {
        const dx = (touch.clientX - drag.x) / drag.rect.width, dy = (touch.clientY - drag.y) / drag.rect.height;
        if (moved && (dx || dy)) this.context.change(drag.note, movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan));
        else {
          this.position(drag.element, drag.note); if (drag.pan || drag.resize) this.preview([drag.note]);
          // A native touch drag prevents the synthetic click. Restore tap-to-open explicitly.
          if (!moved && drag.note.collapsed && !this.suppressTap) {
            // Do not let WebKit retarget a compatibility click onto the newly
            // expanded card's controls after replacing this folded label.
            event.preventDefault(); this.open(drag.note.id);
          }
        }
      }
      refreshText(); if (moved) event.stopPropagation();
    }, { signal, capture: true, passive: false });
    doc.addEventListener("touchcancel", () => { clearTimeout(this.hold); this.drag = undefined; refreshText(); this.last = undefined; this.sync(); }, { signal, capture: true });
    doc.defaultView?.addEventListener("blur", () => { clearTimeout(this.hold); this.drag = undefined; refreshText(); this.last = undefined; this.sync(); }, { signal });
  }
  dispose(): void { this.events.abort(); this.cards.abort(); this.markdown.unload(); this.menu?.hide(); clearTimeout(this.hold); this.layer.remove(); }
  private position(el: HTMLElement, note: StickyNote): void {
    el.style.left = `${note.x * 100}%`; el.style.top = `${note.y * 100}%`;
    const scale = this.host.clientWidth / note.boardPageWidth;
    el.style.width = `${stickyFrameWidth(note, this.host.clientWidth)}px`;
    el.style.height = `${stickyFrameHeight(note, this.host.clientWidth, this.host.clientHeight)}px`;
    el.style.backgroundColor = note.color;
    el.style.setProperty("--sticky-header-height", `${STICKY_HEADER * scale}px`);
  }
  private card(id: string): HTMLElement | undefined {
    return Array.from(this.layer.children).find((el) => (el as HTMLElement).dataset.stickyId === id) as HTMLElement | undefined;
  }
  open(id: string, block?: string): void {
    const note = this.context.page().stickyNotes?.find((n) => n.id === id); if (!note) return;
    if (block) this.target = { id, block };
    if (note.collapsed || this.readFrames.get(id)) this.update(note, { collapsed: false });
    const card = this.card(id);
    card?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); card?.focus({ preventScroll: true });
    if (block) this.revealBlock(id, block);
  }
  private revealBlock(id: string, block: string): void {
    const card = this.card(id);
    const el = Array.from(card?.querySelectorAll<HTMLElement>("[data-sticky-block]") ?? []).find((el) => el.dataset.stickyBlock === block);
    if (!el) return;
    const note = this.context.page().stickyNotes?.find((n) => n.id === id);
    const top = el.offsetTop + 16;
    const scale = this.host.clientWidth / (note?.boardPageWidth ?? 1);
    if (note && (top < note.scrollY || top > note.scrollY + card!.clientHeight / Math.max(.001, scale) - STICKY_HEADER)) {
      this.target = { id, block }; this.update(note, { scrollY: Math.max(0, top - 16) }); return;
    }
    el.classList.add("ink-sticky-reference-target"); this.target = undefined;
  }
  private update(note: StickyNote, patch: Partial<StickyNote>): void {
    if (this.context.busy()) return;
    if (patch.collapsed === false) {
      // At right/bottom edges unfold to the left/up, keeping the saved size.
      patch = { ...patch, x: Math.min(note.x, 1 - note.width), y: Math.min(note.y, 1 - note.height) };
    }
    if (!this.context.editable()) {
      if (patch.collapsed !== undefined) { this.readFrames.set(note.id, patch.collapsed); this.last = undefined; this.sync(); }
      return;
    }
    const current = this.context.page().stickyNotes?.find((n) => n.id === note.id);
    if (current) this.context.change(current, { ...current, ...patch });
  }
  private commitText(): void {
    const edit = this.editing; if (!edit) return; this.editing = undefined;
    const current = this.context.page().stickyNotes?.find((n) => n.id === edit.id);
    if (current && current[edit.field] !== edit.base[edit.field]) {
      this.editing = edit; new Notice("This text changed in another pane. Copy your draft before reopening it."); return;
    }
    this.update(edit.base, { [edit.field]: edit.input.value }); edit.input.remove(); this.last = undefined; this.sync();
  }
  private edit(note: StickyNote, field: "title" | "text" | "keywords", parent: HTMLElement): void {
    if (!this.context.editable() || this.context.busy()) return;
    if (this.editing) { this.editing.input.focus(); return; }
    const current = this.context.page().stickyNotes?.find((n) => n.id === note.id); if (!current) return;
    const input = parent.createEl(field === "text" ? "textarea" : "input", { cls: "ink-sticky-inline-input", attr: { "aria-label": field === "text" ? "Sticky Markdown" : `Sticky ${field}` } });
    input.value = current[field]; this.editing = { id: current.id, field, base: cloneSticky(current), input };
    for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "touchcancel", "keydown"] as const) input.addEventListener(type, (e) => e.stopPropagation());
    input.onblur = () => this.commitText();
    input.onkeydown = (e) => {
      if (e.key === "Escape") { this.editing = undefined; this.last = undefined; this.sync(); }
      else if (e.key === "Enter" && (field !== "text" || e.ctrlKey || e.metaKey)) { e.preventDefault(); this.commitText(); }
    };
    input.focus({ preventScroll: true }); input.select();
  }
  private showMenu(note: StickyNote, x: number, y: number): void {
    clearTimeout(this.hold); this.menu?.hide(); const menu = new Menu(); this.menu = menu; this.menuNote = note.id;
    menu.onHide(() => { if (this.menu === menu) { this.menu = undefined; this.menuNote = undefined; } });
    if (this.context.editable()) {
      menu.addItem((item) => item.setTitle("Type on sticky note").setIcon("type").onClick(() => {
        this.open(note.id); const card = this.card(note.id); if (card) this.edit(note, "text", card);
      }));
      menu.addItem((item) => item.setTitle("Rename sticky note").setIcon("pencil").onClick(() => {
        this.open(note.id); const header = this.card(note.id)?.querySelector<HTMLElement>(".ink-sticky-header");
        if (header) this.edit(note, "title", header);
      }));
    }
    menu.addItem((item) => item.setTitle(note.collapsed ? "Expand" : "Fold").setIcon(note.collapsed ? "maximize-2" : "minimize-2")
      .onClick(() => this.update(note, { collapsed: !note.collapsed })));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("Copy link to sticky note").setIcon("link").onClick(() => {
      void navigator.clipboard.writeText(this.context.link(note)).catch(() => new Notice("Could not copy the sticky note link"));
    }));
    for (const block of note.text.matchAll(/(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/gm)) {
      menu.addItem((item) => item.setTitle(`Copy paragraph link: ${block[1]}`).setIcon("link").onClick(() => {
        void navigator.clipboard.writeText(this.context.link(note, block[1])).catch(() => new Notice("Could not copy the paragraph link"));
      }));
    }
    if (this.context.editable()) {
      menu.addItem((item) => item.setTitle("Edit keywords").setIcon("tags").onClick(() => {
        this.open(note.id); const card = this.card(note.id);
        if (card) this.edit(note, "keywords", card);
      }));
      menu.addItem((item) => item.setTitle("Preview when folded").setChecked(note.preview).onClick(() => this.update(note, { preview: !note.preview })));
      menu.addSeparator();
      for (const [name, color] of [["Yellow", "#fff1a8"], ["Rose", "#ffd5df"], ["Blue", "#cfe9ff"], ["Mint", "#d7f0d4"], ["Lilac", "#e6dcff"]])
        menu.addItem((item) => item.setTitle(name).setChecked(note.color === color).onClick(() => this.update(note, { color })));
      menu.addSeparator(); menu.addItem((item) => item.setTitle("Delete sticky note").setIcon("trash-2").onClick(() => {
        const current = this.context.page().stickyNotes?.find((n) => n.id === note.id);
        if (current && !this.context.busy()) this.context.change(current, undefined);
      }));
    }
    menu.showAtMouseEvent(new MouseEvent("contextmenu", { clientX: x, clientY: y }));
  }
  sync(): void {
    const page = this.context.page(), editable = this.context.editable(), width = this.host.clientWidth;
    if (!editable) this.editing = undefined;
    // Invalidating the render cache (for example after a text commit) is not
    // a page change, and must not cancel the contact that committed the text.
    if (this.editing && this.editing.base.pageId !== page.id) this.editing = undefined;
    if (this.drag && this.drag.page !== page.id) this.drag = undefined;
    if (this.last && this.last.page !== page.id) this.menu?.hide();
    if (this.editing || this.drag || this.pendingTextRefresh) return;
    if (this.last?.page === page.id && this.last.notes === page.stickyNotes && this.last.editable === editable && this.last.width === width) return;
    const frameKey = (note: StickyNote) => {
      const { strokes, deletedStrokeIds, updatedAt, textUpdatedAt, ...frame } = note;
      return JSON.stringify(frame);
    };
    if (this.last?.page === page.id && this.last.editable === editable && this.last.width === width
      && this.last.notes?.length === page.stickyNotes?.length
      && page.stickyNotes?.every((note, i) => frameKey(note) === frameKey(this.last!.notes![i]))) {
      // Handwriting changes do not replace focused controls or re-run the
      // Markdown renderer on every Pencil lift.
      this.preview(page.stickyNotes); this.last.notes = page.stickyNotes; return;
    }
    this.last = { page: page.id, notes: page.stickyNotes, editable, width }; this.cards.abort(); this.cards = new AbortController();
    this.markdown.unload(); this.markdown = new Component(); this.markdown.load(); this.layer.empty();
    for (const stored of page.stickyNotes ?? []) {
      let note = !editable && this.readFrames.has(stored.id) ? { ...stored, collapsed: this.readFrames.get(stored.id)! } : stored;
      if (!note.collapsed && stored.collapsed) note = { ...note, x: Math.min(note.x, 1 - note.width), y: Math.min(note.y, 1 - note.height) };
      const card = this.layer.createDiv({ cls: `ink-sticky-note${note.collapsed ? " is-collapsed" : ""}`, attr: { "data-sticky-id": note.id, tabindex: "-1", "aria-label": note.title || "Sticky note" } }); this.position(card, note);
      const header = card.createDiv({ cls: "ink-sticky-header" });
      header.style.height = `${STICKY_HEADER * width / note.boardPageWidth}px`;
      const grip = button(header, "Move sticky note", "grip-vertical", () => undefined);
      grip.classList.add("ink-sticky-move");
      const title = grip.createSpan({ cls: "ink-sticky-title", text: note.title || "Sticky note" });
      let titleContact = "mouse";
      title.addEventListener("pointerdown", (e) => { titleContact = e.pointerType; }, { signal: this.cards.signal });
      title.addEventListener("touchstart", (e) => { titleContact = (e.touches[0] as Touch & { touchType?: string })?.touchType === "stylus" ? "pen" : "touch"; }, { signal: this.cards.signal });
      title.ondblclick = () => { if (!note.collapsed && (titleContact !== "pen" || this.context.pointer())) this.edit(note, "title", header); };
      grip.onclick = () => { if (this.suppressTap) { this.suppressTap = false; return; } if (note.collapsed) this.open(note.id); };
      let titleTap = 0;
      title.addEventListener("touchmove", () => { titleTap = 0; }, { signal: this.cards.signal });
      title.addEventListener("touchend", (e) => {
        if (note.collapsed || (e.changedTouches[0] as Touch & { touchType?: string })?.touchType === "stylus") return;
        const now = Date.now(); if (now - titleTap < 300) { titleTap = 0; this.edit(note, "title", header); } else titleTap = now;
      }, { signal: this.cards.signal });
      const bindDrag = (element: HTMLElement, resize: boolean, pan = false) => {
        element.addEventListener("pointerdown", (e) => {
          if (e.pointerType === "touch" || !editable || this.context.busy() || pan && !this.context.pointer() || e.pointerType === "pen" && !this.context.pointer() || e.button !== 0 || pan && (e.target as HTMLElement).closest("a")) return;
          e.preventDefault(); e.stopPropagation();
          const rect = this.host.getBoundingClientRect();
          const current = this.context.page().stickyNotes?.find((n) => n.id === note.id); if (!current) return;
          this.drag = { pointer: e.pointerId, touch: false, page: page.id, note: cloneSticky(current), rect, x: e.clientX, y: e.clientY, resize, element: card, pan: pan ? rect.height / rect.width : 0 };
        }, { signal: this.cards.signal });
        element.addEventListener("touchstart", (e) => {
          if (this.drag || !editable || this.context.busy() || pan && !this.context.pointer() || e.touches.length !== 1 || pan && (e.target as HTMLElement).closest("a")) return;
          const t = e.touches[0]; if ((t as Touch & { touchType?: string }).touchType === "stylus") return;
          e.preventDefault(); e.stopPropagation();
          const rect = this.host.getBoundingClientRect();
          const current = this.context.page().stickyNotes?.find((n) => n.id === note.id); if (!current) return;
          this.drag = { pointer: t.identifier, touch: true, page: page.id, note: cloneSticky(current), rect, x: t.clientX, y: t.clientY, resize, element: card, pan: pan ? rect.height / rect.width : 0 };
        }, { signal: this.cards.signal, passive: false });
      };
      // The whole title is a move handle, rather than a tiny grip icon.
      bindDrag(grip, false);
      button(header, note.collapsed ? "Expand" : "Fold", note.collapsed ? "maximize-2" : "minimize-2", () => this.update(note, { collapsed: !note.collapsed }));
      if (!note.collapsed && editable) button(header, "Type on sticky note", "type", () => this.edit(note, "text", card)).classList.add("ink-sticky-type");
      const options = button(header, "Sticky note options", "ellipsis", () => {
        if (this.closeMenuTarget === options) { this.closeMenuTarget = undefined; return; }
        if (this.menuNote === note.id) { this.menu?.hide(); return; }
        const r = header.getBoundingClientRect(); this.showMenu(note, r.right, r.bottom);
      });
      header.addEventListener("pointerdown", () => {
        this.layer.querySelector(".is-active")?.classList.remove("is-active"); card.classList.add("is-active");
      }, { signal: this.cards.signal, capture: true });
      // Isolate the whole control contact: a bubbling touchend otherwise
      // reaches the page recognizer, which cancels the button's native click.
      // Active drags run in document capture before these chrome shields.
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "touchcancel"] as const) header.addEventListener(type, (e) => e.stopPropagation(), { signal: this.cards.signal });
      if (!note.collapsed || note.preview) {
        const board = card.createDiv({ cls: "ink-sticky-board", attr: { "aria-label": "Sticky handwriting board" } });
        if (!note.collapsed) bindDrag(board, false, true);
        const canvas = board.createEl("canvas");
        const scale = width / note.boardPageWidth;
        const w = card.clientWidth, h = Math.max(1, card.clientHeight - header.offsetHeight);
        const ratio = Math.min(2, window.devicePixelRatio || 1, 2048 / Math.max(w, h));
        canvas.width = Math.max(1, Math.ceil(w * ratio)); canvas.height = Math.max(1, Math.ceil(h * ratio));
        const ctx = canvas.getContext("2d"); if (ctx) paintStickyBoard(ctx, { ...note, text: "" }, canvas.width, canvas.height, scale * ratio, false);
        const text = board.createDiv({ cls: "ink-sticky-markdown markdown-rendered" });
        text.style.transformOrigin = "top left"; text.style.transform = `scale(${scale})`;
        text.style.left = `${(16 - note.scrollX) * scale}px`; text.style.top = `${(16 - note.scrollY) * scale}px`;
        text.style.width = `${Math.max(60, note.textWidth ?? note.width * note.boardPageWidth - 32)}px`;
        void MarkdownRenderer.render(this.app, note.text, text, this.context.source(), this.markdown).then(() => {
          for (const paragraph of note.text.split(/\n\s*\n/)) {
            const block = /(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/.exec(paragraph); if (!block) continue;
            const content = paragraph.slice(0, block.index).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
            const node = Array.from(text.querySelectorAll<HTMLElement>("p,li,blockquote,h1,h2,h3,h4,h5,h6")).find((el) => {
              const value = el.textContent?.replace(/\^[a-zA-Z0-9-]+\s*$/, "").replace(/\s+/g, " ").trim(); return value === content;
            });
            if (node) node.dataset.stickyBlock = block[1];
          }
          if (this.target?.id === note.id) this.revealBlock(note.id, this.target.block);
        }).catch((error: unknown) => {
          text.textContent = note.text; console.error("Ink Notes: sticky Markdown rendering failed", error);
        });
        if (editable && !note.collapsed && !note.text && !note.strokes.length) board.createDiv({ cls: "ink-sticky-hint", text: "Write here, or double-tap to type" });
        let contact = "mouse", tap = 0, tapX = 0, tapY = 0, startX = 0, startY = 0, moved = false;
        board.addEventListener("pointerdown", (e) => { contact = e.pointerType; }, { signal: this.cards.signal });
        board.addEventListener("touchstart", (e) => {
          contact = (e.touches[0] as Touch & { touchType?: string })?.touchType === "stylus" ? "pen" : "touch";
          const t = e.touches[0]; if (t) { startX = t.clientX; startY = t.clientY; }
          moved = e.touches.length !== 1;
        }, { signal: this.cards.signal });
        board.addEventListener("touchmove", (e) => {
          const t = e.touches[0];
          if (e.touches.length !== 1 || t && Math.hypot(t.clientX - startX, t.clientY - startY) > 10) { moved = true; tap = 0; }
        }, { signal: this.cards.signal });
        board.addEventListener("touchcancel", () => { moved = true; tap = 0; }, { signal: this.cards.signal });
        board.ondblclick = (e) => { if (!note.collapsed && !(e.target as HTMLElement).closest("a") && (contact !== "pen" || this.context.pointer())) this.edit(note, "text", card); };
        board.addEventListener("touchend", (e) => {
          if (note.collapsed || moved || this.context.fingerAsPen() || contact !== "touch" || e.changedTouches.length !== 1 || (e.target as HTMLElement).closest("a")) return;
          const t = e.changedTouches[0], now = Date.now();
          if (now - tap < 300 && Math.hypot(t.clientX - tapX, t.clientY - tapY) < 16) { tap = 0; this.edit(note, "text", card); }
          else { tap = now; tapX = t.clientX; tapY = t.clientY; }
        }, { signal: this.cards.signal });
        text.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest("a") && contact !== "touch" && !this.context.pointer()) { e.preventDefault(); e.stopPropagation(); }
        }, { signal: this.cards.signal, capture: true });
        if (note.collapsed) {
          board.onclick = () => { if (this.suppressTap) { this.suppressTap = false; return; } this.open(note.id); };
          for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "touchcancel"] as const) board.addEventListener(type, (e) => e.stopPropagation(), { signal: this.cards.signal });
        }
        // Alt-wheel scrolls the unbounded board without changing page zoom.
        board.addEventListener("wheel", (e) => {
          if (!e.altKey || note.collapsed || !editable || this.context.busy()) return;
          e.preventDefault(); e.stopPropagation(); this.update(note, { scrollX: Math.max(0, note.scrollX + e.deltaX / scale), scrollY: Math.max(0, note.scrollY + e.deltaY / scale) });
        }, { signal: this.cards.signal, passive: false });
      }
      if (editable && !note.collapsed) bindDrag(button(card, "Resize note", "move-diagonal-2", () => undefined), true);
      card.lastElementChild?.classList.toggle("ink-sticky-resize", editable && !note.collapsed);
      card.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showMenu(note, e.clientX, e.clientY); }, { signal: this.cards.signal });
      card.addEventListener("touchstart", (e) => {
        if ((!note.collapsed && !(e.target as HTMLElement).closest(".ink-sticky-move")) || e.touches.length !== 1
          || (e.target as HTMLElement).closest("button:not(.ink-sticky-move)")) return;
        const t = e.touches[0]; if ((t as Touch & { touchType?: string }).touchType === "stylus") return;
        this.hold = setTimeout(() => { this.drag = undefined; this.suppressTap = true; this.showMenu(note, t.clientX, t.clientY); }, 550);
      }, { signal: this.cards.signal, capture: true });
      for (const type of ["touchmove", "touchend", "touchcancel"] as const) card.addEventListener(type, () => clearTimeout(this.hold), { signal: this.cards.signal, capture: true });
    }
  }
  /** Repaint only ink during erasing; avoid rebuilding controls mid-contact. */
  preview(notes: StickyNote[]): void {
    for (const note of notes) {
      const card = Array.from(this.layer.children).find((el) => (el as HTMLElement).dataset.stickyId === note.id) as HTMLElement | undefined;
      const canvas = card?.querySelector("canvas"); if (!canvas || note.collapsed) continue;
      const board = canvas.parentElement!, scale = this.host.clientWidth / note.boardPageWidth;
      const ratio = Math.min(2, window.devicePixelRatio || 1, 2048 / Math.max(1, board.clientWidth, board.clientHeight));
      const w = Math.max(1, Math.ceil(board.clientWidth * ratio)), h = Math.max(1, Math.ceil(board.clientHeight * ratio));
      if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d"); if (ctx) paintStickyBoard(ctx, { ...note, text: "" }, canvas.width, canvas.height, scale * ratio, false);
      card?.querySelector<HTMLElement>(".ink-sticky-hint")?.toggleAttribute("hidden", !!note.strokes.length || !!note.text);
      const text = card?.querySelector<HTMLElement>(".ink-sticky-markdown");
      if (text) { text.style.left = `${(16 - note.scrollX) * scale}px`; text.style.top = `${(16 - note.scrollY) * scale}px`; }
    }
  }
}

export function markdownStickyLink(file: string, note: StickyNote, vault: string, block?: string): string {
  return `[${(note.title || "Sticky note").replace(/[\[\]\\\n]/g, " ")}${block ? ` · ${block}` : ""}](${stickyLink(file, note.pageId, note.id, vault, block)})`;
}
