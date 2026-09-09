import { App, MarkdownPostProcessorContext, MarkdownRenderChild, TFile, setIcon } from "obsidian";
import { InkNotebook, InkPage, normalizeNotebook } from "./model";
import { drawInkStroke } from "./rendering";
import { InkEmbedSpec, parseInkEmbed } from "./embed-spec";
export { parseInkEmbed } from "./embed-spec";

export function createInkEmbedProcessor(app: App, open: (file: TFile, pageId?: string) => Promise<void>) {
  return (source: string, el: HTMLElement, context: MarkdownPostProcessorContext): void => {
    let spec: InkEmbedSpec;
    try { spec = parseInkEmbed(source); }
    catch (error) { renderError(el, error); return; }
    context.addChild(new InkEmbedChild(app, el, spec, open));
  };
}

class InkEmbedChild extends MarkdownRenderChild {
  private renderRevision = 0;
  constructor(
    private readonly app: App,
    container: HTMLElement,
    private readonly spec: InkEmbedSpec,
    private readonly open: (file: TFile, pageId?: string) => Promise<void>,
  ) { super(container); }

  onload(): void {
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.path === this.spec.path) void this.render().catch((error) => renderError(this.containerEl, error));
    }));
    void this.render().catch((error) => renderError(this.containerEl, error));
  }

  private async render(): Promise<void> {
    const revision = ++this.renderRevision;
    const el = this.containerEl;
    el.empty();
    el.addClass("ink-embed");
    const file = this.app.vault.getAbstractFileByPath(this.spec.path);
    if (!(file instanceof TFile)) { renderError(el, new Error(`Ink notebook not found: ${this.spec.path}`)); return; }
    let notebook: InkNotebook;
    try { notebook = normalizeNotebook(JSON.parse(await this.app.vault.cachedRead(file))); }
    catch { renderError(el, new Error(`Ink notebook is damaged: ${this.spec.path}`)); return; }
    if (revision !== this.renderRevision) return;
    const page = this.spec.pageId ? notebook.pages.find((candidate) => candidate.id === this.spec.pageId) : notebook.pages[0];
    if (!page) { renderError(el, new Error(`Ink page not found: ${this.spec.pageId ?? "first page"}`)); return; }
    const frame = el.createDiv({ cls: `ink-embed-page ink-paper-${page.paper}` });
    frame.style.aspectRatio = `${notebook.pageWidth} / ${notebook.pageHeight}`;
    const canvas = frame.createEl("canvas", { attr: { "aria-label": `Ink preview: ${page.title}` } });
    drawPage(canvas, notebook, page);
    const button = el.createEl("button", { cls: "ink-embed-open", attr: { type: "button", "aria-label": "Open Ink notebook" } });
    setIcon(button, "external-link");
    button.createSpan({ text: "Open notebook" });
    button.addEventListener("click", () => void this.open(file, page.id));
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
