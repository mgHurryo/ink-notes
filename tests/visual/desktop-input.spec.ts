import { expect, test } from "@playwright/test";

test("desktop mouse middle button and space drag pan without creating ink", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  const state = await page.evaluate(() => {
    const scope = window as unknown as { __inkNotesPreview: { view: any } };
    const view = scope.__inkNotesPreview.view;
    view.setZoom(2);
    const pageEl = document.querySelector<HTMLElement>(".ink-page")!;
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = 100; scroller.scrollTop = 100;
    return { before: view.notebook.pages[0].strokes.length, page: scroller.getBoundingClientRect(), scroll: { x: scroller.scrollLeft, y: scroller.scrollTop } };
  });
  const x = state.page.left + state.page.width / 2, y = state.page.top + state.page.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x - 80, y - 50);
  await page.mouse.up({ button: "middle" });
  const middle = await page.evaluate(() => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    return { strokes: view.notebook.pages[0].strokes.length, x: scroller.scrollLeft, y: scroller.scrollTop };
  });
  expect(middle.strokes).toBe(state.before);
  expect(middle.x).toBeGreaterThan(state.scroll.x);
  expect(middle.y).toBeGreaterThan(state.scroll.y);
  await page.keyboard.down("Space");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y - 25);
  await page.mouse.up();
  await page.keyboard.up("Space");
  const space = await page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.notebook.pages[0].strokes.length);
  expect(space).toBe(state.before);
  await page.mouse.move(x - 100, y - 100);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x - 80, y - 80);
  await page.mouse.up({ button: "right" });
  expect(await page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.notebook.pages[0].strokes.length)).toBe(state.before);
  await page.mouse.move(x - 100, y - 100);
  await page.mouse.down();
  await page.mouse.move(x - 70, y - 80);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.notebook.pages[0].strokes.length)).toBe(state.before + 1);
});

test("keyboard page navigation, zoom, history and tool shortcuts stay in the editor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    document.querySelector<HTMLElement>(".ink-page-scroller")!.focus();
  });
  await page.keyboard.press("PageDown");
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await page.keyboard.press("Home");
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
  await page.keyboard.press("Control+=");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.zoom)).toBe(1.1);
  await page.keyboard.press("0");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.zoom)).toBe(1);
  await page.keyboard.press("e");
  await expect(page.getByRole("button", { name: "Erase", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("b");
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 1");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
});

test("touchpad-like ctrl wheel zooms at the cursor and horizontal wheel flips once per burst", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
  });
  const pageEl = page.locator(".ink-page");
  const box = await pageEl.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -80);
  await page.keyboard.up("Control");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.zoom)).toBeGreaterThan(1);
  const scroller = page.locator(".ink-page-scroller");
  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth - el.clientWidth; });
  await page.mouse.wheel(140, 0);
  await page.mouse.wheel(140, 0);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await page.mouse.wheel(140, 0);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
});
