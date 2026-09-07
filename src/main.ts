import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { InkView, VIEW_TYPE_INK } from "./view";
import { INK_EXTENSION, NotebookStore } from "./storage";

export default class InkNotesPlugin extends Plugin {
  private store!: NotebookStore;
  async onload(): Promise<void> {
    this.store = new NotebookStore(this.app);
    this.registerView(VIEW_TYPE_INK, (leaf) => this.createView(leaf));
    this.registerExtensions([INK_EXTENSION], VIEW_TYPE_INK);
    this.addRibbonIcon("pen-line", "Open Ink Notes", () => void this.openNotebook());
    this.addCommand({ id: "open-ink-notebook", name: "Open Ink Notebook", callback: () => void this.openNotebook() });
    this.addCommand({ id: "create-ink-notebook", name: "Create Ink Notebook", callback: () => void this.createNotebook() });
    this.registerInterval(window.setInterval(() => void this.refreshViews(), 2500));
  }

  private createView(leaf: WorkspaceLeaf): InkView {
    return new InkView(leaf, this.store);
  }

  private async openNotebook(): Promise<void> {
    const files = await this.store.list();
    if (files.length === 0) { await this.createNotebook(); return; }
    await this.openFile(files[0]);
  }

  private async createNotebook(): Promise<void> {
    const file = await this.store.create("Ink Notebook");
    await this.openFile(file);
  }

  private async openFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  private async refreshViews(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      if (leaf.view instanceof InkView) await leaf.view.reloadFromDisk();
    }
  }
}
