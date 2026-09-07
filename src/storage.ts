import { App, TAbstractFile, TFile, Vault } from "obsidian";
import { InkNotebook, createNotebook, mergeNotebooks, normalizeNotebook } from "./model";

export const INK_EXTENSION = "ink";
export const INK_FOLDER = "Ink Notes";

export class NotebookStore {
  private readonly vault: Vault;
  private readonly app: App;

  constructor(app: App) {
    this.app = app;
    this.vault = app.vault;
  }

  async create(title: string): Promise<TFile> {
    await this.ensureFolder();
    const safeTitle = title.trim().replace(/[\\/:*?"<>|#^\[\]]/g, "-").slice(0, 80) || "Ink Notebook";
    let path = `${INK_FOLDER}/${safeTitle}.${INK_EXTENSION}`;
    let count = 2;
    while (this.vault.getAbstractFileByPath(path)) path = `${INK_FOLDER}/${safeTitle} ${count++}.${INK_EXTENSION}`;
    const notebook = createNotebook(safeTitle);
    return this.vault.create(path, serialize(notebook));
  }

  async read(file: TFile): Promise<InkNotebook> {
    const raw = await this.vault.read(file);
    return normalizeNotebook(JSON.parse(raw));
  }

  async save(file: TFile, notebook: InkNotebook): Promise<InkNotebook> {
    const next = { ...notebook, updatedAt: Date.now() };
    let merged = next;
    await this.vault.process(file, (raw) => {
      let latest: InkNotebook;
      try {
        latest = normalizeNotebook(JSON.parse(raw));
      } catch {
        latest = createNotebook(next.title);
      }
      merged = mergeNotebooks(latest, next);
      return serialize(merged);
    });
    return merged;
  }

  async list(): Promise<TFile[]> {
    return this.vault.getFiles().filter((file) => file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`));
  }

  observe(onChange: (file: TFile) => void): () => void {
    const handler = (file: TAbstractFile) => {
      if (file instanceof TFile && file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`)) onChange(file);
    };
    const ref = this.vault.on("modify", handler);
    return () => this.vault.offref(ref);
  }

  private async ensureFolder(): Promise<void> {
    if (!this.vault.getAbstractFileByPath(INK_FOLDER)) await this.vault.createFolder(INK_FOLDER);
  }
}

function serialize(notebook: InkNotebook): string {
  return `${JSON.stringify(notebook, null, 2)}\n`;
}
