import { App, TAbstractFile, TFile, Vault } from "obsidian";
import { InkNotebook, createNotebook, mergeNotebooks, normalizeNotebook } from "./model";
import { parseStoredJson, serializeStoredJson } from "./storage-codec";

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

  async create(title: string, folder?: string): Promise<TFile> {
    const parent = this.resolveFolder(folder);
    await this.ensureFolder(parent);
    const safeTitle = title.trim().replace(/[\\/:*?"<>|#^\[\]]/g, "-").slice(0, 80) || "Ink Notebook";
    let path = `${parent}/${safeTitle}.${INK_EXTENSION}`;
    let count = 2;
    while (this.vault.getAbstractFileByPath(path)) path = `${parent}/${safeTitle} ${count++}.${INK_EXTENSION}`;
    const notebook = createNotebook(safeTitle);
    return this.vault.create(path, serialize(notebook));
  }

  async read(file: TFile): Promise<InkNotebook> {
    const raw = await this.readRaw(file);
    return normalizeNotebook(parseStoredJson(raw));
  }

  async readRaw(file: TFile): Promise<string> {
    return this.vault.read(file);
  }

  async writeIfUnchanged(file: TFile, expectedRaw: string, nextRaw: string): Promise<boolean> {
    let matched = false;
    try {
      await this.vault.process(file, (raw) => {
        if (raw !== expectedRaw) return raw;
        matched = true;
        this.selfWrites.set(file.path, nextRaw);
        return nextRaw;
      });
    } catch (error) {
      if (this.selfWrites.get(file.path) === nextRaw) this.selfWrites.delete(file.path);
      throw error;
    }
    return matched;
  }

  async save(file: TFile, notebook: InkNotebook): Promise<InkNotebook> {
    const next = { ...notebook, updatedAt: Date.now() };
    let merged = next;
    let expectedWrite: string | null = null;
    try {
      await this.vault.process(file, (raw) => {
        let latest: InkNotebook;
        try {
          latest = normalizeNotebook(parseStoredJson(raw));
        } catch (error) {
          throw new NotebookFormatError(`Cannot save ${file.path || "notebook"}: existing file is corrupt or uses an unsupported encoding`);
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

  /** Full-vault scan: every .ink file is a notebook regardless of folder, so
   *  notebooks moved out of the default folder stay discoverable. The scan
   *  reads vault.getFiles() — Obsidian's incrementally maintained in-memory
   *  index — so one filter pass per picker open costs no disk I/O and needs no
   *  second cache that could go stale. */
  async list(): Promise<TFile[]> {
    return this.vault.getFiles().filter((file) => file.extension === INK_EXTENSION);
  }

  observe(onChange: (file: TFile) => void): () => void {
    const timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
    const handler = (file: TAbstractFile) => {
      if (!(file instanceof TFile) || file.extension !== INK_EXTENSION) return;
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

  /** Custom creation folders follow Obsidian's forward-slash path semantics:
   *  backslashes and duplicated slashes are normalized away, and reserved
   *  filename characters are cleaned exactly like notebook titles so a pasted
   *  path can never produce an invalid folder name. An empty result falls back
   *  to the default folder for zero-perception compatibility. */
  private resolveFolder(folder?: string): string {
    const cleaned = (folder ?? "").trim().replace(/\\/g, "/").replace(/\/+/g, "/")
      .split("/").map((segment) => segment.trim().replace(/[:*?"<>|#^\[\]]/g, "-"))
      .filter((segment) => segment && segment !== "." && segment !== "..")
      .join("/");
    return cleaned || INK_FOLDER;
  }

  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const segment of path.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.vault.getAbstractFileByPath(current);
      if (existing) {
        if (existing instanceof TFile) throw new Error(`Cannot create notebook folder: a file already exists at ${current}`);
        continue;
      }
      await this.vault.createFolder(current);
    }
  }
}

export interface NotebookHistoryEntry {
  path: string;
  title: string;
  lastOpened: number;
}

/** Bounds the remembered notebooks so the plugin data document stays small
 *  even after years of opens; the least recently opened entries fall out
 *  first and remain discoverable through the vault scan while they exist. */
const MAX_HISTORY_ENTRIES = 200;

/** Remembers opened notebooks (path, title, last opened time) so the picker
 *  can still offer a notebook after it moves anywhere in the vault. Entries
 *  are only removed by explicit user action, never automatically. */
export class NotebookHistoryIndex {
  private entries = new Map<string, NotebookHistoryEntry>();

  constructor(saved?: unknown) {
    if (!Array.isArray(saved)) return;
    for (const item of saved) {
      const entry = NotebookHistoryIndex.coerce(item);
      if (!entry) continue;
      const previous = this.entries.get(entry.path);
      if (!previous || previous.lastOpened < entry.lastOpened) this.entries.set(entry.path, entry);
    }
    this.trim();
  }

  record(path: string, title: string, openedAt = Date.now()): void {
    if (!path) return;
    this.entries.set(path, { path, title, lastOpened: openedAt });
    this.trim();
  }

  remove(path: string): void {
    this.entries.delete(path);
  }

  /** Manual bulk cleanup for entries whose files no longer exist: drops every
   *  remembered path that is not among the given existing paths. */
  removeMissing(existingPaths: ReadonlySet<string>): number {
    let removed = 0;
    for (const path of [...this.entries.keys()]) {
      if (!existingPaths.has(path)) { this.entries.delete(path); removed++; }
    }
    return removed;
  }

  list(): NotebookHistoryEntry[] {
    return [...this.entries.values()].sort((left, right) => right.lastOpened - left.lastOpened || left.path.localeCompare(right.path));
  }

  private trim(): void {
    while (this.entries.size > MAX_HISTORY_ENTRIES) {
      let oldest: string | null = null;
      for (const [path, entry] of this.entries) {
        if (oldest === null || entry.lastOpened < this.entries.get(oldest)!.lastOpened) oldest = path;
      }
      if (oldest === null) break;
      this.entries.delete(oldest);
    }
  }

  /** Field-level load: one malformed value is skipped instead of taking the
   *  whole history down with it. */
  private static coerce(item: unknown): NotebookHistoryEntry | null {
    if (typeof item !== "object" || item === null) return null;
    const path = (item as { path?: unknown }).path;
    if (typeof path !== "string" || !path) return null;
    const title = (item as { title?: unknown }).title;
    const lastOpened = (item as { lastOpened?: unknown }).lastOpened;
    return {
      path,
      title: typeof title === "string" && title ? title : path.slice(path.lastIndexOf("/") + 1),
      lastOpened: typeof lastOpened === "number" && Number.isFinite(lastOpened) ? lastOpened : 0,
    };
  }
}

/** One searchable notebook: the vault file when it still exists, or a
 *  history-only memory whose file has gone missing. */
export interface NotebookDiscovery {
  path: string;
  title: string;
  lastOpened?: number;
  file: TFile | null;
}

/** Merges the full-vault .ink scan with the remembered history: one entry per
 *  path, existing files first (most recently opened first), then history
 *  entries whose file has gone missing. */
export function discoverNotebooks(files: TFile[], history: NotebookHistoryEntry[]): NotebookDiscovery[] {
  const remembered = new Map(history.map((entry) => [entry.path, entry]));
  const merged = new Map<string, NotebookDiscovery>();
  for (const file of files) {
    merged.set(file.path, { path: file.path, title: file.basename, lastOpened: remembered.get(file.path)?.lastOpened, file });
  }
  for (const entry of remembered.values()) {
    if (!merged.has(entry.path)) merged.set(entry.path, { path: entry.path, title: entry.title, lastOpened: entry.lastOpened, file: null });
  }
  return [...merged.values()].sort((left, right) =>
    (left.file ? 0 : 1) - (right.file ? 0 : 1)
    || (right.lastOpened ?? 0) - (left.lastOpened ?? 0)
    || left.path.localeCompare(right.path));
}

function serialize(notebook: InkNotebook): string {
  return serializeStoredJson(notebook);
}
