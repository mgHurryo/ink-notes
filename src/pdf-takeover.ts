import { around } from "monkey-around";
import { WorkspaceLeaf, type OpenViewState, type TFile } from "obsidian";

/**
 * PDF tab takeover.
 *
 * Obsidian has no public API to replace the built-in `pdf` view, and the plan
 * explicitly rules out private registries — so this module wraps the public
 * `WorkspaceLeaf.prototype.setViewState` where PDF open paths converge (file
 * list, search, internal links and `#page=` links). In Ink-first mode the public
 * openFile request also supplies
 * the opening intent, before native viewers add remembered viewport state.
 * The patch redirects ordinary opens to our view type before the built-in view
 * is instantiated.
 *
 * Patch pattern follows PDF++ (MIT, © Ryota Ushio,
 * https://github.com/RyotaUshio/obsidian-pdf-plus), including the use of the
 * `monkey-around` wrapper so uninstallation only restores the original while
 * our patch is still the outermost one.
 *
 * Native PDF compatibility: viewer extensions keep the built-in `pdf` view and enhance it
 * from the inside, so while our patch is active its enhancements never engage
 * (the built-in view is never created). We therefore yield automatically
 * while a source-confirmed native extension is enabled in compatibility mode. Ink-first mode
 * honors the user's explicit viewer choice. PDFs open in the built-in viewer and
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
  /** Explicit Ink-first choice overrides extension detection, not native navigation. */
  preferInk?: boolean;
  /** Vault membership + extension check for the path inside the view state. */
  isPdfFile: (path: string) => boolean;
}

/**
 * Pure decision: which view type a setViewState call should actually open.
 * Returns the replacement view type, or null to pass through untouched.
 */
export function pdfTakeoverReplacement(viewState: PdfViewState | null | undefined, gate: PdfTakeoverGate, viewType: string, eState?: unknown, ordinaryOpen = false): string | null {
  if (!gate.enabled || (gate.enhancerActive && !gate.preferInk)) return null;
  if (!viewState || viewState.type !== "pdf") return null;
  const file = viewState.state?.file;
  if (typeof file !== "string" || !gate.isPdfFile(file)) return null;
  // An ordinary openFile request takes precedence over remembered native state
  // in Ink-first mode. Explicit navigation and unknown requests still stay native.
  if (!(gate.preferInk && ordinaryOpen) && Object.entries(viewState.state ?? {})
    .some(([key, value]) => key !== "file" && !(key === "sync" && typeof value === "boolean") && value != null)) return null;
  if (hasNativeNavigation(eState)) return null;
  return viewType;
}

/** Shared by opening routes and existing views so focus never becomes navigation. */
export function hasNativeNavigation(state: unknown): boolean {
  if (state == null) return false;
  if (typeof state !== "object" || Array.isArray(state)) return true;
  return Object.entries(state).some(([key, value]) => {
    if (value == null) return false;
    if (key === "focus" && typeof value === "boolean") return false;
    if (key === "subpath" && (value === "" || value === "#")) return false;
    return true;
  });
}

export class PdfTabTakeover {
  private uninstaller: (() => void) | null = null;
  private inert = false;
  private readonly suppressedLeaves = new WeakSet<WorkspaceLeaf>();
  private readonly ordinaryOpens = new WeakMap<WorkspaceLeaf, { path: string; ordinary: boolean; active: boolean }>();

  constructor(private readonly gateProvider: () => PdfTakeoverGate, private readonly viewType: string) {}

  get installed(): boolean {
    return this.uninstaller !== null;
  }

  install(
    target: {
      setViewState: (this: WorkspaceLeaf, viewState: PdfViewState, eState?: unknown) => Promise<void>;
      openFile?: (this: WorkspaceLeaf, file: TFile, openState?: OpenViewState) => Promise<void>;
    } = WorkspaceLeaf.prototype,
  ): void {
    if (this.uninstaller) return;
    const takeover = this;
    this.inert = false;
    const uninstallViewState = around(target, {
      setViewState(old: (this: WorkspaceLeaf, viewState: PdfViewState, eState?: unknown) => Promise<void>) {
        return async function setViewState(this: WorkspaceLeaf, viewState: PdfViewState, eState?: unknown) {
          if (!takeover.inert && !takeover.suppressedLeaves.has(this)) {
            const request = takeover.ordinaryOpens.get(this);
            const ordinary = request?.active === true && request.ordinary && request.path === viewState.state?.file;
            const replacement = pdfTakeoverReplacement(viewState, takeover.gateProvider(), takeover.viewType, eState, ordinary);
            if (replacement) return old.call(this, { ...viewState, type: replacement }, eState);
          }
          return old.call(this, viewState, eState);
        } as unknown as typeof old;
      },
    });
    const uninstallOpenFile = typeof target.openFile === "function" ? around(target as typeof target & {
      openFile: NonNullable<typeof target.openFile>;
    }, {
      openFile(old) {
        return async function(this: WorkspaceLeaf, file: TFile, openState?: OpenViewState) {
          const gate = takeover.gateProvider();
          const ordinary = !takeover.inert && !takeover.suppressedLeaves.has(this) && gate.preferInk
            && pdfTakeoverReplacement({ type: "pdf", state: { ...openState?.state, file: file.path } },
              gate, takeover.viewType, openState?.eState) !== null;
          const request = { path: file.path, ordinary: !!ordinary, active: true };
          const previous = takeover.ordinaryOpens.get(this);
          takeover.ordinaryOpens.set(this, request);
          try {
            await old.call(this, file, openState);
          } finally {
            request.active = false;
            if (takeover.ordinaryOpens.get(this) === request) {
              if (previous?.active) takeover.ordinaryOpens.set(this, previous);
              else takeover.ordinaryOpens.delete(this);
            }
          }
        };
      },
    }) : undefined;
    this.uninstaller = () => { uninstallOpenFile?.(); uninstallViewState(); };
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
