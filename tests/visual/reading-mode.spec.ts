import { expect, test } from "@playwright/test";

for (const width of [360, 1280]) {
  test(`reading mode hides edits and keeps navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    await page.evaluate(async () => {
      const view = (window as any).__inkNotesPreview.view;
      view.duplicateCurrentPage();
      await view.navigateToPage(view.notebook.pages[0].id);
    });
    const toggle = page.getByRole("button", { name: "Reading mode", exact: true });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    for (const name of ["Undo", "Redo", "Pen", "Highlight", "Erase", "Select", "Add page", "Page options"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeHidden();
    }
    for (const name of ["Pages", "Reading mode", "Export as PDF"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
    const metrics = await page.locator(".ink-toolbar").evaluate((el) => ({
      height: el.getBoundingClientRect().height, overflow: el.scrollWidth > el.clientWidth,
    }));
    expect(metrics.height).toBe(56);
    expect(metrics.overflow).toBe(false);
    await page.locator(".ink-page-scroller").focus();
    await page.keyboard.press("PageDown");
    await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
    await page.keyboard.press("Control+z");
    await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
    await page.keyboard.press("Control+=");
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.zoom)).toBeGreaterThan(1);
    await page.screenshot({ path: `dist/reading-mode-${width}.png` });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("button", { name: "Pen", exact: true })).toBeVisible();
  });
}

test("mode switch commits the active stroke and reading mouse drag only pans", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  const before = await page.evaluate(() => {
    const view = (window as any).__inkNotesPreview.view;
    view.setZoom(2);
    const host = document.querySelector<HTMLElement>(".ink-page")!;
    const rect = host.getBoundingClientRect();
    host.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "pen", pointerId: 77,
      clientX: rect.left + 100, clientY: rect.top + 100, pressure: 0.5, buttons: 1, bubbles: true }));
    host.dispatchEvent(new PointerEvent("pointermove", { pointerType: "pen", pointerId: 77,
      clientX: rect.left + 160, clientY: rect.top + 160, pressure: 0.5, buttons: 1, bubbles: true }));
    return { strokes: view.notebook.pages[0].strokes.length, active: view.activePointerId };
  });
  expect(before.active).toBe(77);
  await page.getByRole("button", { name: "Reading mode", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.activePointerId)).toBeNull();
  const scroller = page.locator(".ink-page-scroller");
  const box = (await scroller.boundingBox())!;
  const start = await scroller.evaluate((el) => { el.scrollLeft = 100; el.scrollTop = 100; return el.scrollTop; });
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 70, box.y + 240);
  await page.mouse.up();
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(start);
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.notebook.pages[0].strokes.length)).toBe(before.strokes);
});
