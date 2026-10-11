import { expect, test, type Page } from "@playwright/test";

async function ready(page: Page) {
  await page.setViewportSize({ width: 820, height: 1100 }); await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
}

test("fingers move and resize images in every default tool without writing or navigation", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Image library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Image library", exact: true });
  await library.locator('input[type="file"]').setInputFiles({ name: "Diagram.png", mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64") });
  await expect(library.locator(".ink-image-library-card")).toHaveCount(1);
  await library.getByRole("button", { name: "Select visible", exact: true }).click();
  await library.getByRole("button", { name: "Insert selected (1)", exact: true }).click();
  const session = await page.context().newCDPSession(page);
  const state = () => page.evaluate(() => { const v = (window as any).__inkNotesPreview.view;
    return { image: v.currentPage().images[0], strokes: v.currentPage().strokes.length, zoom: v.zoom, index: v.pageIndex }; });
  for (const tool of ["Pen", "Highlight", "Erase", "Select"]) {
    await page.getByRole("button", { name: tool, exact: true }).click();
    await expect(page.locator(".ink-image-inspector")).toBeHidden();
    const image = page.locator(".ink-placed-image"), r = (await image.boundingBox())!, before = await state();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 24, y: y + 16, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.locator(".ink-image-inspector")).toBeVisible();
    const after = await state(); expect(after.image.x).toBeGreaterThan(before.image.x);
    expect(after.strokes).toBe(before.strokes); expect(after.zoom).toBe(before.zoom); expect(after.index).toBe(before.index);
    const handle = page.getByRole("button", { name: "Resize image", exact: true }), h = (await handle.boundingBox())!;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: h.x + h.width / 2, y: h.y + h.height / 2, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: h.x + h.width / 2 + 20, y: h.y + h.height / 2 + 20, id: 1 }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    expect((await state()).image.width).toBeGreaterThan(after.image.width);
  }
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await page.evaluate(() => { (window as any).__inkNotesPreview.view.state.fingerAsPen = true; });
  const r = (await page.locator(".ink-placed-image").boundingBox())!, beforeWriting = await state();
  const x = r.x + r.width / 2, y = r.y + r.height / 2;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + 30, y: y + 20, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect((await state()).image).toEqual(beforeWriting.image); expect((await state()).strokes).toBe(beforeWriting.strokes + 1);
  await expect(page.locator(".ink-image-inspector")).toBeHidden();
  await page.getByRole("button", { name: "Pointer", exact: true }).click();
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.locator(".ink-image-inspector")).toBeVisible();
  await page.screenshot({ path: "test-results/unified-finger-image.png" }); await session.detach();
});

test("opt-in native finger writes once, pinch cancels ink, and Pointer remains available", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { (window as any).__inkNotesPreview.view.state.fingerAsPen = true; });
  const r = (await page.locator(".ink-page").boundingBox())!, x = r.x + r.width * .3, y = r.y + r.height * .15;
  const state = () => page.evaluate(() => { const v = (window as any).__inkNotesPreview.view;
    return { strokes: v.currentPage().strokes.length, zoom: v.zoom, history: v.undoStack.length, active: v.activePointerId }; });
  const session = await page.context().newCDPSession(page), before = await state();
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  for (let i = 1; i <= 4; i++) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + i * 12, y: y + i * 6, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect((await state()).strokes).toBe(before.strokes + 1); const written = await state();
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }, { x: x + 100, y, id: 2 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 30, y, id: 1 }, { x: x + 130, y, id: 2 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const pinched = await state(); expect(pinched.strokes).toBe(written.strokes); expect(pinched.history).toBe(written.history);
  expect(pinched.zoom).toBeGreaterThan(written.zoom); expect(pinched.active).toBeNull();
  await page.getByRole("button", { name: "Undo", exact: true }).click(); expect((await state()).strokes).toBe(before.strokes);
  await page.getByRole("button", { name: "Pointer", exact: true }).click();
  const next = (await page.locator(".ink-page").boundingBox())!;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: next.x + 30, y: next.y + 100, id: 1 }] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect((await state()).strokes).toBe(before.strokes); await session.detach();
});

test("native finger rectangle selects and moves handwriting, hold alone opens paste", async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view, ink = v.currentPage().strokes[0];
    ink.points = [{ x: .2, y: .15, pressure: .5, t: 1 }, { x: .4, y: .2, pressure: .5, t: 2 }];
    v.queueStrokePatch(v.currentPage(), [ink], []); v.state.lasso.mode = "rectangle"; v.renderAll();
  });
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const r = (await page.locator(".ink-page").boundingBox())!, point = (x: number, y: number) => ({ x: r.x + r.width * x, y: r.y + r.height * y, id: 1 });
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(.1, .1)] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(.5, .3)] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(.3, .175)] });
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(.4, .225)] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes[0].points[0].x)).toBeCloseTo(.3);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await page.evaluate(() => { (window as any).__inkNotesPreview.view.state.fingerAsPen = true; });
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(.7, .2)] });
  await expect(page.getByRole("button", { name: "Paste", exact: true })).toBeVisible();
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(1);
  await page.getByRole("button", { name: "Paste", exact: true }).click();
  await expect(page.locator(".ink-selection-actions")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(2);
  await session.detach();
});

test("color hold opens a working explicit menu and curve gestures do not delete points", async ({ page }) => {
  await ready(page); const pen = page.getByRole("button", { name: "Pen", exact: true }); await pen.click();
  const swatch = page.getByRole("button", { name: "Pen blue", exact: true }), r = (await swatch.boundingBox())!;
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 }] });
  await expect(page.getByRole("button", { name: "Remove preset color", exact: true })).toBeVisible();
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.state.palette.length)).toBe(5);
  await page.getByRole("button", { name: "Remove preset color", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.state.palette.length)).toBe(4);
  await expect(page.getByRole("dialog", { name: "Tool settings" })).toBeVisible();
  await page.getByRole("button", { name: "Expand pressure curve editor" }).click();
  const canvas = page.locator(".ink-curve-editor-canvas"); await canvas.scrollIntoViewIfNeeded(); const c = (await canvas.boundingBox())!;
  await page.mouse.dblclick(c.x + c.width / 2, c.y + c.height / 2);
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.state.pen.pressureCurve.length)).toBe(3);
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2); await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height - 1); await page.mouse.up();
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.state.pen.pressureCurve.length)).toBe(3);
  await page.getByRole("button", { name: "Remove point", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.state.pen.pressureCurve.length)).toBe(2);
  await session.detach();
});
