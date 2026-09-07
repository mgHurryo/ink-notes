import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TFile, WorkspaceLeaf } from "obsidian";
import { InkNotebook, InkStroke, createNotebook, createPage } from "../src/model";
import { NotebookStore } from "../src/storage";
import { InkView } from "../src/view";

interface ViewInternals {
  notebook: InkNotebook;
  canvas: HTMLCanvasElement;
  activeStroke: InkStroke | null;
  activePointerId: number | null;
  pageIndex: number;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onLostPointerCapture(event: PointerEvent): void;
  drawStrokes: () => void;
  renderAll: () => void;
  updateHistoryButtons: () => void;
  save(): Promise<void>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pointer(x: number, options: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerId: 7, pointerType: "pen", clientX: x, clientY: 20,
    pressure: 0.5, tiltX: 0, tiltY: 0, preventDefault: vi.fn(),
    ...options,
  } as PointerEvent;
}

function setup() {
  const store = { read: vi.fn(), save: vi.fn() };
  const view = new InkView({} as WorkspaceLeaf, store as unknown as NotebookStore);
  const internal = view as unknown as ViewInternals;
  view.file = {} as TFile;
  internal.notebook = createNotebook();
  const captured = new Set<number>();
  internal.canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); },
  } as HTMLCanvasElement;
  internal.drawStrokes = vi.fn();
  Object.assign(internal, {
    pageElement: internal.canvas,
    updateViewport: vi.fn(),
    resizePreview: vi.fn(),
    drawPreview: vi.fn(),
    commitPreview: vi.fn(),
    requestRender: vi.fn(),
    tiles: { sync: vi.fn() },
  });
  internal.renderAll = vi.fn();
  internal.updateHistoryButtons = vi.fn();
  return { store, view, internal, captured };
}

describe("consecutive handwriting input", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a new stroke alive when an old capture-loss event arrives for the same pen", () => {
    const { internal } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    internal.onPointerDown(pointer(30));
    internal.onLostPointerCapture(pointer(20));
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));

    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4, 0.5]]);
    expect(internal.activePointerId).toBeNull();
  });

  it("finishes real capture loss without treating its coordinates as an ink sample", () => {
    const { internal, captured } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerMove(pointer(20));
    captured.clear();
    internal.onLostPointerCapture(pointer(0));
    expect(internal.activePointerId).toBeNull();
    internal.onPointerDown(pointer(30));
    internal.onPointerUp(pointer(40));
    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it("accepts many consecutive strokes without waiting for autosave", () => {
    const { internal, store } = setup();
    for (let i = 0; i < 40; i++) {
      internal.onPointerDown(pointer(10));
      internal.onPointerMove(pointer(20));
      internal.onPointerUp(pointer(30));
      internal.onLostPointerCapture(pointer(0));
    }
    expect(internal.notebook.pages[0].strokes).toHaveLength(40);
    expect(internal.notebook.pages[0].strokes.every((stroke) => stroke.points.length === 3)).toBe(true);
    expect(store.save).not.toHaveBeenCalled();
  });

  it("defers a disk read that completes after the next stroke has started", async () => {
    const { internal, view, store } = setup();
    const disk = structuredClone(internal.notebook);
    disk.pages[0].title = "Remote page title";
    disk.pages[0].updatedAt += 1000;
    const read = deferred<InkNotebook>();
    store.read.mockReturnValue(read.promise);
    const refresh = view.reloadFromDisk();
    internal.onPointerDown(pointer(10));
    const activeNotebook = internal.notebook;
    read.resolve(disk);
    await refresh;

    expect(internal.notebook).toBe(activeNotebook);
    expect(internal.renderAll).not.toHaveBeenCalled();
    internal.onPointerMove(pointer(20));
    internal.onPointerUp(pointer(30));
    expect(internal.notebook.pages[0].title).toBe("Remote page title");
    expect(internal.notebook.pages[0].strokes[0].points.map((point) => point.x)).toEqual([0.1, 0.2, 0.3]);
  });

  it("does not apply a disk read to a different file after navigation", async () => {
    const { internal, view, store } = setup();
    const read = deferred<InkNotebook>();
    store.read.mockReturnValue(read.promise);
    const refresh = view.reloadFromDisk();
    view.file = {} as TFile;
    const nextNotebook = createNotebook("Next notebook");
    internal.notebook = nextNotebook;
    read.resolve(createNotebook("Previous notebook"));
    await refresh;
    expect(internal.notebook).toBe(nextNotebook);
    expect(internal.renderAll).not.toHaveBeenCalled();
  });

  it("preserves both completed and active strokes when saving overlaps the next stroke", async () => {
    const { internal, store } = setup();
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    const snapshot = structuredClone(internal.notebook);
    const saved = deferred<InkNotebook>();
    store.save.mockReturnValue(saved.promise);
    const saving = internal.save();
    internal.onPointerDown(pointer(30));
    saved.resolve(snapshot);
    await saving;
    expect(internal.renderAll).not.toHaveBeenCalled();
    internal.onPointerMove(pointer(40));
    internal.onPointerUp(pointer(50));
    expect(internal.notebook.pages[0].strokes.map((stroke) => stroke.points.map((point) => point.x)))
      .toEqual([[0.1, 0.2], [0.3, 0.4, 0.5]]);
  });

  it("accumulates disk and save results that both arrive during a stroke", async () => {
    const { internal, view, store } = setup();
    const disk = structuredClone(internal.notebook);
    const remotePage = createPage("Remote page");
    disk.pages.push(remotePage);
    const snapshot = structuredClone(internal.notebook);
    const read = deferred<InkNotebook>();
    const saved = deferred<InkNotebook>();
    store.read.mockReturnValue(read.promise);
    store.save.mockReturnValue(saved.promise);
    const refresh = view.reloadFromDisk();
    const saving = internal.save();
    internal.onPointerDown(pointer(10));
    read.resolve(disk);
    await refresh;
    saved.resolve(snapshot);
    await saving;
    expect(internal.renderAll).not.toHaveBeenCalled();
    internal.onPointerUp(pointer(20));
    expect(internal.notebook.pages.map((page) => page.id)).toContain(remotePage.id);
    expect(internal.notebook.pages[internal.pageIndex].strokes[0].points).toHaveLength(2);
  });

  it("keeps the writing page selected when a background merge inserts an earlier page", async () => {
    const { internal, view, store } = setup();
    const pageId = internal.notebook.pages[0].id;
    const disk = structuredClone(internal.notebook);
    disk.pages.push(createPage("Earlier remote page", "blank", disk.pages[0].createdAt - 1000));
    store.read.mockResolvedValue(disk);
    await view.reloadFromDisk();
    expect(internal.pageIndex).toBe(1);
    expect(internal.notebook.pages[internal.pageIndex].id).toBe(pageId);
    internal.onPointerDown(pointer(10));
    internal.onPointerUp(pointer(20));
    expect(internal.notebook.pages[0].strokes).toHaveLength(0);
    expect(internal.notebook.pages[1].strokes).toHaveLength(1);
  });
});
