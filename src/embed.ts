import { App, MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile, setIcon } from "obsidian";
import { InkNotebook, InkPage, normalizeNotebook } from "./model";
import { drawInkStroke } from "./rendering";
import { InkEmbedSpec, parseInkEmbed } from "./embed-spec";
import { ImageLibraryStore } from "./image-library";
import { paintPageStickies } from "./sticky-rendering";
export { parseInkEmbed } from "./embed-spec";

export function createInkEmbedProcessor(app: App, open: (file: TFile, pageId?: string) => Promise<void>, images?: ImageLibraryStore) {
  return (source: string, el: HTMLElement, context: MarkdownPostProcessorContext): void => {
    let spec: InkEmbedSpec;
    try { spec = parseInkEmbed(source); }
    catch (error) { renderError(el, error); return; }
    context.addChild(new InkEmbedChild(app, el, spec, open, images));
  };
}

class InkEmbedChild extends MarkdownRenderChild {
  private renderRevision = 0;
  private unloaded = false;
  constructor(
    private readonly app: App,
    container: HTMLElement,
    private readonly spec: InkEmbedSpec,
    private readonly open: (file: TFile, pageId?: string) => Promise<void>,
    private readonly images?: ImageLibraryStore,
  ) { super(container); }

  onload(): void {
    this.unloaded = false;
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.path === this.spec.path) this.requestRender();
    }));
    this.requestRender();
  }

  onunload(): void {
    this.unloaded = true;
    this.renderRevision += 1;
  }

  private requestRender(): void {
    const revision = ++this.renderRevision;
    void this.render(revision).catch((error) => this.renderError(revision, error));
  }

  private async render(revision: number): Promise<void> {
    const el = this.containerEl;
    el.addClass("ink-embed");
    const file = this.app.vault.getAbstractFileByPath(this.spec.path);
    if (!(file instanceof TFile)) { this.renderError(revision, new Error(`Ink notebook not found: ${this.spec.path}`)); return; }
    let notebook: InkNotebook;
    try { notebook = normalizeNotebook(JSON.parse(await this.app.vault.cachedRead(file))); }
    catch { this.renderError(revision, new Error(`Ink notebook is damaged: ${this.spec.path}`)); return; }
    if (!this.isCurrent(revision)) return;
    const page = this.spec.pageId ? notebook.pages.find((candidate) => candidate.id === this.spec.pageId) : notebook.pages[0];
    if (!page) { this.renderError(revision, new Error(`Ink page not found: ${this.spec.pageId ?? "first page"}`)); return; }
    const next = document.createElement("div");
    const frame = next.createDiv({ cls: `ink-embed-page ink-paper-${page.paper}` });
    frame.style.aspectRatio = `${notebook.pageWidth} / ${notebook.pageHeight}`;
    const canvas = frame.createEl("canvas", { attr: { "aria-label": `Ink preview: ${page.title}` } });
    drawPage(canvas, notebook, page);
    for (const image of page.images ?? []) {
      const img = frame.createEl("img", { cls: "ink-embed-image", attr: { alt: "Inserted image" } });
      try { img.src = (this.images ?? new ImageLibraryStore(this.app)).url(image.assetPath); } catch { img.alt = "Missing image"; }
      img.style.left = `${image.x * 100}%`; img.style.top = `${image.y * 100}%`;
      img.style.width = `${image.width * 100}%`; img.style.height = `${image.height * 100}%`;
      img.style.zIndex = image.foreground ? "2" : "0";
    }
    if (page.stickyNotes?.length) {
      const overlay = frame.createEl("canvas", { cls: "ink-embed-stickies" });
      overlay.width = canvas.width; overlay.height = canvas.height;
      const ctx = overlay.getContext("2d"); if (ctx) {
        const scale = overlay.width / notebook.pageWidth; ctx.scale(scale, scale);
        paintPageStickies(ctx, page.stickyNotes, notebook.pageWidth, notebook.pageHeight);
      }
    }
    const button = next.createEl("button", { cls: "ink-embed-open", attr: { type: "button", "aria-label": "Open Ink notebook" } });
    setIcon(button, "external-link");
    button.createSpan({ text: "Open notebook" });
    button.addEventListener("click", () => {
      void this.open(file, page.id).catch((error) => new Notice(`Ink Notes could not open ${file.path}: ${error instanceof Error ? error.message : String(error)}`));
    });
    if (!this.isCurrent(revision)) return;
    el.replaceChildren(...Array.from(next.childNodes));
  }

  private isCurrent(revision: number): boolean {
    return !this.unloaded && revision === this.renderRevision;
  }

  private renderError(revision: number, error: unknown): void {
    if (this.isCurrent(revision)) renderError(this.containerEl, error);
  }
}

function drawPage(canvas: HTMLCanvasElement, notebook: InkNotebook, page: InkPage): void {
  const width = Math.min(1200, notebook.pageWidth);
  const height = Math.round(width * notebook.pageHeight / notebook.pageWidth);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  for (const stroke of page.strokes) drawInkStroke(ctx, stroke, width, height);
}

function renderError(el: HTMLElement, error: unknown): void {
  el.empty();
  el.createDiv({ cls: "ink-embed-error", text: error instanceof Error ? error.message : String(error) });
}
