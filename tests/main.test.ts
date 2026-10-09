import { beforeEach, describe, expect, it, vi } from "vitest";

const observe = vi.fn();
const register = vi.fn();
const registerMarkdown = vi.fn();
const list = vi.fn();
const notice = vi.fn();
const pickerOpen = vi.fn();
const pickerArguments = vi.fn();
const create = vi.fn();

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
  NotebookStore: class { observe = observe; list = list; create = create; },
}));
vi.mock("../src/notebook-modal", () => ({ NotebookSuggestModal: class {
  constructor(...args: unknown[]) { pickerArguments(...args); }
  open = pickerOpen;
} }));
vi.mock("../src/embed", () => ({ createInkEmbedProcessor: vi.fn(() => vi.fn()) }));
vi.mock("../src/view", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  VIEW_TYPE_INK: "ink-notes-view",
  InkView: class {},
}));

import InkNotesPlugin from "../src/main";
import { InkView } from "../src/view";

describe("plugin event synchronization", () => {
  beforeEach(() => { observe.mockReset(); register.mockReset(); registerMarkdown.mockReset(); list.mockReset(); notice.mockReset();
    pickerOpen.mockReset(); pickerArguments.mockReset(); create.mockReset(); });
  it.each([{ files: [] }, { files: [{ path: "Ink Notes/Existing.ink", basename: "Existing" }] }])("ribbon always opens a picker with a reusable creation action: $files", async ({ files }) => {
    list.mockResolvedValue(files);
    const file = { path: "Ink Notes/New name.ink" };
    create.mockResolvedValue(file);
    const plugin = new InkNotesPlugin({} as never, {} as never);
    const openFile = vi.fn(async () => undefined);
    const getLeaf = vi.fn(() => ({ openFile }));
    Object.assign(plugin.app.workspace, { getLeaf });
    await plugin.onload();
    (plugin.addRibbonIcon as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]();
    await vi.waitFor(() => expect(pickerOpen).toHaveBeenCalledOnce());
    expect(create).not.toHaveBeenCalled();
    expect(pickerArguments.mock.calls[0][1]).toBe(files);
    const add = pickerArguments.mock.calls[0][3] as (title: string) => Promise<void>;
    await add("New name"); await add("Another name");
    expect(create.mock.calls).toEqual([["New name"], ["Another name"]]);
    expect(openFile).toHaveBeenCalledWith(file);
  });

  it("renames through FileManager while retaining the current directory and ink extension", async () => {
    const file = { path: "Ink Notes/Course/Existing.ink", basename: "Existing" };
    list.mockResolvedValue([file]);
    const plugin = new InkNotesPlugin({} as never, {} as never);
    const renameFile = vi.fn(async () => undefined);
    Object.assign(plugin.app, { fileManager: { renameFile } });
    await plugin.onload();
    await (plugin as unknown as { openNotebook(): Promise<void> }).openNotebook();
    const rename = pickerArguments.mock.calls[0][4] as (file: unknown, title: string) => Promise<void>;
    await rename(file, "Existing");
    expect(renameFile).not.toHaveBeenCalled();
    await rename(file, "Renamed");
    expect(renameFile).toHaveBeenCalledWith(file, "Ink Notes/Course/Renamed.ink");
  });
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
