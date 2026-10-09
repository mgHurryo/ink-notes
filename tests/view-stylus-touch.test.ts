// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => import("../dev/obsidian"));

import { InkView } from "../src/view";
import { createNotebook } from "../src/model";
import type { InkPage, InkStroke } from "../src/model";
import type { NotebookStore } from "../src/storage";
import type { WorkspaceLeaf } from "obsidian";

interface DrawingView {
  activePointerId: number | null;
  activeStroke: InkStroke | null;
  interaction: { source: "pointer" | "stylus-touch"; pointerType: string; tool: string } | null;
  touchGesture: unknown;
  selectedStrokeIds: Set<string>;
  cleanups: (() => void)[];
  currentPage(): InkPage;
}

interface TestTouch {
  identifier: number;
  target: EventTarget;
  clientX: number;
  clientY: number;
  force: number;
  touchType?: "direct" | "stylus";
  altitudeAngle?: number;
  azimuthAngle?: number;
}

let view: InkView;
let drawing: DrawingView;
let paper: HTMLElement;
let scroller: HTMLElement;

function clickButton(label: string): void {
  document.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!.click();
}

function touch(identifier = 7, overrides: Partial<TestTouch> = {}): TestTouch {
  return {
    identifier,
    target: paper,
    clientX: 300,
    clientY: 350,
    force: 0.35,
    touchType: "stylus",
    ...overrides,
  };
}

function touchList(touches: TestTouch[]) {
  return Object.assign(touches, { item: (index: number) => touches[index] ?? null });
}

// Synthetic input events advance an 8 ms clock (120 Hz pen), giving the
// stroke modeler realistic per-sample time deltas.
let inputClock = 1_000;

function dispatchTouch(type: string, changed: TestTouch[], remaining = changed, target: EventTarget = paper): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    changedTouches: { value: touchList(changed) },
    touches: { value: touchList(remaining) },
    targetTouches: { value: touchList(remaining.filter((sample) => sample.target === target)) },
    timeStamp: { value: inputClock += 8 },
  });
  target.dispatchEvent(event);
  return event;
}

function dispatchPointer(type: string, options: {
  pointerId?: number;
  pointerType?: string;
  clientX?: number;
  clientY?: number;
  pressure?: number;
  buttons?: number;
  tiltX?: number;
  tiltY?: number;
} = {}, target: EventTarget = paper): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.clientX ?? 300,
    clientY: options.clientY ?? 350,
    buttons: options.buttons ?? (type === "pointerup" ? 0 : 1),
  });
  Object.defineProperties(event, {
    pointerId: { value: options.pointerId ?? 7 },
    pointerType: { value: options.pointerType ?? "pen" },
    pressure: { value: options.pressure ?? 0.35 },
    tiltX: { value: options.tiltX ?? 0 },
    tiltY: { value: options.tiltY ?? 0 },
    timeStamp: { value: inputClock += 8 },
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  document.body.innerHTML = '<div id="host"><div></div><main></main></div>';
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("Path2D", class {
    moveTo = vi.fn();
    lineTo = vi.fn();
    quadraticCurveTo = vi.fn();
    closePath = vi.fn();
  });
  const ctx = new Proxy({}, { get: () => vi.fn(), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as CanvasRenderingContext2D);
  view = new InkView({} as WorkspaceLeaf, {
    read: async () => createNotebook("Stylus notebook"),
  } as unknown as NotebookStore);
  await view.onOpen();
  drawing = view as unknown as DrawingView;
  paper = document.querySelector<HTMLElement>(".ink-page")!;
  scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
  paper.getBoundingClientRect = () => ({
    left: 100, top: 50, width: 800, height: 1000,
    right: 900, bottom: 1050, x: 100, y: 50, toJSON: () => ({}),
  });
  paper.hasPointerCapture = () => false;
  paper.setPointerCapture = vi.fn();
  paper.releasePointerCapture = vi.fn();
  Object.assign(view, { canvasLogicalWidth: 800, canvasLogicalHeight: 1000 });
});

afterEach(async () => {
  await view.onClose();
  drawing.cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("stylus touch input ownership", () => {
  it("draws consecutive complete strokes when Scribble omits all Pointer events", () => {
    for (let identifier = 7; identifier < 10; identifier += 1) {
      const start = touch(identifier);
      expect(dispatchTouch("touchstart", [start]).defaultPrevented).toBe(true);
      expect(drawing.interaction?.source).toBe("stylus-touch");
      expect(drawing.activePointerId).not.toBeNull();
      dispatchTouch("touchmove", [touch(identifier, { clientX: 380, force: 0.6 })]);
      expect(dispatchTouch("touchend", [touch(identifier, { clientX: 420 })], []).defaultPrevented).toBe(true);
      expect(drawing.activePointerId).toBeNull();
      expect(drawing.activeStroke).toBeNull();
      expect(drawing.interaction).toBeNull();
    }
    expect(drawing.currentPage().strokes).toHaveLength(3);
    for (const stroke of drawing.currentPage().strokes) {
      // Modeled capture streams the touch as a full trajectory, not one point
      // per event; the ends still land exactly on the contact positions.
      expect(stroke.points.length).toBeGreaterThanOrEqual(3);
      expect(stroke.points[0]).toMatchObject({ x: 0.25, y: 0.3, pressure: 0.35 });
      expect(stroke.points.at(-1)?.x).toBeCloseTo(0.4);
    }
  });

  it("adopts a Pointer-first Pencil stroke without starting a second stroke", () => {
    dispatchPointer("pointerdown");
    const stroke = drawing.currentPage().strokes[0];
    expect(drawing.interaction?.source).toBe("pointer");
    dispatchTouch("touchstart", [touch(20)]);
    expect(drawing.interaction?.source).toBe("stylus-touch");
    expect(drawing.currentPage().strokes).toEqual([stroke]);
    dispatchTouch("touchmove", [touch(20, { clientX: 380 })]);
    dispatchTouch("touchend", [touch(20, { clientX: 420 })], []);
    expect(drawing.currentPage().strokes).toEqual([stroke]);
    expect(stroke.points.length).toBeGreaterThanOrEqual(3);
    expect(stroke.points.at(-1)?.x).toBeCloseTo(0.4);
    expect(drawing.activePointerId).toBeNull();
  });

  it("ignores duplicate Pointer events after a Touch-first Pencil stroke", () => {
    dispatchTouch("touchstart", [touch()]);
    const stroke = drawing.currentPage().strokes[0];
    dispatchPointer("pointerdown");
    dispatchPointer("pointermove", { clientX: 600 });
    expect(drawing.currentPage().strokes).toEqual([stroke]);
    expect(stroke.points).toHaveLength(1);
    expect(drawing.interaction?.source).toBe("stylus-touch");
    dispatchTouch("touchmove", [touch(7, { clientX: 380 })]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    dispatchPointer("pointerup", { clientX: 600 });
    expect(stroke.points.length).toBeGreaterThanOrEqual(3);
    expect(stroke.points.at(-1)?.x).toBeCloseTo(0.4);
    expect(drawing.activePointerId).toBeNull();
  });

  it.each(["pointerup", "pointercancel"])("does not end Touch-owned ink on a duplicate %s", (type) => {
    dispatchPointer("pointerdown");
    dispatchTouch("touchstart", [touch(20)]);
    dispatchPointer(type, { pointerId: 7, clientX: 600 });
    // Exercise the document fallback with the adopted Touch identifier too.
    dispatchPointer(type, { pointerId: 20, clientX: 600 }, document.body);
    expect(drawing.interaction?.source).toBe("stylus-touch");
    expect(drawing.activePointerId).not.toBeNull();
    dispatchTouch("touchmove", [touch(20, { clientX: 380 })]);
    dispatchTouch("touchend", [touch(20, { clientX: 420 })], []);
    expect(drawing.currentPage().strokes[0].points.length).toBeGreaterThanOrEqual(3);
    expect(drawing.currentPage().strokes[0].points.at(-1)?.x).toBeCloseTo(0.4);
    expect(drawing.activePointerId).toBeNull();
  });

  it("accepts a new native Pencil contact after Touch has completed", () => {
    dispatchTouch("touchstart", [touch()]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    const strokes = drawing.currentPage().strokes.slice();
    dispatchPointer("pointerdown");
    expect(drawing.interaction?.source).toBe("pointer");
    dispatchPointer("pointermove", { clientX: 600 });
    dispatchPointer("pointerup", { clientX: 650 });
    expect(drawing.currentPage().strokes).toHaveLength(2);
    expect(drawing.currentPage().strokes[0]).toEqual(strokes[0]);
    expect(drawing.currentPage().strokes[1].points.at(-1)?.x).toBeCloseTo(0.6875);
    expect(drawing.activePointerId).toBeNull();
    expect(drawing.interaction).toBeNull();
  });

  it.each(["touchend", "touchcancel", "tool-switch"])("accepts immediate eraser and pen contacts after %s", (ending) => {
    dispatchTouch("touchstart", [touch()]);
    if (ending !== "tool-switch") {
      dispatchTouch(ending, [touch()], []);
      expect(drawing.activePointerId).toBeNull();
    }
    clickButton("Erase");
    dispatchPointer("pointerdown");
    const companion = touch(7, { touchType: undefined });
    dispatchTouch("touchstart", [companion]);
    dispatchTouch("touchmove", [{ ...companion, clientY: 290 }]);
    expect(drawing.interaction).toMatchObject({ source: "pointer", tool: "eraser" });
    expect(drawing.touchGesture).toBeNull();
    expect(scroller.scrollTop).toBe(0);
    expect(drawing.currentPage().strokes).toHaveLength(0);
    dispatchPointer("pointerup");
    dispatchTouch("touchend", [companion], []);
    clickButton("Pen");
    dispatchPointer("pointerdown");
    expect(drawing.interaction).toMatchObject({ source: "pointer", tool: "pen" });
    dispatchPointer("pointerup");
    expect(drawing.currentPage().strokes).toHaveLength(1);
    expect(drawing.activePointerId).toBeNull();
  });

  it.each(["pointer-first", "touch-first"])("deduplicates overlapping %s streams per contact", (order) => {
    if (order === "pointer-first") dispatchPointer("pointerdown");
    dispatchTouch("touchstart", [touch(20)]);
    if (order === "touch-first") dispatchPointer("pointerdown");
    expect(drawing.currentPage().strokes).toHaveLength(1);
    expect(drawing.interaction?.source).toBe("stylus-touch");
    dispatchPointer("pointermove");
    dispatchPointer("pointerup");
    expect(drawing.activePointerId).toBe(20);
    dispatchTouch("touchend", [touch(20)], []);
    expect(drawing.activePointerId).toBeNull();
    // A subsequent pointer-only contact is new, even with a reused pointer id.
    dispatchPointer("pointerdown");
    dispatchPointer("pointerup");
    expect(drawing.currentPage().strokes).toHaveLength(2);
  });

  it("finalizes a stylus cancellation once and admits the next Touch stroke", () => {
    dispatchTouch("touchstart", [touch()]);
    dispatchTouch("touchmove", [touch(7, { clientX: 380 })]);
    expect(dispatchTouch("touchcancel", [touch(7, { clientX: 600 })], []).defaultPrevented).toBe(true);
    // The cancelled stroke finalizes on its last input, never on the
    // cancel event's coordinates.
    const cancelled = drawing.currentPage().strokes[0].points;
    expect(cancelled.length).toBeGreaterThanOrEqual(2);
    expect(cancelled.at(-1)?.x).toBeCloseTo(0.35, 3);
    expect(drawing.activePointerId).toBeNull();
    expect(drawing.interaction).toBeNull();
    dispatchTouch("touchend", [touch()], []);
    dispatchTouch("touchstart", [touch(8)]);
    dispatchTouch("touchend", [touch(8, { clientX: 420 })], []);
    expect(drawing.currentPage().strokes).toHaveLength(2);
    expect(drawing.activePointerId).toBeNull();
  });

  it("does not draw fingers or palms even when they report force", () => {
    const finger = touch(1, { touchType: "direct", force: 0.9 });
    const palm = touch(2, { touchType: "direct", force: 1, clientX: 350 });
    dispatchTouch("touchstart", [finger, palm]);
    dispatchTouch("touchmove", [finger, palm]);
    dispatchTouch("touchend", [finger, palm], []);
    dispatchPointer("pointerdown", { pointerType: "touch", pressure: 1 });
    dispatchPointer("pointermove", { pointerType: "touch", pressure: 1, clientX: 600 });
    dispatchPointer("pointerup", { pointerType: "touch", pressure: 1 });
    expect(drawing.currentPage().strokes).toEqual([]);
    expect(drawing.activePointerId).toBeNull();
    expect(drawing.interaction).toBeNull();
  });

  it("ignores stylus touches that begin outside the paper", () => {
    const margin = document.createElement("div");
    scroller.append(margin);
    const outside = touch(7, { target: margin });
    dispatchTouch("touchstart", [outside], [outside], margin);
    dispatchTouch("touchmove", [touch(7, { target: margin, clientX: 380 })], [outside], margin);
    dispatchTouch("touchend", [outside], [], margin);
    expect(drawing.currentPage().strokes).toEqual([]);
    expect(drawing.activePointerId).toBeNull();
    expect(drawing.interaction).toBeNull();
  });

  it("does not finish stylus ink when only a finger ends", () => {
    const stylus = touch(7);
    const finger = touch(1, { touchType: "direct", force: 0.9 });
    dispatchTouch("touchstart", [stylus]);
    dispatchTouch("touchstart", [finger], [stylus, finger]);
    dispatchTouch("touchend", [finger], [stylus]);
    expect(drawing.interaction?.source).toBe("stylus-touch");
    expect(drawing.activePointerId).not.toBeNull();
    dispatchTouch("touchmove", [touch(7, { clientX: 380 })]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    expect(drawing.currentPage().strokes).toHaveLength(1);
    expect(drawing.currentPage().strokes[0].points.length).toBeGreaterThanOrEqual(3);
  });

  it("rebases a remaining finger at Pencil lift so it can pan without lifting again", () => {
    const stylus = touch(7);
    const finger = touch(1, { touchType: "direct", clientX: 450, clientY: 500 });
    const movedFinger = touch(1, { ...finger, clientY: 480 });
    dispatchTouch("touchstart", [stylus]);
    dispatchTouch("touchstart", [finger], [stylus, finger]);
    dispatchTouch("touchmove", [movedFinger], [stylus, movedFinger]);
    expect(scroller.scrollTop).toBe(0);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], [movedFinger]);
    expect(drawing.activePointerId).toBeNull();
    dispatchTouch("touchmove", [touch(1, { ...finger, clientY: 450 })]);
    expect(scroller.scrollTop).toBe(30);
    expect(drawing.currentPage().strokes).toHaveLength(1);
    dispatchTouch("touchend", [finger], []);
  });

  it("keeps the mouse Pointer path usable after a stylus Touch stroke", () => {
    dispatchTouch("touchstart", [touch()]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    dispatchPointer("pointerdown", { pointerId: 1, pointerType: "mouse" });
    expect(drawing.interaction?.source).toBe("pointer");
    dispatchPointer("pointermove", { pointerId: 1, pointerType: "mouse", clientX: 380 });
    dispatchPointer("pointerup", { pointerId: 1, pointerType: "mouse", clientX: 420 });
    expect(drawing.currentPage().strokes).toHaveLength(2);
    expect(drawing.currentPage().strokes[1].points.length).toBeGreaterThanOrEqual(3);
    expect(drawing.activePointerId).toBeNull();
  });

  it("draws a highlighter through the same stylus Touch lifecycle", () => {
    clickButton("Highlight");
    dispatchTouch("touchstart", [touch()]);
    dispatchTouch("touchmove", [touch(7, { clientX: 380 })]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    expect(drawing.currentPage().strokes).toHaveLength(1);
    expect(drawing.currentPage().strokes[0]).toMatchObject({ tool: "highlighter", opacity: 0.4 });
    expect(drawing.currentPage().strokes[0].points).toHaveLength(3);
    expect(drawing.activePointerId).toBeNull();
  });

  it("erases a completed stroke with stylus Touch without adding an eraser stroke", () => {
    dispatchTouch("touchstart", [touch()]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    const stroke = drawing.currentPage().strokes[0];
    clickButton("Erase");
    dispatchTouch("touchstart", [touch(8)]);
    dispatchTouch("touchend", [touch(8)], []);
    expect(drawing.currentPage().strokes).toEqual([]);
    expect(drawing.currentPage().deletedStrokeIds).toContain(stroke.id);
    expect(drawing.activePointerId).toBeNull();
    expect(drawing.interaction).toBeNull();
  });

  it("selects completed ink with a stylus Touch lasso without adding ink", () => {
    dispatchTouch("touchstart", [touch()]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    const stroke = drawing.currentPage().strokes[0];
    clickButton("Select");
    dispatchTouch("touchstart", [touch(8, { clientX: 220, clientY: 250 })]);
    for (const [clientX, clientY] of [[500, 250], [500, 450], [220, 450]]) {
      dispatchTouch("touchmove", [touch(8, { clientX, clientY })]);
      vi.advanceTimersByTime(17);
    }
    dispatchTouch("touchend", [touch(8, { clientX: 220, clientY: 250 })], []);
    expect(drawing.selectedStrokeIds).toEqual(new Set([stroke.id]));
    expect(drawing.currentPage().strokes).toEqual([stroke]);
    expect(drawing.activePointerId).toBeNull();
  });

  it("undoes and redoes one deduplicated Pencil stroke as a single edit", () => {
    dispatchPointer("pointerdown");
    dispatchTouch("touchstart", [touch(20)]);
    dispatchPointer("pointermove", { clientX: 600 });
    dispatchTouch("touchmove", [touch(20, { clientX: 380 })]);
    dispatchPointer("pointerup", { clientX: 600 });
    dispatchTouch("touchend", [touch(20, { clientX: 420 })], []);
    const stroke = drawing.currentPage().strokes[0];
    expect(drawing.currentPage().strokes).toHaveLength(1);
    clickButton("Undo");
    expect(drawing.currentPage().strokes).toEqual([]);
    clickButton("Redo");
    expect(drawing.currentPage().strokes).toHaveLength(1);
    expect(drawing.currentPage().strokes[0]).toMatchObject({ tool: stroke.tool, color: stroke.color, width: stroke.width });
    expect(drawing.currentPage().strokes[0].points).toEqual(stroke.points);
  });

  it("retains pressure and converts stylus angle metadata into existing point fields", () => {
    dispatchTouch("touchstart", [touch(7, { force: 0.2, altitudeAngle: Math.PI / 4, azimuthAngle: 0 })]);
    // Space the contacts 200 ms apart so the modeled tip can keep up with a
    // physically plausible writing speed before the assertions run.
    inputClock += 200;
    dispatchTouch("touchmove", [touch(7, { clientX: 380, force: 0.8, altitudeAngle: Math.PI / 4, azimuthAngle: Math.PI / 2 })]);
    inputClock += 200;
    dispatchTouch("touchend", [touch(7, { clientX: 420, force: 0.8, altitudeAngle: Math.PI / 4, azimuthAngle: Math.PI / 2 })], []);
    const points = drawing.currentPage().strokes[0].points;
    expect(points[0]).toMatchObject({ x: 0.25, y: 0.3, pressure: 0.2 });
    expect(points[0].tiltX).toBeCloseTo(45);
    expect(points[0].tiltY).toBeCloseTo(0);
    // The modeled tail lands on the lift sample, carrying its pressure and
    // converted tilt through the projection onto the raw input polyline.
    const last = points[points.length - 1];
    expect(last.pressure).toBeCloseTo(0.8, 1);
    expect(last.tiltX).toBeCloseTo(0, 1);
    expect(last.tiltY).toBeCloseTo(45, 1);
    expect(Number.isFinite(points[0].t)).toBe(true);
    expect(Number.isFinite(last.t)).toBe(true);
  });

  it.each([
    [0, 90, 0],
    [Math.PI / 2, 0, 90],
    [Math.PI, -90, 0],
    [Math.PI * 3 / 2, 0, -90],
  ])("converts horizontal stylus azimuth %d without invalid tilt", (azimuthAngle, tiltX, tiltY) => {
    dispatchTouch("touchstart", [touch(7, { altitudeAngle: 0, azimuthAngle })]);
    const point = drawing.currentPage().strokes[0].points[0];
    expect(point.tiltX).toBeCloseTo(tiltX);
    expect(point.tiltY).toBeCloseTo(tiltY);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
  });

  it.each([
    [Number.NaN, 0],
    [Math.PI / 4, Number.NaN],
    [Number.NaN, Number.NaN],
    [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  ])("uses finite neutral tilt for invalid angle metadata %d and %d", (altitudeAngle, azimuthAngle) => {
    dispatchTouch("touchstart", [touch(7, { altitudeAngle, azimuthAngle })]);
    const point = drawing.currentPage().strokes[0].points[0];
    expect(point.tiltX).toBe(0);
    expect(point.tiltY).toBe(0);
    expect(Number.isFinite(point.pressure)).toBe(true);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
  });

  it("keeps ordinary Pencil Pointer input when Touch does not identify a stylus", () => {
    const unknown = touch(7, { touchType: undefined, force: 0.9 });
    dispatchTouch("touchstart", [unknown]);
    expect(drawing.currentPage().strokes).toEqual([]);
    dispatchPointer("pointerdown");
    dispatchPointer("pointermove", { clientX: 380 });
    dispatchPointer("pointerup", { clientX: 420 });
    dispatchTouch("touchend", [unknown], []);
    expect(drawing.currentPage().strokes).toHaveLength(1);
    expect(drawing.currentPage().strokes[0].points.length).toBeGreaterThanOrEqual(3);
    expect(drawing.currentPage().strokes[0].points.at(-1)?.x).toBeCloseTo(0.4);
    expect(drawing.interaction).toBeNull();
    expect(drawing.activePointerId).toBeNull();
  });

  it("does not create ink from Pencil hover before or after Touch ownership is detected", () => {
    dispatchPointer("pointerenter", { pressure: 0, buttons: 0 });
    dispatchPointer("pointermove", { pressure: 0, buttons: 0, clientX: 380 });
    expect(drawing.currentPage().strokes).toEqual([]);
    dispatchTouch("touchstart", [touch()]);
    dispatchTouch("touchend", [touch(7, { clientX: 420 })], []);
    const stroke = drawing.currentPage().strokes[0];
    dispatchPointer("pointerenter", { pressure: 0, buttons: 0 });
    dispatchPointer("pointermove", { pressure: 0, buttons: 0, clientX: 600 });
    expect(drawing.currentPage().strokes).toEqual([stroke]);
    expect(stroke.points.length).toBeGreaterThanOrEqual(2);
    expect(stroke.points.at(-1)?.x).toBeCloseTo(0.4);
    expect(drawing.activePointerId).toBeNull();
  });
});
