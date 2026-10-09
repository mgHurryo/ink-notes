import { expect, test } from "@playwright/test";

for (const width of [360, 1280]) {
  test(`zoom readout locks, pans and resumes at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect(page.locator(".ink-page")).toBeVisible();
    await page.evaluate(() => {
      const scope = window as unknown as {
        zoomSend(type: string, distance?: number, dx?: number, dy?: number): void;
      };
      const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
      const rect = scroller.getBoundingClientRect();
      const x = rect.left + rect.width / 2, y = rect.top + 200;
      scope.zoomSend = (type, distance, dx = 0, dy = 0) => {
        const touches = distance === undefined ? [] : [-1, 1].map((side, index) =>
          new Touch({ identifier: index + 1, target: scroller,
            clientX: x + dx + side * distance / 2, clientY: y + dy }));
        scroller.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, bubbles: true, cancelable: true }));
      };
      scope.zoomSend("touchstart", 100);
      scope.zoomSend("touchmove", 180);
    });
    const hud = page.locator(".ink-zoom-hud");
    await expect(hud).toHaveCSS("opacity", "1");
    await expect(hud).toContainText("180%");
    const layout = await hud.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const parent = el.parentElement!.getBoundingClientRect();
      return { width: box.width, height: box.height, inside: box.left >= parent.left && box.right <= parent.right && box.top >= parent.top };
    });
    expect(layout.inside).toBe(true);
    expect(layout.width).toBeLessThan(130);
    expect(layout.height).toBeLessThanOrEqual(50);
    await page.waitForTimeout(1100);
    await expect(hud).toBeVisible();
    await page.getByRole("button", { name: "Lock zoom", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unlock zoom" })).toHaveAttribute("aria-pressed", "true");
    const before = await page.locator(".ink-page-scroller").evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    await page.evaluate(() => (window as unknown as { zoomSend(type: string, distance: number, dx: number, dy: number): void })
      .zoomSend("touchmove", 250, -20, -35));
    const after = await page.locator(".ink-page-scroller").evaluate((el) => ({ x: el.scrollLeft, y: el.scrollTop }));
    expect(after.x - before.x).toBeCloseTo(20, 0);
    expect(after.y - before.y).toBeCloseTo(35, 0);
    await expect(hud).toContainText("180%");
    await page.screenshot({ path: `test-results/zoom-lock-${width}.png` });
    await page.evaluate(() => (window as unknown as { zoomSend(type: string): void }).zoomSend("touchend"));
    await page.waitForTimeout(990);
    await expect(hud).toHaveCSS("visibility", "hidden");

    await page.getByRole("button", { name: "Page options", exact: true }).click();
    for (const name of ["Zoom out", "Reset zoom", "Zoom in"]) await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      const scope = window as unknown as { zoomSend(type: string, distance?: number): void };
      scope.zoomSend("touchstart", 100);
      scope.zoomSend("touchmove", 200);
    });
    await expect(hud).toHaveCSS("opacity", "1");
    await expect(hud).toContainText("180%");
    await page.getByRole("button", { name: "Unlock zoom", exact: true }).click();
    await page.evaluate(() => (window as unknown as { zoomSend(type: string, distance: number): void }).zoomSend("touchmove", 200));
    await expect(hud).toContainText("180%");
    await page.evaluate(() => (window as unknown as { zoomSend(type: string, distance: number): void }).zoomSend("touchmove", 220));
    await expect(hud).toContainText("198%");
    await page.evaluate(() => (window as unknown as { zoomSend(type: string): void }).zoomSend("touchcancel"));
    await page.waitForTimeout(990);
    await expect(hud).toHaveCSS("visibility", "hidden");
    await expect(page.locator(".ink-page")).toHaveCSS("transform", "none");
  });
}

test("locked notebook page and incoming preview retain magnification", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByRole("button", { name: "Page options", exact: true }).click();
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    const send = (type: string, distance?: number) => {
      const touches = distance === undefined ? [] : [-1, 1].map((side, index) => new Touch({
        identifier: index + 1, target: scroller, clientX: 500 + side * distance / 2, clientY: 300,
      }));
      scroller.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, bubbles: true, cancelable: true }));
    };
    send("touchstart", 100); send("touchmove", 150); send("touchend");
  });
  await page.getByRole("button", { name: "Lock zoom", exact: true }).click();
  const sizes = await page.evaluate(async () => {
    const view = (window as unknown as { __inkNotesPreview: { view: {
      zoom: number; notebook: { pages: { id: string }[] }; swipeDrag(offset: number): void;
      destroySwipeStage(): void; navigateToPage(id: string): Promise<void>;
    } } }).__inkNotesPreview.view;
    view.swipeDrag(80);
    const current = document.querySelector<HTMLElement>(".ink-page:not(.ink-swipe-stage)")!;
    const preview = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
    const widths = { current: parseFloat(current.style.width), preview: parseFloat(preview.style.width) };
    view.destroySwipeStage();
    await view.navigateToPage(view.notebook.pages[0].id);
    return { ...widths, zoom: view.zoom };
  });
  expect(sizes.preview).toBeCloseTo(sizes.current);
  expect(sizes.zoom).toBe(1.5);
});

test("zoom readout respects reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const durations = await page.locator(".ink-zoom-hud").evaluate((el) => getComputedStyle(el).transitionDuration
    .split(",").map((value) => parseFloat(value)));
  expect(durations.every((value) => value < 0.001)).toBe(true);
});
