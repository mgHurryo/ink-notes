import { expect, test } from "@playwright/test";

test.skip(({ browserName }) => browserName !== "webkit", "Run with playwright.webkit.config.ts");

for (const mode of ["ink", "pdf"]) for (const axis of ["horizontal", "vertical"]) test(`WebKit ${mode}: touch controls and handwriting track ${axis} page motion`, async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 900 }); await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view;
    v.desktopZoom(1 / v.zoom);
    v.finishDesktopZoom?.(); v.finishPinchRender?.(); v.inputScroller().scrollTop = 0;
    const p = v.currentPage(), ids = p.strokes.map((s: any) => s.id);
    p.strokes = []; p.deletedStrokeIds.push(...ids); v.queueStrokePatch(p, [], ids); v.drawStrokes([]);
  });
  await page.getByRole("button", { name: "Add sticky note", exact: true }).tap();
  const card = page.locator(".ink-sticky-note");
  await card.getByRole("button", { name: "Fold", exact: true }).tap();
  await expect(card).toHaveClass(/is-collapsed/);
  await card.getByRole("button", { name: "Expand", exact: true }).tap();
  await expect(card).not.toHaveClass(/is-collapsed/);
  await card.getByRole("button", { name: "Type on sticky note", exact: true }).tap();
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("**WebKit draft**");
  await card.getByRole("button", { name: "Fold", exact: true }).tap();
  await expect(card).toHaveClass(/is-collapsed/);
  await card.getByRole("button", { name: "Expand", exact: true }).tap();
  await expect(card.locator("strong")).toHaveText("WebKit draft");
  await card.getByRole("button", { name: "Sticky note options", exact: true }).tap();
  await expect(page.getByRole("button", { name: "Copy link to sticky note", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mint", exact: true }).tap();

  const board = card.getByLabel("Sticky handwriting board");
  await board.evaluate((el) => {
    const r = el.getBoundingClientRect();
    for (const [type, offset] of [["touchstart", 0], ["touchmove", 110], ["touchend", 110]] as const) {
      // Desktop WebKit exposes native taps but no public Touch constructor.
      const touch = { target: el, identifier: 11, clientX: r.x + 30 + offset, clientY: r.y + 85 + offset / 4, force: .5, touchType: "stylus" };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [touch] }, changedTouches: { value: [touch] } });
      el.dispatchEvent(event);
    }
  });
  const before = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
  expect(before.strokes).toHaveLength(1);
  const baseline = await board.boundingBox();
  const image = await board.screenshot();
  await board.evaluate((el, axis) => {
    const r = el.getBoundingClientRect();
    for (const [type, offset] of [["touchstart", 0], ["touchmove", -50], ["touchmove", -85]] as const) {
      const t = { target: el, identifier: 23, clientX: r.x + 160 + (axis === "horizontal" ? offset : 0), clientY: r.y + 120 + (axis === "vertical" ? offset : 0) };
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { touches: { value: [t] }, changedTouches: { value: [t] } });
      el.dispatchEvent(event);
    }
  }, axis);
  const moved = (await board.boundingBox())!;
  expect(axis === "horizontal" ? moved.x : moved.y).toBeCloseTo((axis === "horizontal" ? baseline!.x : baseline!.y) - 85, 0);
  expect(await board.screenshot()).toEqual(image);
  await board.evaluate((el) => {
    const event = new Event("touchcancel", { bubbles: true, cancelable: true });
    Object.defineProperties(event, { touches: { value: [] }, changedTouches: { value: [] } });
    el.dispatchEvent(event);
  });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0])).toEqual(before);
  await page.screenshot({ path: `test-results/sticky-webkit-${mode}.png` });
});
