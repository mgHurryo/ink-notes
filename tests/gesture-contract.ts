import { describe, expect, it, vi } from "vitest";
import { defaultToolState } from "../src/tool-state";
import type { InkPage } from "../src/model";
import { rotateScribble, scribbleLoops, scribbleWaves } from "./scribble-fixtures";
import { SHAPES } from "../src/shapes";
import type { NotebookOperation } from "../src/worker-protocol";

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
      let wheelTime = 0;
      const wheel = (x: number, y: number, options: WheelEventInit & { timeStamp?: number } = {}, target: HTMLElement = scroller) => {
        const { timeStamp, ...init } = options;
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: x, deltaY: y, ...init });
        Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp ?? (wheelTime += 200) });
        target.dispatchEvent(event); return event;
      };
      return { editor, scroller, settle, wheel };
    }

    it.each(SHAPES)("draws %s live through the shape menu and finalizes one undoable stroke", async (kind, label) => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn();
      const operation = vi.spyOn(editor, "queueWorkerOperation");
      const button = editor.toolbarRoot().querySelector('[data-tool="shape"]') as HTMLButtonElement;
      button.click();
      const choice = Array.from(document.querySelectorAll<HTMLButtonElement>(".menu button")).find(b => b.textContent === label)!;
      expect(choice).toBeDefined(); choice.click();
      const sample = (x: number, y: number) => ({ pointerId: 42, pointerType: "pen", clientX: x, clientY: y, pressure: .7 });
      const history = editor.undoStack.length;
      editor.onPointerDown(sample(200, 200)); editor.onPointerMove(sample(600, 500));
      expect(page.strokes).toHaveLength(1);
      expect(page.strokes[0].points.length).toBeGreaterThan(1);
      expect(page.strokes[0].tool).toBe("pen");
      editor.onPointerUp(sample(650, 550));
      const points = structuredClone(page.strokes[0].points);
      expect(operation.mock.calls.some(([value]) => { const op = value as NotebookOperation;
        return op.type === "finalize-stroke" && JSON.stringify(op.stroke.points) === JSON.stringify(points); })).toBe(true);
      expect(editor.undoStack).toHaveLength(history + 1);
      editor.undo(); expect(page.strokes).toHaveLength(0);
      editor.redo(); expect(page.strokes[0].points).toEqual(points);
      // Re-tapping the same menu trigger closes it, rather than moving it.
      button.click(); expect(document.querySelector(".menu")).not.toBeNull();
      button.click(); expect(document.querySelector(".menu")).toBeNull();
    });

    it.each(["pointer", "stylus-touch"])("straightens held %s input after two seconds, tolerates jitter and adjusts the endpoint", async source => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn(); editor.state.pen.smooth = 60;
      const operation = vi.spyOn(editor, "queueWorkerOperation");
      vi.useFakeTimers();
      try {
        let time = 100;
        const sample = (x: number, y: number) => ({ pointerId: 42, pointerType: "pen", clientX: x, clientY: y, pressure: .6, timeStamp: time += 10 });
        editor.onPointerDown(sample(200, 200), source);
        for (const [x,y] of [[300,201], [400,199], [500,200]]) editor.onPointerMove(sample(x,y), source);
        vi.advanceTimersByTime(1500); editor.onPointerMove(sample(501,200), source);
        vi.advanceTimersByTime(499); expect(editor.geometricStroke).toBeNull();
        vi.advanceTimersByTime(1); expect(page.strokes[0].points).toHaveLength(2);
        expect(page.strokes[0].points[0].x).toBeCloseTo(.2);
        editor.onPointerMove(sample(700,250), source);
        expect(page.strokes[0].points).toHaveLength(2);
        expect(page.strokes[0].points[1].x).toBeCloseTo(.7);
        editor.onPointerUp(sample(700,250), source);
        expect(page.strokes[0].points).toHaveLength(2);
        expect(operation.mock.calls.some(([op]) => (op as NotebookOperation).type === "finalize-stroke")).toBe(true);
        editor.undo(); expect(page.strokes).toHaveLength(0);
        editor.redo(); expect(page.strokes[0].points).toHaveLength(2);
      } finally { vi.useRealTimers(); }
    });

    it("keeps shape drawing under the existing finger opt-in", async () => {
      const { editor, page, draw } = await setup();
      draw("shape"); expect(page.strokes).toHaveLength(0);
      editor.state.fingerAsPen = true;
      draw("shape"); expect(page.strokes).toHaveLength(1);
      expect(page.strokes[0].points).toHaveLength(5);
    });

    it("ignores a late freehand Worker outline after a held line replaces its points", async () => {
      const { editor } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn(); editor.state.pen.smooth = 0;
      const queue = vi.spyOn(editor, "queueWorkerOperation").mockImplementation(() => undefined);
      vi.useFakeTimers();
      try {
        const sample = (x: number, y: number) => ({ pointerId:42, pointerType:"pen", clientX:x, clientY:y, pressure:.6 });
        editor.onPointerDown(sample(200,200)); editor.onPointerMove(sample(300,201)); editor.onPointerMove(sample(500,200));
        editor.flushWorkerStrokePoints();
        const append = queue.mock.calls.find(([value]) => (value as NotebookOperation).type === "append-stroke-points")!;
        expect(append).toBeDefined();
        vi.advanceTimersByTime(2000);
        (append[2] as (value: unknown) => void)({ type:"operation-applied", strokeId:editor.activeStroke.id,
          outline:new Float32Array([0,0,1,1]), sampleCount:100 });
        expect(editor.confirmedStrokeOutlines.has(editor.activeStroke.id)).toBe(false);
        expect(editor.activeStroke.points).toHaveLength(2);
        editor.finishPointerInput(true);
      } finally { vi.useRealTimers(); }
    });

    it.each(["shape", "hold"])("routes %s ink into a sticky note with one-step undo", async kind => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn(); editor.state.pen.smooth = 0;
      editor.addSticky(); const note = page.stickyNotes![0];
      editor.changeSticky(note, { ...note, x:.2, y:.2, width:.5, height:.5, boardPageWidth:1000 });
      editor.state.tool = kind === "shape" ? "shape" : "pen";
      const sample = (x: number, y: number) => ({ pointerId:42, pointerType:"pen", clientX:x, clientY:y, pressure:.6 });
      vi.useFakeTimers();
      try {
        editor.onPointerDown(sample(300,350)); editor.onPointerMove(sample(400,351)); editor.onPointerMove(sample(600,350));
        if (kind === "hold") vi.advanceTimersByTime(2000);
        editor.onPointerUp(sample(600,350));
        expect(page.strokes).toHaveLength(0);
        expect(page.stickyNotes![0].strokes.length).toBeGreaterThan(0);
        const points = structuredClone(page.stickyNotes![0].strokes.map(s => s.points));
        editor.undo(); expect(page.stickyNotes![0].strokes).toHaveLength(0);
        editor.redo(); expect(page.stickyNotes![0].strokes.map(s => s.points)).toEqual(points);
      } finally { vi.useRealTimers(); }
    });

    it.each(["lift", "cancel", "tool", "reading", "blur", "moving", "curve", "highlighter"])("does not straighten after %s", async scenario => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn(); editor.state.pen.smooth = 0;
      vi.useFakeTimers();
      try {
        const sample = (x: number, y: number) => ({ pointerId: 42, pointerType: "pen", clientX: x, clientY: y, pressure: .6 });
        if (scenario === "highlighter") editor.state.tool = "highlighter";
        editor.onPointerDown(sample(200,200)); editor.onPointerMove(sample(300,scenario === "curve" ? 300 : 201));
        editor.onPointerMove(sample(500,200));
        if (scenario === "lift") editor.onPointerUp(sample(500,200));
        if (scenario === "cancel") editor.onPointerCancel(sample(500,200));
        if (scenario === "tool") editor.selectWritingTool("eraser");
        if (scenario === "reading") editor.setReadingMode(true);
        if (scenario === "blur") window.dispatchEvent(new Event("blur"));
        if (scenario === "moving") { vi.advanceTimersByTime(1500); editor.onPointerMove(sample(600,200)); vi.advanceTimersByTime(1000); }
        else vi.advanceTimersByTime(2500);
        expect(editor.geometricStroke).toBeNull();
        expect(page.strokes[0].points.length).toBeGreaterThan(2);
        editor.finishPointerInput(false);
      } finally { vi.useRealTimers(); }
    });

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

    it("keeps a fast pixel touchpad flick together and normalizes line-unit scrolling", async () => {
      const { scroller, settle, wheel } = await desktopSetup();
      scroller.scrollTop = 600;
      wheel(0, 140, { timeStamp: 100 });
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150]]) wheel(0, delta, { timeStamp: time });
      expect(settle).toHaveBeenCalledOnce();
      scroller.scrollTop = 0;
      wheel(0, 10, { deltaMode: 1, timeStamp: 160 });
      expect(settle).toHaveBeenCalledOnce();
      expect(scroller.scrollTop).toBe(160);
      wheel(0, 2, { deltaMode: 1, timeStamp: 400 });
      expect(scroller.scrollTop).toBe(192);
      expect(settle).toHaveBeenCalledOnce();
    });

    it("turns one page for each standard vertical mouse-wheel notch", async () => {
      const { scroller, settle, wheel } = await desktopSetup();
      scroller.scrollTop = 600;
      // Notches land 200ms apart so each is its own gesture: deliberate
      // wheel-by-wheel scrolling stays one page per notch. A sub-180ms burst
      // is one gesture and stops at the per-gesture page budget instead.
      for (let index = 0; index < 5; index++) wheel(0, 100, { timeStamp: 100 + index * 200 });
      expect(settle).toHaveBeenCalledTimes(5);
      expect(settle).toHaveBeenNthCalledWith(1, 1, 0, "top");
    });

    it("counts one high-speed pixel wheel event as one page and caps the dampened burst at the per-gesture budget", async () => {
      const { scroller, settle, wheel } = await desktopSetup();
      scroller.scrollTop = 600;
      wheel(0, 1200, { timeStamp: 100 });
      expect(settle).toHaveBeenCalledTimes(1);

      // The 0.8 damping still spreads credit (the second page lands on the
      // third notch), but a sub-180ms notch stream is one gesture, so the
      // burst stops at MAX_TRACKPAD_PAGES_PER_GESTURE (2) pages in total.
      for (const timeStamp of [140, 180, 220, 260]) wheel(0, 100, { timeStamp });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it("waits for a quiet gap before rearming a same-direction trackpad flick", async () => {
      const { wheel, settle } = await desktopSetup();
      vi.useFakeTimers();
      try {
        wheel(140, 0, { timeStamp: 100 });
        for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [20, 140], [18, 150], [15, 160]]) {
          wheel(delta, 0, { timeStamp: time });
        }
        expect(settle).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(180);
        wheel(140, 0, { timeStamp: 340 });
        expect(settle).toHaveBeenCalledTimes(2);
      } finally { vi.useRealTimers(); }
    });

    it("rearms a constant-velocity flick that lands inside the inertia tail", async () => {
      const { wheel, settle } = await desktopSetup();
      // A Windows precision trackpad bridges human re-flick cadence with a
      // 1-2s inertia tail, and a fresh flick's fast-phase deltas hold nearly
      // constant instead of compounding - the jump itself must re-arm.
      wheel(140, 0, { timeStamp: 100 });
      for (const [delta, timeStamp] of [[90, 110], [60, 120], [35, 130], [25, 140]]) {
        wheel(delta, 0, { timeStamp });
      }
      expect(settle).toHaveBeenCalledTimes(1);
      for (const timeStamp of [150, 160, 170]) wheel(60, 0, { timeStamp });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it("rearms a constant-velocity vertical flick that lands inside the inertia tail", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      scroller.scrollTop = 600;
      wheel(0, 140, { timeStamp: 100 });
      for (const [delta, timeStamp] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150]]) {
        wheel(0, delta, { timeStamp });
      }
      expect(settle).toHaveBeenCalledTimes(1);
      for (const timeStamp of [210, 220, 230, 240]) wheel(0, 60, { timeStamp });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it("rearms a constant-velocity vertical flick landing inside the inertia tail without a quiet gap", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      // A real Windows precision trackpad bridges a human re-flick with a
      // 1-2s inertia tail, so every gap stays under the quiet-gap threshold
      // and the jump itself must re-arm - the vertical mirror of the
      // horizontal constant-velocity rearm above.
      scroller.scrollTop = 600;
      wheel(0, 140, { timeStamp: 100 });
      for (const [delta, timeStamp] of [[90, 110], [60, 120], [30, 130], [20, 140], [14, 150]]) {
        wheel(0, delta, { timeStamp });
      }
      expect(settle).toHaveBeenCalledTimes(1);
      for (const timeStamp of [160, 170, 180, 190]) wheel(0, 60, { timeStamp });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it("does not rearm while the same tail decays smoothly", async () => {
      const { wheel, settle } = await desktopSetup();
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [40, 130], [30, 140],
        [25, 150], [20, 160], [15, 170], [12, 180], [10, 190]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("does not rearm while the same vertical tail decays smoothly", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      scroller.scrollTop = 600;
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [40, 130], [30, 140],
        [25, 150], [20, 160], [15, 170], [12, 180], [10, 190]]) {
        wheel(0, delta, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("keeps the visual single-flick fixture burst to one page", async () => {
      const { wheel, settle } = await desktopSetup();
      // tests/visual/desktop-input.spec.ts "a trackpad flick advances one page"
      // dispatches this exact burst with real ~0ms gaps. The deltas must decay
      // monotonically: a mid-tail rise over the decayed envelope (>= 2.2x) is
      // contracted as a renewed flick and would flip a second page, so the
      // fixture and this burst must evolve together.
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [30, 130], [20, 140],
        [14, 150], [10, 160]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("keeps the same decaying burst to one page on the vertical axis", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      // The vertical mirror of the fixture burst above: sharing the jump
      // re-arm with the x axis must not let a monotonically decaying y burst
      // clear the 2.2x envelope and flip a second page.
      scroller.scrollTop = 600;
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [30, 130], [20, 140],
        [14, 150], [10, 160]]) {
        wheel(0, delta, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("caps the visual vertical five-notch dampened burst at the per-gesture budget", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      // The same visual test fires five deltaY=100 notches in one synchronous
      // task right after the horizontal burst above. Synchronous dispatch
      // collides real Event.timeStamps, and a 0ms gap keeps notch sensitivity
      // at 1.0, so the fixture must pin a 40ms cadence. That 40ms stream is
      // one gesture, so the damped burst now flips the budgeted two pages
      // instead of four: 1 + 2 settles.
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [30, 130], [20, 140],
        [14, 150], [10, 160]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      scroller.scrollTop = 600;
      for (const timeStamp of [340, 380, 420, 460, 500]) wheel(0, 100, { timeStamp });
      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("rearms a horizontal trackpad flick after a short pause and a renewed swipe", async () => {
      const { wheel, settle } = await desktopSetup();
      vi.useFakeTimers();
      try {
        wheel(140, 0, { timeStamp: 100 });
        for (const [delta, timeStamp] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150]]) {
          wheel(delta, 0, { timeStamp });
        }
        expect(settle).toHaveBeenCalledTimes(1);
        wheel(140, 0, { timeStamp: 210 });
        expect(settle).toHaveBeenCalledTimes(2);
      } finally { vi.useRealTimers(); }
    });

    it("rearms trackpad navigation on reversal and a renewed horizontal flick", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(140, 0, { timeStamp: 100 });
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
      // A new flick ramps up before the old burst reaches its idle timeout; the
      // re-armed gesture flips once its own travel crosses the page threshold.
      for (const [delta, time] of [[8, 154], [20, 164], [35, 174], [70, 184]]) wheel(delta, 0, { timeStamp: time });
      expect(settle).toHaveBeenCalledTimes(2);
      wheel(-60, 0, { timeStamp: 194 });
      expect(settle).toHaveBeenLastCalledWith(-1, 0, undefined);
      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("rearms an aggressively stronger flick while the previous renewal is still blocked", async () => {
      const { wheel, settle } = await desktopSetup();
      for (const [delta, timeStamp] of [[140, 100], [90, 110], [60, 120], [40, 130], [26, 140],
        [60, 150], [60, 160], [40, 170], [55, 180]]) {
        wheel(delta, 0, { timeStamp });
      }
      expect(settle).toHaveBeenCalledTimes(2);
      // Blocked after the mid-tail renewal: the same flick's continuation stays
      // suppressed, but a jump 3x over the decayed envelope re-arms.
      wheel(200, 0, { timeStamp: 190 });
      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("rearms a same-direction touchpad flick that ramps up from small deltas", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(140, 0, { timeStamp: 100 });
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150]]) wheel(delta, 0, { timeStamp: time });
      expect(settle).toHaveBeenCalledOnce();

      for (const [delta, time] of [[8, 210], [20, 220], [35, 230], [70, 240]]) wheel(delta, 0, { timeStamp: time });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it("turns a page on a short intentional horizontal touchpad swipe", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(60, 0, { timeStamp: 100 });
      expect(settle).toHaveBeenCalledOnce();
    });

    it("rearms a horizontal trackpad swipe that accelerates before inertia goes idle", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(140, 0, { timeStamp: 100 });
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150]]) wheel(delta, 0, { timeStamp: time });
      expect(settle).toHaveBeenCalledOnce();

      for (const [delta, time] of [[8, 154], [20, 164], [35, 174], [70, 184]]) wheel(delta, 0, { timeStamp: time });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it("rearms after a short-gap flick without requiring a near-zero inertia event", async () => {
      const { wheel, settle } = await desktopSetup();
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [30, 130], [10, 140], [8, 150],
        [20, 160], [35, 170], [70, 180], [90, 190], [60, 200], [30, 210], [10, 220]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(2);

      for (const [delta, time] of [[8, 280], [20, 290], [35, 300], [70, 310]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("rearms repeated horizontal swipes when each new stream starts below the prior inertia delta", async () => {
      const { wheel, settle } = await desktopSetup();
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [30, 130], [10, 140],
        [20, 200], [30, 210], [45, 220], [20, 280], [30, 290], [45, 300]]) {
        wheel(delta, 0, { timeStamp: time });
      }

      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("resets the two-page limit for each renewed same-direction swipe", async () => {
      const { wheel, settle } = await desktopSetup();
      for (const [delta, timeStamp] of [
        [140, 100], [90, 110], [60, 120], [30, 130], [10, 140], [4, 150],
        [140, 210], [90, 220], [60, 230], [30, 240], [10, 250], [4, 260], [140, 320],
      ]) wheel(delta, 0, { timeStamp });
      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("bounds trackpad pages queued during one slow page handoff", async () => {
      const { editor, wheel } = await desktopSetup();
      const desktop = editor as any;
      desktop.flipSettling = true;
      desktop.beginPageSwipe(1, 6, 0);
      for (const timeStamp of [100, 110, 120, 130]) wheel(120, 0, { timeStamp });
      expect(desktop.pageSwipeRequest.target).toBe(2);
      desktop.queueTrackpadPageSwipeDelta(1, 42);
      desktop.queueTrackpadPageSwipeDelta(1, 42);
      expect(desktop.pageSwipeRequest.target).toBe(3);
    });

    it("keeps a mouse drag from adding a page to queued trackpad gestures", async () => {
      const { editor, wheel } = await desktopSetup();
      const desktop = editor as any;
      desktop.flipSettling = true;
      desktop.beginPageSwipe(1, 6, 0);
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [30, 130], [10, 140], [4, 150],
        [8, 154], [20, 164], [35, 174], [70, 184], [20, 194], [10, 204], [4, 214],
        [8, 218], [20, 228], [35, 238], [70, 248]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(desktop.pageSwipeRequest.target).toBe(4);
      editor.capturePointer = vi.fn();
      editor.releasePointer = vi.fn();

      const sample = (x: number) => ({
        pointerType: "mouse", pointerId: 7, button: 1, clientX: x, clientY: 200,
        preventDefault: vi.fn(),
      });
      editor.onPointerDown(sample(500));
      editor.onPointerMove(sample(100));
      editor.onPointerUp(sample(100));

      expect(desktop.pageSwipeRequest.target).toBe(2);
    });

    it("keeps each discrete mouse-wheel notch queued during a slow page handoff", async () => {
      const { editor, wheel } = await desktopSetup();
      const desktop = editor as any;
      desktop.flipSettling = true;
      desktop.beginPageSwipe(1, 6, 0);
      // 200ms gaps keep every notch its own gesture, so each deliberate notch
      // still queues onto the in-flight swipe; a sub-180ms burst would stop
      // at the per-gesture page budget.
      for (const timeStamp of [100, 300, 500]) wheel(0, 100, { timeStamp });
      expect(desktop.pageSwipeRequest.target).toBe(4);
    });

    it("never pages again on decaying or constant momentum continuation", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(140, 0, { timeStamp: 100 });
      // A tail that only decays or holds constant is what momentum looks like
      // on supported trackpads (#264); it must stay suppressed, ripples below
      // the 24px re-arm floor included.
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [20, 140], [20, 150],
        [20, 160], [12, 170], [12, 180], [6, 190], [5, 200]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
      wheel(140, 0, { timeStamp: 500 });
      expect(settle).toHaveBeenCalledTimes(2);
    });

    it("re-arms a rising sequence after the tail as a fresh flick", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(140, 0, { timeStamp: 100 });
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150],
        [8, 154], [20, 164], [35, 174], [70, 184], [90, 194], [110, 204], [90, 214], [60, 224]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(2);

      // A second sustained rise (8 -> 70 within 30ms, 8.75x) cannot be
      // momentum: supported-trackpad tails hold constant or decay (#264), so
      // it is a new finger contact and the blocked window re-arms on it. This
      // rise used to be swallowed here.
      for (const [delta, time] of [[8, 234], [20, 244], [35, 254], [70, 264]]) wheel(delta, 0, { timeStamp: time });
      expect(settle).toHaveBeenCalledTimes(3);
    });

    it("keeps a single contact with one momentum tail to at most two pages", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(140, 0, { timeStamp: 100 });
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [10, 140], [4, 150]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
      // One mid-tail flick may land (initial + at most one continuation); the
      // tail decaying afterwards must not add a page.
      for (const [delta, time] of [[50, 160], [55, 170], [60, 180], [30, 190], [20, 200], [12, 210], [25, 220]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(2);
      // Only a new finger contact after an idle gap produces a third page.
      wheel(140, 0, { timeStamp: 500 });
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

    it("keeps noisy horizontal gestures out of nested vertical scrollers", async () => {
      const { wheel, settle, scroller } = await desktopSetup();
      const nested = document.createElement("div"); nested.style.overflowY = "auto"; scroller.append(nested);
      Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });

      const event = wheel(140, 140, {}, nested);

      expect(event.defaultPrevented).toBe(true);
      expect(settle).toHaveBeenCalledOnce();
      expect(settle).toHaveBeenCalledWith(1, 0, undefined);
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
