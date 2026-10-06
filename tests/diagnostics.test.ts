// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECORDED_STROKES,
  StrokeDiagnosticsRecord,
  intervalStats,
  pushStrokeRecord,
} from "../src/diagnostics";
import { InkNotebook, createNotebook } from "../src/model";
import { NotebookStore } from "../src/storage";
import { InkView } from "../src/view";

describe("interval statistics", () => {
  it("returns nulls for an empty window", () => {
    expect(intervalStats([])).toEqual({ count: 0, min: null, median: null, mean: null, max: null });
  });

  it("takes the middle sample for odd counts", () => {
    const stats = intervalStats([8, 40, 4, 16, 5]);
    expect(stats).toEqual({ count: 5, min: 4, median: 8, mean: 14.6, max: 40 });
  });

  it("averages the two middle samples for even counts", () => {
    const stats = intervalStats([10, 20, 30, 40]);
    expect(stats.median).toBe(25);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(40);
  });
});

describe("stroke record ring buffer", () => {
  function record(index: number): StrokeDiagnosticsRecord {
    return {
      index, startedAt: 0, durationMs: 5, tool: "pen", smooth: 0, engaged: false, reason: "direct",
      fallback: false, rawSamples: 3, pointsStored: 3, intervals: intervalStats([]), liftDistancePx: null,
    };
  }

  it("keeps only the most recent strokes", () => {
    const records: StrokeDiagnosticsRecord[] = [];
    for (let index = 1; index <= MAX_RECORDED_STROKES + 3; index++) pushStrokeRecord(records, record(index));
    expect(records).toHaveLength(MAX_RECORDED_STROKES);
    expect(records[0].index).toBe(4);
    expect(records[records.length - 1].index).toBe(MAX_RECORDED_STROKES + 3);
  });
});

interface ViewInternals {
  notebook: InkNotebook;
  canvas: HTMLCanvasElement;
  activeStroke: { points: { x: number; y: number; pressure: number; t: number }[] } | null;
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  queueWorkerOperation(op: unknown): void;
  updateEraserHover(point: unknown, inside: boolean): void;
  state: { tool: string; pen: { smooth?: number } };
  strokeRecords: StrokeDiagnosticsRecord[];
  currentStrokeRecord: StrokeDiagnosticsRecord | null;
  devPanel: HTMLElement | null;
}

function setup() {
  const store = { read: vi.fn(), save: vi.fn() };
  const view = new InkView({} as never, store as unknown as NotebookStore);
  const internal = view as unknown as ViewInternals;
  view.file = {} as never;
  internal.notebook = createNotebook();
  const captured = new Set<number>();
  internal.canvas = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture: (id: number) => { captured.add(id); },
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => { captured.delete(id); },
  } as HTMLCanvasElement;
  Object.assign(internal, {
    pageElement: internal.canvas, updateViewport: vi.fn(), resizePreview: vi.fn(), drawPreview: vi.fn(),
    commitPreview: vi.fn(), requestRender: vi.fn(), drawStrokes: vi.fn(),
    tiles: { sync: vi.fn(), patchStrokes: vi.fn(), commitInteractive: vi.fn(), commitInk: vi.fn((_a: unknown, _b: unknown, _c: unknown, complete: (ok: boolean) => void) => complete(true)), removeStrokes: vi.fn(), previewInteractiveCells: vi.fn(), beginInput: vi.fn(), pauseInkCommit: vi.fn(), resumeInkCommit: vi.fn(), cancelInkCommit: vi.fn() },
    canvasLogicalWidth: 100, canvasLogicalHeight: 100,
  });
  Object.assign(internal, { renderAll: vi.fn(), renderPageRail: vi.fn(), renderPage: vi.fn(), updateHistoryButtons: vi.fn(), updateEraserHover: vi.fn() });
  internal.queueWorkerOperation = vi.fn();
  return internal;
}

function ev(x: number, t: number): PointerEvent {
  return {
    pointerId: 7, pointerType: "pen", clientX: x, clientY: 20,
    pressure: 0.5, tiltX: 0, tiltY: 0, preventDefault: vi.fn(), timeStamp: t,
  } as unknown as PointerEvent;
}

describe("view stroke records", () => {
  it("records a direct stroke with its decision and tail landing distance", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      const internal = setup();
      internal.state.pen.smooth = 0;
      internal.onPointerDown(ev(10, 1_000));
      expect(internal.currentStrokeRecord?.engaged).toBe(false);
      expect(internal.currentStrokeRecord?.reason).toBe("direct");
      internal.onPointerMove(ev(30, 1_008));
      internal.onPointerUp(ev(50, 1_016));

      expect(internal.strokeRecords).toHaveLength(1);
      const record = internal.strokeRecords[0];
      expect(record.engaged).toBe(false);
      expect(record.reason).toBe("direct");
      expect(record.rawSamples).toBeGreaterThan(0);
      expect(record.pointsStored).toBeGreaterThan(1);
      expect(record.durationMs).not.toBeNull();
      // The raw lift lands on the last stored point for direct capture.
      expect(record.liftDistancePx).toBeLessThan(0.5);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("records the modeler reason when a smooth strength is selected", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      const internal = setup();
      internal.state.pen.smooth = 50;
      internal.onPointerDown(ev(10, 1_000));
      internal.onPointerMove(ev(30, 1_008));
      internal.onPointerUp(ev(50, 1_016));

      const record = internal.strokeRecords[0];
      expect(record.engaged).toBe(true);
      expect(record.reason).toBe("smooth");
      expect(record.smooth).toBe(50);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("retains raw delivered samples only while the panel is open", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    try {
      const internal = setup();
      internal.state.pen.smooth = 0;
      internal.onPointerDown(ev(10, 1_000));
      internal.onPointerMove(ev(30, 1_008));
      expect(internal.currentStrokeRecord?.rawPointSamples).toBeUndefined();
      internal.onPointerUp(ev(50, 1_016));

      internal.devPanel = document.createElement("div");
      internal.onPointerDown(ev(10, 2_000));
      internal.onPointerMove(ev(30, 2_008));
      internal.onPointerUp(ev(50, 2_016));

      const withSamples = internal.strokeRecords[internal.strokeRecords.length - 1];
      expect(withSamples.rawPointSamples?.length).toBeGreaterThan(0);
      const [x, y, pressure, time] = withSamples.rawPointSamples![0];
      // Recording starts with the first move sample; the down point lives in
      // stroke.points only.
      expect(x).toBeCloseTo(0.3, 5);
      expect(y).toBeCloseTo(0.2, 5);
      expect(pressure).toBe(0.5);
      expect(typeof time).toBe("number");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
