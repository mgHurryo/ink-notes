import { expect, test } from "@playwright/test";

test.skip(({ browserName }) => browserName !== "webkit", "Run with playwright.webkit.config.ts");

test("WebKit swipe preview renders at page resolution instead of rail-thumbnail resolution", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  const sizes = await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const thumb = document.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb-canvas")[1]!;
    if (thumb.dataset.previewReady !== "true") await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    view.swipeDrag(-180);
    const stage = document.querySelector<HTMLCanvasElement>(".ink-swipe-stage .ink-swipe-canvas")!;
    return { swipeWidth: stage.width, thumbnailWidth: thumb.width,
      devicePixelRatio: window.devicePixelRatio, displayWidth: stage.getBoundingClientRect().width };
  });
  expect(sizes.devicePixelRatio).toBe(2);
  expect(sizes.swipeWidth).toBeGreaterThan(sizes.thumbnailWidth);
  expect(sizes.swipeWidth / sizes.displayWidth).toBeGreaterThan(1.5);
});

test("WebKit swipe preview stays at full device density on iPad-sized pages", async ({ page }) => {
  // A ~980px page at dpr 2 needs ~5.3M pixels - above the old 4M overlay
  // budget, which downscaled the preview to ~1.74x and left page flips blurry
  // on real iPads even though the small-viewport case stayed crisp.
  await page.setViewportSize({ width: 1032, height: 1376 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  const sizes = await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const thumb = document.querySelectorAll<HTMLCanvasElement>(".ink-page-thumb-canvas")[1]!;
    if (thumb.dataset.previewReady !== "true") await new Promise<void>((resolve) => window.setTimeout(resolve, 200));
    view.swipeDrag(-180);
    const stage = document.querySelector<HTMLCanvasElement>(".ink-swipe-stage .ink-swipe-canvas")!;
    return { swipeWidth: stage.width, displayWidth: stage.getBoundingClientRect().width };
  });
  expect(sizes.swipeWidth / sizes.displayWidth).toBeGreaterThan(1.9);
});
