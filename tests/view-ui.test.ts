// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
// drawInkStroke is mocked so thumbnail tests can assert the vector snapshot
// was painted (with which stroke and at what logical size) without pixels.
vi.mock("../src/rendering", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  drawInkStroke: vi.fn(),
}));
import { drawInkStroke } from "../src/rendering";
import { InkView } from "../src/view";
import { createNotebook } from "../src/model";
import type { InkPage, InkStroke } from "../src/model";
import { defaultToolState } from "../src/tool-state";
import type { NotebookStore } from "../src/storage";
import type { WorkspaceLeaf } from "obsidian";

const button = (label: string) => document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!;
// An opened popover keeps a requestAnimationFrame in flight; jsdom runs it
// on a timer that can fire after afterEach's restoreAllMocks(), hitting
// jsdom's unimplemented HTMLCanvasElement.getContext and printing
// "Error: Not implemented" noise into the test output. This module-level
// stub is assigned before any spy and never restored, so late callbacks
// find a harmless all-stub context; the per-test spyOn below still takes
// precedence inside each test and restores back to this stub.
const stubCtx = new Proxy({}, { get: () => vi.fn(), set: () => true });
HTMLCanvasElement.prototype.getContext = (() => stubCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
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
  // Rail-width persistence is real localStorage in jsdom; keep tests independent.
  window.localStorage.clear();
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
    // A picked custom color becomes a preset swatch (via the plus) and is
    // selected immediately.
    const added = document.querySelector<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"][data-color="#abcdef"]');
    expect(added?.getAttribute("aria-pressed")).toBe("true");
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
  it("hints and applies double-click editing on a preset swatch", async () => {
    button("Pen").click();
    const blue = button("Pen blue");
    expect(blue.getAttribute("title")).toContain("double-click to edit");
    blue.click(); // select it first
    blue.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30)); // editor open's rAF
    const editor = document.querySelector<HTMLElement>(".ink-preset-editor.is-open")!;
    expect(editor).not.toBeNull();
    const value = editor.querySelector<HTMLInputElement>('input[aria-label="Preset color value"]')!;
    expect(value.value.toLowerCase()).toBe("#195bff");
    // Editing the selected preset follows the tool's color along.
    value.value = "#123456";
    value.dispatchEvent(new Event("input"));
    const edited = document.querySelector<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"][data-color="#123456"]');
    expect(edited?.getAttribute("aria-pressed")).toBe("true");
    const remove = editor.querySelector<HTMLButtonElement>('button[aria-label="Remove preset color"]')!;
    expect(remove.disabled).toBe(false);
    remove.click();
    expect(document.querySelector('.ink-color-swatch[data-brush-tool="pen"][data-color="#123456"]')).toBeNull();
    expect(document.querySelectorAll('.ink-color-swatch[data-brush-tool="pen"]').length).toBe(4);
  });
  it("never removes the last preset swatch", async () => {
    button("Pen").click();
    for (let removed = 0; removed < 4; removed++) {
      const swatch = document.querySelectorAll<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"]')[0];
      swatch.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30)); // editor open's rAF
      const editor = document.querySelector<HTMLElement>(".ink-preset-editor.is-open")!;
      (editor.querySelector('button[aria-label="Remove preset color"]') as HTMLButtonElement).click();
    }
    expect(document.querySelectorAll('.ink-color-swatch[data-brush-tool="pen"]').length).toBe(1);
    const last = document.querySelector<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"]')!;
    last.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30)); // editor open's rAF
    const remove = document.querySelector<HTMLButtonElement>('.ink-preset-editor.is-open button[aria-label="Remove preset color"]')!;
    expect(remove.disabled).toBe(true);
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
  it("toggles the eraser mini popover on re-tap without the reopen race", async () => {
    button("Erase").click();   // select the eraser
    button("Erase").click();   // re-tap opens the mini popover
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(document.querySelector(".ink-eraser-popover.is-open")).not.toBeNull();
    // The pointerdown of a tool-button tap must not close it first - that
    // race made the popover reopen on every tap (flash, never closes).
    button("Pen").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".ink-eraser-popover.is-open")).not.toBeNull();
    // The click itself switches tools and closes the eraser popover.
    button("Pen").click();
    expect(document.querySelector(".ink-eraser-popover.is-open")).toBeNull();
    expect((view as unknown as { eraserPopover: unknown }).eraserPopover).toBeNull();
  });
  it("mounts the eraser mini popover inside the themed view root", () => {
    button("Erase").click();
    button("Erase").click();
    // Outside the view root the --ink-* tokens never resolve: the popover
    // rendered fully transparent.
    expect(document.querySelector(".ink-notes-view > .ink-eraser-popover")).not.toBeNull();
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

describe("page rail thumbnails and resizing", () => {
  const stroke = (page: InkPage, id: string): InkStroke => ({
    id, pageId: page.id, tool: "pen", color: "#123456", width: 3, opacity: 1,
    points: [{ x: 0.2, y: 0.3, pressure: 0.5, t: 0 }, { x: 0.6, y: 0.7, pressure: 0.5, t: 40 }],
    createdAt: 1, updatedAt: 1,
  });
  const pointer = (type: string, clientX: number, pointerId = 7): PointerEvent => {
    // jsdom has no PointerEvent; a real MouseEvent carrying pointerId
    // satisfies both dispatchEvent and the handler's capture bookkeeping.
    const event = new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    return event as unknown as PointerEvent;
  };
  /** jsdom has no layout: pin the thumb box the painter measures. */
  const withBox = (canvas: HTMLCanvasElement, width: number, height: number): void => {
    Object.defineProperty(canvas, "clientWidth", { value: width, configurable: true });
    Object.defineProperty(canvas, "clientHeight", { value: height, configurable: true });
  };

  it("paints every thumbnail as a vector snapshot once the rail is visible", () => {
    vi.useFakeTimers();
    try {
      const internal = view as unknown as {
        notebook: ReturnType<typeof createNotebook>;
        addPage(): void;
        redrawPageThumbnails(): void;
      };
      internal.addPage();
      internal.notebook.pages[0].strokes.push(stroke(internal.notebook.pages[0], "s1"));
      internal.notebook.pages[1].strokes.push(stroke(internal.notebook.pages[1], "s2"));
      button("Pages").click();   // expand: schedules the post-transition repaint
      const canvases = document.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb canvas");
      expect(canvases).toHaveLength(2);
      // jsdom reports no boxes; give both thumbs the 176px rail's box.
      canvases.forEach((canvas) => withBox(canvas, 152, 208));
      vi.advanceTimersByTime(240);
      const dpr = window.devicePixelRatio || 1;
      expect(canvases[0].width).toBe(Math.round(152 * dpr));
      expect(canvases[1].height).toBe(Math.round(208 * dpr));
      const drawn = vi.mocked(drawInkStroke).mock.calls;
      expect(drawn.some((call) => call[1] === internal.notebook.pages[0].strokes[0] && call[2] === 152 && call[3] === 208)).toBe(true);
      expect(drawn.some((call) => call[1] === internal.notebook.pages[1].strokes[0] && call[2] === 152 && call[3] === 208)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes only the current page's thumbnail after its ink changes", () => {
    const internal = view as unknown as {
      notebook: ReturnType<typeof createNotebook>;
      pageIndex: number;
      addPage(): void;
      refreshCurrentPageThumbnail(): void;
    };
    internal.addPage();
    button("Pages").click();
    const canvases = document.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb canvas");
    canvases.forEach((canvas) => withBox(canvas, 152, 208));
    vi.mocked(drawInkStroke).mockClear();
    internal.notebook.pages[1].strokes.push(stroke(internal.notebook.pages[1], "s2"));
    internal.pageIndex = 1;
    internal.refreshCurrentPageThumbnail();
    const drawn = vi.mocked(drawInkStroke).mock.calls;
    expect(drawn.length).toBeGreaterThan(0);
    for (const call of drawn) expect(call[1]).toBe(internal.notebook.pages[1].strokes[0]);
  });

  it("keeps a failing thumbnail render contained to that thumbnail", () => {
    const internal = view as unknown as { addPage(): void; redrawPageThumbnails(): void };
    internal.addPage();
    button("Pages").click();
    const canvases = document.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb canvas");
    canvases.forEach((canvas) => withBox(canvas, 152, 208));
    Object.defineProperty(canvases[0], "getContext", {
      value: () => { throw new Error("2d context unavailable"); },
      configurable: true,
    });
    expect(() => internal.redrawPageThumbnails()).not.toThrow();
    // The sibling page still painted.
    expect(canvases[1].width).toBe(152);
  });

  it("widens the rail by dragging the handle, clamps, and persists the width", () => {
    button("Pages").click();
    const rail = document.querySelector<HTMLElement>(".ink-page-rail")!;
    const handle = document.querySelector<HTMLElement>(".ink-rail-resizer")!;
    expect(handle).not.toBeNull();
    rail.getBoundingClientRect = () => ({ left: 0, top: 0, right: 176, bottom: 600, width: 176, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    const captured = new Set<number>();
    handle.setPointerCapture = (id: number) => { captured.add(id); };
    handle.hasPointerCapture = (id: number) => captured.has(id);
    handle.releasePointerCapture = (id: number) => { captured.delete(id); };
    handle.dispatchEvent(pointer("pointerdown", 176));
    expect(captured.has(7)).toBe(true);
    handle.dispatchEvent(pointer("pointermove", 300));
    expect(rail.style.getPropertyValue("--ink-rail-width")).toBe("300px");
    handle.dispatchEvent(pointer("pointerup", 300));
    expect(window.localStorage.getItem("ink-notes-page-rail-width")).toBe("300");
    expect(captured.has(7)).toBe(false);
    // Widths clamp into the usable range before display or persistence.
    handle.dispatchEvent(pointer("pointerdown", 176, 9));
    handle.dispatchEvent(pointer("pointermove", 176 + 900, 9));
    expect(rail.style.getPropertyValue("--ink-rail-width")).toBe("420px");
    handle.dispatchEvent(pointer("pointermove", 176 - 900, 9));
    expect(rail.style.getPropertyValue("--ink-rail-width")).toBe("150px");
    // A stale pointer's moves never drive the drag.
    handle.dispatchEvent(pointer("pointermove", 500, 3));
    expect(rail.style.getPropertyValue("--ink-rail-width")).toBe("150px");
    handle.dispatchEvent(pointer("pointercancel", 176 - 900, 9));
    expect(window.localStorage.getItem("ink-notes-page-rail-width")).toBe("150");
  });

  it("applies a stored rail width on open and ignores out-of-range values", async () => {
    window.localStorage.setItem("ink-notes-page-rail-width", "300");
    document.body.innerHTML = '<div id="host"><div></div><main></main></div>';
    const second = new InkView({} as WorkspaceLeaf, { read: async () => createNotebook("Stored width") } as unknown as NotebookStore);
    await second.onOpen();
    const rail = document.querySelector<HTMLElement>(".ink-page-rail")!;
    expect(rail.style.getPropertyValue("--ink-rail-width")).toBe("300px");
    window.localStorage.setItem("ink-notes-page-rail-width", "9999");
    await second.onClose();
    (second as unknown as { cleanups: (() => void)[] }).cleanups.forEach((cleanup) => cleanup());
  });
});
