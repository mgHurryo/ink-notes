import { beforeEach, describe, expect, it, vi } from "vitest";

const observe = vi.fn();
const register = vi.fn();
const registerMarkdown = vi.fn();

vi.mock("obsidian", () => ({
  Plugin: class {
    app = { workspace: { getLeavesOfType: vi.fn(() => []) } };
    registerView = vi.fn(); registerExtensions = vi.fn(); addRibbonIcon = vi.fn(); addCommand = vi.fn();
    registerMarkdownCodeBlockProcessor = registerMarkdown;
    register = register;
  },
  Notice: class {},
  SuggestModal: class {},
  TFile: class {},
  WorkspaceLeaf: class {},
}));
vi.mock("../src/storage", () => ({
  INK_EXTENSION: "ink",
  NotebookStore: class { observe = observe; },
}));
vi.mock("../src/embed", () => ({ createInkEmbedProcessor: vi.fn(() => vi.fn()) }));
vi.mock("../src/view", () => ({ VIEW_TYPE_INK: "ink-notes-view", InkView: class {} }));

import InkNotesPlugin from "../src/main";
import { InkView } from "../src/view";

describe("plugin event synchronization", () => {
  beforeEach(() => { observe.mockReset(); register.mockReset(); registerMarkdown.mockReset(); });
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
