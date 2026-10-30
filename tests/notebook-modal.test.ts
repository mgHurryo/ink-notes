// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { NotebookNameModal, NotebookSuggestModal } from "../src/notebook-modal";
import type { NotebookDiscovery } from "../src/storage";
import type { TFile } from "obsidian";

const files = [
  { path: "Ink Notes/Course/Algebra.ink", basename: "Algebra" },
  { path: "Ink Notes/Sketchbook.ink", basename: "Sketchbook" },
] as TFile[];
const discovery = (file: TFile): NotebookDiscovery => ({ path: file.path, title: file.basename, file });
const missingEntry: NotebookDiscovery = { path: "Archive/Gone.ink", title: "Gone", lastOpened: 5, file: null };
const modals: (NotebookSuggestModal | NotebookNameModal)[] = [];
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
  .find((el) => el.getAttribute("aria-label") === label || el.textContent === label)!;

function picker(entries = files.map(discovery)) {
  const select = vi.fn(), create = vi.fn(async () => undefined), rename = vi.fn(async () => undefined), clear = vi.fn(async () => undefined);
  const modal = new NotebookSuggestModal({} as never, entries, select, create, rename, clear);
  modals.push(modal); modal.open();
  return { modal, select, create, rename, clear };
}

afterEach(() => {
  modals.splice(0).forEach((modal) => modal.close());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.body.replaceChildren();
});

describe("notebook launcher", () => {
  it.each([{ entries: [] }, { entries: files.map(discovery) }])("keeps a fixed creation button when filtering has no results: $entries", ({ entries }) => {
    const { modal, create } = picker(entries);
    modal.inputEl.value = "No matching notebook";
    modal.inputEl.dispatchEvent(new Event("input"));
    expect(document.querySelectorAll(".ink-notebook-result")).toHaveLength(0);
    expect(button("Create Ink notebook")).toBeDefined();
    button("Create Ink notebook").click();
    expect(document.querySelector(".ink-notebook-picker")).toBeNull();
    expect(document.querySelector(".ink-notebook-name-modal")).not.toBeNull();
    expect(create).not.toHaveBeenCalled();
    button("Cancel").click();
    expect(document.querySelector(".preview-modal-container")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("filters paths case-insensitively and opens the chosen notebook", () => {
    const { modal, select } = picker();
    expect(modal.getSuggestions(" COURSE ").map((entry) => entry.file)).toEqual([files[0]]);
    const row = document.querySelector<HTMLElement>(".ink-notebook-result")!;
    expect(row.textContent).toContain("Algebra");
    expect(row.textContent).toContain(files[0].path);
    row.click();
    expect(select).toHaveBeenCalledExactlyOnceWith(files[0]);
  });

  it("offers the bulk clear action only when history entries are missing", () => {
    picker();
    expect(button("Clear missing notebook entries")).toBeUndefined();
    picker([...files.map(discovery), missingEntry]);
    expect(button("Clear missing notebook entries")).toBeDefined();
  });

  it("greys out missing history entries and clears one without opening anything", async () => {
    const { clear, select } = picker([discovery(files[0]), missingEntry]);
    const row = document.querySelector<HTMLElement>(".ink-notebook-result-missing")!;
    expect(row.textContent).toContain("Gone");
    expect(row.textContent).toContain("Archive/Gone.ink");
    expect(row.textContent).toContain("File missing");
    expect(button("Rename Gone")).toBeUndefined();
    const clearButton = button("Clear Gone from history");
    expect(clearButton).toBeDefined();
    row.click();
    expect(select).not.toHaveBeenCalled();
    clearButton.click();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledExactlyOnceWith([missingEntry]));
  });

  it("clears every missing entry through the bulk action", async () => {
    const missing = [
      { path: "Archive/Gone.ink", title: "Gone", lastOpened: 5, file: null },
      { path: "Courses/Also gone.ink", title: "Also gone", lastOpened: 4, file: null },
    ] as NotebookDiscovery[];
    const { clear } = picker([...files.map(discovery), ...missing]);
    button("Clear missing notebook entries").click();
    expect(document.querySelector(".ink-notebook-picker")).toBeNull();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledExactlyOnceWith(missing));
  });

  it("rename opens a prefilled name form without opening the selected notebook", async () => {
    const { select, rename } = picker();
    button("Rename Algebra").click();
    const input = document.querySelector<HTMLInputElement>(".ink-notebook-name-form input")!;
    expect(input.value).toBe("Algebra");
    expect(document.activeElement).toBe(input);
    input.value = "Linear Algebra";
    button("Rename").click();
    await vi.waitFor(() => expect(rename).toHaveBeenCalledExactlyOnceWith(files[0], "Linear Algebra"));
    expect(select).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(document.querySelector(".preview-modal-container")).toBeNull());
  });

  it("creates with the entered name and disables duplicate submissions until completion", async () => {
    let release!: () => void;
    const submit = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const modal = new NotebookNameModal({} as never, "Create Ink notebook", "Ink Notebook", "Create", submit);
    modals.push(modal); modal.open();
    document.querySelector<HTMLInputElement>("input")!.value = "  New Book  ";
    const form = document.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(submit).toHaveBeenCalledExactlyOnceWith("New Book", undefined);
    expect(button("Create").disabled).toBe(true);
    release();
    await vi.waitFor(() => expect(document.querySelector(".preview-modal-container")).toBeNull());
  });

  it("create mode collects an optional folder next to the name", async () => {
    const submit = vi.fn(async () => undefined);
    const modal = new NotebookNameModal({} as never, "Create Ink notebook", "Ink Notebook", "Create", submit, { folder: true });
    modals.push(modal); modal.open();
    const inputs = document.querySelectorAll<HTMLInputElement>(".ink-notebook-name-form input");
    expect(inputs).toHaveLength(2);
    expect(inputs[1].getAttribute("placeholder")).toContain("Ink Notes");
    inputs[0].value = "Algebra";
    inputs[1].value = " Courses/Math ";
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(submit).toHaveBeenCalledExactlyOnceWith("Algebra", "Courses/Math");
  });

  it.each(["..", "bad:name", ".", "a/b/../c"])("rejects invalid folders without a storage call: %s", (folder) => {
    const submit = vi.fn(async () => undefined);
    const modal = new NotebookNameModal({} as never, "Create Ink notebook", "Ink Notebook", "Create", submit, { folder: true });
    modals.push(modal); modal.open();
    const inputs = document.querySelectorAll<HTMLInputElement>(".ink-notebook-name-form input");
    inputs[0].value = "Algebra";
    inputs[1].value = folder;
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("valid folder path");
  });

  it.each(["a//b", "/leading", "trailing/", "a\\b"])("normalizes slash noise in folders instead of rejecting it: %s", async (folder) => {
    const submit = vi.fn(async () => undefined);
    const modal = new NotebookNameModal({} as never, "Create Ink notebook", "Ink Notebook", "Create", submit, { folder: true });
    modals.push(modal); modal.open();
    const inputs = document.querySelectorAll<HTMLInputElement>(".ink-notebook-name-form input");
    inputs[0].value = "Algebra";
    inputs[1].value = folder;
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(submit).toHaveBeenCalledWith("Algebra", expect.not.stringMatching(/(^\/|\/\/|\/$|\\)/));
  });

  it.each(["../Outside", "folder/book", "bad:name", ".", "x".repeat(81), "   "])("rejects invalid names without a storage call: %s", (name) => {
    const submit = vi.fn(async () => undefined);
    const modal = new NotebookNameModal({} as never, "Rename Ink notebook", "Existing", "Rename", submit);
    modals.push(modal); modal.open();
    document.querySelector<HTMLInputElement>("input")!.value = name;
    document.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(submit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("valid notebook name");
  });

  it("retains input and re-enables retry after a failed operation", async () => {
    const submit = vi.fn().mockRejectedValueOnce(new Error("A notebook with this name already exists"))
      .mockResolvedValueOnce(undefined);
    const modal = new NotebookNameModal({} as never, "Rename Ink notebook", "Existing", "Rename", submit);
    modals.push(modal); modal.open();
    const input = document.querySelector<HTMLInputElement>("input")!;
    input.value = "Duplicate";
    button("Rename").click();
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')!.textContent).toContain("already exists"));
    await vi.waitFor(() => expect(button("Rename").disabled).toBe(false));
    expect(input.value).toBe("Duplicate");
    input.value = "Unique";
    button("Rename").click();
    await vi.waitFor(() => expect(submit).toHaveBeenLastCalledWith("Unique", undefined));
    await vi.waitFor(() => expect(document.querySelector(".preview-modal-container")).toBeNull());
  });
});
