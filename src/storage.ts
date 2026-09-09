import { App, TAbstractFile, TFile, Vault } from "obsidian";
import { InkNotebook, createNotebook, mergeNotebooks, normalizeNotebook } from "./model";

export const INK_EXTENSION = "ink";
export const INK_FOLDER = "Ink Notes";
export class NotebookFormatError extends Error {
  constructor(message = "Ink notebook contains invalid JSON") {
    super(message);
    this.name = "NotebookFormatError";
  }
}

export class NotebookStore {
  private readonly vault: Vault;
  private readonly app: App;
  private readonly selfWrites = new Map<string, string>();

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
    let expectedWrite: string | null = null;
    try {
      await this.vault.process(file, (raw) => {
        let latest: InkNotebook;
        try {
          latest = normalizeNotebook(JSON.parse(raw));
        } catch (error) {
          throw new NotebookFormatError(`Cannot save ${file.path || "notebook"}: existing file is not valid JSON`);
        }
        merged = mergeNotebooks(latest, next);
        expectedWrite = serialize(merged);
        this.selfWrites.set(file.path, expectedWrite);
        return expectedWrite;
      });
    } catch (error) {
      if (expectedWrite !== null && this.selfWrites.get(file.path) === expectedWrite) this.selfWrites.delete(file.path);
      throw error;
    }
    return merged;
  }

  async list(): Promise<TFile[]> {
    return this.vault.getFiles().filter((file) => file.extension === INK_EXTENSION && file.path.startsWith(`${INK_FOLDER}/`));
  }

  observe(onChange: (file: TFile) => void): () => void {
    const timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
    const handler = (file: TAbstractFile) => {
      if (!(file instanceof TFile) || file.extension !== INK_EXTENSION || !file.path.startsWith(`${INK_FOLDER}/`)) return;
      const expected = this.selfWrites.get(file.path);
      const notify = () => {
        timers.delete(file.path);
        onChange(file);
      };
      const existing = timers.get(file.path);
      if (existing !== undefined) globalThis.clearTimeout(existing);
      if (!expected) {
        timers.set(file.path, globalThis.setTimeout(notify, 75));
        return;
      }
      void this.vault.cachedRead(file).then((raw) => {
        if (this.selfWrites.get(file.path) === expected) this.selfWrites.delete(file.path);
        if (raw !== expected) timers.set(file.path, globalThis.setTimeout(notify, 75));
      }).catch(() => {
        this.selfWrites.delete(file.path);
        timers.set(file.path, globalThis.setTimeout(notify, 75));
      });
    };
    const ref = this.vault.on("modify", handler);
    return () => {
      for (const timer of timers.values()) globalThis.clearTimeout(timer);
      timers.clear();
      this.vault.offref(ref);
    };
  }

  private async ensureFolder(): Promise<void> {
    if (!this.vault.getAbstractFileByPath(INK_FOLDER)) await this.vault.createFolder(INK_FOLDER);
  }
}

function serialize(notebook: InkNotebook): string {
  return `${JSON.stringify(notebook, null, 2)}\n`;
}
