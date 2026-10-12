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
import { Menu } from "obsidian";
import { gestureContract } from "./gesture-contract";

const button = (label: string) => document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!;
/** iPads deliver no dblclick for touch; the preset editor opens on two taps. */
const doubleTap = (el: HTMLElement): void => {
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
};
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

gestureContract(async () => view);

describe("reference-style editor", () => {
  it("duplicates sticky boards with independent note/stroke ownership and content", () => {
    const host = view as any, page = host.notebook.pages[0];
    button("Add sticky note").click();
    const sticky = page.stickyNotes[0];
    sticky.strokes.push({ id: "source-ink", pageId: sticky.id, tool: "pen", width: 3, opacity: 1, color: "#000000",
      points: [{ x: 4, y: 8, pressure: .5, t: 1 }], createdAt: 1, updatedAt: 1 });
    expect(document.querySelector(".ink-sticky-editor")).toBeNull();
    host.duplicateCurrentPage();
    const duplicate = host.notebook.pages[1], copy = duplicate.stickyNotes[0];
    expect(copy.id).not.toBe(page.stickyNotes[0].id);
    expect(copy.pageId).toBe(duplicate.id); expect(copy.strokes[0].pageId).toBe(copy.id);
    expect(copy.strokes[0].id).not.toBe(page.stickyNotes[0].strokes[0].id);
    expect(copy.strokes[0].points).toEqual(page.stickyNotes[0].strokes[0].points);
    copy.strokes[0].points[0].x = 90; expect(page.stickyNotes[0].strokes[0].points[0].x).toBe(4);
  });
  function selectSampleInk() {
    const host = view as unknown as { notebook: ReturnType<typeof createNotebook>; canvasLogicalWidth: number; canvasLogicalHeight: number;
      lassoPath: { x: number; y: number; pressure: number; t: number }[]; finishLasso(page: InkPage): void; clearSelection(): void };
    host.canvasLogicalWidth = 100; host.canvasLogicalHeight = 100;
    const page = host.notebook.pages[0];
    page.strokes.push({ id: "selected", pageId: page.id, tool: "pen", color: "#123456", width: 3, opacity: 1,
      createdAt: 1, updatedAt: 1, points: [{ x: 0.2, y: 0.3, pressure: 0.5, t: 1 }, { x: 0.4, y: 0.4, pressure: 0.7, t: 2 }] });
    button("Select").click();
    host.lassoPath = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]].map(([x, y]) => ({ x, y, pressure: 0.5, t: 1 }));
    host.finishLasso(page);
    return { host, page };
  }

  it("offers copy, cut, delete and paste after lasso selection with one-step history", () => {
    const { page } = selectSampleInk();
    expect(button("Paste").disabled).toBe(true);
    button("Copy").click();
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
    expect(page.strokes).toHaveLength(1);
    document.querySelector<HTMLElement>(".ink-page-scroller")!.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
    expect(page.strokes).toHaveLength(2);
    expect(page.strokes[1].id).not.toBe("selected");
    button("Undo").click();
    expect(page.strokes).toHaveLength(1);
    button("Redo").click();
    expect(page.strokes).toHaveLength(2);
    button("Select").click();
    expect(document.querySelector('[aria-label="Lasso settings"]')).not.toBeNull();
  });

  it.each([
    [0.1, 0.1, 0.5, 0.5], [0.5, 0.5, 0.1, 0.1],
    [0.1, 0.5, 0.5, 0.1], [0.5, 0.1, 0.1, 0.5],
  ])("selects a rectangle in any drag direction (%s, %s to %s, %s)", (x1, y1, x2, y2) => {
    const { host, page } = selectSampleInk();
    button("Select").click();
    const freehand = document.querySelector<HTMLButtonElement>('[aria-label="Freehand selection"]')!;
    const rectangle = document.querySelector<HTMLButtonElement>('[aria-label="Rectangle selection"]')!;
    expect(freehand.getAttribute("aria-checked")).toBe("true");
    rectangle.click();
    expect(rectangle.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
    const base = page.strokes[0];
    const originalPoints = structuredClone(base.points);
    const points = (pairs: number[][]) => pairs.map(([x, y]) => ({ x, y, pressure: 0.5, t: 1 }));
    page.strokes.push(
      { ...base, id: "crossing", points: points([[0, 0.35], [0.9, 0.35]]) },
      { ...base, id: "miss", points: points([[0.3, 0.8], [0.8, 0.3]]) },
      { ...base, id: "outside", points: points([[0.9, 0.9]]) });
    const editor = host as unknown as { inputRect(): DOMRect; selectedStrokeIds: Set<string>; state: ReturnType<typeof defaultToolState>;
      onPointerDown(event: unknown): void; onPointerMove(event: unknown): void; onPointerUp(event: unknown): void };
    vi.spyOn(editor, "inputRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const inputHost = document.querySelector<HTMLElement>(".ink-page")!;
    inputHost.hasPointerCapture = () => false;
    inputHost.setPointerCapture = vi.fn();
    inputHost.releasePointerCapture = vi.fn();
    const event = (x: number, y: number) => ({ pointerId: 1, pointerType: "pen", clientX: x * 100, clientY: y * 100, pressure: 0.5 });
    editor.onPointerDown(event(x1, y1));
    // A different pane can change the shared setting during this drag.
    editor.state.lasso.mode = "freehand";
    editor.onPointerMove(event(x2, y2));
    editor.onPointerUp(event(x2, y2));
    expect([...editor.selectedStrokeIds].sort()).toEqual(["crossing", "selected"]);
    button("Copy").click();
    document.querySelector<HTMLElement>(".ink-page-scroller")!.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
    expect(page.strokes).toHaveLength(6);
    button("Undo").click();
    expect(page.strokes).toHaveLength(4);
    expect(base.points).toEqual(originalPoints);
  });

  it.each([[0.1, 0.1], [0.1, 0.5], [0.5, 0.1]])("does not select ink from a zero-area rectangle ending at %s, %s", (x, y) => {
    const { host, page } = selectSampleInk();
    button("Select").click();
    document.querySelector<HTMLButtonElement>('[aria-label="Rectangle selection"]')!.click();
    host.lassoPath = [{ x: 0.1, y: 0.1, pressure: 0.5, t: 1 }, { x, y, pressure: 0.5, t: 2 }];
    host.finishLasso(page);
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
    expect(page.strokes).toHaveLength(1);
  });

  it("cuts selected ink and allows paste onto empty paper; delete does not replace copied ink", () => {
    const { page } = selectSampleInk();
    button("Cut").click();
    expect(page.strokes).toHaveLength(0);
    expect(page.deletedStrokeIds).toContain("selected");
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true }));
    expect(page.strokes).toHaveLength(1);
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect(page.strokes).toHaveLength(0);
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
    button("Undo").click();
    expect(page.strokes).toHaveLength(1);
  });

  it("closes Delete and never reopens Paste after clicking outside a copied selection", () => {
    const { host, page } = selectSampleInk();
    button("Copy").click();
    const editor = host as any;
    vi.spyOn(editor, "inputRect").mockReturnValue(new DOMRect(0, 0, 100, 100));
    const paper = document.querySelector<HTMLElement>('.ink-page')!;
    paper.hasPointerCapture = () => false; paper.setPointerCapture = vi.fn(); paper.releasePointerCapture = vi.fn();
    const event = { pointerId: 5, pointerType: "mouse", clientX: 90, clientY: 90, pressure: .5 };
    editor.onPointerDown(event); editor.onPointerUp(event);
    expect(editor.selectedStrokeIds.size).toBe(0);
    expect(document.querySelector('.ink-selection-actions')).toBeNull();
    host.lassoPath = [[.1, .1], [.5, .1], [.5, .5], [.1, .5]].map(([x, y]) => ({ x, y, pressure: .5, t: 1 }));
    host.finishLasso(page); button("Delete").click();
    expect(document.querySelector('.ink-selection-actions')).toBeNull();
    expect(page.strokes).toHaveLength(0);
    button("Undo").click(); expect(page.strokes).toHaveLength(1);
    expect(document.querySelector('.ink-selection-actions')).toBeNull();
  });

  it("supports lasso shortcuts and clears stale selection when switching pages", async () => {
    const { host, page } = selectSampleInk();
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    const key = (key: string, ctrlKey = false) => scroller.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true }));
    key("c", true); key("x", true);
    expect(page.strokes).toHaveLength(0);
    key("v", true);
    expect(page.strokes).toHaveLength(1);
    key("Delete");
    expect(page.strokes).toHaveLength(0);
    button("Undo").click();
    host.lassoPath = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]].map(([x, y]) => ({ x, y, pressure: 0.5, t: 1 }));
    host.finishLasso(page);
    const editor = host as unknown as { addPage(): void; navigateToPage(id: string): Promise<void>; selectedStrokeIds: Set<string>; pasteTarget: unknown };
    editor.addPage();
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
    expect(editor.selectedStrokeIds.size).toBe(0);
    expect(editor.pasteTarget).toBeNull();
    await editor.navigateToPage(page.id);
    button("Reading mode").click();
    key("v", true);
    expect(page.strokes).toHaveLength(1);
  });

  it("keeps the action strip within a split-pane viewport when the selection is near the edge", () => {
    const { host } = selectSampleInk();
    const strip = document.querySelector<HTMLElement>(".ink-selection-actions")!;
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 100, 320, 500));
    Object.defineProperties(strip, { offsetWidth: { value: 250 }, offsetHeight: { value: 60 } });
    const positionHost = host as unknown as { inputRect(): DOMRect; positionSelectionActions(): void };
    vi.spyOn(positionHost, "inputRect").mockReturnValue(new DOMRect(200, 100, 1000, 1000));
    positionHost.positionSelectionActions();
    expect(parseFloat(strip.style.left)).toBeGreaterThanOrEqual(208);
    expect(parseFloat(strip.style.left) + 250).toBeLessThanOrEqual(512);
    expect(parseFloat(strip.style.top)).toBeGreaterThanOrEqual(108);
    button("Reading mode").click();
    expect(document.querySelector(".ink-selection-actions")).toBeNull();
  });
  it("locks notebook mutations and closes settings in reading mode, then restores editing", () => {
    const host = view as unknown as { notebook: ReturnType<typeof createNotebook>; readingMode: boolean;
      inputLocked(): boolean; addPage(): void; duplicateCurrentPage(): void; deleteCurrentPage(): void; moveCurrentPage(n: number): void;
      undo(): void; redo(): void; state: { tool: string }; onTouchStart(e: TouchEvent): void; onTouchMove(e: TouchEvent): void };
    host.addPage();
    button("Pen").click();
    expect(document.querySelector(".ink-size-popover.is-open")).not.toBeNull();
    button("Reading mode").click();
    expect(document.querySelector(".ink-size-popover.is-open")).toBeNull();
    expect(button("Reading mode").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".ink-notes-view")!.classList.contains("ink-reading")).toBe(true);
    expect(host.inputLocked()).toBe(true);
    const before = JSON.stringify(host.notebook);
    host.addPage(); host.duplicateCurrentPage(); host.deleteCurrentPage(); host.moveCurrentPage(-1); host.undo(); host.redo();
    button("Add page").click(); button("Page options").click(); button("Erase").click();
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(host.state.tool).toBe("pen");
    expect(document.querySelector(".preview-menu")).toBeNull();
    expect(JSON.stringify(host.notebook)).toBe(before);
    button("Pages").click();
    expect(document.querySelector(".ink-notes-view")!.classList.contains("ink-rail-hidden")).toBe(false);
    button("Reading mode").click();
    expect(host.inputLocked()).toBe(false);
    button("Erase").click();
    expect(host.state.tool).toBe("eraser");
    host.addPage();
    expect(host.notebook.pages).toHaveLength(3);
  });

  it("keeps desktop shortcuts out of form fields and supports native button Space activation", () => {
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    const host = view as unknown as { state: { tool: string }; desktopSpaceDown: boolean };
    const input = document.querySelector(".ink-notes-view")!.createEl("input");
    input.focus();
    const typing = new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true });
    input.dispatchEvent(typing);
    expect(typing.defaultPrevented).toBe(false);
    expect(host.state.tool).toBe("pen");
    const buttonSpace = new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true });
    button("Pages").dispatchEvent(buttonSpace);
    expect(buttonSpace.defaultPrevented).toBe(false);
    scroller.focus();
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
    expect(host.desktopSpaceDown).toBe(true);
    window.dispatchEvent(new Event("blur"));
    expect(host.desktopSpaceDown).toBe(false);
    expect(scroller.classList.contains("ink-pan-ready")).toBe(false);
  });

  it("normalizes line/page wheel zoom, preserves scrolling and honors the zoom lock", () => {
    const host = view as unknown as { zoom: number; zoomLocked: boolean; desktopZoom(f: number, target?: unknown): void };
    const zoom = vi.spyOn(host, "desktopZoom");
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    Object.defineProperty(scroller, "clientHeight", { value: 600 });
    const wheel = (deltaY: number, deltaMode = 0, ctrlKey = true) => {
      const event = new WheelEvent("wheel", { deltaY, deltaMode, ctrlKey, bubbles: true, cancelable: true });
      scroller.dispatchEvent(event); return event;
    };
    expect(wheel(30, 0, false).defaultPrevented).toBe(true);
    expect(zoom).not.toHaveBeenCalled();
    wheel(-1, 1);
    expect(zoom).toHaveBeenLastCalledWith(Math.exp(16 * 0.004), { x: 0, y: 0 });
    host.zoomLocked = true;
    const before = host.zoom;
    expect(wheel(-1, 2).defaultPrevented).toBe(true);
    expect(host.zoom).toBe(before);
  });

  it.each([
    ["Add page before current", 1], ["Add page after current", 2],
    ["Add page before first", 0], ["Add page after last", 3],
  ])("inserts and selects a blank page with %s, with undo and redo", (label, index) => {
    const host = view as unknown as { notebook: ReturnType<typeof createNotebook>; pageIndex: number; addPage(): void };
    host.addPage(); host.addPage(); host.pageIndex = 1;
    const previous = host.notebook.pages.map((page) => page.id);
    button("Add page").click();
    Array.from(document.querySelectorAll<HTMLButtonElement>(".preview-menu button"))
      .find((item) => item.textContent === label)!.click();
    const added = host.notebook.pages[index];
    expect(host.pageIndex).toBe(index);
    expect(added).toMatchObject({ paper: "blank", strokes: [] });
    expect(host.notebook.pageOrder).toEqual(host.notebook.pages.map((page) => page.id));
    expect(host.notebook.pages.filter((page) => page.id !== added.id).map((page) => page.id)).toEqual(previous);
    button("Undo").click();
    expect(host.notebook.pages.map((page) => page.id)).toEqual(previous);
    expect(host.pageIndex).toBe(1);
    button("Redo").click();
    expect(host.pageIndex).toBe(index);
    expect(host.notebook.pages[index].strokes).toEqual([]);
  });

  it("switches between the plus and options menus and toggles plus closed", () => {
    button("Page options").click();
    button("Add page").click();
    expect(document.querySelectorAll(".preview-menu")).toHaveLength(1);
    expect(button("Page options").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".preview-menu")!.textContent).toContain("Add page before first");
    button("Add page").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    button("Add page").click();
    expect(document.querySelector(".preview-menu")).toBeNull();
  });

  it("creates once after a deliberate boundary release, and cancels short or interrupted drags", async () => {
    const host = view as unknown as { notebook: ReturnType<typeof createNotebook>; pageIndex: number; pageScroller: HTMLElement;
      onTouchStart(e: TouchEvent): void; onTouchMove(e: TouchEvent): void; cancelPageFlip(): void; flipSettling: boolean };
    Object.defineProperties(host.pageScroller, { clientWidth: { value: 800 }, clientHeight: { value: 700 } });
    const touch = (x?: number) => ({ touches: x === undefined ? [] : [{ identifier: 1, clientX: x, clientY: 200 }],
      timeStamp: 100, cancelable: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as TouchEvent);
    const drag = (distance: number) => { host.onTouchStart(touch(400)); host.onTouchMove(touch(400 + distance)); };
    const original = host.notebook.pages[0].id;
    drag(80); host.onTouchStart(touch());
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(host.notebook.pages).toHaveLength(1);
    drag(250);
    expect(document.querySelector(".ink-swipe-stage")!.classList.contains("is-ready")).toBe(true);
    host.cancelPageFlip(); host.onTouchStart(touch());
    await vi.waitFor(() => expect(host.flipSettling).toBe(false));
    expect(host.notebook.pages).toHaveLength(1);
    drag(250); host.onTouchStart(touch()); host.onTouchStart(touch());
    expect(host.notebook.pages).toHaveLength(2);
    expect(host.pageIndex).toBe(0);
    expect(host.notebook.pages[1].id).toBe(original);
    expect(host.notebook.pages[0].paper).toBe("blank");
  });

  it("shows pinch magnification, keeps it while held, and hides within one second of release", () => {
    vi.useFakeTimers();
    try {
      const host = view as unknown as { onTouchStart(e: TouchEvent): void; onTouchMove(e: TouchEvent): void };
      const touch = (points: number[][]) => ({ touches: points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })),
        cancelable: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as TouchEvent);
      host.onTouchStart(touch([[1, 200, 300], [2, 300, 300]]));
      host.onTouchMove(touch([[1, 150, 300], [2, 350, 300]]));
      const hud = document.querySelector<HTMLElement>(".ink-zoom-hud")!;
      expect(hud.textContent).toContain("200%");
      expect(hud.getAttribute("aria-hidden")).toBe("false");
      vi.advanceTimersByTime(1500);
      expect(hud.classList.contains("is-visible")).toBe(true);
      host.onTouchStart(touch([]));
      vi.advanceTimersByTime(849);
      expect(hud.classList.contains("is-visible")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(hud.getAttribute("aria-hidden")).toBe("true");
      expect(button("Lock zoom").getAttribute("tabindex")).toBe("-1");
    } finally { vi.useRealTimers(); }
  });

  it("locks menu and wheel zoom, shows attempted pinches, and unlocks without a distance jump", () => {
    const host = view as unknown as { zoom: number; zoomLocked: boolean; touchGesture: { zoom: number; distance: number };
      onTouchStart(e: TouchEvent): void; onTouchMove(e: TouchEvent): void; onWheel(e: WheelEvent): void };
    const touch = (points: number[][]) => ({ touches: points.map(([identifier, clientX, clientY]) => ({ identifier, clientX, clientY })),
      cancelable: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as TouchEvent);
    host.onTouchStart(touch([[1, 200, 300], [2, 300, 300]]));
    host.onTouchMove(touch([[1, 150, 300], [2, 350, 300]]));
    button("Lock zoom").click();
    expect(host.zoomLocked).toBe(true);
    expect(button("Unlock zoom").getAttribute("aria-pressed")).toBe("true");
    host.onTouchMove(touch([[1, 100, 300], [2, 400, 300]]));
    expect(host.zoom).toBe(2);
    host.onWheel({ ctrlKey: true, deltaY: -10, preventDefault: vi.fn() } as unknown as WheelEvent);
    expect(host.zoom).toBe(2);
    button("Page options").click();
    const menuButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".preview-menu button"));
    expect(menuButtons.filter((item) => ["Zoom out", "Reset zoom", "Zoom in"].includes(item.textContent!))
      .every((item) => item.disabled)).toBe(true);
    button("Page options").click();
    button("Unlock zoom").click();
    expect(host.touchGesture.distance).toBe(300);
    const companion = touch([[1, 100, 300], [2, 400, 300], [3, 300, 100]]);
    Object.assign(companion.touches[2], { target: button("Lock zoom") });
    host.onTouchMove(companion);
    expect(host.touchGesture.distance).toBe(300);
    host.onTouchMove(touch([[1, 100, 300], [2, 400, 300]]));
    expect(host.zoom).toBe(2);
    host.onTouchMove(touch([[1, 85, 300], [2, 415, 300]]));
    expect(host.zoom).toBeCloseTo(2.2);
    host.onTouchStart(touch([]));
  });

  it("cleans up the readout's pending hide on view close", async () => {
    const host = view as unknown as { onTouchStart(e: TouchEvent): void };
    host.onTouchStart({ touches: [{ identifier: 1, clientX: 200, clientY: 300 }, { identifier: 2, clientX: 300, clientY: 300 }],
      preventDefault: vi.fn() } as unknown as TouchEvent);
    host.onTouchStart({ touches: [], preventDefault: vi.fn() } as unknown as TouchEvent);
    await view.onClose();
    expect(document.querySelector(".ink-zoom-hud")).toBeNull();
  });

  it("orders navigation and history on the left, drawing centrally, and export before options", () => {
    const toolbar = document.querySelector<HTMLElement>(".ink-toolbar")!;
    const labels = (selector: string) => Array.from(toolbar.querySelectorAll(selector))
      .map((el) => el.getAttribute("aria-label"));
    expect(labels(".ink-toolbar-start button")).toEqual(["Pages", "Undo", "Redo"]);
    expect(labels(".ink-toolbar-section-draw button")).toEqual(["Pen", "Highlight", "Erase", "Select", "Pointer", "Shapes", "Add sticky note"]);
    expect(labels(".ink-toolbar-section-document button")).toEqual(["Reading mode", "Add page", "Export as PDF", "Page options"]);
  });

  it("toggles closed even when the host's document dismissal was registered first", () => {
    let opened: Menu | undefined;
    const show = Menu.prototype.showAtMouseEvent;
    vi.spyOn(Menu.prototype, "showAtMouseEvent").mockImplementation(function (this: Menu, event) {
      opened = this;
      return show.call(this, event);
    });
    const dismiss = () => opened?.hide();
    document.addEventListener("pointerdown", dismiss, true);
    try {
      const trigger = button("Page options");
      trigger.click();
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      trigger.click();
      expect(document.querySelector(".preview-menu")).toBeNull();
    } finally {
      document.removeEventListener("pointerdown", dismiss, true);
    }
  });

  it("does not let a stale hide callback clear the replacement menu's state", () => {
    const callbacks: (() => void)[] = [];
    vi.spyOn(Menu.prototype, "onHide").mockImplementation((callback) => { callbacks.push(callback); });
    const trigger = button("Page options");
    trigger.click();
    trigger.click();
    trigger.click();
    callbacks[0]();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".preview-menu")).not.toBeNull();
    trigger.click();
    expect(document.querySelector(".preview-menu")).toBeNull();
  });

  it("toggles page options through native pointer dismissal, outside taps and Escape", () => {
    const trigger = button("Page options");
    const tap = () => {
      trigger.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      trigger.click();
    };
    tap();
    const first = document.querySelector(".preview-menu");
    expect(first).not.toBeNull();
    tap();
    expect(document.querySelector(".preview-menu")).toBeNull();
    tap();
    expect(document.querySelector(".preview-menu")).not.toBe(first);
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".preview-menu")).toBeNull();
    tap();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".preview-menu")).toBeNull();
    tap();
    expect(document.querySelector(".preview-menu")).not.toBeNull();
  });

  it("toggles page options with click-only activation and closes them with the view", async () => {
    const trigger = button("Page options");
    trigger.click();
    expect(document.querySelector(".preview-menu")).not.toBeNull();
    trigger.click();
    expect(document.querySelector(".preview-menu")).toBeNull();
    trigger.click();
    await view.onClose();
    expect(document.querySelector(".preview-menu")).toBeNull();
  });

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
  it("selects and deletes multiple notebook pages as one undoable action", () => {
    const host = view as unknown as { addPage(): void; notebook: ReturnType<typeof createNotebook> };
    host.addPage();
    host.addPage();
    button("Pages").click();
    button("Manage pages").click();
    button("1: Page 1").click();
    button("3: Page 3").click();
    expect(document.querySelector(".ink-rail-count")?.textContent).toBe("2 selected");
    button("Delete selected pages").click();
    expect(host.notebook.pages.map((page) => page.title)).toEqual(["Page 2"]);
    button("Undo").click();
    expect(host.notebook.pages).toHaveLength(3);
    expect(host.notebook.pages.map((page) => page.title)).toEqual(["Page 1", "Page 2", "Page 3"]);
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
    // While the platform picker is open nothing joins the palette: iOS fires
    // a change for EVERY swatch tapped inside it, so settling on change/
    // debounce stuffed the palette with every tried color.
    color.value = "#abcdef";
    color.dispatchEvent(new Event("input"));
    color.dispatchEvent(new Event("change"));
    expect(document.querySelector('.ink-color-swatch[data-brush-tool="pen"][data-color="#abcdef"]')).toBeNull();
    // The picker closes (blur on the input): exactly one preset is added and
    // selected.
    color.dispatchEvent(new Event("blur"));
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
  it("wraps pen dynamics away from the highlighter and resets scroll on a panel switch", async () => {
    button("Pen").click();   // pen panel opens (pen starts active)
    await new Promise((resolve) => setTimeout(resolve, 30));
    const dynamics = document.querySelector<HTMLElement>(".ink-pen-dynamics");
    expect(dynamics).not.toBeNull();
    expect(dynamics!.querySelector('input[aria-label="Smooth"]')).not.toBeNull();
    const body = document.querySelector<HTMLElement>(".ink-popover-body")!;
    body.scrollTop = 120;
    button("Highlight").click(); // panel switch must land at the top
    expect(body.scrollTop).toBe(0);
  });
  it("re-colors a preset through its own picker armed by the first tap", () => {
    button("Pen").click();
    const blue = button("Pen blue");
    expect(blue.getAttribute("title")).toContain("double-tap to change");
    // Tap 1 selects and arms the swatch's own native picker input.
    blue.click();
    const picker = document.querySelector<HTMLInputElement>('input.ink-swatch-picker[data-color="#195bff"]')!;
    expect(picker.classList.contains("is-armed")).toBe(true);
    // Tap 2 lands on the real input and opens the system picker natively;
    // the settled pick replaces the preset and follows the selected color.
    picker.value = "#123456";
    picker.dispatchEvent(new Event("change"));
    const edited = document.querySelector<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"][data-color="#123456"]');
    expect(edited?.getAttribute("aria-pressed")).toBe("true");
    expect(button("Pen blue")).toBeNull();
    // In-place update: the picker input itself must survive the change, or
    // the platform picker anchored to it snaps shut mid-adjust.
    expect(picker.isConnected).toBe(true);
  });
  it("opens options on hold and removes a preset only explicitly, never the last one", () => {
    vi.useFakeTimers();
    try {
      button("Pen").click();
      const hold = () => {
        document.querySelectorAll<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"]')[0]
          .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
        vi.advanceTimersByTime(600);
      };
      hold();
      expect(document.querySelectorAll('.ink-color-swatch[data-brush-tool="pen"]').length).toBe(5);
      const remove = () => Array.from(document.querySelectorAll<HTMLButtonElement>('.menu button')).find((b) => b.textContent === "Remove preset color")!;
      remove().click();
      for (let i = 0; i < 3; i++) { hold(); remove().click(); }
      expect(document.querySelectorAll('.ink-color-swatch[data-brush-tool="pen"]').length).toBe(1);
      hold();
      expect(remove().disabled).toBe(true); remove().click();
      expect(document.querySelectorAll('.ink-color-swatch[data-brush-tool="pen"]').length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not select the color after a hold opens its options", () => {
    vi.useFakeTimers();
    try {
      button("Pen").click();
      const swatch = document.querySelectorAll<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"]')[1];
      swatch.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      vi.advanceTimersByTime(600);
      swatch.click(); // the click after the hold must not re-select
      // The tool color is unchanged - still whatever was selected before the
      // hold, never the removed preset.
      const pressed = document.querySelector<HTMLElement>('.ink-color-swatch[data-brush-tool="pen"][aria-pressed="true"]');
      expect(pressed?.getAttribute("data-color")).toBe("#1b1b1b");
    } finally {
      vi.useRealTimers();
    }
  });
  it("cancels color options for movement, another finger, and a closed panel", () => {
    vi.useFakeTimers();
    try {
      button("Pen").click(); const swatch = button("Pen blue");
      swatch.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 10, clientY: 10 }));
      const move = new MouseEvent("pointermove", { bubbles: true, clientX: 30, clientY: 10 });
      Object.defineProperty(move, "pointerId", { value: 1 }); swatch.dispatchEvent(move);
      vi.advanceTimersByTime(600); expect(document.querySelector('.menu')).toBeNull();
      swatch.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      const touch = new Event("touchstart", { bubbles: true }); Object.defineProperty(touch, "touches", { value: [{}, {}] });
      swatch.dispatchEvent(touch); vi.advanceTimersByTime(600); expect(document.querySelector('.menu')).toBeNull();
      swatch.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); button("Pen").click();
      vi.advanceTimersByTime(600); expect(document.querySelector('.menu')).toBeNull();
      expect((view as any).state.palette).toHaveLength(5);
    } finally { vi.useRealTimers(); }
  });
  it("offers the same color options by right-click and keyboard", () => {
    button("Pen").click(); const swatch = button("Pen blue");
    swatch.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(document.querySelector('.menu')?.textContent).toContain("Remove preset color");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    swatch.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.querySelector('.menu')?.textContent).toContain("Remove preset color");
    expect((view as any).state.palette).toHaveLength(5);
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
    // The stroke eraser ignores the size - the slider hides for it.
    const sizeRow = document.querySelector<HTMLElement>(".ink-eraser-size-row")!;
    expect(sizeRow.style.display).toBe("none");
    button("Circle eraser").click();
    expect(strokeMode.getAttribute("aria-checked")).toBe("false");
    expect(sizeRow.style.display).toBe("");
    size.value = "48";
    size.dispatchEvent(new Event("input"));
    const cursor = document.querySelector<HTMLElement>(".ink-eraser-cursor")!;
    expect(cursor.style.width).toBe("48px");
    button("Square eraser").click();
    expect(cursor.classList.contains("is-square")).toBe(true);
    expect(button("Square eraser").getAttribute("aria-checked")).toBe("true");
  });
  it("exposes a persistent scribble eraser toggle in eraser settings", () => {
    const scheduleSave = vi.fn();
    (view as unknown as { sharedToolSettings: unknown }).sharedToolSettings = {
      config: defaultToolState(), scheduleSave,
    };
    button("Erase").click();
    button("Erase").click();
    const toggle = document.querySelector<HTMLInputElement>('input[aria-label="Scribble erase with pen"]')!;
    expect(toggle.checked).toBe(true);
    const sensitivity = document.querySelector<HTMLInputElement>('input[aria-label="Scribble erase sensitivity"]')!;
    expect(sensitivity.value).toBe("25");
    sensitivity.value = "60";
    sensitivity.dispatchEvent(new Event("input", { bubbles: true }));
    expect((view as any).state.scribbleSensitivity).toBe(60);
    expect(document.body.textContent).toContain("Scribble sensitivity: 60%");
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(scheduleSave).toHaveBeenCalled();
    expect((view as any).state.scribbleErase).toBe(false);
    expect(sensitivity.disabled).toBe(true);
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(sensitivity.disabled).toBe(false);
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
      // Thumbs draw scaled CLONES of the strokes (nib width relative to the
      // page), so match on id, then assert the miniature scaling itself.
      expect(drawn.some((call) => (call[1] as InkStroke).id === "s1" && call[2] === 152 && call[3] === 208)).toBe(true);
      expect(drawn.some((call) => (call[1] as InkStroke).id === "s2" && call[2] === 152 && call[3] === 208)).toBe(true);
      const scale = 152 / (internal as unknown as { pageBaseWidth: number }).pageBaseWidth;
      const drawnStroke = drawn.find((call) => (call[1] as InkStroke).id === "s1")![1] as InkStroke;
      expect(drawnStroke.width).toBeCloseTo(3 * scale, 6);
      // The paper ruling follows the page's real line count (cells scaled to
      // the thumbnail), not a sparse re-flow.
      const paper = canvases[0].closest(".ink-page-thumb")?.querySelector<HTMLElement>(".ink-page-thumb-paper");
      expect(paper?.style.getPropertyValue("--ink-page-scale")).toBe(String(scale));
    } finally {
      vi.useRealTimers();
    }
  });

  it("scales the paper ruling with zoom instead of re-flowing the line count", () => {
    const internal = view as unknown as { zoom: number; layoutPage(): void };
    internal.zoom = 2;
    internal.layoutPage();
    const page = document.querySelector<HTMLElement>(".ink-page")!;
    // Cell size = exactly 32 page px * zoom: zooming reads like zooming an
    // image, never like re-ruled paper.
    expect(page.style.getPropertyValue("--ink-page-scale")).toBe("2");
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
    // Scaled clones again: match the refreshed page's stroke by id.
    for (const call of drawn) expect((call[1] as InkStroke).id).toBe("s2");
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
