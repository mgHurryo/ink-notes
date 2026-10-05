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
      const send = (type: string, index: number) => paper.dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 7, pointerType: "pen", buttons: type === "pointerup" ? 0 : 1,
        pressure: 0.65, clientX: box.left + box.width * (0.15 + 0.65 * index / 96),
        clientY: box.top + box.height * (0.48 + 0.08 * Math.sin(index * Math.PI / 24)),
      }));
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
      // A burst larger than the old 32-sample tail limit reaches one frame.
      for (let index = 9; index <= 96; index++) paper.dispatchEvent(new PointerEvent("pointermove", {
        bubbles: true, pointerId: 7, pointerType: "pen", buttons: 1, pressure: 0.65,
        clientX: box.left + box.width * (0.15 + 0.65 * index / 96),
        clientY: box.top + box.height * (0.48 + 0.08 * Math.sin(index * Math.PI / 24)),
      }));
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
      paper.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 7, pointerType: "pen", buttons: 0, pressure: 0,
        clientX: box.left + box.width * 0.8, clientY: box.top + box.height * 0.48,
      }));
      const view = (window as unknown as PreviewScope).__inkNotesPreview.view;
      return { strokes: view.currentPage().strokes.length,
        points: view.currentPage().strokes.at(-1)?.points.length, active: view.activePointerId };
    });
    // The preview starts with one demonstration stroke. Raw capture keeps the
    // lift sample too: it reports a sub-pixel jitter offset from the last move
    // instead of the exact same position, so it is a real (tiny) sample.
    expect(result).toMatchObject({ strokes: 2, points: 98, active: null });
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
    for (const [index, [x, y]] of [[0.15, 0.42], [0.55, 0.42], [0.55, 0.62]].entries()) {
      paper.dispatchEvent(new PointerEvent(index === 0 ? "pointerdown" : "pointermove", {
        bubbles: true, pointerId: 7, pointerType: "pen", buttons: 1, pressure: 0.65,
        clientX: box.left + box.width * x, clientY: box.top + box.height * y,
      }));
    }
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
    })).toBe(3);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await inkAtCorner()).toBe(true);
  }
});
}
