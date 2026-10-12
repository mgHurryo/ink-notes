import { App, Modal, Notice, TFile } from "obsidian";
import { normalizeNotebook } from "./model";
import { normalizeSidecar, PDF_INK_FOLDER, PDF_SIDECAR_EXTENSION } from "./pdf-sidecar";
import { cloneSticky, StickyNote, stickyText } from "./sticky-model";
import { parseStoredJson } from "./storage-codec";

export interface StickySearchEntry { file: string; pageId: string; pageTitle: string; note: StickyNote; handwritingTerms?: string[]; }
/** Optional local/remote recognition adapter. Nothing is transmitted by default.
 * Return searchable terms, not modified notes. Respect cancellation; errors leave basic search available. */
export type StickyHandwritingIndexer = (note: Readonly<StickyNote>, signal: AbortSignal) => Promise<string[]>;

export function filterStickyEntries(entries: StickySearchEntry[], query: string): StickySearchEntry[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => {
    const text = [entry.file, entry.pageTitle, entry.note.title, stickyText(entry.note), entry.note.keywords, ...(entry.handwritingTerms ?? [])].join("\n").toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

/** Derive the index from authoritative files on demand; do not maintain another database. */
export async function collectStickyEntries(app: App, signal: AbortSignal): Promise<{ entries: StickySearchEntry[]; errors: string[] }> {
  const entries: StickySearchEntry[] = [], errors: string[] = [];
  for (const file of app.vault.getFiles()) {
    if (signal.aborted) break;
    const pdf = file.parent?.path === PDF_INK_FOLDER && file.name.endsWith(`.${PDF_SIDECAR_EXTENSION}`);
    if (file.extension !== "ink" && !pdf) continue;
    try {
      const raw = parseStoredJson(await app.vault.read(file));
      if (signal.aborted) break;
      const sidecar = pdf ? normalizeSidecar(raw) : undefined;
      if (!sidecar && (raw.schema !== 2 || !Array.isArray(raw.pages))) throw new Error("Invalid notebook format");
      const notebook = sidecar?.notebook ?? normalizeNotebook(raw), path = sidecar?.source.path ?? file.path;
      if (sidecar && !(app.vault.getAbstractFileByPath(path) instanceof TFile)) continue;
      for (const page of notebook.pages) for (const note of page.stickyNotes ?? []) entries.push({ file: path, pageId: page.id, pageTitle: page.title, note: cloneSticky(note) });
    } catch (error) { errors.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { entries, errors };
}

export class StickySearchModal extends Modal {
  private events = new AbortController();
  private entries: StickySearchEntry[] = [];
  constructor(app: App, private openNote: (entry: StickySearchEntry) => Promise<void>, private live: () => { files: string[]; entries: StickySearchEntry[] }, private handwriting?: StickyHandwritingIndexer) { super(app); }
  onOpen(): void {
    this.setTitle("Find sticky notes"); this.modalEl.addClass("ink-sticky-search");
    const search = this.contentEl.createEl("input", { type: "search", attr: { "aria-label": "Search sticky notes", placeholder: "Title, text or keywords" } });
    const status = this.contentEl.createEl("p", { attr: { role: "status" }, text: "Reading notebook index…" });
    const list = this.contentEl.createDiv({ cls: "ink-sticky-results" });
    const render = () => {
      list.empty(); const matches = filterStickyEntries(this.entries, search.value);
      status.textContent = `${matches.length} sticky notes`;
      for (const entry of matches) {
        const button = list.createEl("button", { text: `${entry.note.title || "Sticky note"} — ${entry.file} / ${entry.pageTitle}`, attr: { type: "button" } });
        button.onclick = () => { void this.openNote(entry).then(() => this.close()).catch((error) => new Notice(`Could not locate sticky note: ${String(error)}`)); };
        list.createEl("p", { text: (stickyText(entry.note) || entry.note.keywords || "Handwriting (add keywords to find it)").slice(0, 180) });
      }
    };
    search.oninput = render; search.focus();
    void (async () => {
      const { entries, errors } = await collectStickyEntries(this.app, this.events.signal);
      if (this.events.signal.aborted) return;
      const live = this.live(), paths = new Set(live.files);
      this.entries = [...entries.filter((entry) => !paths.has(entry.file)), ...live.entries]; render();
      if (errors.length) new Notice(`Sticky index skipped ${errors.length} unreadable files: ${errors.join("\n")}`, 8000);
      if (!this.handwriting) return;
      for (const entry of this.entries) {
        if (this.events.signal.aborted) break;
        if (!entry.note.strokes.length) continue;
        const controller = new AbortController();
        const abort = () => controller.abort(); this.events.signal.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const terms = await Promise.race([this.handwriting(cloneSticky(entry.note), controller.signal), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("Handwriting index timed out")); }, 5000);
            controller.signal.addEventListener("abort", () => reject(new Error("Handwriting index cancelled")), { once: true });
          })]);
          if (this.events.signal.aborted) break;
          entry.handwritingTerms = Array.isArray(terms) ? terms.filter((term) => typeof term === "string").slice(0, 1000) : []; render();
        } catch (error) { if (!this.events.signal.aborted) { new Notice(`Handwriting index unavailable: ${String(error)}`); break; } }
        finally { clearTimeout(timer); controller.abort(); this.events.signal.removeEventListener("abort", abort); }
      }
    })().catch((error) => { if (!this.events.signal.aborted) { status.textContent = "Could not read sticky index"; new Notice(String(error)); } });
  }
  onClose(): void { this.events.abort(); this.contentEl.empty(); }
}
