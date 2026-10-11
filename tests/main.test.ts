import { beforeEach, describe, expect, it, vi } from "vitest";

const observe = vi.fn();
const register = vi.fn();
const registerMarkdown = vi.fn();
const list = vi.fn();
const notice = vi.fn();
const pickerOpen = vi.fn();
const pickerArguments = vi.fn();
const create = vi.fn();
const settings: { name: string; options?: Record<string, string>; value?: string; change?: (value: string) => Promise<void> }[] = [];

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Plugin: class {
    app = {
      vault: null,
      workspace: { on: vi.fn(), getLeavesOfType: vi.fn(() => []), getActiveFile: vi.fn(() => null), getActiveViewOfType: vi.fn(() => null) },
    };
    registerView = vi.fn(); registerExtensions = vi.fn(); addRibbonIcon = vi.fn(); addCommand = vi.fn(); addSettingTab = vi.fn(); registerEvent = vi.fn();
    loadData = vi.fn(async () => ({})); saveData = vi.fn(async () => undefined);
    registerMarkdownCodeBlockProcessor = registerMarkdown;
    register = register;
  },
  Notice: class { constructor(message: string) { notice(message); } },
  SuggestModal: class {},
  Modal: class {},
  PluginSettingTab: class { containerEl = { empty: vi.fn() }; },
  Setting: class {
    entry = { name: "" } as typeof settings[number];
    constructor() { settings.push(this.entry); }
    setName(name: string) { this.entry.name = name; return this; }
    setHeading() { return this; }
    setDesc() { return this; }
    addButton() { return this; }
    addDropdown(build: (dropdown: unknown) => void) {
      const entry = this.entry;
      const dropdown = {
        addOption(value: string, text: string) { (entry.options ??= {})[value] = text; return dropdown; },
        setValue(value: string) { entry.value = value; return dropdown; },
        onChange(change: typeof entry.change) { entry.change = change; return dropdown; },
      };
      build(dropdown); return this;
    }
  },
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
import { TFile } from "obsidian";
import { PdfTabTakeover } from "../src/pdf-takeover";
import { PdfInkView } from "../src/pdf-view";

describe("plugin event synchronization", () => {
  beforeEach(() => { observe.mockReset(); register.mockReset(); registerMarkdown.mockReset(); list.mockReset(); notice.mockReset();
    pickerOpen.mockReset(); pickerArguments.mockReset(); create.mockReset(); settings.length = 0; });

  it("settings expose and immediately apply the three viewer choices, and report save failures", async () => {
    const plugin = new InkNotesPlugin({} as never, {} as never);
    await plugin.onload();
    const tab = (plugin.addSettingTab as ReturnType<typeof vi.fn>).mock.calls[0][0];
    tab.display();
    const choice = settings.find((setting) => setting.name === "Default PDF viewer")!;
    expect(choice.options).toEqual({ native: "Native PDF viewer", compatible: "Compatibility mode", ink: "Ink Notes first" });
    expect(choice.value).toBe("compatible");
    const refresh = vi.spyOn(plugin, "refreshPdfTakeover").mockImplementation(() => undefined);
    await choice.change!("ink");
    expect(plugin.config.pdfOpenMode).toBe("ink");
    expect(refresh).toHaveBeenCalledOnce();
    expect(plugin.saveData).toHaveBeenLastCalledWith(expect.objectContaining({ pdfOpenMode: "ink" }));
    (plugin.saveData as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("storage failed"));
    await choice.change!("native");
    expect(notice).toHaveBeenCalledWith("Ink Notes could not save PDF settings: storage failed");
    await choice.change!("invalid");
    expect(plugin.config.pdfOpenMode).toBe("native");
  });

  it.each([
    [{}, "compatible"],
    [{ takeOverPdfTabs: true }, "ink"],
    [{ takeOverPdfTabs: false }, "native"],
    [{ pdfOpenMode: "compatible", takeOverPdfTabs: true }, "compatible"],
    [{ pdfOpenMode: "native", takeOverPdfTabs: true }, "native"],
    [{ pdfOpenMode: "ink", takeOverPdfTabs: false }, "ink"],
    [{ pdfOpenMode: "invalid", takeOverPdfTabs: true }, "ink"],
    [{ pdfOpenMode: "invalid" }, "compatible"],
  ])("loads and persists the PDF viewer choice from %j", async (saved, expected) => {
    const plugin = new InkNotesPlugin({} as never, {} as never);
    (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue(saved);
    await plugin.onload();
    expect(plugin.config.pdfOpenMode).toBe(expected);
    await plugin.persistSettings();
    expect(plugin.saveData).toHaveBeenLastCalledWith(expect.objectContaining({ pdfOpenMode: expected }));
    expect((plugin.saveData as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]).not.toHaveProperty("takeOverPdfTabs");
  });

  it("migrates the checked legacy setting to automatic ink with PDF++ enabled, including uppercase PDF", async () => {
    const install = vi.spyOn(PdfTabTakeover.prototype, "install").mockImplementation(() => undefined);
    try {
      const plugin = new InkNotesPlugin({} as never, {} as never);
      const file = Object.assign(new TFile(), { path: "docs/Test.PDF", extension: "PDF" });
      (plugin.loadData as ReturnType<typeof vi.fn>).mockResolvedValue({ takeOverPdfTabs: true });
      Object.assign(plugin.app, { plugins: { enabledPlugins: new Set(["pdf-plus"]) }, vault: { on: vi.fn(), getAbstractFileByPath: vi.fn(() => file) } });
      await plugin.onload();
      const takeover = (plugin as unknown as { takeover: { gateProvider(): { enabled: boolean; preferInk: boolean; enhancerActive: boolean; isPdfFile(path: string): boolean } } }).takeover;
      expect(takeover.gateProvider()).toMatchObject({ enabled: true, preferInk: true, enhancerActive: true });
      expect(takeover.gateProvider().isPdfFile(file.path)).toBe(true);
      plugin.config.pdfOpenMode = "compatible";
      expect(takeover.gateProvider().preferInk).toBe(false);
      plugin.config.pdfOpenMode = "native";
      expect(takeover.gateProvider().enabled).toBe(false);
    } finally { install.mockRestore(); }
  });
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

  it("adds handwriting to the PDF file menu without consuming other menu entries", async () => {
    const plugin = new InkNotesPlugin({} as never, {} as never);
    const setViewState = vi.fn(async () => undefined);
    Object.assign(plugin.app.workspace, { getLeaf: vi.fn(() => ({ setViewState })) });
    await plugin.onload();
    const listener = (plugin.app.workspace.on as ReturnType<typeof vi.fn>).mock.calls.find(([name]) => name === "file-menu")![1];
    let click!: () => void;
    const item = { setTitle: vi.fn(() => item), setIcon: vi.fn(() => item), onClick: vi.fn((callback) => { click = callback; return item; }) };
    const menu = { addItem: vi.fn((build) => build(item)) };
    listener(menu, { extension: "pdf" });
    expect(menu.addItem).not.toHaveBeenCalled();
    const file = Object.assign(new TFile(), { path: "docs/Test.PDF", extension: "PDF" });
    listener(menu, file);
    expect(menu.addItem).toHaveBeenCalledOnce();
    click();
    await vi.waitFor(() => expect(setViewState).toHaveBeenCalledWith({ type: "ink-notes-pdf-view", state: { file: file.path } }));
  });

  it("reads live enabled-plugin state and routes only matching PDF source changes", async () => {
    const install = vi.spyOn(PdfTabTakeover.prototype, "install").mockImplementation(() => undefined);
    try {
      const plugin = new InkNotesPlugin({} as never, {} as never);
      const file = Object.assign(new TFile(), { path: "docs/Test.pdf", extension: "pdf" });
      const other = Object.assign(new TFile(), { path: "docs/Other.pdf", extension: "pdf" });
      const enabledPlugins = new Set<string>();
      const view = Object.assign(Object.create(PdfInkView.prototype), { file, checkSourcePdfRevision: vi.fn(async () => undefined) });
      const otherView = Object.assign(Object.create(PdfInkView.prototype), { file: other, checkSourcePdfRevision: vi.fn(async () => undefined) });
      const on = vi.fn();
      Object.assign(plugin.app, { plugins: { enabledPlugins }, vault: { on, getAbstractFileByPath: vi.fn(() => file) } });
      plugin.app.workspace.getLeavesOfType = vi.fn(() => [{ view }, { view: otherView }]) as never;
      await plugin.onload();
      const takeover = (plugin as unknown as { takeover: { gateProvider(): { enhancerActive: boolean } } }).takeover;
      expect(takeover.gateProvider().enhancerActive).toBe(false);
      enabledPlugins.add("pdf-selection-translator");
      expect(takeover.gateProvider().enhancerActive).toBe(true);
      enabledPlugins.clear(); enabledPlugins.add("reflow");
      expect(takeover.gateProvider().enhancerActive).toBe(false);
      on.mock.calls.find(([name]) => name === "modify")![1](file);
      expect(view.checkSourcePdfRevision).toHaveBeenCalledOnce();
      expect(otherView.checkSourcePdfRevision).not.toHaveBeenCalled();
    } finally { install.mockRestore(); }
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
