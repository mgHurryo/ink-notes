import { expect, test } from "@playwright/test";

for (const scenario of [
  { name: "desktop", width: 1366, height: 1024, dpr: 1, paper: "ruled", end: "touchend" },
  { name: "tablet", width: 1024, height: 1366, dpr: 2, paper: "grid", end: "touchcancel" },
  { name: "mobile", width: 390, height: 844, dpr: 2, paper: "dot", end: "touchend" },
]) {
test.describe(scenario.name, () => {
test.use({ viewport: { width: scenario.width, height: scenario.height }, deviceScaleFactor: scenario.dpr });
test("pinch scales paper and ink together without rerasterizing during a pause", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await expect.poll(() => page.locator(".ink-tile-layer canvas").count()).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  await page.evaluate((paperStyle) => {
    const scope = window as unknown as {
      pinchSend(type: string, distance?: number): void;
      pinchBaseline: { width: number; background: string; tiles: Element[] };
    };
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    const paper = document.querySelector<HTMLElement>(".ink-page")!;
    paper.className = `ink-page ink-paper-${paperStyle}`;
    const rect = paper.getBoundingClientRect();
    const x = rect.left + rect.width * 0.5;
    const y = rect.top + 230;
    scope.pinchSend = (type, distance) => {
      const touches = distance === undefined ? [] : [-1, 1].map((side, index) =>
        new Touch({ identifier: index + 1, target: scroller, clientX: x + side * distance / 2, clientY: y }));
      scroller.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, bubbles: true, cancelable: true }));
    };
    scope.pinchBaseline = { width: rect.width, background: getComputedStyle(paper).backgroundSize,
      tiles: Array.from(paper.querySelectorAll(".ink-tile-layer canvas")) };
    scope.pinchSend("touchstart", 100);
    scope.pinchSend("touchmove", 137);
  }, scenario.paper);
  // The 100ms refinement debounce must not fire while fingers are still down.
  await page.waitForTimeout(250);
  const held = await page.evaluate(() => {
    const scope = window as unknown as { pinchBaseline: { width: number; background: string; tiles: Element[] } };
    const paper = document.querySelector<HTMLElement>(".ink-page")!;
    return { background: getComputedStyle(paper).backgroundSize, initialBackground: scope.pinchBaseline.background,
      width: paper.getBoundingClientRect().width, expectedWidth: scope.pinchBaseline.width * 1.37,
      replaced: scope.pinchBaseline.tiles.filter((tile) => !tile.isConnected &&
        paper.querySelector(`[data-cell="${tile.parentElement?.getAttribute("data-cell")}"]`)).length };
  });
  expect(held.width).toBeCloseTo(held.expectedWidth, 1);
  expect(held.background).toBe(held.initialBackground);
  expect(held.replaced).toBe(0);
  const atRelease = await page.evaluate(() => {
    const scope = window as unknown as { pinchSend(type: string, distance?: number): void };
    scope.pinchSend("touchmove", 157);
    return document.querySelector<HTMLElement>(".ink-page")!.getBoundingClientRect().toJSON();
  });
  await page.evaluate((type) => {
    (window as unknown as { pinchSend(type: string): void }).pinchSend(type);
  }, scenario.end);
  const released = await page.locator(".ink-page").boundingBox();
  expect(released).not.toBeNull();
  for (const [key, rectKey] of [["x", "left"], ["y", "top"], ["width", "width"], ["height", "height"]] as const) {
    expect(Math.abs(released![key] - atRelease[rectKey])).toBeLessThan(0.1);
  }
  await page.evaluate(() => {
    const scope = window as unknown as { __inkNotesPreview: { view: { zoom: number } } };
    if (scope.__inkNotesPreview.view.zoom !== 1.57) throw new Error("Pinch scale was not retained");
  });
  const paper = page.locator(".ink-page");
  await expect(paper).toHaveCSS("transform", "none");
  expect(await page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: { zoom: number } } })
    .__inkNotesPreview.view.zoom)).toBeCloseTo(1.57);
  const settled = await paper.boundingBox();
  await page.waitForTimeout(800);
  expect(await paper.boundingBox()).toEqual(settled);
  const inkPixels = await page.locator(".ink-tile-layer canvas").evaluateAll((canvases: HTMLCanvasElement[]) => {
    let total = 0;
    for (const canvas of canvases) {
      // Worker bitmaps need a 2D copy for readback.
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext("2d")!;
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
      for (let index = 3; index < data.length; index += 4) if (data[index] > 0) total++;
    }
    return total;
  });
  expect(inkPixels).toBeGreaterThan(0);
  await page.screenshot({ path: `test-results/pinch-stability-${scenario.name}.png` });
  await page.evaluate(() => {
    const scope = window as unknown as { pinchSend(type: string, distance?: number): void };
    scope.pinchSend("touchstart", 100);
    scope.pinchSend("touchmove", 55);
  });
  await page.waitForTimeout(250);
  await page.evaluate(() => (window as unknown as { pinchSend(type: string): void }).pinchSend("touchend"));
  await expect(paper).toHaveCSS("transform", "none");
  const box = await paper.boundingBox();
  if (!box) throw new Error("Paper disappeared after shrinking");
  const count = await page.evaluate(() => (window as unknown as {
    __inkNotesPreview: { view: { notebook: { pages: { strokes: unknown[] }[] } } }
  }).__inkNotesPreview.view.notebook.pages[0].strokes.length);
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.25, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as unknown as {
    __inkNotesPreview: { view: { notebook: { pages: { strokes: unknown[] }[] } } }
  }).__inkNotesPreview.view.notebook.pages[0].strokes.length)).toBe(count + 1);
});
});
}
