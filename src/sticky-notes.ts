import { App, Component, MarkdownRenderer, Menu, Notice, setIcon } from "obsidian";
import { InkPage, newId } from "./model";
import { cloneSticky, StickyNote, StickyTextBox, stickyLink, stickyPosition, stickyTextBoxes, stickyText, PRIMARY_TEXT_BOX, patchStickyTextBox } from "./sticky-model";
import { paintStickyBoard, paintStickyIcon, stickyFrameHeight, stickyFrameWidth } from "./sticky-rendering";
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
function movedNote(note: StickyNote, dx: number, dy: number, resize: boolean, rect: DOMRect, pan = 0, boxId?: string): StickyNote {
  if (boxId) {
    const box = stickyTextBoxes(note).find((box) => box.id === boxId); if (!box) return note;
    const x = dx * note.boardPageWidth, y = dy * rect.height / rect.width * note.boardPageWidth;
    return patchStickyTextBox(note, boxId, resize ? { width: Math.max(60, box.width + x), height: Math.max(60, (box.height ?? 120) + y) }
      : { x: Math.max(0, box.x + x), y: Math.max(0, box.y + y) });
  }
  if (pan) return { ...note, scrollX: Math.max(0, note.scrollX - dx * note.boardPageWidth), scrollY: Math.max(0, note.scrollY - dy * pan * note.boardPageWidth) };
  const { x, y } = stickyPosition(note);
  return resize ? { ...note, width: Math.max(.12, Math.min(1 - x, note.width + dx)), height: Math.max(.10, Math.min(1 - y, note.height + dy)) }
    : { ...note, x: Math.max(0, Math.min(1 - stickyFrameWidth(note, rect.width) / rect.width, x + dx)),
      y: Math.max(0, Math.min(1 - stickyFrameHeight(note, rect.width, rect.height) / rect.height, y + dy)) };
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
  private iconTap?: { id: string; time: number; x: number; y: number };
  private iconSecond?: { id: string; x: number; y: number };
  private readFrames = new Map<string, boolean>();
  private target?: { id: string; block: string };
  private selectedBox?: { note: string; box: string };
  private boxTap?: { note: string; box: string; time: number; x: number; y: number };
  private editing?: { id: string; field: "title" | "text" | "keywords"; boxId?: string; base: StickyNote; input: HTMLInputElement | HTMLTextAreaElement };
  private last?: { page: string; notes: StickyNote[] | undefined; editable: boolean; width: number };
  private drag?: { pointer: number; touch: boolean; page: string; note: StickyNote; rect: DOMRect; x: number; y: number; resize: boolean; element: HTMLElement; pan?: number; moved?: boolean; boxId?: string };
  constructor(readonly host: HTMLElement, private app: App, private context: StickyContext) {
    this.layer = host.createDiv({ cls: "ink-sticky-layer" }); this.markdown.load();
    const signal = this.events.signal, doc = host.ownerDocument;
    const commitOutside = (event: Event) => {
      if (event.type === "touchstart") this.suppressTap = false;
      const target = event.target as HTMLElement;
      const contact = event.type === "touchstart" ? (event as TouchEvent).touches.length === 1 ? (event as TouchEvent).touches[0] : undefined
        : event.type === "pointerdown" && (event as PointerEvent).pointerType !== "touch" && (event as PointerEvent).button === 0 && ((event as PointerEvent).pointerType !== "pen" || this.context.pointer()) ? event as PointerEvent : undefined;
      const tap = this.iconTap;
      if (event.type === "touchstart" && (event as TouchEvent).touches.length !== 1) { this.iconTap = undefined; this.iconSecond = undefined; }
      if (contact && !(contact as Touch & { touchType?: string }).touchType?.includes("stylus") && this.host.closest(".ink-page-scroller, .ink-pdf-scroller")?.contains(target) && tap && Date.now() - tap.time < 300 && Math.hypot(contact.clientX - tap.x, contact.clientY - tap.y) < 16) {
        this.iconTap = undefined; this.iconSecond = { id: tap.id, x: contact.clientX, y: contact.clientY };
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (contact) this.iconTap = undefined;
      const toggle = target.closest?.('.ink-sticky-header button[aria-label="Sticky note options"]');
      // Host menus dismiss in document capture, before the button click.
      // Remember that this contact closes the menu rather than reopening it.
      if (toggle && this.menuNote && this.menuNote === toggle.closest<HTMLElement>(".ink-sticky-note")?.dataset.stickyId) {
        this.closeMenuTarget = toggle as HTMLElement; this.menu?.hide();
      } else if (!this.closeMenuTarget?.contains(target)) this.closeMenuTarget = undefined;
      if (this.editing && !this.editing.input.contains(event.target as Node)) {
        this.pendingTextRefresh = true; this.commitText();
      }
      const writingContact = !this.context.pointer() && target.closest?.(".ink-sticky-board") && !target.closest("button, .ink-sticky-inline-input")
        && (event.type === "pointerdown" && ["pen", "mouse"].includes((event as PointerEvent).pointerType)
          || event.type === "touchstart" && ((event as TouchEvent).touches[0] as Touch & { touchType?: string })?.touchType === "stylus"
          || event.type === "touchstart" && this.context.fingerAsPen());
      if (writingContact || !target.closest?.('.ink-sticky-text-box, .ink-sticky-inline-input, button[aria-label="Type on sticky note"]')) { this.selectBox(); this.boxTap = undefined; }
      if (!this.layer.contains(event.target as Node)) {
        this.layer.querySelector(".is-active")?.classList.remove("is-active");
      }
    };
    doc.addEventListener("pointerdown", commitOutside, { signal, capture: true });
    doc.addEventListener("touchstart", commitOutside, { signal, capture: true, passive: false });
    const finishIcon = (event: PointerEvent | TouchEvent) => {
      if (event.type === "pointerup" && (event as PointerEvent).pointerType === "touch") return;
      const second = this.iconSecond; if (!second) return; this.iconSecond = undefined;
      const contact = event.type === "touchend" ? (event as TouchEvent).changedTouches[0] : event as PointerEvent;
      event.preventDefault(); event.stopImmediatePropagation();
      const note = this.context.page().stickyNotes?.find((n) => n.id === second.id), card = this.card(second.id);
      if (contact && Math.hypot(contact.clientX - second.x, contact.clientY - second.y) < 16 && note && card) this.edit(note, "text", card);
    };
    doc.addEventListener("pointerup", finishIcon, { signal, capture: true });
    doc.addEventListener("pointercancel", () => { this.iconSecond = undefined; this.iconTap = undefined; }, { signal, capture: true });
    doc.addEventListener("touchend", finishIcon, { signal, capture: true, passive: false });
    const refreshText = () => {
      if (!this.pendingTextRefresh) return;
      // Let the native click complete before replacing its button target.
      setTimeout(() => { if (!signal.aborted) { this.pendingTextRefresh = false; this.last = undefined; this.sync(); } }, 0);
    };
    doc.addEventListener("pointerup", (event) => { if (event.pointerType !== "touch") refreshText(); }, { signal, capture: true });
    doc.addEventListener("touchend", () => { clearTimeout(this.hold); refreshText(); }, { signal, capture: true });
    doc.addEventListener("click", refreshText, { signal });
    doc.addEventListener("touchstart", (event) => {
      if (event.touches.length > 1) this.boxTap = undefined;
      if (this.drag && event.touches.length > 1) { clearTimeout(this.hold); this.drag = undefined; this.last = undefined; this.sync(); }
    }, { signal, capture: true });
    doc.addEventListener("pointermove", (event) => {
      const drag = this.drag; if (!drag || drag.touch || drag.pointer !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation();
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      drag.moved = true;
      const dx = (event.clientX - drag.x) / drag.rect.width, dy = (event.clientY - drag.y) / drag.rect.height;
      const note = movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan, drag.boxId);
      if (drag.pan || drag.boxId) this.preview([note]); else { this.position(drag.element, note); if (drag.resize) this.preview([note]); }
    }, { signal, passive: false, capture: true });
    const finish = (event: PointerEvent) => {
      const drag = this.drag; if (!drag || drag.touch || drag.pointer !== event.pointerId) return; this.drag = undefined;
      const moved = drag.moved || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 6;
      if (event.type === "pointerup" && this.context.editable() && this.context.page().id === drag.page) {
        const dx = (event.clientX - drag.x) / drag.rect.width, dy = (event.clientY - drag.y) / drag.rect.height;
        const after = movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan, drag.boxId);
        if (moved && (dx || dy)) { this.boxTap = undefined; this.context.change(drag.note, after); }
        else { this.position(drag.element, drag.note); if (drag.pan || drag.resize || drag.boxId) this.preview([drag.note]); }
      }
      if (event.type !== "pointerup") { this.last = undefined; this.sync(); }
      if (event.type === "pointerup" && !moved && drag.note.collapsed && !this.suppressTap) this.activateIcon(drag.note.id, event.clientX, event.clientY);
      refreshText(); this.sync(); if (moved || event.type === "pointercancel") event.stopPropagation();
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
      const note = movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan, drag.boxId);
      if (drag.pan || drag.boxId) this.preview([note]); else { this.position(drag.element, note); if (drag.resize) this.preview([note]); }
    }, { signal, passive: false, capture: true });
    doc.addEventListener("touchend", (event) => {
      const drag = this.drag; if (!drag?.touch) return;
      const touch = Array.from(event.changedTouches).find((t) => t.identifier === drag.pointer); if (!touch) return;
      this.drag = undefined;
      const moved = drag.moved || Math.hypot(touch.clientX - drag.x, touch.clientY - drag.y) >= 6;
      if (this.context.editable() && this.context.page().id === drag.page) {
        const dx = (touch.clientX - drag.x) / drag.rect.width, dy = (touch.clientY - drag.y) / drag.rect.height;
        if (moved && (dx || dy)) { this.boxTap = undefined; this.context.change(drag.note, movedNote(drag.note, dx, dy, drag.resize, drag.rect, drag.pan, drag.boxId)); }
        else {
          this.position(drag.element, drag.note); if (drag.pan || drag.resize || drag.boxId) this.preview([drag.note]);
          // A native touch drag prevents the synthetic click. Restore tap-to-open explicitly.
          if (!moved && drag.note.collapsed && !this.suppressTap) {
            // Do not let WebKit retarget a compatibility click onto the newly
            // expanded card's controls after replacing this folded label.
            event.preventDefault(); this.activateIcon(drag.note.id, touch.clientX, touch.clientY);
          }
        }
      }
      if (!moved && drag.boxId && !drag.resize) this.tapBox(drag.note.id, drag.boxId, touch.clientX, touch.clientY);
      refreshText(); this.sync(); if (moved || drag.boxId) { event.preventDefault(); event.stopPropagation(); }
    }, { signal, capture: true, passive: false });
    doc.addEventListener("touchcancel", () => { clearTimeout(this.hold); this.iconSecond = undefined; this.iconTap = undefined; this.drag = undefined; refreshText(); this.last = undefined; this.sync(); }, { signal, capture: true });
    doc.defaultView?.addEventListener("blur", () => { clearTimeout(this.hold); this.iconSecond = undefined; this.iconTap = undefined; this.drag = undefined; refreshText(); this.last = undefined; this.sync(); }, { signal });
  }
  dispose(): void { this.events.abort(); this.cards.abort(); this.markdown.unload(); this.menu?.hide(); clearTimeout(this.hold); this.layer.remove(); }
  private activateIcon(id: string, x: number, y: number): void {
    this.iconTap = { id, x, y, time: Date.now() }; this.open(id);
  }
  private position(el: HTMLElement, note: StickyNote): void {
    const { x, y } = stickyPosition(note);
    el.style.left = `${x * 100}%`; el.style.top = `${y * 100}%`;
    const scale = this.host.clientWidth / note.boardPageWidth;
    el.style.width = `${stickyFrameWidth(note, this.host.clientWidth)}px`;
    el.style.height = `${stickyFrameHeight(note, this.host.clientWidth, this.host.clientHeight)}px`;
    el.style.backgroundColor = note.color;
    el.style.setProperty("--sticky-header-height", `${STICKY_HEADER * scale}px`);
  }
  private card(id: string): HTMLElement | undefined {
    return Array.from(this.layer.children).find((el) => (el as HTMLElement).dataset.stickyId === id) as HTMLElement | undefined;
  }
  private positionBox(element: HTMLElement, note: StickyNote, box: StickyTextBox): void {
    const scale = this.host.clientWidth / note.boardPageWidth;
    element.style.transformOrigin = "top left"; element.style.transform = `scale(${scale})`;
    element.style.left = `${(box.x - note.scrollX) * scale}px`; element.style.top = `${(box.y - note.scrollY) * scale}px`;
    element.style.width = `${box.width}px`; element.style.height = box.height === undefined ? "auto" : `${box.height}px`;
    element.style.setProperty("--sticky-control-size", `${44 / Math.max(.1, scale)}px`);
    element.style.setProperty("--sticky-control-icon", `${20 / Math.max(.1, scale)}px`);
    // Fit the selected actions to the visible board, including small or
    // partially cropped boxes; their hit targets do not shrink with text.
    const boardWidth = note.width * this.host.clientWidth;
    const boardHeight = Math.max(1, note.height * this.host.clientHeight - STICKY_HEADER * scale);
    const columns = Math.max(1, Math.min(3, Math.floor(boardWidth / 44)));
    const controlsWidth = columns * 44, controlsHeight = Math.ceil(3 / columns) * 44;
    const x = (box.x - note.scrollX) * scale, y = (box.y - note.scrollY) * scale;
    const left = Math.max(0, Math.min(boardWidth - controlsWidth, x + box.width * scale - controlsWidth));
    const top = Math.max(0, Math.min(boardHeight - controlsHeight, y >= controlsHeight ? y - controlsHeight : y + (box.height ?? element.offsetHeight) * scale));
    element.style.setProperty("--sticky-controls-left", `${(left - x) / scale}px`);
    element.style.setProperty("--sticky-controls-top", `${(top - y) / scale}px`);
    element.style.setProperty("--sticky-controls-width", `${controlsWidth / scale}px`);
  }
  private selectBox(note?: string, box?: string): void {
    this.selectedBox = note && box ? { note, box } : undefined;
    for (const element of Array.from(this.layer.querySelectorAll<HTMLElement>(".ink-sticky-text-box"))) {
      element.classList.toggle("is-selected", element.dataset.textBoxId === box && element.closest<HTMLElement>(".ink-sticky-note")?.dataset.stickyId === note);
    }
  }
  private tapBox(id: string, box: string, x: number, y: number): void {
    const previous = this.boxTap;
    this.selectBox(id, box);
    if (previous?.note === id && previous.box === box && Date.now() - previous.time < 300 && Math.hypot(x - previous.x, y - previous.y) < 16) {
      this.boxTap = undefined;
      const note = this.context.page().stickyNotes?.find((note) => note.id === id), card = this.card(id);
      if (note && card) this.edit(note, "text", card, box);
    } else this.boxTap = { note: id, box, time: Date.now(), x, y };
  }
  private addTextBox(note: StickyNote): void {
    if (!this.context.editable() || this.context.busy()) return;
    this.open(note.id);
    const current = this.context.page().stickyNotes?.find((item) => item.id === note.id); if (!current) return;
    const id = newId("sticky-text"), now = Date.now();
    const offset = ((current.textBoxes?.length ?? 0) % 4) * 24;
    const box: StickyTextBox = { id, text: "", x: current.scrollX + 16 + offset, y: current.scrollY + 16 + offset,
      width: Math.max(60, Math.min(240, current.width * current.boardPageWidth - 32)), height: 120, createdAt: now, updatedAt: now };
    this.selectBox(current.id, id);
    this.update(current, { textBoxes: [...(current.textBoxes ?? []), box] });
    const card = this.card(current.id); if (card) this.edit(current, "text", card, id);
  }
  private deleteTextBox(note: StickyNote, id: string): void {
    const current = this.context.page().stickyNotes?.find((item) => item.id === note.id); if (!current) return;
    this.selectBox();
    this.update(current, id === PRIMARY_TEXT_BOX ? { text: "" } : { textBoxes: current.textBoxes?.filter((box) => box.id !== id) });
  }
  open(id: string, block?: string): void {
    const note = this.context.page().stickyNotes?.find((n) => n.id === id); if (!note) return;
    if (block) this.target = { id, block };
    if (note.collapsed || this.readFrames.get(id)) this.update(note, { collapsed: false });
    const card = this.card(id);
    const scroller = this.host.closest<HTMLElement>(".ink-page-scroller, .ink-pdf-scroller");
    if (card && scroller) {
      const frame = card.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
      if (frame.top < viewport.top) scroller.scrollTop += frame.top - viewport.top;
      else if (frame.bottom > viewport.bottom) scroller.scrollTop += Math.min(frame.top - viewport.top, frame.bottom - viewport.bottom);
      if (frame.left < viewport.left) scroller.scrollLeft += frame.left - viewport.left;
      else if (frame.right > viewport.right) scroller.scrollLeft += Math.min(frame.left - viewport.left, frame.right - viewport.right);
    }
    card?.focus({ preventScroll: true });
    if (block) this.revealBlock(id, block);
  }
  private revealBlock(id: string, block: string): void {
    const card = this.card(id);
    const el = Array.from(card?.querySelectorAll<HTMLElement>("[data-sticky-block]") ?? []).find((el) => el.dataset.stickyBlock === block);
    if (!el) return;
    const note = this.context.page().stickyNotes?.find((n) => n.id === id);
    const boxId = el.closest<HTMLElement>(".ink-sticky-text-box")?.dataset.textBoxId;
    const box = note && stickyTextBoxes(note).find((box) => box.id === boxId);
    const top = el.offsetTop + (box?.y ?? 16), left = box?.x ?? 16;
    const scale = this.host.clientWidth / (note?.boardPageWidth ?? 1);
    if (note && (top < note.scrollY || top > note.scrollY + card!.clientHeight / Math.max(.001, scale) - STICKY_HEADER
      || left < note.scrollX || left > note.scrollX + card!.clientWidth / Math.max(.001, scale))) {
      this.target = { id, block }; this.update(note, { scrollY: Math.max(0, top - 16), scrollX: Math.max(0, left - 16) }); return;
    }
    el.classList.add("ink-sticky-reference-target"); this.target = undefined;
  }
  private update(note: StickyNote, patch: Partial<StickyNote>): void {
    if (this.context.busy()) return;
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
    const currentBox = current && stickyTextBoxes(current).find((box) => box.id === edit.boxId);
    const baseBox = stickyTextBoxes(edit.base).find((box) => box.id === edit.boxId);
    if (!current || edit.boxId && !currentBox || (edit.boxId ? currentBox?.text !== baseBox?.text : current[edit.field] !== edit.base[edit.field])) {
      this.editing = edit; new Notice("This text changed in another pane. Copy your draft before reopening it."); return;
    }
    if (edit.boxId) this.update(current, patchStickyTextBox(current, edit.boxId, { text: edit.input.value }));
    else this.update(current, { [edit.field]: edit.input.value });
    edit.input.remove(); this.last = undefined; this.sync();
  }
  private edit(note: StickyNote, field: "title" | "text" | "keywords", parent: HTMLElement, boxId = PRIMARY_TEXT_BOX): void {
    if (!this.context.editable() || this.context.busy()) return;
    if (this.editing) { this.editing.input.focus(); return; }
    const current = this.context.page().stickyNotes?.find((n) => n.id === note.id); if (!current) return;
    const box = field === "text" ? stickyTextBoxes(current).find((box) => box.id === boxId) : undefined;
    if (field === "text" && !box) return;
    const board = parent.querySelector<HTMLElement>(".ink-sticky-board");
    const input = (box && board ? board : parent).createEl(field === "text" ? "textarea" : "input", { cls: "ink-sticky-inline-input", attr: { "aria-label": field === "text" ? "Sticky Markdown" : `Sticky ${field}` } });
    if (box) {
      this.selectBox(current.id, boxId); input.classList.add("ink-sticky-box-input");
      this.positionBox(input, current, { ...box, height: box.height ?? 120 });
    }
    input.value = box?.text ?? current[field]; this.editing = { id: current.id, field, boxId: box?.id, base: cloneSticky(current), input };
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
      menu.addItem((item) => item.setTitle("Add text box").setIcon("plus").onClick(() => this.addTextBox(note)));
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
    for (const block of stickyText(note).matchAll(/(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/gm)) {
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
    if (!editable) { this.editing = undefined; this.selectBox(); }
    // Invalidating the render cache (for example after a text commit) is not
    // a page change, and must not cancel the contact that committed the text.
    if (this.editing && this.editing.base.pageId !== page.id) this.editing = undefined;
    if (this.drag && this.drag.page !== page.id) this.drag = undefined;
    if (this.last && this.last.page !== page.id) { this.menu?.hide(); this.iconTap = undefined; this.iconSecond = undefined; this.selectedBox = undefined; this.boxTap = undefined; }
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
      const note = !editable && this.readFrames.has(stored.id) ? { ...stored, collapsed: this.readFrames.get(stored.id)! } : stored;
      const card = this.layer.createDiv({ cls: `ink-sticky-note${note.collapsed ? " is-collapsed" : ""}`, attr: { "data-sticky-id": note.id, tabindex: "-1", "aria-label": note.title || "Sticky note" } }); this.position(card, note);
      const bindDrag = (element: HTMLElement, resize: boolean, pan = false, boxId?: string) => {
        element.addEventListener("pointerdown", (e) => {
          if (e.pointerType === "touch" || !editable || this.context.busy() || pan && !this.context.pointer() || e.pointerType === "pen" && !this.context.pointer() || e.button !== 0 || (pan || boxId) && (e.target as HTMLElement).closest("a") || boxId && (e.target as HTMLElement).closest("button") && e.target !== element) return;
          // A mouse remains a writing input in drawing tools. The Pointer
          // tool or an explicit move/resize handle owns object manipulation.
          if (boxId && e.pointerType === "mouse" && !this.context.pointer() && element.classList.contains("ink-sticky-text-box")) return;
          e.preventDefault(); e.stopPropagation();
          const rect = this.host.getBoundingClientRect();
          const current = this.context.page().stickyNotes?.find((n) => n.id === note.id); if (!current) return;
          this.drag = { pointer: e.pointerId, touch: false, page: page.id, note: cloneSticky(current), rect, x: e.clientX, y: e.clientY, resize, element: card, pan: pan ? rect.height / rect.width : 0, boxId };
          if (boxId) { this.selectBox(note.id, boxId); element.closest<HTMLElement>(".ink-sticky-text-box")?.focus({ preventScroll: true }); }
        }, { signal: this.cards.signal });
        element.addEventListener("touchstart", (e) => {
          if (this.drag || !editable || this.context.busy() || pan && !this.context.pointer() || e.touches.length !== 1 || (pan || boxId) && (e.target as HTMLElement).closest("a") || boxId && this.context.fingerAsPen() && !this.context.pointer() || boxId && (e.target as HTMLElement).closest("button") && e.target !== element) return;
          const t = e.touches[0]; if ((t as Touch & { touchType?: string }).touchType === "stylus") return;
          e.preventDefault(); e.stopPropagation();
          const rect = this.host.getBoundingClientRect();
          const current = this.context.page().stickyNotes?.find((n) => n.id === note.id); if (!current) return;
          this.drag = { pointer: t.identifier, touch: true, page: page.id, note: cloneSticky(current), rect, x: t.clientX, y: t.clientY, resize, element: card, pan: pan ? rect.height / rect.width : 0, boxId };
          if (boxId) { this.selectBox(note.id, boxId); element.closest<HTMLElement>(".ink-sticky-text-box")?.focus({ preventScroll: true }); }
        }, { signal: this.cards.signal, passive: false });
      };
      card.addEventListener("contextmenu", (e) => { e.preventDefault(); this.showMenu(note, e.clientX, e.clientY); }, { signal: this.cards.signal });
      card.addEventListener("touchstart", (e) => {
        if ((!note.collapsed && !(e.target as HTMLElement).closest(".ink-sticky-move")) || e.touches.length !== 1
          || (e.target as HTMLElement).closest("button:not(.ink-sticky-move):not(.ink-sticky-icon)")) return;
        const t = e.touches[0]; if ((t as Touch & { touchType?: string }).touchType === "stylus") return;
        this.hold = setTimeout(() => { this.drag = undefined; this.suppressTap = true; this.iconTap = undefined; this.showMenu(note, t.clientX, t.clientY); }, 550);
      }, { signal: this.cards.signal, capture: true });
      for (const type of ["touchmove", "touchend", "touchcancel"] as const) card.addEventListener(type, () => clearTimeout(this.hold), { signal: this.cards.signal, capture: true });
      if (note.collapsed) {
        const icon = button(card, "Expand", "sticky-note", () => {
          if (this.suppressTap) { this.suppressTap = false; return; }
          this.open(note.id);
        });
        icon.classList.add("ink-sticky-icon"); icon.title = note.title || "Sticky note";
        icon.replaceChildren(); const canvas = icon.createEl("canvas", { attr: { "aria-hidden": "true" } });
        canvas.width = canvas.height = Math.max(1, Math.ceil(card.clientWidth * Math.min(2, window.devicePixelRatio || 1)));
        const ctx = canvas.getContext("2d"); if (ctx) paintStickyIcon(ctx, note, canvas.width, canvas.height, this.host.clientHeight / this.host.clientWidth);
        bindDrag(icon, false);
        for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "touchcancel"] as const) icon.addEventListener(type, (e) => e.stopPropagation(), { signal: this.cards.signal });
        continue;
      }
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
      // The whole title is a move handle, rather than a tiny grip icon.
      bindDrag(grip, false);
      button(header, note.collapsed ? "Expand" : "Fold", note.collapsed ? "maximize-2" : "minimize-2", () => this.update(note, { collapsed: !note.collapsed }));
      if (!note.collapsed && editable) {
        button(header, "Type on sticky note", "type", () => this.edit(note, "text", card, this.selectedBox?.note === note.id ? this.selectedBox.box : PRIMARY_TEXT_BOX)).classList.add("ink-sticky-type");
        button(header, "Add text box", "plus", () => this.addTextBox(note)).classList.add("ink-sticky-add-text");
      }
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
        const ctx = canvas.getContext("2d"); if (ctx) paintStickyBoard(ctx, { ...note, text: "", textBoxes: [] }, canvas.width, canvas.height, scale * ratio, false);
        for (const box of stickyTextBoxes(note)) {
          if (!box.text && box.id === PRIMARY_TEXT_BOX) continue;
          const frame = board.createDiv({ cls: "ink-sticky-text-box", attr: { "data-text-box-id": box.id, tabindex: editable ? "0" : "-1", "aria-label": "Text box" } });
          this.positionBox(frame, note, box);
          frame.classList.toggle("is-selected", this.selectedBox?.note === note.id && this.selectedBox.box === box.id);
          const text = frame.createDiv({ cls: "ink-sticky-markdown markdown-rendered" });
          text.style.width = `${box.width}px`;
          text.addEventListener("click", (event) => {
            if ((event.target as HTMLElement).closest("a") && contact !== "touch" && !this.context.pointer()) { event.preventDefault(); event.stopPropagation(); }
          }, { signal: this.cards.signal, capture: true });
          if (box.height !== undefined) { text.style.height = `${box.height}px`; text.style.overflow = "hidden"; }
          void MarkdownRenderer.render(this.app, box.text, text, this.context.source(), this.markdown).then(() => {
            if (!frame.isConnected) return;
            // A delayed Markdown render must not reset a live drag's layout.
            if (!this.drag) {
              const current = this.context.page().stickyNotes?.find((item) => item.id === note.id);
              const currentBox = current && stickyTextBoxes(current).find((item) => item.id === box.id);
              if (current && currentBox) this.positionBox(frame, current, currentBox);
            }
            for (const paragraph of box.text.split(/\n\s*\n/)) {
              const block = /(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/.exec(paragraph); if (!block) continue;
              const content = paragraph.slice(0, block.index).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
              const node = Array.from(text.querySelectorAll<HTMLElement>("p,li,blockquote,h1,h2,h3,h4,h5,h6")).find((el) => {
                const value = el.textContent?.replace(/\^[a-zA-Z0-9-]+\s*$/, "").replace(/\s+/g, " ").trim(); return value === content;
              });
              if (node) node.dataset.stickyBlock = block[1];
            }
            if (this.target?.id === note.id) this.revealBlock(note.id, this.target.block);
          }).catch((error: unknown) => {
            text.textContent = box.text; console.error("Ink Notes: sticky Markdown rendering failed", error);
          });

          if (editable) {
            bindDrag(frame, false, false, box.id);
            const controls = frame.createDiv({ cls: "ink-sticky-text-controls" });
            const move = button(controls, "Move text box", "grip-vertical", () => undefined); bindDrag(move, false, false, box.id);
            button(controls, "Edit text box", "pencil", () => this.edit(note, "text", card, box.id));
            button(controls, "Delete text box", "trash-2", () => this.deleteTextBox(note, box.id));
            const resize = button(frame, "Resize text box", "move-diagonal-2", () => undefined);
            resize.classList.add("ink-sticky-text-resize"); bindDrag(resize, true, false, box.id);
            for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "touchcancel"] as const) {
              controls.addEventListener(type, (e) => e.stopPropagation(), { signal: this.cards.signal });
              resize.addEventListener(type, (e) => e.stopPropagation(), { signal: this.cards.signal });
            }
            frame.addEventListener("dblclick", (event) => {
              if ((event.target as HTMLElement).closest("button,a") || contact === "pen" && !this.context.pointer()) return;
              event.preventDefault(); event.stopPropagation(); this.edit(note, "text", card, box.id);
            }, { signal: this.cards.signal });
            frame.addEventListener("keydown", (event) => {
              if (event.target !== frame) return;
              if (event.key === "Escape") { event.stopPropagation(); this.selectBox(); return; }
              this.selectBox(note.id, box.id);
              if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); this.edit(note, "text", card, box.id); return; }
              if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); event.stopPropagation(); this.deleteTextBox(note, box.id); return; }
              const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
              const direction = directions[event.key]; if (!direction) return;
              event.preventDefault(); event.stopPropagation();
              const current = this.context.page().stickyNotes?.find((item) => item.id === note.id); if (!current) return;
              const step = event.shiftKey ? 10 : 1, rect = this.host.getBoundingClientRect();
              this.update(current, movedNote(current, direction[0] * step / current.boardPageWidth, direction[1] * step / current.boardPageWidth * rect.width / rect.height, event.altKey, rect, 0, box.id));
              this.card(note.id)?.querySelectorAll<HTMLElement>(".ink-sticky-text-box").forEach((el) => { if (el.dataset.textBoxId === box.id) el.focus({ preventScroll: true }); });
            }, { signal: this.cards.signal });
          }
        }
        if (editable && !note.collapsed && !stickyText(note) && !note.strokes.length) board.createDiv({ cls: "ink-sticky-hint", text: "Write here, or double-tap to type" });
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
        board.ondblclick = (e) => { if (!note.collapsed && !(e.target as HTMLElement).closest("a") && (contact !== "pen" || this.context.pointer()) && !(contact === "touch" && this.context.fingerAsPen() && !this.context.pointer())) this.edit(note, "text", card); };
        board.addEventListener("touchend", (e) => {
          if (note.collapsed || moved || this.context.fingerAsPen() || contact !== "touch" || e.changedTouches.length !== 1 || (e.target as HTMLElement).closest("a")) return;
          const t = e.changedTouches[0], now = Date.now();
          if (now - tap < 300 && Math.hypot(t.clientX - tapX, t.clientY - tapY) < 16) { tap = 0; this.edit(note, "text", card); }
          else { tap = now; tapX = t.clientX; tapY = t.clientY; }
        }, { signal: this.cards.signal });
        // Alt-wheel scrolls the unbounded board without changing page zoom.
        board.addEventListener("wheel", (e) => {
          if (!e.altKey || note.collapsed || !editable || this.context.busy()) return;
          e.preventDefault(); e.stopPropagation(); this.update(note, { scrollX: Math.max(0, note.scrollX + e.deltaX / scale), scrollY: Math.max(0, note.scrollY + e.deltaY / scale) });
        }, { signal: this.cards.signal, passive: false });
      }
      if (editable && !note.collapsed) bindDrag(button(card, "Resize note", "move-diagonal-2", () => undefined), true);
      card.lastElementChild?.classList.toggle("ink-sticky-resize", editable && !note.collapsed);

    }
  }
  /** Repaint only ink during erasing; avoid rebuilding controls mid-contact. */
  preview(notes: StickyNote[]): void {
    for (const note of notes) {
      const card = Array.from(this.layer.children).find((el) => (el as HTMLElement).dataset.stickyId === note.id) as HTMLElement | undefined;
      const canvas = card?.querySelector("canvas"); if (!canvas) continue;
      if (note.collapsed) { const ctx = canvas.getContext("2d"); if (ctx) paintStickyIcon(ctx, note, canvas.width, canvas.height, this.host.clientHeight / this.host.clientWidth); continue; }
      const board = canvas.parentElement!, scale = this.host.clientWidth / note.boardPageWidth;
      const ratio = Math.min(2, window.devicePixelRatio || 1, 2048 / Math.max(1, board.clientWidth, board.clientHeight));
      const w = Math.max(1, Math.ceil(board.clientWidth * ratio)), h = Math.max(1, Math.ceil(board.clientHeight * ratio));
      if (canvas.width !== w) canvas.width = w; if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext("2d"); if (ctx) paintStickyBoard(ctx, { ...note, text: "", textBoxes: [] }, canvas.width, canvas.height, scale * ratio, false);
      card?.querySelector<HTMLElement>(".ink-sticky-hint")?.toggleAttribute("hidden", !!note.strokes.length || !!stickyText(note));
      for (const frame of Array.from(card?.querySelectorAll<HTMLElement>(".ink-sticky-text-box") ?? [])) {
        const box = stickyTextBoxes(note).find((box) => box.id === frame.dataset.textBoxId);
        if (box) { this.positionBox(frame, note, box); const text = frame.querySelector<HTMLElement>(".ink-sticky-markdown");
          if (text) { text.style.width = `${box.width}px`; text.style.height = box.height === undefined ? "auto" : `${box.height}px`; text.style.overflow = box.height === undefined ? "visible" : "hidden"; } }
      }
    }
  }
}

export function markdownStickyLink(file: string, note: StickyNote, vault: string, block?: string): string {
  return `[${(note.title || "Sticky note").replace(/[\[\]\\\n]/g, " ")}${block ? ` · ${block}` : ""}](${stickyLink(file, note.pageId, note.id, vault, block)})`;
}
