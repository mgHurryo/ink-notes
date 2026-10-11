import { InkImage, InkPage } from "./model";
import { ImageLibraryStore } from "./image-library";

export function constrainImage(image: InkImage): InkImage {
  const factor = Math.min(1, 1 / Math.max(0.01, image.width), 1 / Math.max(0.01, image.height));
  const width = Math.max(0.01, image.width * factor), height = Math.max(0.01, image.height * factor);
  return { ...image, width, height, x: Math.min(1 - width, Math.max(0, image.x)), y: Math.min(1 - height, Math.max(0, image.y)) };
}

interface ImageEditorContext {
  page: () => InkPage;
  editable: () => boolean;
  change: (before: InkImage[], after: InkImage[]) => void;
  select: () => void;
}

/** DOM images follow the existing page transform; ink raster resolution stays independent. */
export class PageImageLayer {
  private layer: HTMLElement;
  private outline: HTMLElement;
  private inspector: HTMLElement;
  private selectedId: string | null = null;
  private last?: { pageId: string; images: InkImage[] | undefined; editable: boolean; selectedId: string | null };
  private events = new AbortController();
  private drag: { id: number; touch: boolean; pageId: string; original: InkImage; preview: InkImage; x: number; y: number; rect: DOMRect; resize: boolean } | null = null;
  constructor(readonly host: HTMLElement, root: HTMLElement, private readonly store: ImageLibraryStore, private readonly context: ImageEditorContext) {
    this.layer = host.createDiv({ cls: "ink-page-images" });
    this.outline = host.createDiv({ cls: "ink-image-outline" });
    this.inspector = root.createDiv({ cls: "ink-image-inspector", attr: { role: "group", "aria-label": "Image controls" } });
    this.outline.hidden = this.inspector.hidden = true;
    const signal = this.events.signal;
    host.addEventListener("touchstart", (e) => { if (e.touches.length > 1) this.cancel(); }, { signal, capture: true });
    const doc = host.ownerDocument;
    const outside = (e: Event) => {
      if (this.selectedId === null && !this.drag) return;
      const target = e.target as Node | null;
      if (target && (this.layer.contains(target) || this.outline.contains(target) || this.inspector.contains(target))) return;
      this.clear(); this.sync();
    };
    doc.addEventListener("pointerdown", outside, { signal, capture: true });
    doc.addEventListener("touchstart", outside, { signal, capture: true });
    doc.addEventListener("pointermove", (e) => { if (this.drag && !this.drag.touch && e.pointerId === this.drag.id) { this.move(e.clientX, e.clientY); e.preventDefault(); e.stopPropagation(); } }, { signal, passive: false });
    doc.addEventListener("pointerup", (e) => { if (this.drag && !this.drag.touch && e.pointerId === this.drag.id) { this.finish(); e.stopPropagation(); } }, { signal });
    doc.addEventListener("pointercancel", () => this.cancel(), { signal });
    doc.addEventListener("touchmove", (e) => { if (!this.drag?.touch) return; const touch = Array.from(e.touches).find((t) => t.identifier === this.drag!.id);
      if (touch && e.touches.length === 1) { this.move(touch.clientX, touch.clientY); e.preventDefault(); e.stopPropagation(); } else this.cancel(); }, { signal, passive: false });
    doc.addEventListener("touchend", (e) => { if (this.drag?.touch && Array.from(e.changedTouches).some((t) => t.identifier === this.drag!.id)) { this.finish(); e.stopPropagation(); } }, { signal });
    doc.addEventListener("touchcancel", () => this.cancel(), { signal });
    doc.defaultView?.addEventListener("blur", () => this.cancel(), { signal });
    this.bind(this.outline, true);
    for (const type of ["pointerdown", "touchstart", "touchmove"] as const) this.inspector.addEventListener(type, (e) => e.stopPropagation(), { signal });
  }
  dispose(): void { this.events.abort(); this.layer.remove(); this.outline.remove(); this.inspector.remove(); }
  clear(): void { this.cancel(); this.selectedId = null; this.last = undefined; this.outline.hidden = this.inspector.hidden = true; }
  select(id: string): void {
    if (!this.context.editable() || !this.context.page().images?.some((image) => image.id === id)) return;
    this.context.select(); this.selectedId = id; this.last = undefined; this.sync();
  }
  sync(): void {
    const page = this.context.page(), editable = this.context.editable();
    if (this.drag && (this.drag.pageId !== page.id || !editable)) this.cancel();
    if (this.last?.pageId === page.id && this.last.images === page.images && this.last.editable === editable && this.last.selectedId === this.selectedId) return;
    this.last = { pageId: page.id, images: page.images, editable, selectedId: this.selectedId }; this.layer.empty();
    for (const image of page.images ?? []) {
      const el = this.layer.createEl("img", { cls: "ink-placed-image", attr: { alt: "Inserted image", draggable: "false" } });
      try { el.src = this.store.url(image.assetPath); } catch { el.alt = "Missing image"; }
      el.dataset.imageId = image.id; el.style.zIndex = image.foreground ? "7" : "0";
      el.style.pointerEvents = editable ? "auto" : "none"; this.position(el, image); this.bind(el, false);
    }
    const image = (page.images ?? []).find((i) => i.id === this.selectedId);
    this.outline.hidden = this.inspector.hidden = !image || !editable;
    if (image && editable) {
      this.position(this.outline, image); this.inspector.empty();
      this.inspector.createSpan({ text: "Image" });
      for (const key of ["x", "y", "width"] as const) {
        const label = this.inspector.createEl("label", { text: key === "width" ? "Width %" : `${key.toUpperCase()} %` });
        const input = label.createEl("input", { type: "number", value: String(Math.round(image[key] * 1000) / 10), attr: { min: key === "width" ? "1" : "0", max: "100", step: "1", "aria-label": key === "width" ? "Image width percent" : `Image ${key.toUpperCase()} percent` } });
        input.onchange = () => {
          const value = Number(input.value) / 100; if (!Number.isFinite(value)) return;
          const safe = key === "width" ? Math.max(.01, value) : value;
          const changed = { ...image, [key]: safe }; if (key === "width") changed.height = image.height * safe / image.width;
          this.commit(image, constrainImage(changed));
        };
      }
      this.button(image.foreground ? "Below handwriting" : "Above handwriting", () => this.commit(image, { ...image, foreground: !image.foreground }));
      this.button("Delete image", () => {
        if (!this.isSelected(image)) return;
        this.context.change([image], []); this.clear(); this.sync();
      });
      this.button("Done", () => { this.clear(); this.sync(); });
      this.outline.textContent = "";
      const handle = this.outline.createEl("button", { cls: "ink-image-resize", attr: { type: "button", "aria-label": "Resize image" } });
      handle.textContent = "↘"; this.bind(handle, true);
    }
  }
  private button(text: string, run: () => void): void { const b = this.inspector.createEl("button", { text, attr: { type: "button" } }); b.onclick = run; }
  private position(el: HTMLElement, image: InkImage): void {
    el.style.left = `${image.x * 100}%`; el.style.top = `${image.y * 100}%`; el.style.width = `${image.width * 100}%`; el.style.height = `${image.height * 100}%`;
  }
  private bind(el: HTMLElement, resize: boolean): void {
    // Element listeners die with their nodes; document listeners use the view's abort signal.
    const start = (id: number, touch: boolean, x: number, y: number, e: Event) => {
      if (!this.context.editable()) return;
      if (this.drag) { e.preventDefault(); e.stopPropagation(); return; }
      const page = this.context.page();
      const image = page.images?.find((i) => i.id === (el.dataset.imageId ?? this.selectedId)); if (!image) return;
      e.preventDefault(); e.stopPropagation();
      this.select(image.id);
      this.drag = { id, touch, pageId: page.id, original: { ...image }, preview: { ...image }, x, y, rect: this.host.getBoundingClientRect(), resize };
    };
    el.addEventListener("pointerdown", (e) => { if (e.pointerType !== "mouse" || e.button !== 0) return; start(e.pointerId, false, e.clientX, e.clientY, e); });
    el.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1 && e.touches[0].touchType !== "stylus") {
        const t = e.touches[0]; start(t.identifier, true, t.clientX, t.clientY, e);
      }
    }, { passive: false });
    el.addEventListener("dragstart", (e) => e.preventDefault());
  }
  private move(x: number, y: number): void {
    const drag = this.drag; if (!drag || !this.context.editable() || this.context.page().id !== drag.pageId) { this.cancel(); return; }
    const dx = (x - drag.x) / drag.rect.width, dy = (y - drag.y) / drag.rect.height;
    let changed = { ...drag.original };
    if (drag.resize) {
      const ratio = Math.max(0.02, Math.min(1 / changed.width, 1 / changed.height,
        1 + (Math.abs(dx / changed.width) > Math.abs(dy / changed.height) ? dx / changed.width : dy / changed.height)));
      changed.width *= ratio; changed.height *= ratio;
    } else { changed.x += dx; changed.y += dy; }
    drag.preview = constrainImage(changed);
    const el = Array.from(this.layer.children).find((node) => (node as HTMLElement).dataset.imageId === drag.original.id) as HTMLElement;
    if (el) this.position(el, drag.preview); this.position(this.outline, drag.preview);
  }
  private finish(): void {
    const drag = this.drag; this.drag = null;
    if (drag && this.context.editable() && this.context.page().id === drag.pageId) this.commit(drag.original, drag.preview);
  }
  private cancel(): void { if (!this.drag) return; this.drag = null; this.last = undefined; this.sync(); }
  private isSelected(image: InkImage): boolean {
    return this.context.editable() && this.selectedId === image.id && this.context.page().id === image.pageId
      && !!this.context.page().images?.some((current) => current.id === image.id);
  }
  private commit(before: InkImage, after: InkImage): void {
    if (!this.isSelected(before)) return;
    if (JSON.stringify(before) !== JSON.stringify(after)) this.context.change([before], [after]);
    this.last = undefined; this.sync();
  }
}
