// @vitest-environment jsdom
// Regression coverage for the progressive notebook-open window: while a large
// raw file (>256KB) is parsed in slices, the toolbar and keyboard could still
// mutate the transient partial model, and those edits were silently discarded
// by the next model replacement (or written to disk by an armed save timer).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
// Same reason as view-ui.test.ts: keep thumbnail/tile painting deterministic
// and off the real rasterizer.
vi.mock("../src/rendering", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  drawInkStroke: vi.fn(),
}));
import { InkView } from "../src/view";
import { createNotebook } from "../src/model";
import type { InkNotebook } from "../src/model";
import { InkWorkerRequestError, type InkWorkerService } from "../src/worker-service";
import type { TFile, WorkspaceLeaf } from "obsidian";
import type { NotebookStore } from "../src/storage";

const PAGE_0_ID = "disk-page-1";
const PAGE_1_ID = "disk-page-2";
const PAGE_0_STROKES = 1200;
const PAGE_1_STROKES = 200;
const OFFSCREEN_STROKES = 20;

const strokeJson = (pageId: string, index: number, x: number, y: number): string =>
  `{"id":"disk-s-${pageId}-${index}","pageId":"${pageId}","tool":"pen","color":"#101010","width":3,"opacity":1,` +
  `"createdAt":1,"updatedAt":1,"points":[` +
  Array.from({ length: 12 }, (_, point) =>
    `{"x":${(x + point * 0.0004).toFixed(4)},"y":${(y + point * 0.0003).toFixed(4)},"pressure":0.5,"t":${point + 1}}`).join(",")
  + `]}`;

const notebookRaw = (page0Count: number, page0X: number, page0Y: number, page1Count: number): string => {
  const page0 = Array.from({ length: page0Count }, (_, index) => strokeJson(PAGE_0_ID, index, page0X, page0Y)).join(",");
  const page1 = Array.from({ length: page1Count }, (_, index) => strokeJson(PAGE_1_ID, index, 0.98, 0.5)).join(",");
  return `{"schema":2,"title":"Disk notebook","pageWidth":1600,"pageHeight":2200,`
    + `"pages":[`
    + `{"id":"${PAGE_0_ID}","title":"Page 1","paper":"blank","createdAt":1,"updatedAt":1,"strokes":[${page0}],"deletedStrokeIds":[],"stickyNotes":[]},`
    + `{"id":"${PAGE_1_ID}","title":"Page 2","paper":"blank","createdAt":1,"updatedAt":1,"strokes":[${page1}],"deletedStrokeIds":[],"stickyNotes":[]}`
    + `],"pageOrder":["${PAGE_0_ID}","${PAGE_1_ID}"],"deletedPages":{},"pageOrderUpdatedAt":1,"updatedAt":1}`;
};

/** Same store semantics the failing-save path hits (worker-core missing-session). */
const missingSession = (): never => {
  throw new InkWorkerRequestError("missing-session", "Ink worker session is not initialized");
};

let view: InkView;
const storeMock: Record<string, unknown> = { read: async () => createNotebook("Loaded notebook") };

const host = () => view as unknown as Record<string, any> & { notebook: InkNotebook };
const rootElement = () => document.querySelector<HTMLElement>(".ink-notes-view")!;

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 2): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("progressive-open condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

beforeEach(async () => {
  document.body.innerHTML = '<div id="host"><div></div><main></main></div>';
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const ctx = new Proxy({}, { get: () => vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as CanvasRenderingContext2D);
  const session = {
    canRenderTiles: () => false,
    // initializeRaw is never reached here (jsdom has no Worker), but if a
    // regression calls it, the session must fail like a dead worker would.
    initializeRaw: vi.fn(async () => missingSession()),
    barrier: vi.fn(async () => missingSession()),
    prepareSave: vi.fn(async () => missingSession()),
    dispose: vi.fn(),
  };
  const workers = { createSession: vi.fn(() => session), isDisabled: () => false } as unknown as InkWorkerService;
  view = new InkView({} as WorkspaceLeaf, storeMock as unknown as NotebookStore, workers);
  await view.onOpen();
});

afterEach(async () => {
  await view.onClose();
  (view as unknown as { cleanups: (() => void)[] }).cleanups.forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
});

/** Mocks the raw disk read and forbids the parsed-read fallback. */
function mockDisk(raw: string): void {
  const store = (view as unknown as { store: Record<string, unknown> }).store;
  Object.assign(store, {
    readRaw: vi.fn(async () => raw),
    read: vi.fn(async () => { throw new Error("parsed read must not be reached while raw opening is in progress"); }),
    save: vi.fn(async () => undefined),
  });
}

const openFile = { basename: "Big notebook", path: "Big notebook.ink" } as TFile;

describe("progressive notebook open window", () => {
  it("makes the toolbar Add page click a guarded no-op while the partial model is live", async () => {
    mockDisk(notebookRaw(PAGE_0_STROKES, 0.001, 0.001, PAGE_1_STROKES));
    // Strokes sit inside the (1px-wide) visible cell, so the first 8-stroke
    // preview paints a tile raster and reaches the installed state.

    const opening = view.onLoadFile(openFile);
    await waitFor(() => rootElement().classList.contains("is-progressive-opening"));

    document.querySelector<HTMLButtonElement>('button[aria-label="Add page"]')!.click();
    const menuOpened = document.querySelector(".menu") !== null;
    if (menuOpened) {
      const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".menu button"))
        .find((candidate) => candidate.textContent === "Add page before current");
      item?.click();
    }
    // openPageInsertMenu must refuse during the open window; jsdom does not
    // enforce pointer-events CSS, so this is the behavior-level lock.
    expect(menuOpened).toBe(false);
    // scheduleSave (idle 1.5s / deadline 10s) must not be armed mid-window:
    // firing there would cloneNotebook the partial model straight to disk.
    expect(host().saveTimer).toBeUndefined();
    expect(host().maxSaveTimer).toBeUndefined();

    await opening;
    expect(host().notebook.pages.map((page: { id: string }) => page.id)).toEqual([PAGE_0_ID, PAGE_1_ID]);
    expect(host().notebook.pages[0].strokes).toHaveLength(PAGE_0_STROKES);
    expect(host().undoStack).toHaveLength(0);
    expect(host().saveTimer).toBeUndefined();
    expect(host().maxSaveTimer).toBeUndefined();
  });

  it("blocks keyboard model edits (text box, undo) while the partial model is live", async () => {
    mockDisk(notebookRaw(PAGE_0_STROKES, 0.001, 0.001, PAGE_1_STROKES));

    const opening = view.onLoadFile(openFile);
    await waitFor(() => rootElement().classList.contains("is-progressive-opening"));

    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    // addPageText → changeSticky mutates the model and arms the save timers.
    expect(host().saveTimer).toBeUndefined();
    expect(host().maxSaveTimer).toBeUndefined();
    scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));

    await opening;
    expect(host().notebook.pages[0].stickyNotes ?? []).toHaveLength(0);
    expect(host().undoStack).toHaveLength(0);
    expect(host().notebook.pages[0].strokes).toHaveLength(PAGE_0_STROKES);
    expect(host().saveTimer).toBeUndefined();
    expect(host().maxSaveTimer).toBeUndefined();
  });

  it("restores the previous notebook when parsing fails before the preview installed", async () => {
    // The jsdom page box is ~1px wide, so real tiles would raster every cell
    // and the preview would always install. Faking the tile renderer keeps
    // the layer empty: the preview never installs even though the model was
    // already swapped — the exact rollback gap this fix closes.
    (view as unknown as { tiles: unknown }).tiles = new Proxy({}, {
      get: (_target, property: string) => {
        if (property === "commitInk") {
          return (_strokes: unknown, _viewport: unknown, _density: unknown, committed: (result: boolean) => void) => committed(false);
        }
        return vi.fn();
      },
    });
    // The cut sits ~1.5MB past the first preview, keeping the swapped window
    // open long enough to observe it even with a JIT-warmed parser.
    const raw = notebookRaw(OFFSCREEN_STROKES, 0.98, 0.5, 2600).slice(0, 1_500_000);
    expect(raw.length).toBeGreaterThanOrEqual(256 * 1024);
    mockDisk(raw);

    const previous = host().notebook;
    const opening = view.onLoadFile(openFile);
    // The partial model replaced the live one before the failure point.
    await waitFor(() => host().notebook !== previous);
    await expect(opening).rejects.toThrow();
    expect(host().notebook).toBe(previous);
    expect(document.querySelector(".ink-notes-view")?.getAttribute("aria-busy")).toBe("false");
    expect(document.querySelector(".ink-notebook-load-feedback")?.getAttribute("role")).toBe("alert");
  });

  it("drops save timers left armed by a failed open when a retry re-enters onLoadFile", async () => {
    vi.useFakeTimers();
    const store = (view as unknown as { store: Record<string, unknown> }).store;
    Object.assign(store, {
      readRaw: vi.fn(async () => { throw new Error("disk unavailable"); }),
      read: vi.fn(async () => { throw new Error("disk unavailable"); }),
    });
    await expect(view.onLoadFile(openFile)).rejects.toThrow("disk unavailable");

    const scheduled = vi.spyOn(view as unknown as { performScheduledSave: () => void }, "performScheduledSave");
    (view as unknown as { scheduleSave: () => void }).scheduleSave();
    const retry = view.onLoadFile(openFile);
    void retry.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1600);
    // The retry must clear residue timers, not let them save mid-parse.
    expect(scheduled).not.toHaveBeenCalled();
    await expect(retry).rejects.toThrow("disk unavailable");
  });
});
