import { expect, test, type Page } from "@playwright/test";

async function gesture(page: Page, travel: number, end = "touchend"): Promise<void> {
  await page.evaluate(({ travel, end }) => {
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    const rect = scroller.getBoundingClientRect();
    const send = (type: string, x?: number) => {
      const touches = x === undefined ? [] : [new Touch({ identifier: 11, target: scroller,
        clientX: x, clientY: rect.top + 150 })];
      scroller.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches,
        bubbles: true, cancelable: true }));
    };
    send("touchstart", rect.left + rect.width / 2);
    send("touchmove", rect.left + rect.width / 2 + travel);
    if (end) send(end);
  }, { travel, end });
}

for (const width of [390, 1280]) {
  test(`boundary insertion previews, cancels and opens an empty page at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    const status = page.locator(".ink-page-status");
    await gesture(page, 70);
    await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
    await expect(status).toHaveText("1 / 1");
    await gesture(page, 250, "touchcancel");
    await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
    await expect(status).toHaveText("1 / 1");
    await gesture(page, 250, "");
    const stage = page.locator(".ink-swipe-stage");
    await expect(stage).toHaveAttribute("data-insert", "true");
    await expect(stage).toHaveClass(/is-ready/);
    const offset = await page.evaluate(() => ({
      current: document.querySelector<HTMLElement>(".ink-page-extent")!.style.transform,
      incoming: document.querySelector<HTMLElement>(".ink-swipe-stage")!.style.transform,
    }));
    expect(offset.incoming).toBe(offset.current);
    await page.screenshot({ path: `test-results/page-insert-${width}.png` });
    await page.evaluate(() => {
      const scroller = document.querySelector(".ink-page-scroller")!;
      for (let i = 0; i < 2; i++) scroller.dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true }));
    });
    await expect(status).toHaveText("1 / 2");
    await expect(stage).toHaveCount(0);
    await expect(page.locator(".ink-page-extent")).toHaveCSS("visibility", "visible");
    await expect.poll(() => page.locator(".ink-tile-layer canvas").evaluateAll((canvases) => {
      let painted = 0;
      for (const canvas of canvases as HTMLCanvasElement[]) {
        const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (pixels) for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) painted++;
      }
      return painted;
    })).toBe(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(status).toHaveText("1 / 1");
    await gesture(page, -250);
    await expect(status).toHaveText("2 / 2");
    await expect(stage).toHaveCount(0);
    await page.getByRole("button", { name: "Pages", exact: true }).click();
    await page.screenshot({ path: `test-results/page-insert-landed-${width}.png` });
  });
}

test("plus menus switch cleanly and a separate insertion cancels a pending boundary animation", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  const plus = page.getByRole("button", { name: "Add page", exact: true });
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  // The preview host's menu can cover adjacent toolbar buttons; keyboard
  // activation exercises the same trigger ownership without that overlap.
  await plus.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".preview-menu")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Add page before first", exact: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator(".preview-menu")).toHaveCount(0);
  await page.evaluate(() => {
    const view = (window as unknown as { __inkNotesPreview: { view: {
      swipeDrag(x: number): void; swipeSettle(delta: number, travel: number): void; addPage(index: number): void;
    } } }).__inkNotesPreview.view;
    view.swipeDrag(250);
    view.swipeSettle(0, 250);
    view.addPage(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
});

test("insertion remains selected after an older page navigation finishes its Worker barrier", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = window as unknown as { releaseInsertionBarrier?: () => void; __inkNotesPreview: { view: {
      notebook: { pages: { id: string }[] }; duplicateCurrentPage(): void; navigateToPage(id: string): Promise<void>;
      swipeDrag(x: number): void; swipeSettle(delta: number): void; addPage(index: number): void;
      workerSession: { barrier(revision: number): Promise<unknown> };
    } } };
    const view = scope.__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const barrier = view.workerSession.barrier.bind(view.workerSession);
    view.workerSession.barrier = async (revision) => {
      await barrier(revision);
      await new Promise<void>((resolve) => { scope.releaseInsertionBarrier = resolve; });
    };
    view.swipeDrag(-200); view.swipeSettle(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseInsertionBarrier?: () => void })
    .releaseInsertionBarrier)).toBe("function");
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("button", { name: "Add page before first", exact: true }).click();
  await page.evaluate(() => (window as unknown as { releaseInsertionBarrier(): void }).releaseInsertionBarrier());
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 3");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
});
