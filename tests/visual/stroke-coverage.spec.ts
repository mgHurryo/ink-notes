import { expect, test } from "@playwright/test";

interface PreviewScope extends Window {
  __inkNotesPreview: { view: { pendingInkStrokes: unknown[]; currentPage(): { strokes: unknown[] } } };
  pathX(index: number): number;
  pathY(index: number): number;
}

async function drawLongFastStroke(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(async () => {
    const scope = window as unknown as PreviewScope & { pathX(index: number): number; pathY(index: number): number };
    scope.pathX = (index: number) => (index <= 80 ? 0.12 + 0.7 * index / 80 : 0.82);
    scope.pathY = (index: number) => (index <= 80 ? 0.35 : 0.35 + 0.35 * (index - 80) / 39);
    const paper = document.querySelector<HTMLElement>(".ink-page")!;
    const box = paper.getBoundingClientRect();
    const send = (type: string, index: number) => paper.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 7, pointerType: "pen", buttons: type === "pointerup" ? 0 : 1, pressure: 0.65,
      clientX: box.left + box.width * scope.pathX(index),
      clientY: box.top + box.height * scope.pathY(index),
    }));
    send("pointerdown", 0);
    for (let index = 1; index < 120; index++) send("pointermove", index);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

for (const mode of ["no-worker", "worker"] as const) {
  test(`a long fast stroke keeps its whole path live, retained and committed with ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    if (mode === "no-worker") await page.addInitScript(() => { window.Worker = undefined as unknown as typeof Worker; });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");

    await drawLongFastStroke(page);

    const coverageOn = (selector: string) => page.evaluate((sel) => {
      const scope = window as unknown as PreviewScope;
      const paper = document.querySelector<HTMLElement>(".ink-page")!.getBoundingClientRect();
      const canvas = document.querySelector<HTMLCanvasElement>(sel)!;
      const box = canvas.getBoundingClientRect();
      const ctx = canvas.getContext("2d")!;
      const checkpoints: boolean[] = [];
      for (let index = 0; index <= 120; index += 8) {
        const x = Math.round((paper.left + paper.width * scope.pathX(index) - box.left) / box.width * canvas.width);
        const y = Math.round((paper.top + paper.height * scope.pathY(index) - box.top) / box.height * canvas.height);
        const pixels = ctx.getImageData(x - 8, y - 8, 17, 17).data;
        checkpoints.push(Array.from(pixels).some((value, offset) => offset % 4 === 3 && value > 0));
      }
      return checkpoints;
    }, selector);

    // Live ink covers the whole drawn path, including across the corner.
    expect(await coverageOn(".ink-preview-canvas")).toEqual(Array(16).fill(true));

    await page.evaluate(() => {
      const paper = document.querySelector<HTMLElement>(".ink-page")!;
      const box = paper.getBoundingClientRect();
      paper.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 7, pointerType: "pen", buttons: 0, pressure: 0,
        clientX: box.left + box.width * 0.82, clientY: box.top + box.height * 0.7,
      }));
      return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    // The retained overlay still covers the whole path.
    expect(await coverageOn(".ink-confirmed-preview-canvas")).toEqual(Array(16).fill(true));

    // Once the tiles commit, the committed ink covers the whole path too.
    await expect.poll(() => page.evaluate(() => (window as unknown as PreviewScope).__inkNotesPreview.view.pendingInkStrokes.length)).toBe(0);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const tileCoverage = await page.evaluate(() => {
      const scope = window as unknown as PreviewScope;
      const view = scope.__inkNotesPreview.view as unknown as {
        tiles: { active: { index: { width: number; height: number } } };
      };
      const index = view.tiles.active.index;
      const paper = document.querySelector<HTMLElement>(".ink-page")!.getBoundingClientRect();
      const probe = document.createElement("canvas");
      probe.width = 17; probe.height = 17;
      const probeCtx = probe.getContext("2d")!;
      const results: boolean[] = [];
      for (let index2 = 0; index2 <= 120; index2 += 8) {
        const px = paper.left + paper.width * scope.pathX(index2);
        const py = paper.top + paper.height * scope.pathY(index2);
        // Sample the tile whose cell (in the index's own coordinate space)
        // mathematically contains the point; the bounding rect includes the
        // bleed, so the mapping below is exact. Neighbor tiles' bleed regions
        // may be stale and must not be used.
        const column = Math.floor(scope.pathX(index2) * index.width / 128);
        const row = Math.floor(scope.pathY(index2) * index.height / 128);
        const canvas = document.querySelector<HTMLCanvasElement>(`.ink-tile-layer div[data-cell="${column}:${row}"] canvas`);
        if (!canvas) { results.push(false); continue; }
        const rect = canvas.getBoundingClientRect();
        const sx = Math.round((px - rect.left) / rect.width * canvas.width);
        const sy = Math.round((py - rect.top) / rect.height * canvas.height);
        probeCtx.clearRect(0, 0, 17, 17);
        probeCtx.drawImage(canvas, sx - 8, sy - 8, 17, 17, 0, 0, 17, 17);
        const data = probeCtx.getImageData(0, 0, 17, 17).data;
        results.push(Array.from(data).some((value, offset) => offset % 4 === 3 && value > 0));
      }
      return results;
    });
    expect(tileCoverage).toEqual(Array(16).fill(true));
  });
}
