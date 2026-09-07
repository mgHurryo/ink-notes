// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { InkView } from "../src/view";
import { createNotebook } from "../src/model";
import type { NotebookStore } from "../src/storage";
import type { WorkspaceLeaf } from "obsidian";

const button = (label: string) => document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!;
let view: InkView;
beforeEach(async () => {
  document.body.innerHTML = '<div id="host"><div></div><main></main></div>';
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const ctx = new Proxy({}, { get: () => vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as CanvasRenderingContext2D);
  view = new InkView({} as WorkspaceLeaf, { read: async () => createNotebook("Loaded notebook") } as unknown as NotebookStore);
  await view.onOpen();
});

afterEach(async () => {
  await view.onClose();
  const host = view as unknown as { cleanups: (() => void)[] };
  host.cleanups.forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reference-style editor", () => {
  it("starts with a collapsed rail and synchronizes both toolbars", () => {
    expect(document.querySelector(".ink-notes-view")?.classList.contains("ink-rail-hidden")).toBe(true);
    expect(button("Pen").getAttribute("aria-pressed")).toBe("true");
    button("Highlighter tip").click();
    expect(button("Highlight").getAttribute("aria-pressed")).toBe("true");
    expect(button("Pen").getAttribute("aria-pressed")).toBe("false");
  });
  it("keeps page rail inside the workspace and updates navigation", () => {
    button("Add page").click();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("2 / 2");
    expect(button("Previous").disabled).toBe(false);
    expect(button("Next").disabled).toBe(true);
    button("Pages").click();
    expect(button("Pages").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".ink-workspace > .ink-page-rail")).not.toBeNull();
    button("1: Page 1").click();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("1 / 2");
    expect(button("Previous").disabled).toBe(true);
  });
  it("synchronizes preset, slider and custom-color selection", () => {
    button("8 px").click();
    button("Brush size").click();
    const size = document.querySelector<HTMLInputElement>('input[aria-label="Brush size"]')!;
    expect(size.value).toBe("8");
    size.value = "5.5";
    size.dispatchEvent(new Event("input"));
    expect(button("8 px").getAttribute("aria-pressed")).toBe("false");
    expect(document.querySelector(".ink-size-popover-header .ink-control-value")?.textContent).toBe("5.5 px");
    const color = document.querySelector<HTMLInputElement>('input[type="color"]')!;
    color.value = "#abcdef";
    color.dispatchEvent(new Event("input"));
    expect(document.querySelector('.ink-color-swatch[aria-pressed="true"]')).toBeNull();
  });
  it("clamps zoom and resets the readout", () => {
    for (let i = 0; i < 40; i++) button("Zoom in").click();
    expect(button("Reset zoom").textContent).toBe("300%");
    expect(button("Zoom in").disabled).toBe(true);
    button("Reset zoom").click();
    expect(button("Reset zoom").textContent).toBe("100%");
  });
  it("refreshes document title after loading a file", async () => {
    await view.onLoadFile({} as never);
    expect(document.querySelector(".ink-document-title")?.textContent).toBe("Loaded notebook");
  });
});
