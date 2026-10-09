// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { NotebookNameModal, NotebookSuggestModal } from "../src/notebook-modal";
import type { TFile } from "obsidian";

const files = [
  { path: "Ink Notes/Course/Algebra.ink", basename: "Algebra" },
  { path: "Ink Notes/Sketchbook.ink", basename: "Sketchbook" },
] as TFile[];
const modals: (NotebookSuggestModal | NotebookNameModal)[] = [];
const button = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
  .find((el) => el.getAttribute("aria-label") === label || el.textContent === label)!;

function picker(entries = files) {
  const select = vi.fn(), create = vi.fn(async () => undefined), rename = vi.fn(async () => undefined);
  const modal = new NotebookSuggestModal({} as never, entries, select, create, rename);
  modals.push(modal); modal.open();
  return { modal, select, create, rename };
}

afterEach(() => {
  modals.splice(0).forEach((modal) => modal.close());
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  document.body.replaceChildren();
});

describe("notebook launcher", () => {
  it.each([{ entries: [] }, { entries: files }])("keeps a fixed creation button when filtering has no results: $entries", ({ entries }) => {
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
    expect(modal.getSuggestions(" COURSE ")).toEqual([files[0]]);
    const row = document.querySelector<HTMLElement>(".ink-notebook-result")!;
    expect(row.textContent).toContain("Algebra");
    expect(row.textContent).toContain(files[0].path);
    row.click();
    expect(select).toHaveBeenCalledExactlyOnceWith(files[0]);
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
    expect(submit).toHaveBeenCalledExactlyOnceWith("New Book");
    expect(button("Create").disabled).toBe(true);
    release();
    await vi.waitFor(() => expect(document.querySelector(".preview-modal-container")).toBeNull());
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
    await vi.waitFor(() => expect(submit).toHaveBeenLastCalledWith("Unique"));
    await vi.waitFor(() => expect(document.querySelector(".preview-modal-container")).toBeNull());
  });
});
