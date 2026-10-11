import { describe, expect, it, vi } from "vitest";
import { defaultToolState } from "../src/tool-state";
import type { InkPage } from "../src/model";

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
