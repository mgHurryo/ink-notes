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

test("WebKit page navigation clears pending ink from the previous PDF page", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  const result = await page.evaluate(async () => {
    await (window as any).__inkNotesPreview.openPdf();
    const view = (window as any).__inkNotesPreview.view;
    view.addBlankPage(1);
    await view.navigatePages(-view.noteIndex);
    const host = document.querySelector<HTMLElement>(".ink-pdf-ink-host")!;
    const rect = host.getBoundingClientRect();
    const send = (type: string, x: number, y: number) => host.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 42, pointerType: "pen", buttons: type === "pointerup" ? 0 : 1,
      clientX: rect.left + x, clientY: rect.top + y, pressure: 0.6,
    }));
    send("pointerdown", 80, 120);
    send("pointermove", 180, 220);
    send("pointerup", 260, 300);
    const previousPageStrokes = view.currentPage().strokes.length;
    const pendingBefore = view.pendingInkStrokes.length;
    const hasPreviewInk = () => {
      const canvas = document.querySelector<HTMLCanvasElement>(".ink-confirmed-preview-canvas")!;
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
      return pixels.some((value, index) => index % 4 === 3 && value > 0);
    };
    const previewHasInkBefore = hasPreviewInk();
    await view.navigatePages(1);
    return {
      previousPageStrokes, pendingBefore,
      pendingAfter: view.pendingInkStrokes.length,
      previewHasInkBefore,
      previewHasInkAfter: hasPreviewInk(),
      pageIndex: view.noteIndex,
    };
  });
  expect(result).toMatchObject({ previousPageStrokes: 1, pendingBefore: 1, pendingAfter: 0, pageIndex: 1 });
  expect(result.previewHasInkBefore).toBe(true);
  expect(result.previewHasInkAfter).toBe(false);
});
