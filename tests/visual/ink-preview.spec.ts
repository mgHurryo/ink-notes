import { expect, test } from "@playwright/test";

interface PreviewView {
  activeStroke: { id: string };
  activePointerId: number | null;
  confirmedStrokeOutlines: Map<string, { sampleCount: number }>;
  workerSession: { apply(revision: number, operation: { type: string }, transfer?: Transferable[]): Promise<unknown> };
  currentPage(): { strokes: { points: unknown[] }[] };
}

interface PreviewScope extends Window {
  __inkNotesPreview: { view: PreviewView };
  __releaseInkPreview?: () => void;
}

for (const mode of ["no-worker", "lagging-worker"] as const) {
  test(`rapid live ink preserves its whole path with ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    if (mode === "no-worker") await page.addInitScript(() => { window.Worker = undefined as unknown as typeof Worker; });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");

    await page.evaluate(() => {
      const paper = document.querySelector<HTMLElement>(".ink-page")!;
      const box = paper.getBoundingClientRect();
      // Synthetic events carry explicit 24 ms timestamps: the stroke modeler
      // resamples and integrates against real inter-sample time, so a burst
      // of equal-time events would model as one instantaneous jump.
      const send = (type: string, index: number) => {
        const event = new PointerEvent(type, {
          bubbles: true, pointerId: 7, pointerType: "pen", buttons: type === "pointerup" ? 0 : 1,
          pressure: 0.65,
          clientX: box.left + box.width * (0.15 + 0.65 * index / 96),
          clientY: box.top + box.height * (0.48 + 0.08 * Math.sin(index * Math.PI / 24)),
        });
        Object.defineProperty(event, "timeStamp", { value: 1_000 + index * 24 });
        paper.dispatchEvent(event);
      };
      send("pointerdown", 0);
      for (let index = 1; index <= 8; index++) send("pointermove", index);
    });

    if (mode === "lagging-worker") {
      await expect.poll(() => page.evaluate(() => {
        const view = (window as unknown as PreviewScope).__inkNotesPreview.view;
        return view.confirmedStrokeOutlines.get(view.activeStroke.id)?.sampleCount ?? 0;
      })).toBeGreaterThanOrEqual(9);
      await page.evaluate(() => {
        const scope = window as unknown as PreviewScope;
        const view = scope.__inkNotesPreview.view;
        const apply = view.workerSession.apply.bind(view.workerSession);
        const releases: (() => void)[] = [];
        let released = false;
        scope.__releaseInkPreview = () => {
          released = true;
          releases.splice(0).forEach((release) => release());
        };
        view.workerSession.apply = async (...args) => {
          const response = await apply(...args);
          if (args[1].type === "append-stroke-points" && !released) {
            await new Promise<void>((resolve) => releases.push(resolve));
          }
          return response;
        };
      });
    }

    await page.evaluate(async () => {
      const paper = document.querySelector<HTMLElement>(".ink-page")!;
      const box = paper.getBoundingClientRect();
      // A burst larger than the 32-sample tail limit reaches one frame. The
      // explicit timestamps keep it a coherent stroke for the modeler.
      for (let index = 9; index <= 96; index++) {
        const event = new PointerEvent("pointermove", {
          bubbles: true, pointerId: 7, pointerType: "pen", buttons: 1, pressure: 0.65,
          clientX: box.left + box.width * (0.15 + 0.65 * index / 96),
          clientY: box.top + box.height * (0.48 + 0.08 * Math.sin(index * Math.PI / 24)),
        });
        Object.defineProperty(event, "timeStamp", { value: 1_000 + index * 24 });
        paper.dispatchEvent(event);
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });

    const coverage = () => page.evaluate(() => {
      const paper = document.querySelector<HTMLElement>(".ink-page")!.getBoundingClientRect();
      const canvas = document.querySelector<HTMLCanvasElement>(".ink-preview-canvas")!;
      const box = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d")!;
      return [0, 24, 48, 72, 96].map((index) => {
        const x = Math.round((paper.left + paper.width * (0.15 + 0.65 * index / 96) - box.left) / box.width * canvas.width);
        const y = Math.round((paper.top + paper.height * 0.48 - box.top) / box.height * canvas.height);
        const pixels = ctx.getImageData(x - 8, y - 8, 17, 17).data;
        return pixels.some((value, offset) => offset % 4 === 3 && value > 0);
      });
    });
    expect(await coverage()).toEqual([true, true, true, true, true]);

    if (mode === "lagging-worker") {
      await page.evaluate(() => (window as unknown as PreviewScope).__releaseInkPreview?.());
      await expect.poll(() => page.evaluate(() => {
        const view = (window as unknown as PreviewScope).__inkNotesPreview.view;
        return view.confirmedStrokeOutlines.get(view.activeStroke.id)?.sampleCount ?? 0;
      })).toBeGreaterThanOrEqual(97);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      expect(await coverage()).toEqual([true, true, true, true, true]);
    }

    const result = await page.evaluate(() => {
      const paper = document.querySelector<HTMLElement>(".ink-page")!;
      const box = paper.getBoundingClientRect();
      const lift = new PointerEvent("pointerup", {
        bubbles: true, pointerId: 7, pointerType: "pen", buttons: 0, pressure: 0,
        clientX: box.left + box.width * 0.8, clientY: box.top + box.height * 0.48,
      });
      Object.defineProperty(lift, "timeStamp", { value: 1_000 + 97 * 24 });
      paper.dispatchEvent(lift);
      const view = (window as unknown as PreviewScope).__inkNotesPreview.view;
      return { strokes: view.currentPage().strokes.length,
        points: view.currentPage().strokes.at(-1)?.points.length, active: view.activePointerId };
    });
    // The preview starts with one demonstration stroke. The modeler resamples
    // the 97-move sine at 180 Hz, so the stored stroke holds far more samples
    // than the input events, and the lift catches the tail onto the pen.
    expect(result).toMatchObject({ strokes: 2, active: null });
    expect(result.points).toBeGreaterThan(97);
  });
}

for (const mode of ["no-worker", "worker"] as const) {
test(`a fast sparse corner stays at the pen position while writing with ${mode}`, async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  if (mode === "no-worker") await page.addInitScript(() => { window.Worker = undefined as unknown as typeof Worker; });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const paper = document.querySelector<HTMLElement>(".ink-page")!;
    const box = paper.getBoundingClientRect();
    // Events carry 24 ms timestamps; after the fast segment the pen dwells
    // at the corner, as it does in real handwriting, so the modeled tip
    // settles exactly onto the corner vertex instead of trailing behind it.
    const send = (type: string, index: number, x: number, y: number) => {
      const event = new PointerEvent(type, {
        bubbles: true, pointerId: 7, pointerType: "pen", buttons: 1, pressure: 0.65,
        clientX: box.left + box.width * x, clientY: box.top + box.height * y,
      });
      Object.defineProperty(event, "timeStamp", { value: 1_000 + index * 24 });
      paper.dispatchEvent(event);
    };
    send("pointerdown", 0, 0.15, 0.42);
    send("pointermove", 1, 0.55, 0.42);
    for (let dwell = 0; dwell < 10; dwell++) send("pointermove", 2 + dwell, 0.55, 0.42);
    send("pointermove", 12, 0.55, 0.62);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const inkAtCorner = () => page.evaluate(() => {
    const paper = document.querySelector<HTMLElement>(".ink-page")!.getBoundingClientRect();
    const canvas = document.querySelector<HTMLCanvasElement>(".ink-preview-canvas")!;
    const box = canvas.getBoundingClientRect();
    const x = Math.round((paper.left + paper.width * 0.55 - box.left) / box.width * canvas.width);
    const y = Math.round((paper.top + paper.height * 0.42 - box.top) / box.height * canvas.height);
    return canvas.getContext("2d")!.getImageData(x - 5, y - 5, 11, 11).data
      .some((value, offset) => offset % 4 === 3 && value > 0);
  });
  expect(await inkAtCorner()).toBe(true);
  if (mode === "worker") {
    await expect.poll(() => page.evaluate(() => {
      const view = (window as unknown as PreviewScope).__inkNotesPreview.view;
      return view.confirmedStrokeOutlines.get(view.activeStroke.id)?.sampleCount ?? 0;
    })).toBeGreaterThan(2);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await inkAtCorner()).toBe(true);
  }
});
}
