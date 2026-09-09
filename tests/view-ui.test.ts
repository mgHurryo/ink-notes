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
  it("starts with a collapsed rail and switches primary tools", () => {
    expect(document.querySelector(".ink-notes-view")?.classList.contains("ink-rail-hidden")).toBe(true);
    expect(button("Pen").getAttribute("aria-pressed")).toBe("true");
    button("Highlight").click();
    expect(button("Highlight").getAttribute("aria-pressed")).toBe("true");
    expect(button("Pen").getAttribute("aria-pressed")).toBe("false");
  });
  it("keeps page rail inside the workspace and updates navigation", () => {
    (view as unknown as { addPage(): void }).addPage();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("2 / 2");
    button("Pages").click();
    expect(button("Pages").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".ink-workspace > .ink-page-rail")).not.toBeNull();
    button("1: Page 1").click();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("1 / 2");
  });
  it("synchronizes preset, slider and custom-color selection", () => {
    button("8 px").click();
    button("Pen").click();
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
  it("exposes smoothing for pen tools without adding another persistent control", () => {
    button("Pen").click();
    const smoothing = document.querySelector<HTMLInputElement>('input[aria-label="Smoothing"]')!;
    expect(smoothing).toBeTruthy();
    expect(smoothing.value).toBe("0.7");
    smoothing.value = "0.9";
    smoothing.dispatchEvent(new Event("input"));
    expect(document.querySelector(".ink-size-popover-header .ink-control-value")?.textContent).toBe("3 px");
    button("Erase").click();
    expect(smoothing.offsetParent).toBeNull();
  });
  it("shows a reference cursor and only offers size for local erasers", () => {
    button("Erase").click();
    button("Erase").click();
    const popover = document.querySelector<HTMLElement>(".ink-size-popover")!;
    const size = document.querySelector<HTMLInputElement>('input[aria-label="Eraser size"]')!;
    expect(popover.classList.contains("is-stroke-eraser")).toBe(true);
    expect(document.querySelector(".ink-stroke-eraser-hint")?.textContent).toContain("Size is fixed");
    expect(document.querySelector(".ink-eraser-reference-point")).not.toBeNull();
    button("Circle eraser").click();
    expect(popover.classList.contains("is-stroke-eraser")).toBe(false);
    size.value = "48";
    size.dispatchEvent(new Event("input"));
    const cursor = document.querySelector<HTMLElement>(".ink-eraser-cursor")!;
    expect(cursor.style.width).toBe("48px");
    button("Square eraser").click();
    expect(cursor.classList.contains("is-square")).toBe(true);
    expect(button("Square eraser").getAttribute("aria-checked")).toBe("true");
  });
  it("shows the eraser reference on hover and refreshes it without pressing", () => {
    button("Erase").click();
    const paper = document.querySelector<HTMLElement>(".ink-page")!;
    paper.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    Object.assign(view as unknown as object, { canvasLogicalWidth: 100, canvasLogicalHeight: 100 });
    paper.dispatchEvent(new MouseEvent("pointerenter", { clientX: 40, clientY: 60, bubbles: false }));
    const cursor = document.querySelector<HTMLElement>(".ink-eraser-cursor")!;
    expect(cursor.classList.contains("is-visible")).toBe(true);
    expect(cursor.style.left).toBe("40px");
    expect(cursor.style.top).toBe("60px");

    button("Erase").click();
    button("Circle eraser").click();
    const size = document.querySelector<HTMLInputElement>('input[aria-label="Eraser size"]')!;
    size.value = "64";
    size.dispatchEvent(new Event("input"));
    expect(cursor.classList.contains("is-visible")).toBe(true);
    expect(cursor.classList.contains("is-stroke")).toBe(false);
    expect(cursor.style.width).toBe("64px");
    expect(cursor.style.left).toBe("40px");
    expect(cursor.querySelector(".ink-eraser-reference-point")).not.toBeNull();

    paper.dispatchEvent(new MouseEvent("pointerleave", { bubbles: false }));
    expect(cursor.classList.contains("is-visible")).toBe(false);
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
