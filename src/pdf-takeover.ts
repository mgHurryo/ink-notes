import { around } from "monkey-around";
import { WorkspaceLeaf } from "obsidian";

/**
 * PDF tab takeover.
 *
 * Obsidian has no public API to replace the built-in `pdf` view, and the plan
 * explicitly rules out private registries — so this module wraps the public
 * `WorkspaceLeaf.prototype.setViewState` at the single choke point every PDF
 * open path converges on (file list, search, internal links, `#page=` links
 * all end in a setViewState call with type "pdf"). The patch redirects those
 * calls to our view type before the built-in view is instantiated.
 *
 * Patch pattern follows PDF++ (MIT, © Ryota Ushio,
 * https://github.com/RyotaUshio/obsidian-pdf-plus), including the use of the
 * `monkey-around` wrapper so uninstallation only restores the original while
 * our patch is still the outermost one.
 *
 * Native PDF compatibility: viewer extensions keep the built-in `pdf` view and enhance it
 * from the inside, so while our patch is active its enhancements never engage
 * (the built-in view is never created). We therefore yield automatically
 * while a source-confirmed native extension is enabled. PDFs open in the built-in viewer and
 * handwriting stays available per-tab through the explicit open command and
 * file menu entry. The user can also flip a tab back to the built-in viewer
 * from inside our view.
 */

/** Source evidence and pinned upstream revisions: docs/pdf-plugin-compatibility.json. */
export const PDF_VIEW_ENHANCER_PLUGIN_IDS: readonly string[] = [
  "annotations-everywhere", "book-note", "easy-pdf-highlight", "fit-pdf", "fleur-pdf",
  "fleurpdf-tint", "freedraw-pdf", "handwriting", "handwritten-notes",
  "icor-for-life-pdf-annotation", "inkidian", "inkling", "jot", "lark-knowledge-ai",
  "llm-translator", "local-pdf-annotator", "magicnotes", "marglow", "native-pdf-handwriting",
  "native-search", "note-reader-cosyvoice", "note-reader-mobile", "open-pdf-translate",
  "pandocit", "paper-reader", "pdf-editor", "pdf-highlight-notes", "pdf-pager-hz", "pdf-plus",
  "pdf-read-aloud", "pdf-scholia-scribe", "pdf-scroll-lock", "pdf-selection-translator",
  "pdf-simple", "pdf-toggle-dark-mode", "pdf-versioning", "pdftion", "qmd-as-md-obsidian", "reader-margins",
  "reading-progress-bookmarks", "reading-ruler", "siden", "study-pdf", "supernote-annotations",
  "third-mind-reader", "view-memory", "word-memo", "yh-inklight", "pdf-writer",
];

export interface PdfViewState {
  type: string;
  state?: Record<string, unknown>;
}

export interface PdfTakeoverGate {
  /** Master setting (kill switch). */
  enabled: boolean;
  /** True while an installed enhancer plugin owns the built-in viewer UX. */
  enhancerActive: boolean;
  /** Vault membership + extension check for the path inside the view state. */
  isPdfFile: (path: string) => boolean;
}

/**
 * Pure decision: which view type a setViewState call should actually open.
 * Returns the replacement view type, or null to pass through untouched.
 */
export function pdfTakeoverReplacement(viewState: PdfViewState | null | undefined, gate: PdfTakeoverGate, viewType: string, eState?: unknown): string | null {
  if (!gate.enabled || gate.enhancerActive) return null;
  if (!viewState || viewState.type !== "pdf") return null;
  const file = viewState.state?.file;
  if (typeof file !== "string" || !gate.isPdfFile(file)) return null;
  // Native navigation/search/selection state has no equivalent in the ink view.
  // Preserve even unfamiliar state rather than silently discarding another plugin's request.
  if (Object.keys(viewState.state ?? {}).some((key) => key !== "file")) return null;
  if (eState != null && (typeof eState !== "object" || Object.keys(eState).length > 0)) return null;
  return viewType;
}

export class PdfTabTakeover {
  private uninstaller: (() => void) | null = null;
  private inert = false;
  private readonly suppressedLeaves = new WeakSet<WorkspaceLeaf>();

  constructor(private readonly gateProvider: () => PdfTakeoverGate, private readonly viewType: string) {}

  get installed(): boolean {
    return this.uninstaller !== null;
  }

  install(
    target: { setViewState: (this: WorkspaceLeaf, viewState: PdfViewState, eState?: unknown) => Promise<void> } = WorkspaceLeaf.prototype,
  ): void {
    if (this.uninstaller) return;
    const takeover = this;
    this.inert = false;
    this.uninstaller = around(target, {
      setViewState(old: (this: WorkspaceLeaf, viewState: PdfViewState, eState?: unknown) => Promise<void>) {
        return async function setViewState(this: WorkspaceLeaf, viewState: PdfViewState, eState?: unknown) {
          if (!takeover.inert && !takeover.suppressedLeaves.has(this)) {
            const replacement = pdfTakeoverReplacement(viewState, takeover.gateProvider(), takeover.viewType, eState);
            if (replacement) return old.call(this, { ...viewState, type: replacement }, eState);
          }
          return old.call(this, viewState, eState);
        } as unknown as typeof old;
      },
    });
  }

  /**
   * Remove only our wrapper. monkey-around neutralizes its own mid-chain
   * wrapper without removing a wrapper installed later by another plugin.
   */
  uninstall(): void {
    if (!this.uninstaller) return;
    const uninstaller = this.uninstaller;
    this.uninstaller = null;
    uninstaller();
    this.inert = true;
  }

  /**
   * Keep a leaf in the built-in viewer even while the patch is active: set
   * before switching the leaf back to type "pdf", so our own patch does not
   * immediately recapture the tab.
   */
  suppressLeaf(leaf: WorkspaceLeaf): void {
    this.suppressedLeaves.add(leaf);
  }

  releaseLeaf(leaf: WorkspaceLeaf): void {
    this.suppressedLeaves.delete(leaf);
  }
}
