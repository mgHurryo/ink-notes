import { describe, expect, it, vi } from "vitest";
import { defaultToolState } from "../src/tool-state";
import type { InkPage } from "../src/model";
import { rotateScribble, scribbleLoops, scribbleWaves } from "./scribble-fixtures";
import { SHAPES } from "../src/shapes";
import type { NotebookOperation } from "../src/worker-protocol";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WheelEventData } from "wheel-gestures";

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

    function makeScrollable(editor: { inputScroller(): HTMLElement }) {
      const scroller = editor.inputScroller();
      let top = 200, left = 0;
      Object.defineProperties(scroller, {
        clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 1200 },
        clientWidth: { configurable: true, value: 800 }, scrollWidth: { configurable: true, value: 1000 },
        scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(600, value)); } },
        scrollLeft: { configurable: true, get: () => left, set: (value: number) => { left = Math.max(0, Math.min(200, value)); } },
      });
      return () => top;
    }

    async function desktopSetup() {
      const { editor, finger, send } = await setup();
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
      const wheel = (x: number, y: number, options: WheelEventInit & { timeStamp?: number; momentum?: boolean } = {}, target: HTMLElement = scroller) => {
        const { timeStamp, momentum, ...init } = options;
        const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: x, deltaY: y, ...init });
        Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp ?? (wheelTime += 200) });
        if (momentum !== undefined) Object.defineProperty(event, "momentum", { value: momentum });
        target.dispatchEvent(event);
        // jsdom has no wheel default action; model the browser's native scroll
        // when either axis passes through uncanceled.
        if (target === scroller && !event.defaultPrevented) {
          const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
          scroller.scrollLeft += (x || (event.shiftKey ? y : 0)) * scale;
          if (!event.shiftKey) scroller.scrollTop += y * scale;
        }
        return event;
      };
      return { editor, scroller, settle, wheel, finger, send };
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

    it.each(["pointer", "stylus-touch"])("straightens held %s input after 800ms, tolerates jitter and adjusts the endpoint", async source => {
      const { editor, page } = await setup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn(); editor.state.pen.smooth = 60;
      const operation = vi.spyOn(editor, "queueWorkerOperation");
      vi.useFakeTimers();
      try {
        let time = 100;
        const sample = (x: number, y: number) => ({ pointerId: 42, pointerType: "pen", clientX: x, clientY: y, pressure: .6, timeStamp: time += 10 });
        editor.onPointerDown(sample(200, 200), source);
        for (const [x,y] of [[300,201], [400,199], [500,200]]) editor.onPointerMove(sample(x,y), source);
        vi.advanceTimersByTime(500); editor.onPointerMove(sample(501,200), source);
        vi.advanceTimersByTime(299); expect(editor.geometricStroke).toBeNull();
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
        if (scenario === "moving") { vi.advanceTimersByTime(700); editor.onPointerMove(sample(600,250)); vi.advanceTimersByTime(900); }
        else vi.advanceTimersByTime(2500);
        expect(editor.geometricStroke).toBeNull();
        expect(page.strokes[0].points.length).toBeGreaterThan(2);
        editor.finishPointerInput(false);
      } finally { vi.useRealTimers(); }
    });


    // Input-phase recognition is exercised with upstream device recordings.
    // Historical tests tied to the removed rearm ratios/55ms windows are
    // replaced here; application ownership, queues and mouse contracts remain.
    for (const axis of ["x", "y"] as const) {
      for (const direction of [-1, 1]) {
        it.each([
          ["win-chrome-right-ptp", 1], ["win-chrome-fast-right-ptp", 1],
          ["double-swipe-right", 2], ["slow-drag-right", 1],
        ] as const)(`${axis}, direction ${direction}: routes recorded %s through the shared view entry`, async (name, count) => {
          const { editor, scroller, settle, wheel } = await desktopSetup();
          const recording = JSON.parse(readFileSync(resolve("tests/fixtures/wheel-gestures", `${name}.json`), "utf8")) as { wheelEvents: WheelEventData[] };
          scroller.scrollTop = direction > 0 ? 0 : 600;
          vi.useFakeTimers();
          try {
            let previous = recording.wheelEvents[0].timeStamp;
            for (const raw of recording.wheelEvents) {
              vi.advanceTimersByTime(Math.max(0, raw.timeStamp - previous));
              const lift = raw.deltaX === 0 && raw.deltaY === 0 && Object.is(raw.deltaX, -0);
              const x = lift ? -0 : direction * (axis === "x" ? raw.deltaX : raw.deltaY);
              const y = direction * (axis === "x" ? raw.deltaY : raw.deltaX);
              wheel(x, y, { timeStamp: raw.timeStamp });
              previous = raw.timeStamp;
            }
            expect(settle).toHaveBeenCalledTimes(count);
            const edge = axis === "y" ? (direction > 0 ? "bottom" : "top") : undefined;
            expect(settle).toHaveBeenLastCalledWith(-direction, 0, edge);
            vi.advanceTimersByTime(1100);
            expect(settle).toHaveBeenCalledTimes(count);
          } finally { editor.desktopWheel.reset(); vi.useRealTimers(); }
        });
      }

      it(`${axis}: pages again on a small native intentional swipe after inertia`, async () => {
        const { scroller, wheel, settle } = await desktopSetup();
        scroller.scrollTop = 600;
        const send = (movement: number, at: number, momentum: boolean) =>
          wheel(axis === "x" ? movement : 0, axis === "y" ? movement : 0, { timeStamp: at, momentum });
        send(60, 0, false);
        send(30, 10, true);
        send(600, 20, true); // A merged inertia sample must not create a page.
        expect(settle).toHaveBeenCalledTimes(1);
        send(24, 30, false);
        send(24, 40, false);
        expect(settle).toHaveBeenCalledTimes(2);
      });

      it(`${axis}: pans natively while zoomed and pages only on continued input at the boundary`, async () => {
        const { editor, scroller, settle, wheel } = await desktopSetup();
        vi.spyOn(editor, "zoomLevel").mockReturnValue(2);
        let left = 100;
        Object.defineProperties(scroller, {
          scrollWidth: { configurable: true, value: 1400 },
          scrollLeft: { configurable: true, get: () => left, set: (v: number) => { left = Math.max(0, Math.min(600, v)); } },
        });
        scroller.scrollTop = 100;
        const send = (movement: number, at: number) =>
          wheel(axis === "x" ? movement : 0, axis === "y" ? movement : 0, { timeStamp: at, momentum: false });
        expect(send(30, 0).defaultPrevented).toBe(false);
        expect(axis === "x" ? scroller.scrollLeft : scroller.scrollTop).toBe(130);
        expect(settle).not.toHaveBeenCalled();
        if (axis === "x") scroller.scrollLeft = 600;
        else scroller.scrollTop = 600;
        expect(send(60, 10).defaultPrevented).toBe(true);
        expect(settle).toHaveBeenCalledWith(1, 0, axis === "x" ? undefined : "top");
      });

      it(`${axis}: fast paging opens the same preview rail and user selection claims it`, async () => {
        const { editor, scroller, settle, wheel } = await desktopSetup();
        scroller.scrollTop = 600;
        const expanded = vi.spyOn(editor, "onFastPagingRailExpanded");
        const send = (movement: number, at: number, momentum: boolean) =>
          wheel(axis === "x" ? movement : 0, axis === "y" ? movement : 0, { timeStamp: at, momentum });
        for (const at of [0, 100, 200]) { send(60, at, false); send(10, at + 10, true); }
        expect(settle).toHaveBeenCalledTimes(3);
        expect(expanded).toHaveBeenCalledOnce();
        expect(editor.isFastPagingRailOpen()).toBe(true);
        editor.claimFastPagingRail();
        expect(editor.fastPagingRailBorrowed).toBe(false);
      });
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

    it("keeps swipe suppression across a pen stroke", async () => {
      const { editor, scroller, settle, wheel } = await desktopSetup();
      editor.capturePointer = vi.fn(); editor.releasePointer = vi.fn();
      scroller.scrollTop = 600;
      vi.useFakeTimers();
      try {
      // One flick plus its decay tail: a single contact, one page.
      wheel(0, 140, { timeStamp: 100 });
      for (const [delta, time] of [[90, 110], [60, 120], [30, 130], [10, 140]]) wheel(0, delta, { timeStamp: time });
      expect(settle).toHaveBeenCalledTimes(1);
      // Tail samples arriving under a live pen stroke must not reset the
      // gesture: resetting would mint a fresh contact, so the stroke-tail
      // travel re-pages with no input after the pen lifts. The samples are
      // still swallowed - only the reset is dropped.
      editor.state.tool = "pen";
      const sample = (x: number, y: number) => ({ pointerId: 42, pointerType: "pen", clientX: x, clientY: y, pressure: .6 });
      editor.onPointerDown(sample(200, 200));
      // Borrowed samples must still cancel the native scroll: default
      // scrolling moves the rect the stroke maps client coordinates
      // against, kinking the ink by exactly the scrolled amount. The
      // ctrl+wheel page-zoom path is cancelled the same way.
      expect(wheel(0, 60, { timeStamp: 170 }).defaultPrevented).toBe(true);
      expect(wheel(0, 60, { timeStamp: 175, ctrlKey: true }).defaultPrevented).toBe(true);
      for (const time of [180, 190]) wheel(0, 60, { timeStamp: time });
      editor.onPointerUp(sample(200, 200));
      // The tail keeps decaying on the original contact's clock, suppressed.
      for (const [delta, time] of [[40, 210], [32, 230], [24, 250], [18, 270],
        [12, 290], [8, 310], [5, 330], [3, 350]]) wheel(0, delta, { timeStamp: time });
      expect(settle).toHaveBeenCalledTimes(1);
      // A deliberate re-swipe after the stroke still re-arms and flips.
      // The external recognizer uses actual scheduled end events, not only
      // the supplied sample timestamps: advance the real quiet interval too.
      vi.advanceTimersByTime(300);
      wheel(0, 140, { timeStamp: 650 });
      wheel(0, 140, { timeStamp: 660 });
      expect(settle).toHaveBeenCalledTimes(2);
      } finally { editor.desktopWheel.reset(); vi.useRealTimers(); }
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
      // The vertical mirror of the fixture above remains one continuous
      // gesture and must not gain another page from its decaying samples.
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

    it("keeps the page rail open briefly after fast vertical paging, then hands it back", async () => {
      const { editor, scroller, wheel } = await desktopSetup();
      const root = (editor as any).root as HTMLElement;
      const railHidden = () => root.classList.contains("ink-rail-hidden");
      expect(railHidden()).toBe(true);
      // Slow paging: one deliberate notch must not pop the rail.
      scroller.scrollTop = 600;
      wheel(0, 100, { timeStamp: 100 });
      expect(railHidden()).toBe(true);
      vi.useFakeTimers();
      try {
        // Three notches at a 200ms cadence are separate contacts: three
        // vertical pages inside the one-second window engage the rail.
        scroller.scrollTop = 600;
        for (const timeStamp of [1000, 1200, 1400]) wheel(0, 100, { timeStamp });
        expect(railHidden()).toBe(false);
        // Once the window stops holding three pages the burst is over; keep
        // the destination visible beyond the former one-second cutoff.
        vi.advanceTimersByTime(1000);
        expect(railHidden()).toBe(false);
        // A 1-2s trackpad finger lift keeps the rail borrowed; only a full
        // 3s of quiet hands it back.
        vi.advanceTimersByTime(1500);
        expect(railHidden()).toBe(false);
        vi.advanceTimersByTime(500);
        expect(railHidden()).toBe(true);
        // Three synchronous samples are one continuous sideways gesture,
        // so they contribute only one page and cannot reopen the rail.
        for (const timeStamp of [2600, 2800, 3000]) wheel(140, 0, { timeStamp });
        expect(railHidden()).toBe(true);
      } finally { vi.useRealTimers(); }
    });

    it("keeps a borrowed rail open while wheel activity continues, then closes after silence", async () => {
      const { editor, scroller, wheel } = await desktopSetup();
      const root = (editor as any).root as HTMLElement;
      const railHidden = () => root.classList.contains("ink-rail-hidden");
      vi.useFakeTimers();
      try {
        // Three notches at a 200ms cadence are separate contacts: engage the
        // rail the same way the test above does.
        scroller.scrollTop = 600;
        for (const timeStamp of [1000, 1200, 1400]) wheel(0, 100, { timeStamp });
        expect(railHidden()).toBe(false);
        // Continuing horizontal input keeps the borrowed rail visible even
        // when this gesture has already spent its page budget.
        vi.advanceTimersByTime(300);
        wheel(140, 0, { timeStamp: 2500 });
        vi.advanceTimersByTime(300);
        wheel(140, 0, { timeStamp: 2900 });
        vi.advanceTimersByTime(300);
        wheel(140, 0, { timeStamp: 3300 });
        vi.advanceTimersByTime(800);
        expect(railHidden()).toBe(false);
        // With no further wheel events, the normal quiet interval hands back
        // a rail that the fast vertical burst borrowed from the user (the 3s
        // window: 800 + 2200 crosses it; shorter lifts stay borrowed).
        vi.advanceTimersByTime(2200);
        expect(railHidden()).toBe(true);
      } finally { vi.useRealTimers(); }
    });

    it("keeps a rail the user already expanded open across a fast paging burst", async () => {
      const { editor, scroller, wheel } = await desktopSetup();
      const root = (editor as any).root as HTMLElement;
      (editor.toolbarRoot().querySelector('button[aria-label="Pages"]') as HTMLButtonElement).click();
      expect(root.classList.contains("ink-rail-hidden")).toBe(false);
      vi.useFakeTimers();
      try {
        scroller.scrollTop = 600;
        for (const timeStamp of [100, 300, 500]) wheel(0, 100, { timeStamp });
        expect(root.classList.contains("ink-rail-hidden")).toBe(false);
        vi.advanceTimersByTime(1000);
        // The burst borrowed nothing, so the quiet timer must not hide a
        // rail the user expanded themselves.
        expect(root.classList.contains("ink-rail-hidden")).toBe(false);
      } finally { vi.useRealTimers(); }
    });

    it("keeps the preview rail open after the user selects a thumbnail", async () => {
      const { editor } = await setup();
      const root = editor.toolbarRoot() as HTMLElement;
      const rail = root.querySelector<HTMLElement>(".ink-page-rail")!;
      const thumb = rail.querySelector<HTMLElement>(".ink-page-thumb")!;
      const hidden = () => root.classList.contains("ink-rail-hidden");

      (editor as any).onFastPagingRailExpanded();
      expect(hidden()).toBe(false);
      thumb.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      thumb.click();
      (editor as any).onFastPagingRailCollapsed();
      expect(hidden()).toBe(false);
    });

    it("centers the active thumbnail in the rail through the shared follow seam", async () => {
      const { editor } = await desktopSetup();
      const rail = (editor.containerEl.querySelector(".ink-page-rail") ?? null) as HTMLElement;
      const list = (rail.querySelector(".ink-rail-thumbs") ?? null) as HTMLElement;
      const thumb = (rail.querySelector(".ink-page-thumb.is-active") ?? null) as HTMLElement;
      // jsdom reports no boxes; pin a thumbnail-list box with the active thumb
      // far below it and drive the shared follow seam directly.
      list.getBoundingClientRect = () => new DOMRect(0, 0, 160, 600);
      thumb.getBoundingClientRect = () => new DOMRect(0, 2400, 150, 120);
      let listTop = 0;
      Object.defineProperties(list, {
        clientHeight: { configurable: true, value: 600 },
        scrollHeight: { configurable: true, value: 3000 },
        scrollTop: { configurable: true, get: () => listTop, set: (value: number) => { listTop = value; } },
      });
      (editor as any).followWheelPageThumb();
      // Center: 2400 + 120/2 - 600/2 = 2160.
      expect(listTop).toBe(2160);
      // Already centered: with the thumb rect reflecting the scroll that just
      // happened (2400 - 2160 = 240), the delta is zero and the list holds
      // still instead of drifting.
      thumb.getBoundingClientRect = () => new DOMRect(0, 240, 150, 120);
      (editor as any).followWheelPageThumb();
      expect(listTop).toBe(2160);
    });

    it("turns a page on a short intentional horizontal touchpad swipe", async () => {
      const { wheel, settle } = await desktopSetup();
      wheel(60, 0, { timeStamp: 100 });
      expect(settle).toHaveBeenCalledOnce();
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
      // The whole stream is one horizontal contact: only its single page
      // queues onto the in-flight swipe (the mid-tail re-arms lift the
      // suppression but the strict one-page-per-contact contract refuses
      // the extra destinations the old per-gesture budget allowed).
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [30, 130], [10, 140], [4, 150],
        [8, 154], [20, 164], [35, 174], [70, 184], [20, 194], [10, 204], [4, 214],
        [8, 218], [20, 228], [35, 238], [70, 248]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(desktop.pageSwipeRequest.target).toBe(2);
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

    it("keeps a touch drag from adding a page to queued wheel gestures", async () => {
      const { editor, wheel, finger, send } = await desktopSetup();
      const desktop = editor as any;
      desktop.flipSettling = true;
      desktop.beginPageSwipe(1, 6, 0);
      for (const timeStamp of [100, 110, 120, 130]) wheel(120, 0, { timeStamp });
      expect(desktop.pageSwipeRequest.target).toBe(2);

      // The touch mirror of the mouse pan arm above: a fresh direct-manipulation
      // drag supersedes wheel destinations not yet started, so the settling
      // queue falls back to the active page instead of being walked off page
      // by page while the drag is swallowed.
      send("touchstart", [finger(1, 500, 200)]);
      send("touchmove", [finger(1, 100, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(1);
      // The drag's own release still counts its single page on the fallback.
      send("touchend", [], [finger(1, 100, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(2);
    });

    it("keeps pages queued by earlier touch swipes when a fresh touch drag starts", async () => {
      const { editor, finger, send } = await desktopSetup();
      const desktop = editor as any;
      desktop.flipSettling = true;
      desktop.beginPageSwipe(1, 6, 0);
      // Same-input accumulation is deliberate (#229): a swipe queued during
      // the handoff stays valid for the next touch drag — only a backlog last
      // written by the wheel path is stale.
      desktop.queuePageSwipeDelta(1);
      expect(desktop.pageSwipeRequest.target).toBe(2);

      send("touchstart", [finger(1, 500, 200)]);
      send("touchmove", [finger(1, 100, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(2);
      send("touchend", [], [finger(1, 100, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(3);
    });

    it("keeps a keyboard merge from erasing the wheel provenance of queued steps", async () => {
      const { editor, wheel, finger, send } = await desktopSetup();
      const desktop = editor as any;
      desktop.flipSettling = true;
      desktop.beginPageSwipe(1, 6, 0);
      for (const timeStamp of [100, 110, 120, 130]) wheel(120, 0, { timeStamp });
      expect(desktop.pageSwipeRequest.target).toBe(2);
      // The keyboard merge queues non-wheel steps onto the same window; a
      // last-writer-wins flag used to erase the wheel provenance here while
      // the wheel steps kept riding in the target, so the next touch drag
      // read false, skipped the discard, and was swallowed onto destinations
      // the finger never saw.
      desktop.desktopNavigate("next");
      expect(desktop.pageSwipeRequest.target).toBe(3);
      send("touchstart", [finger(1, 500, 200)]);
      send("touchmove", [finger(1, 100, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(1);
      send("touchend", [], [finger(1, 100, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(2);
    });

    it("keeps a zero-delta touch release from erasing the wheel provenance of queued steps", async () => {
      const { editor, wheel, finger, send } = await desktopSetup();
      const desktop = editor as any;
      desktop.flipSettling = true;
      desktop.beginPageSwipe(1, 6, 0);
      // The drag starts before the wheel backlog queues, so its moves see
      // nothing stale; the wheels then queue onto the same settle window.
      send("touchstart", [finger(1, 500, 200)]);
      send("touchmove", [finger(1, 480, 200)]);
      for (const timeStamp of [100, 110, 120, 130]) wheel(120, 0, { timeStamp });
      expect(desktop.pageSwipeRequest.target).toBe(2);
      // A zero-delta release (spring-back) queues nothing, mirroring the
      // endDesktopPan guard: writing the queue for it used to erase the
      // wheel flag (and scrollEdge) while the wheel steps stayed queued.
      send("touchend", [], [finger(1, 480, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(2);
      // The next drag must still discard the wheel-written backlog.
      send("touchstart", [finger(1, 500, 200)]);
      send("touchmove", [finger(1, 100, 200)]);
      expect(desktop.pageSwipeRequest.target).toBe(1);
      send("touchend", [], [finger(1, 100, 200)]);
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

    it("keeps a single accelerating flick to one page across the flip boundary", async () => {
      const { wheel, settle } = await desktopSetup();
      // One contact whose fast phase crosses the page threshold must not
      // re-arm on its own still-undecayed envelope two samples later: the
      // rise past the flip is the same flick, not a new intent.
      for (const [delta, time] of [[10, 100], [20, 110], [35, 120], [70, 130], [90, 140], [60, 150], [30, 160]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
      // A second stream past the idle boundary now only flips when it rises
      // sharply at the post-freeze sample: the boundary sample is frozen
      // (20px over 240ms sits far below the still-hot 30px envelope), the
      // next sample (45) stays under 2.2x that envelope, so this slow start
      // rides the old contact - the same tradeoff the 55-179ms band shipped
      // (#341), and the strict x contract pays nothing for it. A re-flick
      // whose post-freeze sample clears the ratio still re-arms (the
      // quiet-gap re-flick test above flips its second page).
      for (const [delta, time] of [[20, 400], [45, 410], [80, 420], [120, 430], [90, 440], [60, 450]]) {
        wheel(delta, 0, { timeStamp: time });
      }
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("keeps the same tail delivered without the stall to one page", async () => {
      // Control for the stall-merged regression above: the identical decaying
      // tail delivered continuously (no stall) is one page, so that regression
      // isolates the stall's delivery timing, not the tail's magnitude.
      const { scroller, wheel, settle } = await desktopSetup();
      scroller.scrollTop = 600;
      for (const [delta, time] of [[140, 100], [90, 110], [60, 120], [35, 130], [20, 140], [14, 150]]) {
        wheel(0, delta, { timeStamp: time });
      }
      Array.from({ length: 45 }, (_, i) => 9 * Math.exp(-(10 + i * 10) / 300))
        .forEach((delta, i) => wheel(0, delta, { timeStamp: 160 + i * 10 }));
      expect(settle).toHaveBeenCalledTimes(1);
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

    it("swallows a flick tail crossing a textarea mid-flight instead of paging again", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      const textarea = document.createElement("textarea"); scroller.append(textarea);
      scroller.scrollTop = 600;
      wheel(0, 140, { timeStamp: 9000 });
      wheel(0, 90, { timeStamp: 9010 });
      expect(settle).toHaveBeenCalledTimes(1);
      wheel(0, 60, { timeStamp: 9020 }, textarea);
      wheel(0, 30, { timeStamp: 9030 }, textarea);
      wheel(0, 90, { timeStamp: 9040 });
      wheel(0, 60, { timeStamp: 9050 });
      wheel(0, 30, { timeStamp: 9060 });
      // The tail's remaining travel must not land as a fresh gesture's first
      // page: the crossing samples keep the flip suppression alive.
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("swallows a horizontal flick tail crossing a textarea mid-flight", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      const textarea = document.createElement("textarea"); scroller.append(textarea);
      wheel(140, 0, { timeStamp: 9000 });
      expect(settle).toHaveBeenCalledTimes(1);
      wheel(60, 0, { timeStamp: 9010 }, textarea);
      wheel(90, 0, { timeStamp: 9020 });
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("swallows a flick tail crossing a nested scroll surface mid-flight", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      const nested = document.createElement("div"); nested.style.overflowY = "auto"; scroller.append(nested);
      Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
      scroller.scrollTop = 600;
      wheel(0, 140, { timeStamp: 9000 });
      expect(settle).toHaveBeenCalledTimes(1);
      wheel(0, 60, { timeStamp: 9010 }, nested);
      wheel(0, 90, { timeStamp: 9020 });
      wheel(0, 60, { timeStamp: 9030 });
      expect(settle).toHaveBeenCalledTimes(1);
    });

    it("still hands a fresh wheel gesture on a textarea or nested surface to the surface", async () => {
      const { scroller, wheel, settle } = await desktopSetup();
      const textarea = document.createElement("textarea"); scroller.append(textarea);
      const nested = document.createElement("div"); nested.style.overflowY = "auto"; scroller.append(nested);
      Object.defineProperties(nested, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
      expect(wheel(0, 140, { timeStamp: 9000 }, textarea).defaultPrevented).toBe(false);
      expect(settle).not.toHaveBeenCalled();
      expect(wheel(0, 140, { timeStamp: 9200 }, nested).defaultPrevented).toBe(false);
      expect(settle).not.toHaveBeenCalled();
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
      expect(page.strokes.map((s) => s.id)).toEqual([adjacent.id]);
      expect(editor.undoStack).toHaveLength(history + 1);
      expect(editor.pendingInkStrokes).toHaveLength(0);
      expect(editor.committingInkStrokes).toBeNull();
      editor.undo(); expect(page.strokes).toHaveLength(2);
      expect(page.strokes.find((s) => s.id !== adjacent.id)!.points).toEqual(original.points);
      editor.redo(); expect(page.strokes.map((s) => s.id)).toEqual([adjacent.id]);
    });

    it("removes whole visible sticky strokes and leaves page and covered notes untouched", async () => {
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
      expect(page.stickyNotes![1].strokes).toHaveLength(0);
      expect(page.stickyNotes![1].deletedStrokeIds).toContain(original[0].id);
      expect(editor.undoStack).toHaveLength(history + 1);
      editor.undo(); expect(page.stickyNotes![1].strokes.map((s) => s.points)).toEqual(original.map((s) => s.points));
      editor.redo(); expect(page.stickyNotes![1].strokes).toHaveLength(0);
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

    it("pans the page with a finger while lasso is selected, then lets pinch take over", async () => {
      const { editor, page, finger, send, draw } = await setup();
      editor.state.fingerAsPen = true; draw("pen"); editor.state.fingerAsPen = false;
      editor.state.tool = "lasso"; editor.state.lasso.mode = "rectangle";
      const scrollTop = makeScrollable(editor);
      const original = page.strokes[0].points.map((p) => ({ ...p }));
      send("touchstart", [finger(1, 100, 100)]); send("touchmove", [finger(1, 150, 150)]);
      send("touchend", [], [finger(1, 150, 150)]);
      expect(scrollTop()).toBe(150);
      expect(editor.selectedStrokeIds.size).toBe(0);
      expect(page.strokes[0].points).toEqual(original);

      send("touchstart", [finger(1, 250, 250)]);
      send("touchstart", [finger(1, 250, 250), finger(2, 500, 250)], [finger(2, 500, 250)]);
      send("touchmove", [finger(1, 200, 250), finger(2, 550, 250)]);
      send("touchend", [], [finger(1, 200, 250), finger(2, 550, 250)]);
      expect(page.strokes[0].points).toEqual(original); expect(editor.zoom).toBeGreaterThan(1);
      expect(editor.activePointerId).toBeNull(); expect(editor.lassoDrag).toBeNull();
      expect(editor.toolbarRoot().querySelector(".ink-selection-actions")).toBeNull();
    });

    it.each(["freehand", "rectangle"])("pans with a finger in %s lasso mode without selecting ink", async (mode) => {
      const { editor, page, finger, send, draw } = await setup();
      editor.state.fingerAsPen = true; draw("pen"); draw("pen"); editor.state.fingerAsPen = false;
      const originals = page.strokes.map((stroke) => ({ ...stroke, points: [
        { x: .2, y: .2, pressure: .5, t: 1 }, { x: .4, y: .2, pressure: .5, t: 2 },
      ] }));
      page.strokes = originals.map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) }));
      editor.queueStrokePatch(page, page.strokes, []); editor.drawStrokes(page.strokes);
      editor.state.tool = "lasso"; editor.state.lasso.mode = mode;
      const scrollTop = makeScrollable(editor);
      send("touchstart", [finger(1, 300, 200)]); send("touchmove", [finger(1, 350, 250)]);
      send("touchend", [], [finger(1, 350, 250)]);
      expect(scrollTop()).toBe(150);
      expect(editor.selectedStrokeIds.size).toBe(0);
      expect(page.strokes.map((s) => s.points)).toEqual(originals.map((s) => s.points));
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
