// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { InkView } from "../src/view";
import { createNotebook } from "../src/model";
import { defaultToolState } from "../src/tool-state";
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
  it.each([null, 7])("cancels native touchstart and empty touchend defaults during pointer %s", (pointerId) => {
    const paper = document.querySelector<HTMLElement>(".ink-page")!;
    const internal = view as unknown as { activePointerId: number | null; touchGesture: unknown };
    internal.activePointerId = pointerId;
    for (const type of ["touchstart", "touchend"]) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      const touches = type === "touchstart" ? [{ identifier: 7, clientX: 100, clientY: 100 }] : [];
      Object.defineProperty(event, "touches", { value: Object.assign(touches, { item: (index: number) => touches[index] ?? null }) });
      paper.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(internal.activePointerId).toBe(pointerId);
    }
    expect(internal.touchGesture).toBeNull();
    internal.activePointerId = null;
  });

  it("starts with a collapsed rail and switches primary tools", () => {
    expect(document.querySelector(".ink-notes-view")?.classList.contains("ink-rail-hidden")).toBe(true);
    expect(button("Pen").getAttribute("aria-pressed")).toBe("true");
    button("Highlight").click();
    expect(button("Highlight").getAttribute("aria-pressed")).toBe("true");
    expect(button("Pen").getAttribute("aria-pressed")).toBe("false");
  });
  it("switches tools without rebuilding or resizing the page", () => {
    const internal = view as unknown as { renderPage(): void; resizeCanvas(): void };
    const render = vi.spyOn(internal, "renderPage");
    const resize = vi.spyOn(internal, "resizeCanvas");
    button("Erase").click();
    expect(render).not.toHaveBeenCalled();
    expect(resize).not.toHaveBeenCalled();
    expect(button("Erase").getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps page rail inside the workspace and updates navigation", () => {
    (view as unknown as { addPage(): void }).addPage();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("2 / 2");
    button("Pages").click();
    expect(button("Pages").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".ink-workspace > .ink-page-rail")).not.toBeNull();
    button("1: Page 1").click();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("1 / 2");
    expect(button("Move current page up").disabled).toBe(true);
    expect(button("Move current page down").disabled).toBe(false);
    expect(button("Delete current page").disabled).toBe(false);
    button("Duplicate current page").click();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("2 / 3");
    button("Move current page down").click();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("3 / 3");
    button("Delete current page").click();
    expect(document.querySelector(".ink-page-status")?.textContent).toBe("2 / 2");
  });
  it("synchronizes preset, slider and custom-color selection", () => {
    button("Pen").click();   // re-tap opens the brush panel (lazy mount)
    button("Pen 8 px").click();
    button("Pen").click();
    const size = document.querySelector<HTMLInputElement>('input[aria-label="Pen size"]')!;
    expect(size.value).toBe("8");
    size.value = "5.5";
    size.dispatchEvent(new Event("input"));
    expect(button("Pen 8 px").getAttribute("aria-pressed")).toBe("false");
    // The pinned popover header carries the live size readout.
    expect(document.querySelector(".ink-popover-title")?.textContent).toBe("Pen settings · 5.5 px");
    const color = document.querySelector<HTMLInputElement>('input[aria-label="Pen custom color"]')!;
    color.value = "#abcdef";
    color.dispatchEvent(new Event("input"));
    expect(document.querySelector('.ink-color-swatch[data-brush-tool="pen"][aria-pressed="true"]')).toBeNull();
  });
  it("keeps pen and highlighter settings independent", () => {
    button("Pen").click();
    const penSize = document.querySelector<HTMLInputElement>('input[aria-label="Pen size"]')!;
    penSize.value = "6";
    penSize.dispatchEvent(new Event("input"));
    button("Pen blue").click();

    button("Highlight").click();
    const highlighterSize = document.querySelector<HTMLInputElement>('input[aria-label="Highlighter size"]')!;
    expect(highlighterSize.value).toBe("18");
    expect(button("Highlighter yellow").getAttribute("aria-pressed")).toBe("true");
    highlighterSize.value = "24";
    highlighterSize.dispatchEvent(new Event("input"));
    button("Highlighter green").click();

    button("Pen").click();
    expect(penSize.value).toBe("6");
    expect(button("Pen blue").getAttribute("aria-pressed")).toBe("true");
    expect(highlighterSize.value).toBe("24");
    expect(button("Highlighter green").getAttribute("aria-pressed")).toBe("true");
  });
  it("moves focus to the active tool's size slider when the popover opens", async () => {
    button("Highlight").click();   // first tap selects the highlighter
    button("Highlight").click();   // re-tap opens the brush popover
    await new Promise((resolve) => setTimeout(resolve, 30)); // open()'s rAF
    expect(document.activeElement).toBe(
      document.querySelector<HTMLInputElement>('input[aria-label="Highlighter size"]'));
  });
  it("hints and applies double-click set-as-default on a swatch", () => {
    button("Pen").click();
    const blue = button("Pen blue");
    expect(blue.getAttribute("title")).toContain("double-click to set as default");
    blue.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(blue.getAttribute("aria-pressed")).toBe("true");
  });
  it("schedules a shared-settings save when popover and eraser controls change", () => {
    const scheduleSave = vi.fn();
    (view as unknown as { sharedToolSettings: unknown }).sharedToolSettings = {
      config: defaultToolState(),
      scheduleSave,
    };
    button("Pen").click();
    const size = document.querySelector<HTMLInputElement>('input[aria-label="Pen size"]')!;
    size.value = "9";
    size.dispatchEvent(new Event("input"));
    expect(scheduleSave).toHaveBeenCalled();

    button("Erase").click();
    button("Erase").click();
    const calls = scheduleSave.mock.calls.length;
    button("Circle eraser").click();
    expect(scheduleSave.mock.calls.length).toBe(calls + 1);
    expect((scheduleSave.mock.calls[calls][0] as { eraserMode: string }).eraserMode).toBe("circle");
  });
  it("shows a reference cursor and only offers size + mode in the eraser mini popover", () => {
    button("Erase").click();
    button("Erase").click();
    const popover = document.querySelector<HTMLElement>(".ink-eraser-popover")!;
    const size = document.querySelector<HTMLInputElement>('input[aria-label="Eraser size"]')!;
    const strokeMode = popover.querySelector<HTMLElement>('[data-eraser-mode="stroke"]')!;
    expect(strokeMode.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".ink-eraser-reference-point")).not.toBeNull();
    button("Circle eraser").click();
    expect(strokeMode.getAttribute("aria-checked")).toBe("false");
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
  it("removes legacy chrome and offscreen focus targets", async () => {
    await view.onLoadFile({} as never);
    expect(view.getDisplayText()).toBe("Loaded notebook");
    expect(document.querySelector(".ink-document-bar, .ink-brush-bar, .ink-statusbar")).toBeNull();
    expect(button("Zoom in")).toBeNull();
    expect(button("Zoom out")).toBeNull();
    expect(button("Reset zoom")).toBeNull();
    button("Pen").click();   // lazy: the panel exists once opened
    expect(document.querySelector(".ink-size-popover")).not.toBeNull();
  });
});
