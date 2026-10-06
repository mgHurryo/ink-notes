import { beforeEach, describe, expect, it, vi } from "vitest";

const observe = vi.fn();
const register = vi.fn();
const registerMarkdown = vi.fn();
const list = vi.fn();
const notice = vi.fn();

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Plugin: class {
    app = {
      vault: null,
      workspace: { getLeavesOfType: vi.fn(() => []), getActiveFile: vi.fn(() => null), getActiveViewOfType: vi.fn(() => null) },
    };
    registerView = vi.fn(); registerExtensions = vi.fn(); addRibbonIcon = vi.fn(); addCommand = vi.fn(); addSettingTab = vi.fn(); registerEvent = vi.fn();
    loadData = vi.fn(async () => ({})); saveData = vi.fn(async () => undefined);
    registerMarkdownCodeBlockProcessor = registerMarkdown;
    register = register;
  },
  Notice: class { constructor(message: string) { notice(message); } },
  SuggestModal: class {},
  PluginSettingTab: class {},
  TFile: class {},
  WorkspaceLeaf: class {},
  FileView: class { app = { scope: {} }; file = null; },
  Scope: class { register(): void {} },
  Menu: class {},
  setIcon: () => undefined,
  loadPdfJs: () => Promise.resolve({}),
}));
vi.mock("../src/storage", () => ({
  INK_EXTENSION: "ink",
  NotebookStore: class { observe = observe; list = list; },
}));
vi.mock("../src/embed", () => ({ createInkEmbedProcessor: vi.fn(() => vi.fn()) }));
vi.mock("../src/view", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  VIEW_TYPE_INK: "ink-notes-view",
  InkView: class {},
}));

import InkNotesPlugin from "../src/main";
import { InkView } from "../src/view";

describe("plugin event synchronization", () => {
  beforeEach(() => { observe.mockReset(); register.mockReset(); registerMarkdown.mockReset(); list.mockReset(); notice.mockReset(); });
  it("registers markdown embeds and vault observation without polling", async () => {
    const dispose = vi.fn();
    observe.mockReturnValue(dispose);
    const interval = vi.spyOn(globalThis, "setInterval");
    const plugin = new InkNotesPlugin({} as never, {} as never);
    await plugin.onload();
    expect(registerMarkdown).toHaveBeenCalledWith("ink", expect.any(Function));
    expect(observe).toHaveBeenCalledOnce();
    expect(register).toHaveBeenCalledWith(dispose);
    expect(interval).not.toHaveBeenCalled();
    interval.mockRestore();
  });

  it("reports command failures instead of leaving rejected promises unhandled", async () => {
    observe.mockReturnValue(vi.fn());
    list.mockRejectedValue(new Error("vault unavailable"));
    const plugin = new InkNotesPlugin({} as never, {} as never);
    await plugin.onload();
    const addCommand = plugin.addCommand as unknown as ReturnType<typeof vi.fn>;
    const command = addCommand.mock.calls.map(([value]) => value).find((value) => value.id === "open-ink-notebook");
    command.callback();
    await vi.waitFor(() => expect(notice).toHaveBeenCalledWith("Ink Notes could not open a notebook: vault unavailable"));
  });

  it("refreshes only the matching open notebook and coalesces in-flight changes", async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    const matching = Object.assign(new InkView({} as never, {} as never), {
      file: { path: "Ink Notes/Target.ink" },
      reloadFromDisk: vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined),
    });
    const other = Object.assign(new InkView({} as never, {} as never), {
      file: { path: "Ink Notes/Other.ink" }, reloadFromDisk: vi.fn(),
    });
    const plugin = new InkNotesPlugin({} as never, {} as never) as unknown as {
      app: { workspace: { getLeavesOfType: ReturnType<typeof vi.fn> } };
      refreshFile(file: { path: string }): Promise<void>;
    };
    plugin.app.workspace.getLeavesOfType = vi.fn(() => [{ view: matching }, { view: other }]);
    const running = plugin.refreshFile({ path: "Ink Notes/Target.ink" });
    await Promise.resolve();
    await plugin.refreshFile({ path: "Ink Notes/Target.ink" });
    release();
    await running;
    expect(matching.reloadFromDisk).toHaveBeenCalledTimes(2);
    expect(other.reloadFromDisk).not.toHaveBeenCalled();
  });
});
