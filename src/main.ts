import { Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { NotebookSuggestModal } from "./notebook-modal";
import { InkView, VIEW_TYPE_INK } from "./view";
import { INK_EXTENSION, NotebookHistoryIndex, NotebookStore, discoverNotebooks, type NotebookDiscovery } from "./storage";
import { createInkEmbedProcessor } from "./embed";
import { InkWorkerService } from "./worker-service";
import { PdfInkView, VIEW_TYPE_PDF_INK } from "./pdf-view";
import { PdfSidecarStore } from "./pdf-store";
import { PDF_INK_FOLDER, PDF_SIDECAR_EXTENSION } from "./pdf-sidecar";
import { PDF_VIEW_ENHANCER_PLUGIN_IDS, PdfTabTakeover } from "./pdf-takeover";
import { sanitizeToolState, storedToolState, ToolStateSaver, type SharedToolState, type StoredToolState } from "./tool-state";
import type { ToolState } from "./ink-writing";
import { InkClipboard } from "./lasso-clipboard";
import { ImageLibraryStore } from "./image-library";
import { StickySearchModal, StickySearchEntry, StickyHandwritingIndexer } from "./sticky-index";

interface InkNotesSettings {
  pdfOpenMode: "native" | "compatible" | "ink";
}

const DEFAULT_SETTINGS: InkNotesSettings = {
  pdfOpenMode: "compatible",
};

export default class InkNotesPlugin extends Plugin {
  private stickyHandwritingIndexer?: StickyHandwritingIndexer;
  /** Optional adapter hook; registration alone never triggers recognition or sends data. */
  setStickyHandwritingIndexer(indexer: StickyHandwritingIndexer | undefined): void { this.stickyHandwritingIndexer = indexer; }
  private liveStickyEntries(): { files: string[]; entries: StickySearchEntry[] } {
    const entries: StickySearchEntry[] = [], files: string[] = [];
    for (const type of [VIEW_TYPE_INK, VIEW_TYPE_PDF_INK]) for (const leaf of this.app.workspace.getLeavesOfType(type)) {
      if (leaf.view instanceof InkView || leaf.view instanceof PdfInkView) { files.push(leaf.view.file?.path ?? ""); entries.push(...leaf.view.stickyIndexEntries()); }
    }
    const byId = new Map<string, StickySearchEntry>();
    for (const entry of entries) {
      const id = `${entry.file}\0${entry.pageId}\0${entry.note.id}`, previous = byId.get(id);
      if (!previous || entry.note.updatedAt > previous.note.updatedAt) byId.set(id, entry);
    }
    return { files, entries: [...byId.values()] };
  }
  private async locateSticky(filePath: string, page: string, sticky: string, block?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || !["pdf", INK_EXTENSION].includes(file.extension.toLowerCase())) throw new Error("Notebook or PDF not found");
    let leaf = [...this.app.workspace.getLeavesOfType(VIEW_TYPE_INK), ...this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_INK)]
      .find((leaf) => (leaf.view instanceof InkView || leaf.view instanceof PdfInkView) && leaf.view.file?.path === file.path);
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      if (file.extension.toLowerCase() === "pdf") await leaf.setViewState({ type: VIEW_TYPE_PDF_INK, state: { file: file.path } });
      else await leaf.openFile(file);
    }
    this.app.workspace.setActiveLeaf(leaf, false, true);
    if (leaf.view instanceof InkView || leaf.view instanceof PdfInkView) {
      if (block) await leaf.view.revealSticky(page, sticky, block);
      else await leaf.view.revealSticky(page, sticky);
    }
    else throw new Error("The handwriting view could not be opened");
  }
  private imageLibrary?: ImageLibraryStore;
  private store!: NotebookStore;
  /** Recently opened notebooks; persisted in the plugin data document so the
   *  picker can offer them even after they leave the default folder. */
  private history = new NotebookHistoryIndex();
  private workers!: InkWorkerService;
  private pdfStore!: PdfSidecarStore;
  private takeover!: PdfTabTakeover;
  config: InkNotesSettings = { ...DEFAULT_SETTINGS };
  /** Tool settings shared by both editors; loaded sanitized in onload and
   *  kept current by the debounced saver. */
  private toolState: ToolState = sanitizeToolState(undefined);
  private toolStateSaver!: ToolStateSaver;
  private toolStateBinding!: SharedToolState;
  private refreshTimers = new Map<string, number>();
  private refreshing = new Set<string>();
  private pendingRefresh = new Set<string>();

  async onload(): Promise<void> {
    // Field-level read: one corrupted value falls back to its default
    // instead of taking the whole configuration down with it.
    const saved = (await this.loadData()) as { pdfOpenMode?: unknown; takeOverPdfTabs?: unknown; toolState?: unknown; notebookHistory?: unknown } | null;
    this.config = {
      pdfOpenMode: saved?.pdfOpenMode === "native" || saved?.pdfOpenMode === "compatible" || saved?.pdfOpenMode === "ink"
        ? saved.pdfOpenMode
        : typeof saved?.takeOverPdfTabs === "boolean"
          ? saved.takeOverPdfTabs ? "ink" : "native"
          : DEFAULT_SETTINGS.pdfOpenMode,
    };
    this.toolState = sanitizeToolState(saved?.toolState);
    this.history = new NotebookHistoryIndex(saved?.notebookHistory);
    this.toolStateSaver = new ToolStateSaver((stored) => this.persistToolState(stored));
    this.toolStateBinding = {
      config: this.toolState,
      scheduleSave: (state) => this.toolStateSaver.schedule(state),
      clipboard: new InkClipboard(),
    };
    this.store = new NotebookStore(this.app);
    if (this.app.vault) this.imageLibrary = new ImageLibraryStore(this.app);
    this.workers = new InkWorkerService((message) => new Notice(message));
    this.register(() => this.workers.dispose());
    this.registerView(VIEW_TYPE_INK, (leaf) => this.createView(leaf));
    this.registerExtensions([INK_EXTENSION], VIEW_TYPE_INK);
    this.configurePdfSupport();
    this.addCommand({ id: "find-sticky-notes", name: "Find sticky notes", callback: () => new StickySearchModal(this.app,
      (entry) => this.locateSticky(entry.file, entry.pageId, entry.note.id), () => this.liveStickyEntries(), this.stickyHandwritingIndexer).open() });
    this.registerObsidianProtocolHandler("ink-notes-sticky", (params) => {
      if (params.vault && params.vault !== this.app.vault.getName()) return;
      if (!params.file || !params.page || !params.sticky) { new Notice("Sticky note link is incomplete"); return; }
      this.runAsync(this.locateSticky(params.file, params.page, params.sticky, params.block), "locate sticky note");
    });
    this.addRibbonIcon("pen-line", "Open Ink Notes", () => this.runAsync(this.openNotebook(), "open a notebook"));
    this.addCommand({ id: "open-ink-notebook", name: "Open Ink Notebook",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "o" }],
      callback: () => this.runAsync(this.openNotebook(), "open a notebook") });
    this.addCommand({ id: "create-ink-notebook", name: "Create Ink Notebook", callback: () => this.runAsync(this.createNotebook(), "create a notebook") });
    this.addCommand({
      id: "toggle-ink-diagnostics",
      name: "Toggle Ink developer diagnostics",
      callback: () => {
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
          if (leaf.view instanceof InkView) leaf.view.toggleDevPanel();
        }
      },
    });
    this.addCommand({
      id: "open-pdf-handwriting",
      name: "Open current PDF with handwriting",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== "pdf") return false;
        if (checking) return true;
        this.runAsync(this.openPdfHandwriting(file), "open PDF handwriting");
        return true;
      },
    });
    this.addCommand({
      id: "export-pdf-handwriting",
      name: "Export current PDF with handwriting",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(PdfInkView);
        if (!view) return false;
        if (checking) return true;
        void view.exportHandwrittenCopy();
        return true;
      },
    });
    this.addCommand({
      id: "restore-pdf-viewer",
      name: "Return current PDF tab to the built-in viewer",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(PdfInkView);
        if (!view) return false;
        if (checking) return true;
        void view.restoreBuiltinViewer();
        return true;
      },
    });
    this.registerMarkdownCodeBlockProcessor("ink", createInkEmbedProcessor(this.app, (file, pageId) => this.openFile(file, pageId), this.imageLibrary));
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf") return;
      menu.addItem((item) => item.setTitle("Open PDF with Ink Notes handwriting").setIcon("pen-line")
        .onClick(() => this.runAsync(this.openPdfHandwriting(file), "open PDF handwriting")));
    }));
    this.addSettingTab(new InkSettingTab(this.app, this));
    this.register(this.store.observe((file) => this.queueRefresh(file)));
    this.register(() => {
      for (const timer of this.refreshTimers.values()) window.clearTimeout(timer);
      this.refreshTimers.clear();
    });
  }

  onunload(): void {
    // Best-effort: persist settings changed within the last debounce window.
    this.toolStateSaver.flush();
    this.takeover?.uninstall();
  }

  private createView(leaf: WorkspaceLeaf): InkView {
    const view = new InkView(leaf, this.store, this.workers, this.toolStateBinding);
    if (this.imageLibrary) view.useImageLibrary(this.imageLibrary);
    return view;
  }

  /**
   * PDF handwriting support: a custom view for PDF tabs, installed by
   * wrapping the public WorkspaceLeaf.setViewState choke point, plus the
   * sidecar store and vault event wiring.
   */
  private configurePdfSupport(): void {
    this.pdfStore = new PdfSidecarStore(this.app);
    this.takeover = new PdfTabTakeover(() => ({
      enabled: this.config.pdfOpenMode !== "native",
      preferInk: this.config.pdfOpenMode === "ink",
      // Query current plugin state on each open, including runtime enable/disable.
      enhancerActive: PDF_VIEW_ENHANCER_PLUGIN_IDS.some((id) => {
        const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
        return plugins?.enabledPlugins?.has(id) === true;
      }),
      isPdfFile: (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        return file instanceof TFile && file.extension.toLowerCase() === "pdf";
      },
    }), VIEW_TYPE_PDF_INK);
    this.registerView(VIEW_TYPE_PDF_INK, (leaf) => {
      const view = new PdfInkView(leaf);
      if (this.imageLibrary) view.useImageLibrary(this.imageLibrary);
      view.configure({ store: this.pdfStore, workers: this.workers, takeover: this.takeover, toolState: this.toolStateBinding });
      return view;
    });
    if (this.app.vault) {
      this.takeover.install();
      this.register(() => this.takeover.uninstall());
      this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile && file.extension === "pdf") {
          void this.pdfStore.migrateForRename(file.path, oldPath).catch(() => {
            // The recovery scan resolves a failed migration on the next open.
          });
        }
      }));
      this.registerEvent(this.app.vault.on("modify", (file: TAbstractFile) => {
        if (!(file instanceof TFile)) return;
        if (file.extension.toLowerCase() === "pdf") {
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_INK)) {
            if (leaf.view instanceof PdfInkView && leaf.view.file?.path === file.path) void leaf.view.checkSourcePdfRevision();
          }
          return;
        }
        if (file.parent?.path !== PDF_INK_FOLDER || !file.name.endsWith(`.${PDF_SIDECAR_EXTENSION}`)) return;
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PDF_INK)) {
          if (leaf.view instanceof PdfInkView) void leaf.view.reloadExternalSidecar(file.path);
        }
      }));
    }
  }

  /** Re-evaluate the takeover patch after the setting changed. */
  refreshPdfTakeover(): void {
    if (!this.takeover) return;
    this.takeover.uninstall();
    if (this.config.pdfOpenMode !== "native" && this.app.vault) this.takeover.install();
  }

  /**
   * One writer for the data file: the plugin settings and the shared tool
   * settings live in the same document, so saving either must carry both or
   * the later write would clobber the earlier one's half.
   */
  private persistToolState(stored: StoredToolState): Promise<void> {
    // Keep the plugin's copy of the per-editor eraser values current so a
    // settings-tab save never regresses a newer editor change. The brush
    // settings need no sync: the editors alias the shared objects in place.
    this.toolState.eraserMode = stored.eraserMode;
    this.toolState.eraserSize = stored.eraserSize;
    return this.saveData({ pdfOpenMode: this.config.pdfOpenMode, toolState: stored, notebookHistory: this.history.list() }).catch((error) => {
      new Notice(`Ink Notes could not save tool settings: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Persists the plugin settings together with the latest tool settings. */
  async persistSettings(): Promise<void> {
    await this.saveData({ pdfOpenMode: this.config.pdfOpenMode, toolState: storedToolState(this.toolState), notebookHistory: this.history.list() });
  }

  get fingerAsPen(): boolean { return this.toolState.fingerAsPen; }

  async setFingerAsPen(enabled: boolean): Promise<void> {
    for (const type of [VIEW_TYPE_INK, VIEW_TYPE_PDF_INK]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if (leaf.view instanceof InkView || leaf.view instanceof PdfInkView) leaf.view.refreshInputPreferences();
      }
    }
    this.toolState.fingerAsPen = enabled;
    await this.persistSettings();
  }

  /** Open a PDF tab in the handwriting view on explicit request. */
  private async openPdfHandwriting(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_PDF_INK, state: { file: file.path } });
  }

  private async openNotebook(): Promise<void> {
    const entries = discoverNotebooks(await this.store.list(), this.history.list());
    new NotebookSuggestModal(this.app, entries, (file) => this.runAsync(this.openFile(file), `open ${file.path}`),
      (title, folder) => this.createNotebook(title, folder),
      async (file, title) => {
        const parent = file.path.slice(0, file.path.lastIndexOf("/") + 1);
        const path = `${parent}${title}.${INK_EXTENSION}`;
        if (path !== file.path) await this.app.fileManager.renameFile(file, path);
      },
      (cleared) => this.runAsync(this.forgetNotebooks(cleared), "clear missing notebook entries")).open();
  }

  private async createNotebook(title = "Ink Notebook", folder?: string): Promise<void> {
    const file = await this.store.create(title, folder);
    await this.openFile(file);
  }

  private async openFile(file: TFile, pageId?: string): Promise<void> {
    if (file.extension === INK_EXTENSION) this.rememberNotebook(file);
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    if (pageId && leaf.view instanceof InkView) leaf.view.revealPage(pageId);
  }

  /** Records the open for discovery even after the notebook moves anywhere in
   *  the vault; a persistence failure must not block opening the notebook. */
  private rememberNotebook(file: TFile): void {
    this.history.record(file.path, file.basename);
    void this.persistSettings().catch((error) => {
      new Notice(`Ink Notes could not save notebook history: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Manual cleanup only: removes the given history entries (missing files)
   *  without touching the notebooks themselves. */
  private async forgetNotebooks(entries: NotebookDiscovery[]): Promise<void> {
    for (const entry of entries) this.history.remove(entry.path);
    await this.persistSettings();
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

class InkSettingTab extends PluginSettingTab {
  constructor(app: Plugin["app"], private readonly plugin: InkNotesPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Input and gestures").setHeading();
    new Setting(containerEl).setName("Use finger as pen").setDesc(
      "Off: use a pen to write and fingers to select or move images and handwriting. "
      + "On: one finger uses the current writing, eraser or selection tool; two fingers move and zoom the page. "
      + "Use Pointer to move images while finger writing is on. Hold still for clipboard options.",
    ).addToggle((toggle) => toggle.setValue(this.plugin.fingerAsPen).onChange(async (value) => {
      try { await this.plugin.setFingerAsPen(value); }
      catch (error) { new Notice(`Ink Notes could not save input settings: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    new Setting(containerEl).setName("PDF handwriting").setHeading();
    new Setting(containerEl).setName("Default PDF viewer").setDesc(
      "PDF handwriting is stored in A_pdfinkwrittern/. Choose which viewer opens ordinary PDFs. "
        + "Compatibility mode keeps the native viewer when PDF extensions are enabled. "
        + "Ink Notes first opens handwriting even with PDF++ enabled; its native-view tools remain available "
        + "after returning to the built-in viewer. Page, search and selection links always keep the native viewer. "
        + "Reopen existing tabs to apply the choice.",
    ).addDropdown((dropdown) => dropdown
      .addOption("native", "Native PDF viewer")
      .addOption("compatible", "Compatibility mode")
      .addOption("ink", "Ink Notes first")
      .setValue(this.plugin.config.pdfOpenMode)
      .onChange(async (value) => {
        if (value !== "native" && value !== "compatible" && value !== "ink") return;
        this.plugin.config.pdfOpenMode = value;
        this.plugin.refreshPdfTakeover();
        try { await this.plugin.persistSettings(); }
        catch (error) { new Notice(`Ink Notes could not save PDF settings: ${error instanceof Error ? error.message : String(error)}`); }
      }));

    new Setting(containerEl).setName("Diagnostics").setHeading();
    new Setting(containerEl).setName("Export diagnostics").setDesc("Export local per-stroke records from open notebooks. Review handwriting data before sharing.")
      .addButton((button) => button.setButtonText("Export JSON").onClick(() => this.eachView((view) => view.exportDiagnosticsJson(false))))
      .addButton((button) => button.setButtonText("Copy JSON").onClick(() => this.eachView((view) => view.exportDiagnosticsJson(true))));
    new Setting(containerEl).setName("Developer panel").setHeading();
    new Setting(containerEl).setName("Live diagnostics").setDesc("Show sample rate and per-stroke records inside open notebooks.")
      .addButton((button) => button.setButtonText("Toggle panel").onClick(() => this.eachView((view) => view.toggleDevPanel())));
  }

  private eachView(run: (view: InkView) => void): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_INK)) {
      if (leaf.view instanceof InkView) run(leaf.view);
    }
  }
}
