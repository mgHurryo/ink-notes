import { Notice, Plugin, SuggestModal, TFile, WorkspaceLeaf } from "obsidian";
import { InkView, VIEW_TYPE_INK } from "./view";
import { INK_EXTENSION, NotebookStore } from "./storage";
import { createInkEmbedProcessor } from "./embed";

export default class InkNotesPlugin extends Plugin {
  private store!: NotebookStore;
  private refreshTimers = new Map<string, number>();
  private refreshing = new Set<string>();
  private pendingRefresh = new Set<string>();
  async onload(): Promise<void> {
    this.store = new NotebookStore(this.app);
    this.registerView(VIEW_TYPE_INK, (leaf) => this.createView(leaf));
    this.registerExtensions([INK_EXTENSION], VIEW_TYPE_INK);
    this.addRibbonIcon("pen-line", "Open Ink Notes", () => this.runAsync(this.openNotebook(), "open a notebook"));
    this.addCommand({ id: "open-ink-notebook", name: "Open Ink Notebook", callback: () => this.runAsync(this.openNotebook(), "open a notebook") });
    this.addCommand({ id: "create-ink-notebook", name: "Create Ink Notebook", callback: () => this.runAsync(this.createNotebook(), "create a notebook") });
    this.registerMarkdownCodeBlockProcessor("ink", createInkEmbedProcessor(this.app, (file, pageId) => this.openFile(file, pageId)));
    this.register(this.store.observe((file) => this.queueRefresh(file)));
    this.register(() => {
      for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
      this.refreshTimers.clear();
    });
  }

  private createView(leaf: WorkspaceLeaf): InkView {
    return new InkView(leaf, this.store);
  }

  private async openNotebook(): Promise<void> {
    const files = await this.store.list();
    if (files.length === 0) { await this.createNotebook(); return; }
    new NotebookSuggestModal(this.app, files, (file) => this.runAsync(this.openFile(file), `open ${file.path}`)).open();
  }

  private async createNotebook(): Promise<void> {
    const file = await this.store.create("Ink Notebook");
    await this.openFile(file);
  }

  private async openFile(file: TFile, pageId?: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    if (pageId && leaf.view instanceof InkView) leaf.view.revealPage(pageId);
  }

  private runAsync(action: Promise<unknown>, operation: string): void {
    void action.catch((error) => new Notice(`Ink Notes could not ${operation}: ${error instanceof Error ? error.message : String(error)}`));
  }

  private queueRefresh(file: TFile): void {
    const existing = this.refreshTimers.get(file.path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.refreshTimers.set(file.path, window.setTimeout(() => {
      this.refreshTimers.delete(file.path);
      void this.refreshFile(file);
    }, 120));
  }

  private async refreshFile(file: TFile): Promise<void> {
    if (this.refreshing.has(file.path)) { this.pendingRefresh.add(file.path); return; }
    this.refreshing.add(file.path);
    try {
      do {
        this.pendingRefresh.delete(file.path);
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
          if (leaf.view instanceof InkView && leaf.view.file?.path === file.path) await leaf.view.reloadFromDisk();
        }
      } while (this.pendingRefresh.has(file.path));
    } catch (error) {
      new Notice(`Ink Notes could not reload ${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.refreshing.delete(file.path);
    }
  }
}

class NotebookSuggestModal extends SuggestModal<TFile> {
  constructor(app: Plugin["app"], private readonly files: TFile[], private readonly select: (file: TFile) => void) { super(app); }
  getSuggestions(query: string): TFile[] {
    const search = query.trim().toLowerCase();
    return this.files.filter((file) => !search || file.path.toLowerCase().includes(search));
  }
  renderSuggestion(file: TFile, el: HTMLElement): void { el.setText(file.path); }
  onChooseSuggestion(file: TFile): void { this.select(file); }
}
