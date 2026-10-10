import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDF_VIEW_ENHANCER_PLUGIN_IDS, PdfTabTakeover, pdfTakeoverReplacement } from "../src/pdf-takeover";

const gate = (overrides: Partial<{ enabled: boolean; enhancerActive: boolean; preferInk: boolean }> = {}) => ({
  enabled: true,
  enhancerActive: false,
  isPdfFile: (path: string) => path.endsWith(".pdf"),
  ...overrides,
});

describe("pdfTakeoverReplacement", () => {
  it("rewrites pdf opens with a vault pdf file", () => {
    expect(pdfTakeoverReplacement({ type: "pdf", state: { file: "docs/lecture.pdf" } }, gate(), "pdf-ink")).toBe("pdf-ink");
  });

  it("passes through when disabled, when a PDF enhancer owns the viewer, or the type differs", () => {
    const state = { type: "pdf", state: { file: "docs/lecture.pdf" } };
    expect(pdfTakeoverReplacement(state, gate({ enabled: false }), "pdf-ink")).toBeNull();
    expect(pdfTakeoverReplacement(state, gate({ enhancerActive: true }), "pdf-ink")).toBeNull();
    expect(pdfTakeoverReplacement({ type: "markdown", state: { file: "a.md" } }, gate(), "pdf-ink")).toBeNull();
    expect(pdfTakeoverReplacement(null, gate(), "pdf-ink")).toBeNull();
  });

  it("passes through when the file is not a vault PDF", () => {
    const vaultGate = { enabled: true, enhancerActive: false, isPdfFile: (path: string) => !path.includes("://") && path.endsWith(".pdf") };
    expect(pdfTakeoverReplacement({ type: "pdf", state: { file: "docs/notes.md" } }, vaultGate, "pdf-ink")).toBeNull();
    expect(pdfTakeoverReplacement({ type: "pdf", state: {} }, vaultGate, "pdf-ink")).toBeNull();
    expect(pdfTakeoverReplacement({ type: "pdf", state: { file: "https://x/y.pdf" } }, vaultGate, "pdf-ink")).toBeNull();
  });

  it("honors Ink-first with PDF++ enabled while retaining native navigation and the off switch", () => {
    const state = { type: "pdf", state: { file: "docs/lecture.pdf" } };
    const ink = gate({ enhancerActive: true, preferInk: true });
    expect(pdfTakeoverReplacement(state, ink, "pdf-ink")).toBe("pdf-ink");
    expect(pdfTakeoverReplacement(state, { ...ink, enabled: false }, "pdf-ink")).toBeNull();
    expect(pdfTakeoverReplacement(state, ink, "pdf-ink", { subpath: "#page=7" })).toBeNull();
    expect(pdfTakeoverReplacement({ ...state, state: { ...state.state, search: "term" } }, ink, "pdf-ink")).toBeNull();
  });

  it.each([{ page: 7 }, { subpath: "#page=3&rect=10,20,30,40" }, { search: "phrase" }, { selection: [1, 4] }, { futureNativeOption: true }])(
    "preserves native persistent and ephemeral navigation state: %j", (navigation) => {
      const state = { type: "pdf", state: { file: "docs/lecture.pdf" } };
      expect(pdfTakeoverReplacement({ ...state, state: { ...state.state, ...navigation } }, gate(), "pdf-ink")).toBeNull();
      expect(pdfTakeoverReplacement(state, gate(), "pdf-ink", navigation)).toBeNull();
      expect(pdfTakeoverReplacement(state, gate(), "pdf-ink", {})).toBe("pdf-ink");
    });
});

interface HostLike {
  setViewState: (this: unknown, viewState: { type: string; state?: Record<string, unknown> }, eState?: unknown) => Promise<void>;
}

/** Minimal WorkspaceLeaf.prototype stand-in with a builtin setViewState. */
function makeHost(): HostLike & { prototype: HostLike } & { lastCall?: string } {
  const host = {
    lastCall: undefined as string | undefined,
    async setViewState(viewState: { type: string; state?: Record<string, unknown> }) {
      host.lastCall = `builtin:${viewState.type}`;
    },
  };
  return Object.assign(host, { prototype: host }) as HostLike & { prototype: HostLike } & { lastCall?: string };
}

function setup(enabled = true, enhancerActive = false) {
  const host = makeHost();
  const takeover = new PdfTabTakeover(() => ({ enabled, enhancerActive, isPdfFile: (path: string) => path.endsWith(".pdf") }), "pdf-ink");
  takeover.install(host.prototype as never);
  return { host, takeover };
}

describe("PdfTabTakeover", () => {
  it("redirects pdf opens to the handwriting view before the builtin view is created", async () => {
    const { host } = setup();
    await host.setViewState({ type: "pdf", state: { file: "docs/lecture.pdf" } });
    expect(host.lastCall).toBe("builtin:pdf-ink");
  });

  it("passes other view types and non-pdf files through untouched", async () => {
    const { host } = setup();
    await host.setViewState({ type: "markdown", state: { file: "a.md" } });
    expect(host.lastCall).toBe("builtin:markdown");
    await host.setViewState({ type: "pdf", state: { file: "a.md" } });
    expect(host.lastCall).toBe("builtin:pdf");
  });

  it("yields while an enhancer plugin is active and picks the setting back up", async () => {
    let enhancerActive = true;
    const host = makeHost();
    const takeover = new PdfTabTakeover(() => ({ enabled: true, enhancerActive, isPdfFile: (path: string) => path.endsWith(".pdf") }), "pdf-ink");
    takeover.install(host.prototype as never);
    await host.setViewState({ type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("builtin:pdf");
    enhancerActive = false;
    await host.setViewState({ type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("builtin:pdf-ink");
  });

  it("never intercepts when the gate is off", async () => {
    const { host } = setup(false);
    await host.setViewState({ type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("builtin:pdf");
  });

  it("switches between compatible, Ink-first and native modes while PDF++ stays enabled", async () => {
    const current = gate({ enhancerActive: true, preferInk: false });
    const host = makeHost();
    const takeover = new PdfTabTakeover(() => current, "pdf-ink");
    takeover.install(host as never);
    const state = { type: "pdf", state: { file: "docs/a.pdf" } };
    await host.setViewState(state);
    expect(host.lastCall).toBe("builtin:pdf");
    current.preferInk = true;
    await host.setViewState(state);
    expect(host.lastCall).toBe("builtin:pdf-ink");
    current.enabled = false;
    await host.setViewState(state);
    expect(host.lastCall).toBe("builtin:pdf");
    takeover.uninstall();
  });

  it("suppresses recapture for leaves handed back to the builtin viewer", async () => {
    const { host, takeover } = setup();
    const leaf = { setViewState: host.setViewState } as unknown as HostLike;
    takeover.suppressLeaf(leaf as never);
    await host.setViewState.call(leaf, { type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("builtin:pdf");
    takeover.releaseLeaf(leaf as never);
    await host.setViewState.call(leaf, { type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("builtin:pdf-ink");
  });

  it("uninstall restores the original while it is still the outermost wrapper", () => {
    const host = makeHost();
    const original = host.setViewState;
    const { takeover } = setup();
    takeover.install(host.prototype as never);
    takeover.uninstall();
    expect(host.setViewState).toBe(original);
    expect(takeover.installed).toBe(false);
  });

  it("neutralizes instead of ripping a later wrapper when uninstalling mid-chain", async () => {
    const host = makeHost();
    const takeover = new PdfTabTakeover(() => ({ enabled: true, enhancerActive: false, isPdfFile: () => true }), "pdf-ink");
    takeover.install(host.prototype as never);
    const wrapped = host.setViewState.bind(host);
    const later: HostLike["setViewState"] = async function (viewState) {
      await wrapped(viewState);
      host.lastCall = `later:${host.lastCall}`;
    };
    host.prototype.setViewState = later;
    takeover.uninstall();
    await host.setViewState({ type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("later:builtin:pdf");
  });

  it("is idempotent when installed twice", () => {
    const host = makeHost();
    const takeover = new PdfTabTakeover(() => ({ enabled: true, enhancerActive: false, isPdfFile: () => true }), "pdf-ink");
    takeover.install(host.prototype as never);
    const patched = host.setViewState;
    takeover.install(host.prototype as never);
    expect(host.setViewState).toBe(patched);
    expect(takeover.installed).toBe(true);
  });
});

describe("patch chain compatibility", () => {
  it("forwards native link state and other wrappers' results without mutation", async () => {
    const received: unknown[][] = [];
    const host = { async setViewState(...args: unknown[]) { received.push(args); } };
    const takeover = new PdfTabTakeover(() => gate(), "pdf-ink");
    takeover.install(host as never);
    const state = { type: "pdf", state: { file: "docs/a.pdf" }, active: true };
    const ephemeral = { subpath: "#page=8", selection: [1, 2] };
    await host.setViewState(state, ephemeral);
    expect(received[0][0]).toBe(state);
    expect(received[0][1]).toBe(ephemeral);
    takeover.uninstall();
  });

  it("keeps an uninstalled patch inert through a later wrapper and reinstall", async () => {
    const host = makeHost();
    let gateCalls = 0;
    const takeover = new PdfTabTakeover(() => { gateCalls++; return gate(); }, "pdf-ink");
    takeover.install(host as never);
    const old = host.setViewState;
    host.setViewState = async function (state, eState) { await old.call(this, state, eState); };
    takeover.uninstall();
    takeover.install(host as never);
    await host.setViewState({ type: "pdf", state: { file: "a.pdf" } }, { subpath: "#page=2" });
    expect(gateCalls).toBe(1);
    expect(host.lastCall).toBe("builtin:pdf");
    takeover.uninstall();
  });

  it("documents a source-confirmed native dependency for every automatically yielding plugin", () => {
    const report = JSON.parse(readFileSync(new URL("../docs/pdf-plugin-compatibility.json", import.meta.url), "utf8"));
    const native = report.plugins.filter((plugin: { status: string }) => plugin.status === "native-dependent");
    expect(native.map((plugin: { id: string }) => plugin.id).sort()).toEqual([...PDF_VIEW_ENHANCER_PLUGIN_IDS].sort());
    for (const plugin of native) {
      expect(plugin.evidence.line).toBeGreaterThan(0);
      expect(plugin.evidence.url).toContain(`/blob/${plugin.sha}/`);
      expect(plugin.runtimeVerified).toBe(false);
    }
    expect(new Set(PDF_VIEW_ENHANCER_PLUGIN_IDS).size).toBe(PDF_VIEW_ENHANCER_PLUGIN_IDS.length);
    expect(PDF_VIEW_ENHANCER_PLUGIN_IDS).toContain("pdf-plus");
    expect(PDF_VIEW_ENHANCER_PLUGIN_IDS).not.toContain("obsidian-annotator");
    expect(PDF_VIEW_ENHANCER_PLUGIN_IDS).not.toContain("reflow");
  });
  it("stacks with an earlier patcher (later install runs outermost, uninstall is safe)", async () => {
    const host = makeHost();
    const early = new PdfTabTakeover(() => ({ enabled: true, enhancerActive: false, isPdfFile: () => true }), "early-view");
    const late = new PdfTabTakeover(() => ({ enabled: true, enhancerActive: false, isPdfFile: () => true }), "late-view");
    early.install(host.prototype as never);
    late.install(host.prototype as never);
    await host.setViewState({ type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("builtin:late-view");
    early.uninstall();
    await host.setViewState({ type: "pdf", state: { file: "docs/a.pdf" } });
    expect(host.lastCall).toBe("builtin:late-view");
  });
});
