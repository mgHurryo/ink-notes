import { App, Modal, Notice, TFile, normalizePath } from "obsidian";
import { InkImage, InkPage, isManagedImagePath, newId } from "./model";
import { paintPageStickies } from "./sticky-rendering";

export interface ImageAsset { id: string; path: string; name: string; width: number; height: number; groupId: string; }
interface ImageLibrary { schema: 1; groups: { id: string; name: string }[]; assets: ImageAsset[]; }
const LIBRARY_PATH = "Ink Notes/Images/library.json";
const EMPTY = (): ImageLibrary => ({ schema: 1, groups: [], assets: [] });
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i;

export function parseImageLibrary(text: string): ImageLibrary {
  const raw = JSON.parse(text) as ImageLibrary;
  if (raw.schema !== 1 || !Array.isArray(raw.assets) || !Array.isArray(raw.groups)) throw new Error("Invalid image library format");
  if (raw.assets.some((a) => !a || typeof a.id !== "string" || !isManagedImagePath(a.path) || typeof a.name !== "string"
    || !Number.isFinite(a.width) || !Number.isFinite(a.height) || a.width <= 0 || a.height <= 0 || typeof a.groupId !== "string")
    || raw.groups.some((g) => !g || typeof g.id !== "string" || typeof g.name !== "string")) throw new Error("Invalid image library entry");
  return raw;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const finish = (error?: Error) => { clearTimeout(timer); image.onload = null; image.onerror = null; error ? reject(error) : resolve(image); };
    const timer = setTimeout(() => { image.src = ""; finish(new Error("Image loading timed out")); }, 15_000);
    image.onload = () => finish();
    image.onerror = () => finish(new Error("Unsupported or damaged image"));
    image.src = url;
  });
}

/** Assets are immutable vault copies. Removing an instance never deletes shared bytes. */
export class ImageLibraryStore {
  private queue: Promise<unknown> = Promise.resolve();
  private decoded = new Map<string, { promise: Promise<HTMLImageElement>; pixels: number }>();
  constructor(readonly app: App) {}

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run); this.queue = next.catch(() => undefined); return next;
  }
  private async ensureFolders(): Promise<void> {
    for (const path of ["Ink Notes", "Ink Notes/Images", "Ink Notes/Images/assets"]) {
      if (!this.app.vault.getAbstractFileByPath(path)) {
        try { await this.app.vault.createFolder(path); }
        catch (error) { if (!this.app.vault.getAbstractFileByPath(path)) throw error; }
      }
    }
  }
  async read(): Promise<ImageLibrary> {
    const file = this.app.vault.getAbstractFileByPath(LIBRARY_PATH);
    return file instanceof TFile ? parseImageLibrary(await this.app.vault.read(file)) : EMPTY();
  }
  private update(change: (library: ImageLibrary) => void): Promise<void> {
    return this.serial(async () => {
      await this.ensureFolders();
      let file = this.app.vault.getAbstractFileByPath(LIBRARY_PATH);
      if (!file) {
        try { file = await this.app.vault.create(LIBRARY_PATH, JSON.stringify(EMPTY())); }
        catch (error) { file = this.app.vault.getAbstractFileByPath(LIBRARY_PATH); if (!file) throw error; }
      }
      if (!(file instanceof TFile)) throw new Error("Image library path is not a file");
      await this.app.vault.process(file, (text) => {
        const library = parseImageLibrary(text); change(library); return JSON.stringify(library, null, 2) + "\n";
      });
    });
  }
  async group(name: string, id = newId("group")): Promise<void> {
    name = name.trim(); if (!name || name.length > 100) throw new Error("Use a group name of 1–100 characters");
    await this.update((library) => { const group = library.groups.find((g) => g.id === id); if (group) group.name = name; else library.groups.push({ id, name }); });
  }
  async move(ids: string[], groupId: string): Promise<void> {
    await this.update((library) => {
      if (groupId && !library.groups.some((g) => g.id === groupId)) throw new Error("Group no longer exists");
      for (const asset of library.assets) if (ids.includes(asset.id)) asset.groupId = groupId;
    });
  }
  /** Remove catalog entries only: placed images still reference these immutable files. */
  async remove(ids: string[]): Promise<ImageAsset[]> {
    const selected = new Set(ids); if (!selected.size) return [];
    let removed: ImageAsset[] = [];
    await this.update((library) => {
      removed = library.assets.filter((asset) => selected.has(asset.id));
      library.assets = library.assets.filter((asset) => !selected.has(asset.id));
    });
    return removed;
  }
  async restore(assets: ImageAsset[]): Promise<void> {
    if (!assets.length) return;
    await this.update((library) => {
      const existing = new Set(library.assets.map((asset) => asset.id));
      const groups = new Set(library.groups.map((group) => group.id));
      for (const asset of assets) if (!existing.has(asset.id)) {
        library.assets.push({ ...asset, groupId: groups.has(asset.groupId) ? asset.groupId : "" });
        existing.add(asset.id);
      }
    });
  }
  vaultImages(): TFile[] { return this.app.vault.getFiles().filter((file) => IMAGE_EXTENSIONS.test(file.path) && !isManagedImagePath(file.path)); }
  async importVault(paths: string[], groupId: string): Promise<string[]> {
    const errors: string[] = [];
    for (const path of [...new Set(paths)]) {
      try {
        const file = this.app.vault.getAbstractFileByPath(normalizePath(path.trim()));
        if (!(file instanceof TFile) || !IMAGE_EXTENSIONS.test(file.path)) throw new Error("Image file not found");
        await this.importBlob(new Blob([await this.app.vault.readBinary(file)]), file.name, groupId);
      } catch (error) { errors.push(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return errors;
  }
  async importFiles(files: File[], groupId: string): Promise<string[]> {
    const errors: string[] = [];
    for (const file of files) {
      try { await this.importBlob(file, file.name || "Pasted image", groupId); }
      catch (error) { errors.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return errors;
  }
  private async importBlob(blob: Blob, name: string, groupId: string): Promise<void> {
    if (blob.size > 30 * 1024 * 1024) throw new Error("Image exceeds 30 MB");
    const url = URL.createObjectURL(blob);
    try {
      const image = await loadImage(url);
      if (image.naturalWidth * image.naturalHeight > 16_000_000) throw new Error("Image exceeds 16 megapixels; resize before importing");
      const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Image conversion is unavailable");
      ctx.drawImage(image, 0, 0);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Image conversion failed")), "image/png"));
      const asset: ImageAsset = { id: newId("image"), path: "", name, width: canvas.width, height: canvas.height, groupId };
      asset.path = `Ink Notes/Images/assets/${asset.id}.png`;
      await this.ensureFolders();
      await this.app.vault.createBinary(asset.path, await png.arrayBuffer());
      await this.update((library) => {
        if (asset.groupId && !library.groups.some((g) => g.id === asset.groupId)) asset.groupId = "";
        library.assets.push(asset);
      });
    } finally { URL.revokeObjectURL(url); }
  }
  url(path: string): string {
    if (!isManagedImagePath(path)) throw new Error("Invalid managed image path");
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Image asset missing: ${path}`);
    return this.app.vault.getResourcePath(file);
  }
  bytes = async (path: string): Promise<ArrayBuffer> => {
    this.url(path); const file = this.app.vault.getAbstractFileByPath(path) as TFile;
    return this.app.vault.readBinary(file);
  };
  async image(path: string): Promise<HTMLImageElement> {
    let entry = this.decoded.get(path);
    if (!entry) {
      entry = { promise: loadImage(this.url(path)), pixels: 0 }; this.decoded.set(path, entry);
      const current = entry;
      void entry.promise.then((image) => {
        current.pixels = image.naturalWidth * image.naturalHeight;
        while (this.decoded.size > 1 && (this.decoded.size > 8 || [...this.decoded.values()].reduce((total, item) => total + item.pixels, 0) > 16_000_000)) {
          this.decoded.delete(this.decoded.keys().next().value!);
        }
      }).catch(() => { if (this.decoded.get(path) === current) this.decoded.delete(path); });
    }
    return entry.promise;
  }
}

export function placedImage(asset: ImageAsset, pageId: string, pageAspect: number, index = 0): InkImage {
  let width = 0.5, height = width * pageAspect * asset.height / asset.width;
  if (height > 0.5) { width *= 0.5 / height; height = 0.5; }
  const offset = (index % 6) * 0.025;
  return { id: newId("placed-image"), pageId, assetPath: asset.path, x: (1 - width) / 2 + offset, y: (1 - height) / 2 + offset,
    width, height, foreground: false, createdAt: Date.now(), updatedAt: Date.now() };
}

const paints = new WeakMap<HTMLCanvasElement, number>();
/** Repaint only after assets are ready, with a token to exclude stale page paints. */
export function paintPageImages(store: ImageLibraryStore | undefined, canvas: HTMLCanvasElement, page: InkPage,
  base: (ctx: CanvasRenderingContext2D) => void, ink: (ctx: CanvasRenderingContext2D) => void): void {
  const token = (paints.get(canvas) ?? 0) + 1; paints.set(canvas, token);
  const images = (page.images ?? []).map((image) => ({ ...image }));
  const draw = (loaded: (HTMLImageElement | undefined)[]) => {
    if (paints.get(canvas) !== token) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); base(ctx);
    const layer = (foreground: boolean) => images.forEach((image, index) => {
      if (image.foreground === foreground && loaded[index]) ctx.drawImage(loaded[index]!, image.x * canvas.width, image.y * canvas.height, image.width * canvas.width, image.height * canvas.height);
    });
    layer(false); ink(ctx); layer(true); paintPageStickies(ctx, page.stickyNotes, canvas.width, canvas.height); ctx.restore();
  };
  draw([]);
  if (images.length && store) void Promise.allSettled(images.map((image) => store.image(image.assetPath))).then((results) => draw(results.map((result) => {
    if (result.status === "fulfilled") return result.value;
    console.warn("Ink Notes could not render a page image", result.reason); return undefined;
  })))
    .catch((error) => console.warn("Ink Notes could not render page images", error));
}

function button(parent: HTMLElement, text: string, run: () => void): HTMLButtonElement {
  const el = parent.createEl("button", { text, attr: { type: "button" } }); el.addEventListener("click", run); return el;
}

export class ImageLibraryModal extends Modal {
  private selected = new Set<string>();
  private groupId = "*";
  private query = "";
  private busy = false;
  private closed = false;
  private renderRevision = 0;
  private lastDeleted: ImageAsset[] = [];
  private deleteConfirmation?: Modal;
  private events = new AbortController();
  constructor(private readonly store: ImageLibraryStore, private readonly insert: (assets: ImageAsset[]) => void) { super(store.app); }
  onOpen(): void {
    this.setTitle("Image library"); this.modalEl.addClass("ink-image-library");
    this.contentEl.addEventListener("dragover", (e) => e.preventDefault(), { signal: this.events.signal });
    this.contentEl.addEventListener("drop", (e) => { e.preventDefault(); void this.importDevice(Array.from(e.dataTransfer?.files ?? [])); }, { signal: this.events.signal });
    this.contentEl.addEventListener("paste", (e) => {
      const files = Array.from(e.clipboardData?.files ?? []); if (files.length) { e.preventDefault(); void this.importDevice(files); }
    }, { signal: this.events.signal });
    void this.render().catch((error) => this.report(error));
  }
  onClose(): void { this.closed = true; this.deleteConfirmation?.close(); this.lastDeleted = []; this.events.abort(); this.contentEl.empty(); }
  private report(error: unknown): void { new Notice(`Image library: ${error instanceof Error ? error.message : String(error)}`, 8000); }
  private async operation(run: () => Promise<unknown>): Promise<void> {
    if (this.busy || this.closed) return;
    this.busy = true; this.renderRevision++; this.contentEl.classList.add("is-busy");
    this.contentEl.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>("button,input,select").forEach((el) => el.disabled = true);
    try { await run(); } catch (error) { this.report(error); }
    finally { this.busy = false; if (!this.closed) await this.render().catch((error) => this.report(error)); }
  }
  private async importDevice(files: File[]): Promise<void> {
    const group = this.groupId === "*" ? "" : this.groupId;
    await this.operation(async () => { const errors = await this.store.importFiles(files, group); if (errors.length) this.report(errors.join("\n")); });
  }
  private async render(): Promise<void> {
    const revision = ++this.renderRevision;
    const library = await this.store.read(); if (this.closed || this.busy || revision !== this.renderRevision) return;
    const existing = new Set(library.assets.map((asset) => asset.id));
    for (const id of this.selected) if (!existing.has(id)) this.selected.delete(id);
    if (this.groupId && this.groupId !== "*" && !library.groups.some((group) => group.id === this.groupId)) this.groupId = "*";
    const el = this.contentEl; el.empty(); el.classList.remove("is-busy");
    const tools = el.createDiv({ cls: "ink-image-library-tools" });
    const filter = tools.createEl("select", { attr: { "aria-label": "Image group" } });
    for (const g of [{ id: "*", name: "All images" }, { id: "", name: "Ungrouped" }, ...library.groups]) filter.createEl("option", { text: g.name, value: g.id });
    filter.value = this.groupId; filter.onchange = () => { this.groupId = filter.value; void this.render().catch((e) => this.report(e)); };
    const search = tools.createEl("input", { type: "search", placeholder: "Search images", attr: { "aria-label": "Search images" } }); search.value = this.query;
    search.onchange = () => { this.query = search.value; void this.render().catch((e) => this.report(e)); };
    button(tools, "New group", () => this.groupDialog());
    if (this.groupId && this.groupId !== "*") button(tools, "Rename group", () => this.groupDialog(this.groupId, library.groups.find((g) => g.id === this.groupId)?.name));
    const imports = el.createDiv({ cls: "ink-image-library-tools" });
    const picker = imports.createEl("input", { type: "file", attr: { multiple: "", accept: "image/*", "aria-label": "Import photos or files" } }); picker.hidden = true;
    picker.onchange = () => { void this.importDevice(Array.from(picker.files ?? [])); };
    button(imports, "Photos / files", () => picker.click());
    button(imports, "From vault", () => this.vaultDialog());
    button(imports, "Enter vault paths", () => this.pathDialog());
    el.createEl("p", { text: "Choose multiple images, drop files here, or paste copied images. Imports are saved as PNG copies (up to 30 MB / 16 MP each). Animated images use their first frame." });
    const assets = library.assets.filter((a) => (this.groupId === "*" || a.groupId === this.groupId) && a.name.toLowerCase().includes(this.query.toLowerCase()));
    const bar = el.createDiv({ cls: "ink-image-library-tools" });
    button(bar, "Select visible", () => { assets.forEach((a) => this.selected.add(a.id)); void this.render().catch((e) => this.report(e)); });
    const clear = button(bar, "Clear selection", () => { this.selected.clear(); void this.render().catch((e) => this.report(e)); });
    const move = bar.createEl("select", { attr: { "aria-label": "Move selected images to group" } });
    move.createEl("option", { text: "Move selected to…", value: "*" });
    for (const g of [{ id: "", name: "Ungrouped" }, ...library.groups]) move.createEl("option", { text: g.name, value: g.id });
    move.onchange = () => { if (move.value !== "*") void this.operation(() => this.store.move([...this.selected], move.value)); };
    const remove = button(bar, "Delete selected", () => this.deleteDialog(library.assets.filter((asset) => this.selected.has(asset.id))));
    remove.addClass("mod-warning");
    const count = el.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
    if (this.lastDeleted.length) {
      button(bar, `Undo last deletion (${this.lastDeleted.length})`, () => { void this.operation(async () => {
        await this.store.restore(this.lastDeleted); this.lastDeleted = [];
        new Notice("Image library deletion undone");
      }); });
      el.createEl("p", { text: "Undo is available for the last deletion until this library closes or another deletion replaces it." });
    }
    const grid = el.createDiv({ cls: "ink-image-library-grid" });
    for (const asset of assets) {
      const card = grid.createEl("label", { cls: "ink-image-library-card" });
      const check = card.createEl("input", { type: "checkbox" }); check.checked = this.selected.has(asset.id);
      check.onchange = () => { if (check.checked) this.selected.add(asset.id); else this.selected.delete(asset.id); updateActions(); };
      try { card.createEl("img", { attr: { src: this.store.url(asset.path), alt: asset.name, loading: "lazy" } }); }
      catch { card.createSpan({ text: "Missing image" }); }
      card.createSpan({ text: asset.name });
    }
    if (!assets.length) grid.createEl("p", { text: "No images yet. Import photos or files to begin." });
    const insert = button(el, "Insert selected", () => { this.insert(library.assets.filter((a) => this.selected.has(a.id))); this.close(); });
    const updateActions = () => {
      const size = this.selected.size, hidden = size - assets.filter((asset) => this.selected.has(asset.id)).length;
      count.textContent = `${size} selected${hidden ? ` (${hidden} hidden by filter)` : ""}`;
      insert.textContent = `Insert selected (${size})`; insert.disabled = !size;
      remove.textContent = `Delete selected (${size})`; remove.disabled = !size;
      move.disabled = !size; clear.disabled = !size;
    };
    updateActions();
  }
  private deleteDialog(assets: ImageAsset[]): void {
    if (!assets.length || this.closed || this.busy || this.deleteConfirmation) return;
    const modal = new Modal(this.app); this.deleteConfirmation = modal;
    modal.setTitle("Delete library images"); modal.modalEl.addClass("ink-image-library-confirm");
    modal.onClose = () => { this.deleteConfirmation = undefined; modal.contentEl.empty(); };
    modal.contentEl.createEl("p", { text: `Remove ${assets.length} selected images from the library, including selections hidden by the current filter?` });
    const list = modal.contentEl.createEl("ul");
    assets.slice(0, 10).forEach((asset) => list.createEl("li", { text: asset.name }));
    if (assets.length > 10) list.createEl("li", { text: `And ${assets.length - 10} more…` });
    modal.contentEl.createEl("p", { text: "Images already placed in notes stay intact. Image files are kept, so this does not free disk space. You can undo the last deletion while the library stays open." });
    const actions = modal.contentEl.createDiv({ cls: "ink-image-library-tools" });
    const cancel = button(actions, "Cancel", () => modal.close());
    const confirm = button(actions, `Delete ${assets.length} images`, () => {
      if (this.closed || this.busy) return;
      confirm.disabled = true; cancel.disabled = true;
      void this.operation(async () => {
        const removed = await this.store.remove(assets.map((asset) => asset.id));
        if (removed.length) this.lastDeleted = removed;
        assets.forEach((asset) => this.selected.delete(asset.id));
        modal.close(); new Notice(`Removed ${removed.length} images from the library`);
      }).finally(() => { confirm.disabled = false; cancel.disabled = false; });
    });
    confirm.addClass("mod-warning"); modal.open(); cancel.focus();
  }
  private groupDialog(id?: string, name = ""): void {
    const modal = new Modal(this.app); modal.setTitle(id ? "Rename group" : "New group");
    const input = modal.contentEl.createEl("input", { value: name, attr: { "aria-label": "Group name" } });
    button(modal.contentEl, "Save", () => { void this.operation(async () => { await this.store.group(input.value, id); modal.close(); }); }); modal.open(); input.focus();
  }
  private pathDialog(): void {
    const modal = new Modal(this.app); modal.setTitle("Import vault paths");
    const input = modal.contentEl.createEl("textarea", { placeholder: "One image path per line", attr: { "aria-label": "Image paths" } });
    button(modal.contentEl, "Import all", () => { const paths = input.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean); const group = this.groupId === "*" ? "" : this.groupId;
      void this.operation(async () => { const errors = await this.store.importVault(paths, group); modal.close(); if (errors.length) this.report(errors.join("\n")); }); }); modal.open();
  }
  private vaultDialog(): void {
    const modal = new Modal(this.app); modal.setTitle("Import images from vault"); const paths = new Set<string>();
    const list = modal.contentEl.createDiv({ cls: "ink-image-vault-list" });
    for (const file of this.store.vaultImages()) {
      const label = list.createEl("label"); const check = label.createEl("input", { type: "checkbox" }); label.createSpan({ text: file.path });
      check.onchange = () => { if (check.checked) paths.add(file.path); else paths.delete(file.path); };
    }
    button(modal.contentEl, "Select all", () => { list.querySelectorAll<HTMLInputElement>("input").forEach((i) => i.checked = true); this.store.vaultImages().forEach((f) => paths.add(f.path)); });
    button(modal.contentEl, "Import selected", () => { const group = this.groupId === "*" ? "" : this.groupId;
      void this.operation(async () => { const errors = await this.store.importVault([...paths], group); modal.close(); if (errors.length) this.report(errors.join("\n")); }); }); modal.open();
  }
}
