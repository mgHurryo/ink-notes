import { describe, expect, it, vi } from "vitest";
import { defaultToolState } from "../src/tool-state";
import type { InkPage } from "../src/model";
import { rotateScribble, scribbleLoops, scribbleWaves } from "./scribble-fixtures";

/** Run the same real DOM input contract against both editor implementations. */
export function gestureContract(create: () => Promise<any>): void {
  describe("unified touch contract", () => {
    async function setup() {
      vi.stubGlobal("Path2D", class { moveTo() {} lineTo() {} closePath() {} });
      const editor = await create(), host = editor.inputHost() as HTMLElement;
      const page = editor.currentPage() as InkPage;
      vi.spyOn(editor, "inputRect").mockReturnValue(new DOMRect(0, 0, 1000, 1000));
      vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 1000));
      editor.canvasLogicalWidth = editor.canvasLogicalHeight = 1000;
      const finger = (id: number, x: number, y: number) => ({ identifier: id, clientX: x, clientY: y, target: host, touchType: "direct" });
      let time = 0;
      const send = (type: string, touches: ReturnType<typeof finger>[], changed = touches) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: touches }, changedTouches: { value: changed }, timeStamp: { value: time += 20 } });
        host.dispatchEvent(event);
      };
      const draw = (tool: string, x = 200, y = 200) => {
        editor.state.tool = tool;
        send("touchstart", [finger(1, x, y)]);
        // A parallel Pointer Touch stream must not add a second stroke.
        editor.onPointerDown({ pointerType: "touch", pointerId: 1, clientX: x, clientY: y, pressure: .5 });
        send("touchmove", [finger(1, x + 100, y + 100)]);
        send("touchend", [], [finger(1, x + 100, y + 100)]);
      };
      return { editor, page, host, finger, send, draw };
    }

    async function desktopSetup() {
      const { editor } = await setup();
      const scroller = editor.inputScroller() as HTMLElement;
      let top = 0, left = 0;
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 1200 },
        clientWidth: { configurable: true, value: 800 }, scrollWidth: { configurable: true, value: 800 },
        scrollTop: { configurable: true, get: () => top, set: (v: number) => { top = Math.max(0, Math.min(600, v)); } },
        scrollLeft: { configurable: true, get: () => left, set: (v: number) => { left = Math.max(0, Math.min(0, v)); } },
      });
      const settle = vi.spyOn(editor, "swipeSettle").mockImplementation(() => undefined);
      vi.spyOn(editor, "swipeDrag").mockImplementation(() => undefined);
      const wheel = (x: number, y: number, options: WheelEventInit = {}, target: HTMLElement = scroller) => {
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: x, deltaY: y, ...options });
        target.dispatchEvent(event); return event;
      };
      return { editor, scroller, settle, wheel };
    }

    it.each([0, 1, 2])("scrolls inside the page before vertical boundary navigation (wheel mode %s)", async (mode) => {
      const { scroller, settle, wheel } = await desktopSetup();
      const amount = mode === 0 ? 120 : mode === 1 ? 8 : 1;
      wheel(0, amount, { deltaMode: mode });
      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(settle).not.toHaveBeenCalled();
      scroller.scrollTop = 600;
      expect(wheel(0, amount, { deltaMode: mode }).defaultPrevented).toBe(true);
      expect(settle).toHaveBeenCalledWith(1, 0, "top");
      wheel(0, -amount, { deltaMode: mode }); // Reverse immediately, without waiting for inertia to expire.
      expect(scroller.scrollTop).toBeLessThan(600);
      scroller.scrollTop = 0;
      wheel(0, -amount, { deltaMode: mode });
      expect(settle).toHaveBeenLastCalledWith(-1, 0, "bottom");
    });

    it.each(["abrupt", "gradual"])("rearms trackpad navigation on reversal and %s renewed motion, but ignores decaying inertia", async (ramp) => {
      const { wheel, settle } = await desktopSetup();
      wheel(140, 0);
      for (const delta of [90, 60, 30, 10, 4]) wheel(delta, 0);
      expect(settle).toHaveBeenCalledTimes(1);
      if (ramp === "gradual") for (const delta of [8, 20, 35]) wheel(delta, 0);
      wheel(140, 0); // New flick after the inertia tail, with no idle interval.
      expect(settle).toHaveBeenCalledTimes(2);
      wheel(-140, 0);
      expect(settle).toHaveBeenLastCalledWith(-1, 0, undefined);
      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("keeps nested editing and scroll surfaces independent from document navigation", async () => {
      const { wheel, settle, scroller } = await desktopSetup();
      const textarea = document.createElement("textarea"); scroller.append(textarea);
      expect(wheel(140, 140, {}, textarea).defaultPrevented).toBe(false);
      const nested = document.createElement("div"); nested.style.overflowY = "auto"; scroller.append(nested);
      Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
      expect(wheel(0, 140, {}, nested).defaultPrevented).toBe(false);
      expect(settle).not.toHaveBeenCalled();
      expect(wheel(0, 140, { altKey: true }).defaultPrevented).toBe(false);
    });

    it("accepts page keys during an ongoing handoff without enabling edits", async () => {
      const { editor, scroller } = await desktopSetup();
      const navigate = vi.spyOn(editor, "desktopNavigate").mockImplementation(() => undefined);
      editor.flipSettling = true;
      const key = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
      scroller.dispatchEvent(key);
      expect(key.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledWith("next");
      scroller.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true }));
      expect(editor.state.tool).toBe("pen");
    });

    it.each(["loops", "horizontal waves", "vertical waves"])("locally erases %s with the normal pen and preserves adjacent ink, undo and redo", async (shape) => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn();
      editor.state.tool = "pen"; editor.state.pen.smooth = 100; editor.state.scribbleSensitivity = 25;
      let time = 1000;
      const sample = (x: number, y: number) => ({ pointerType: "pen", pointerId: 42, clientX: x, clientY: y, pressure: .5,
        timeStamp: time += 4, preventDefault() {} });
      editor.onPointerDown(sample(100, 500)); editor.onPointerMove(sample(900, 500)); editor.onPointerUp(sample(900, 500));
      const original = structuredClone(page.strokes[0]);
      const adjacent = { ...structuredClone(original), id: "adjacent", points: original.points.map((p) => ({ ...p, y: .59 })) };
      page.strokes.push(adjacent); editor.queueStrokePatch(page, [adjacent], []);
      editor.state.eraserMode = "stroke"; editor.state.eraserSize = 160;
      const fixture = shape === "loops" ? scribbleLoops() : rotateScribble(scribbleWaves(), shape === "horizontal waves" ? 90 : 0);
      const path = fixture.map((p) => ({ x: 300 + p.x * 4, y: 300 + p.y * 4 }));
      const history = editor.undoStack.length;
      editor.onPointerDown(sample(path[0].x, path[0].y));
      for (const p of path.slice(1, -1)) editor.onPointerMove(sample(p.x, p.y));
      const last = path[path.length - 1]; editor.onPointerUp(sample(last.x, last.y));
      expect(page.deletedStrokeIds).toContain(original.id);
      expect(page.strokes).toContainEqual(adjacent);
      const remaining = page.strokes.filter((s) => s.id !== adjacent.id);
      expect(remaining.length).toBeGreaterThanOrEqual(2);
      expect(Math.min(...remaining.flatMap((s) => s.points.map((p) => p.x)))).toBeCloseTo(original.points[0].x);
      expect(Math.max(...remaining.flatMap((s) => s.points.map((p) => p.x)))).toBeCloseTo(original.points.at(-1)!.x);
      expect(editor.undoStack).toHaveLength(history + 1);
      expect(editor.pendingInkStrokes).toHaveLength(0);
      expect(editor.committingInkStrokes).toBeNull();
      editor.undo(); expect(page.strokes).toHaveLength(2);
      expect(page.strokes.find((s) => s.id !== adjacent.id)!.points).toEqual(original.points);
      editor.redo(); expect(page.strokes.filter((s) => s.id !== adjacent.id).map((s) => s.points)).toEqual(remaining.map((s) => s.points));
    });

    it("clips scribbling to visible sticky ink and leaves the page and covered notes untouched", async () => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn(); editor.state.tool = "pen"; editor.state.pen.smooth = 0;
      let time = 1000;
      const sample = (x: number, y: number) => ({ pointerType: "pen", pointerId: 42, clientX: x, clientY: y, pressure: .5,
        timeStamp: time += 4, preventDefault() {} });
      const drawLine = () => { editor.onPointerDown(sample(300, 500)); editor.onPointerMove(sample(680, 500)); editor.onPointerUp(sample(680, 500)); };
      drawLine(); const underlying = structuredClone(page.strokes);
      editor.addSticky(); let note = page.stickyNotes![0]; editor.changeSticky(note, { ...note, x: .2, y: .35, width: .5, height: .3, boardPageWidth: 1000 });
      drawLine(); const covered = structuredClone(page.stickyNotes![0].strokes);
      editor.addSticky(); note = page.stickyNotes![1]; editor.changeSticky(note, { ...note, x: .2, y: .35, width: .5, height: .3, boardPageWidth: 1000 });
      drawLine(); const original = structuredClone(page.stickyNotes![1].strokes);
      // The normal page tile index deliberately does not contain sticky projections.
      vi.spyOn(editor.tiles, "query").mockImplementation(() => page.strokes.filter((s) => !editor.stickyInput?.owners.has(s.id)));
      const path = scribbleWaves().map((p) => ({ x: 300 + p.x * 4, y: 300 + p.y * 4 }));
      const history = editor.undoStack.length;
      editor.onPointerDown(sample(path[0].x, path[0].y));
      for (const p of path.slice(1, -1)) editor.onPointerMove(sample(p.x, p.y));
      editor.onPointerUp(sample(path.at(-1)!.x, path.at(-1)!.y));
      expect(page.strokes).toEqual(underlying); expect(page.stickyNotes![0].strokes).toEqual(covered);
      expect(page.stickyNotes![1].strokes).toHaveLength(2);
      expect(page.stickyNotes![1].deletedStrokeIds).toContain(original[0].id);
      expect(editor.undoStack).toHaveLength(history + 1);
      const clipped = page.stickyNotes![1].strokes.map((s) => s.points);
      editor.undo(); expect(page.stickyNotes![1].strokes.map((s) => s.points)).toEqual(original.map((s) => s.points));
      editor.redo(); expect(page.stickyNotes![1].strokes.map((s) => s.points)).toEqual(clipped);
      expect(page.strokes).toEqual(underlying); expect(page.stickyNotes![0].strokes).toEqual(covered);
    });

    it.each(["disabled", "blank paper", "highlighter", "cancelled"])("keeps smooth scribbles from erasing in %s input", async (scenario) => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn(); editor.state.tool = "pen"; editor.state.pen.smooth = 0;
      let time = 1000;
      const sample = (x: number, y: number) => ({ pointerType: "pen", pointerId: 42, clientX: x, clientY: y, pressure: .5,
        timeStamp: time += 4, preventDefault() {} });
      if (scenario !== "blank paper") {
        editor.onPointerDown(sample(300, 500)); editor.onPointerMove(sample(700, 500)); editor.onPointerUp(sample(700, 500));
      }
      const original = structuredClone(page.strokes);
      if (scenario === "disabled") editor.state.scribbleErase = false;
      if (scenario === "highlighter") editor.state.tool = "highlighter";
      const path = scribbleLoops().map((p) => ({ x: 300 + p.x * 4, y: 300 + p.y * 4 }));
      editor.onPointerDown(sample(path[0].x, path[0].y));
      for (const p of path.slice(1, -1)) editor.onPointerMove(sample(p.x, p.y));
      const last = sample(path.at(-1)!.x, path.at(-1)!.y);
      if (scenario === "cancelled") editor.onPointerCancel(last); else editor.onPointerUp(last);
      for (const stroke of original) expect(page.strokes).toContainEqual(stroke);
      // Interrupted stylus handwriting is retained by the existing input
      // contract, but it must not become a destructive erase command.
      expect(page.strokes).toHaveLength(original.length + 1);
      expect(page.deletedStrokeIds).not.toContain(original[0]?.id);
    });

    it("keeps fingers off ink by default and immediately writes/highlights/erases when opted in", async () => {
      const { editor, page, draw } = await setup();
      draw("pen"); expect(page.strokes).toHaveLength(0);
      editor.state.fingerAsPen = true;
      draw("pen"); expect(page.strokes).toHaveLength(1); expect(page.strokes[0].points.length).toBeGreaterThan(1);
      draw("highlighter", 500, 500); expect(page.strokes).toHaveLength(2);
      expect(page.strokes[1].tool).toBe("highlighter");
      draw("eraser"); expect(page.strokes).toHaveLength(1);
      editor.undo(); expect(page.strokes).toHaveLength(2);
      expect(editor.activePointerId).toBeNull();
    });

    it("selects and moves ink with a finger, and cancels its drag when pinch takes over", async () => {
      const { editor, page, finger, send, draw } = await setup();
      editor.state.fingerAsPen = true; draw("pen"); editor.state.fingerAsPen = false;
      editor.state.tool = "lasso"; editor.state.lasso.mode = "rectangle";
      send("touchstart", [finger(1, 100, 100)]); send("touchmove", [finger(1, 400, 400)]);
      send("touchend", [], [finger(1, 400, 400)]);
      expect(editor.selectedStrokeIds.size).toBe(1);
      const original = page.strokes[0].points.map((p) => ({ ...p }));
      send("touchstart", [finger(1, 250, 250)]); send("touchmove", [finger(1, 350, 350)]);
      send("touchend", [], [finger(1, 350, 350)]);
      expect(page.strokes[0].points[0].x).toBeCloseTo(original[0].x + .1);
      editor.undo(); expect(page.strokes[0].points).toEqual(original);
      editor.selectedStrokeIds = new Set([page.strokes[0].id]);
      send("touchstart", [finger(1, 250, 250)]); send("touchmove", [finger(1, 350, 350)]);
      send("touchstart", [finger(1, 350, 350), finger(2, 500, 350)], [finger(2, 500, 350)]);
      send("touchmove", [finger(1, 300, 350), finger(2, 550, 350)]);
      send("touchend", [], [finger(1, 300, 350), finger(2, 550, 350)]);
      expect(page.strokes[0].points).toEqual(original); expect(editor.zoom).toBeGreaterThan(1);
      expect(editor.activePointerId).toBeNull(); expect(editor.lassoDrag).toBeNull();
      expect(editor.toolbarRoot().querySelector(".ink-selection-actions")).toBeNull();
    });

    it.each(["freehand", "rectangle"])("directly selects the topmost sparse stroke in %s mode, moves only it and undoes", async (mode) => {
      const { editor, page, finger, send, draw } = await setup();
      editor.state.fingerAsPen = true; draw("pen"); draw("pen"); editor.state.fingerAsPen = false;
      const originals = page.strokes.map((stroke) => ({ ...stroke, points: [
        { x: .2, y: .2, pressure: .5, t: 1 }, { x: .4, y: .2, pressure: .5, t: 2 },
      ] }));
      page.strokes = originals.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
      editor.queueStrokePatch(page, page.strokes, []); editor.drawStrokes(page.strokes);
      editor.state.tool = "lasso"; editor.state.lasso.mode = mode;
      send("touchstart", [finger(1, 300, 200)]); send("touchend", [], [finger(1, 301, 200)]);
      expect([...editor.selectedStrokeIds]).toEqual([page.strokes[1].id]);
      expect(page.strokes.map((s) => s.points)).toEqual(originals.map((s) => s.points));
      send("touchstart", [finger(1, 300, 200)]); send("touchmove", [finger(1, 350, 250)]); send("touchend", [], [finger(1, 350, 250)]);
      expect(page.strokes[0].points).toEqual(originals[0].points); expect(page.strokes[1].points[0].x).toBeCloseTo(.25);
      editor.undo(); expect(page.strokes.map((s) => s.points)).toEqual(originals.map((s) => s.points));
      editor.redo(); expect(page.strokes[1].points[0].x).toBeCloseTo(.25);
      send("touchstart", [finger(1, 800, 800)]); send("touchend", [], [finger(1, 800, 800)]);
      expect(editor.selectedStrokeIds.size).toBe(0);
    });

    it("keeps an existing multi-stroke selection when its ink is grabbed and cancels pointer drag on interruption", async () => {
      const { editor, page, draw } = await setup();
      editor.state.fingerAsPen = true; draw("pen"); draw("pen", 500, 500); editor.state.fingerAsPen = false;
      editor.state.tool = "lasso"; editor.selectedStrokeIds = new Set(page.strokes.map((s) => s.id));
      const original = page.strokes.map((s) => s.points.map((p) => ({ ...p })));
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn();
      const contact = { pointerType: "mouse", pointerId: 10, clientX: 200, clientY: 200, pressure: .5 };
      editor.onPointerDown(contact); expect(editor.lassoDrag.strokes).toHaveLength(2);
      editor.onPointerMove({ ...contact, clientX: 230, clientY: 220 }); editor.flushPendingLassoPoint();
      editor.onPointerCancel(contact); expect(page.strokes.map((s) => s.points)).toEqual(original);
      expect(editor.lassoDrag).toBeNull(); expect(editor.activePointerId).toBeNull();
    });

    it.each(["pen", "highlighter", "eraser"])("rolls back provisional %s on a second finger without losing redo history", async (tool) => {
      const { editor, page, finger, send, draw } = await setup();
      editor.state.fingerAsPen = true; draw("pen"); draw("pen", 600, 600); editor.undo();
      const before = page.strokes.map((s) => s.points), history = [...editor.undoStack], redo = [...editor.redoStack];
      editor.state.tool = tool;
      send("touchstart", [finger(1, 200, 200)]);
      send("touchstart", [finger(1, 200, 200), finger(2, 400, 200)], [finger(2, 400, 200)]);
      send("touchmove", [finger(1, 150, 200), finger(2, 450, 200)]);
      send("touchend", [finger(1, 150, 200)], [finger(2, 450, 200)]);
      send("touchmove", [finger(1, 170, 220)]); send("touchend", [], [finger(1, 170, 220)]);
      expect(page.strokes.map((s) => s.points)).toEqual(before);
      expect(editor.undoStack).toEqual(history); expect(editor.redoStack).toEqual(redo);
      expect(editor.zoom).toBeGreaterThan(1); expect(editor.activePointerId).toBeNull();
      editor.redo(); expect(page.strokes).toHaveLength(2);
    });

    it("allows stationary finger paste with any writing tool without leaving ink or erasures", async () => {
      const { editor, page, host, finger, send, draw } = await setup();
      editor.state.fingerAsPen = true; draw("pen");
      editor.inkClipboard.copy({ filePath: editor.file?.path ?? "", width: 1000, height: 1000, strokes: page.strokes });
      const before = page.strokes.map((s) => s.points);
      vi.useFakeTimers();
      try {
        for (const tool of ["pen", "highlighter", "eraser"]) {
          editor.state.tool = tool; send("touchstart", [finger(1, 200, 200)]);
          vi.advanceTimersByTime(600);
          expect(page.strokes.map((s) => s.points)).toEqual(before);
          expect(editor.toolbarRoot().querySelector('[aria-label="Paste"]')).not.toBeNull();
          send("touchend", [], [finger(1, 200, 200)]);
          host.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 700, clientY: 700 }));
          expect(editor.toolbarRoot().querySelector('[aria-label="Paste"]')).not.toBeNull();
        }
      } finally { vi.useRealTimers(); }
    });

    it("shares the finger preference live and respects read-only mode and touch cancellation", async () => {
      const { editor, page, finger, send, draw } = await setup();
      const config = defaultToolState(); editor.useSharedToolState({ config, scheduleSave: vi.fn() });
      draw("pen"); expect(page.strokes).toHaveLength(0);
      config.fingerAsPen = true; draw("pen"); expect(page.strokes).toHaveLength(1);
      editor.state.tool = "pen"; send("touchstart", [finger(1, 500, 500)]); send("touchcancel", [], [finger(1, 500, 500)]);
      expect(page.strokes).toHaveLength(1); expect(editor.activePointerId).toBeNull();
      editor.setReadingMode(true); draw("pen"); expect(page.strokes).toHaveLength(1);
    });

    it("keeps an active stylus in control when a finger touches the page and ends finger input on blur", async () => {
      const { editor, page, finger, send } = await setup();
      editor.state.fingerAsPen = true;
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn();
      const pen = { pointerId: 42, pointerType: "pen", clientX: 200, clientY: 200, pressure: .5 };
      editor.onPointerDown(pen); send("touchstart", [finger(1, 700, 700)]);
      send("touchmove", [finger(1, 720, 720)]); send("touchend", [], [finger(1, 720, 720)]);
      expect(editor.activePointerId).toBe(42); expect(page.strokes).toHaveLength(1);
      editor.onPointerUp({ ...pen, clientX: 300, clientY: 300 });
      send("touchstart", [finger(1, 500, 500)]); window.dispatchEvent(new Event("blur"));
      expect(editor.activePointerId).toBeNull(); expect(editor.touchGesture).toBeNull();
      expect(page.strokes).toHaveLength(2);
    });

    it.each(["pointer", "stylus-touch"])("cancels a provisional finger contact when %s pen input begins", async (source) => {
      const { editor, page, finger, send } = await setup();
      editor.state.fingerAsPen = true; editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn();
      send("touchstart", [finger(1, 500, 500)]);
      if (source === "pointer") {
        const pen = { pointerId: 42, pointerType: "pen", clientX: 200, clientY: 200, pressure: .5 };
        editor.onPointerDown(pen); editor.onPointerUp({ ...pen, clientX: 300, clientY: 300 });
      } else {
        const pen = { ...finger(42, 200, 200), touchType: "stylus", force: .5 };
        send("touchstart", [finger(1, 500, 500), pen], [pen]);
        send("touchmove", [finger(1, 500, 500), { ...pen, clientX: 300, clientY: 300 }], [{ ...pen, clientX: 300, clientY: 300 }]);
        send("touchend", [finger(1, 500, 500)], [{ ...pen, clientX: 300, clientY: 300 }]);
      }
      send("touchend", [], [finger(1, 500, 500)]);
      expect(page.strokes).toHaveLength(1); expect(editor.undoStack).toHaveLength(1); expect(editor.activePointerId).toBeNull();
    });
  });
}
