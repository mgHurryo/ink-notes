import { test, expect, type Page } from "@playwright/test";
test.use({ hasTouch: true });
async function ready(page: Page, mode: "ink" | "pdf") {
  await page.setViewportSize({ width: 1000, height: 1000 }); await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view; v.addSticky();
    const n = v.currentPage().stickyNotes[0]; v.changeSticky(n, { ...n, x: .1, y: .1, width: .6, height: .6 });
  });
}
const note = (page: Page) => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
async function drag(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 5 }); await page.mouse.up();
}
for (const mode of ["ink", "pdf"] as const) {
  test(`${mode}: Pointer moves notes and boxes, explicit Alt pans content, Escape clears selection`, async ({ page }) => {
    await ready(page, mode);
    await page.getByRole("button", { name: "Pointer", exact: true }).click();
    const board = page.getByLabel("Sticky handwriting board"), bounds = (await board.boundingBox())!;
    const before = await note(page);
    await drag(page, bounds.x + 200, bounds.y + 170, 45, 30);
    const moved = await note(page); expect(moved.x).toBeGreaterThan(before.x); expect(moved.y).toBeGreaterThan(before.y);
    expect(moved.scrollX).toBe(before.scrollX); expect(moved.scrollY).toBe(before.scrollY);
    const b = (await board.boundingBox())!;
    await page.keyboard.down("Alt"); await drag(page, b.x + 200, b.y + 170, -45, -30); await page.keyboard.up("Alt");
    const panned = await note(page); expect(panned.x).toBe(moved.x); expect(panned.scrollX).toBeGreaterThan(0);
    // The toolbar gained its own "Add text box" (page text); the sticky note
    // button is the one that adds a box to this note.
    await page.locator(".ink-sticky-header").getByRole("button", { name: "Add text box", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Sticky Markdown", exact: true }); await input.fill("Movable text"); await input.press("Control+Enter");
    const box = page.locator(".ink-sticky-text-box"), r = (await box.boundingBox())!;
    const original = await note(page); await drag(page, r.x + 8, r.y + 8, 40, 30);
    const changed = await note(page); expect(changed.textBoxes[0].x).toBeGreaterThan(original.textBoxes[0].x);
    expect(changed.x).toBe(original.x); expect(changed.scrollX).toBe(original.scrollX);
    await page.keyboard.press("Escape"); await expect(box).not.toHaveClass(/is-selected/);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const selected = await note(page), region = (await box.boundingBox())!;
    await drag(page, region.x + 10, region.y + 10, 35, 15);
    expect((await note(page)).textBoxes).toEqual(selected.textBoxes);
  });
  test(`${mode}: lasso taps and moves one sticky stroke through text, with undo and no typing`, async ({ page }) => {
    await ready(page, mode);
    await page.getByRole("button", { name: "Type on sticky note", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Sticky Markdown", exact: true }); await input.fill("Text behind ink"); await input.press("Control+Enter");
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0];
      const stroke = (id: string, y: number) => ({ id, pageId: n.id, tool: "pen", color: "#202020", width: 4, opacity: 1,
        points: [{ x: .04, y, pressure: .5, t: 1 }, { x: .18, y, pressure: .5, t: 2 }], createdAt: 1, updatedAt: 1 });
      v.changeSticky(n, { ...n, strokes: [stroke("target", .022), stroke("other", .09)] });
    });
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const n = await note(page), board = (await page.getByLabel("Sticky handwriting board").boundingBox())!;
    const scale = board.width / (n.width * n.boardPageWidth), x = board.x + 100 * scale, y = board.y + 22 * scale;
    await page.touchscreen.tap(x, y); await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await expect(input).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.selectedStrokeIds.size)).toBe(1);
    await drag(page, x, y, 40, 30);
    const after = await note(page); expect(after.strokes).toHaveLength(2); expect(after.strokes.find((s: any) => s.id === "other")).toEqual(n.strokes[1]);
    expect(after.strokes.find((s: any) => s.id !== "other").points[0].x).toBeGreaterThan(.04);
    expect(after.text).toBe(n.text); expect(after.x).toBe(n.x);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    const restored = (await note(page)).strokes;
    expect(restored).toHaveLength(n.strokes.length);
    for (const stroke of n.strokes) expect(restored.map((s: any) => s.points)).toContainEqual(stroke.points);
  });
  test(`${mode}: Pointer native Pencil handoff moves a box once without writing or moving the card`, async ({ page }) => {
    await ready(page, mode);
    await page.locator(".ink-sticky-header").getByRole("button", { name: "Add text box", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Sticky Markdown", exact: true }); await input.fill("Pencil object"); await input.press("Control+Enter");
    await page.getByRole("button", { name: "Pointer", exact: true }).click();
    const before = await note(page), frame = page.locator(".ink-sticky-text-box");
    await frame.evaluate((el) => {
      const r = el.getBoundingClientRect(), a = { target: el, identifier: 7, clientX: r.x + 10, clientY: r.y + 10, force: .5, touchType: "stylus" };
      const pointer = (type: string, dx: number, dy: number) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true,
        pointerType: "pen", pointerId: 9, button: 0, clientX: a.clientX + dx, clientY: a.clientY + dy }));
      const touch = (type: string, dx: number, dy: number) => {
        const contact = { ...a, clientX: a.clientX + dx, clientY: a.clientY + dy }, event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [contact] }, changedTouches: { value: [contact] } });
        (type === "touchstart" ? el : document).dispatchEvent(event);
      };
      pointer("pointerdown", 0, 0); touch("touchstart", 0, 0);
      pointer("pointermove", 40, 30); touch("touchmove", 40, 30); touch("touchend", 40, 30); pointer("pointerup", 40, 30);
    });
    const after = await note(page); expect(after.textBoxes[0].x).toBeGreaterThan(before.textBoxes[0].x);
    expect(after.x).toBe(before.x); expect(after.y).toBe(before.y); expect(after.strokes).toEqual(before.strokes);
    await expect(frame).toHaveClass(/is-selected/);
    await frame.getByRole("button", { name: "Format text box", exact: true }).click();
    await page.getByLabel("Text font size", { exact: true }).fill("38");
    await page.mouse.click(10, 950); expect((await note(page)).textBoxes[0].fontSize).toBe(38);
    await page.getByRole("button", { name: "Sticky note options", exact: true }).click();
    await page.locator(".menu").getByRole("button", { name: "Scroll sticky content", exact: true }).click();
    const panBefore = await note(page);
    await page.getByLabel("Sticky handwriting board").evaluate((el) => {
      const r = el.getBoundingClientRect(), a = { target: el, identifier: 88, clientX: r.x + r.width - 70, clientY: r.y + 150, touchType: "direct" };
      for (const [type, dx, dy] of [["touchstart", 0, 0], ["touchmove", -40, -30], ["touchend", -40, -30]] as const) {
        const touch = { ...a, clientX: a.clientX + dx, clientY: a.clientY + dy }, e = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperties(e, { touches: { value: type === "touchend" ? [] : [touch] }, changedTouches: { value: [touch] } });
        (type === "touchstart" ? el : document).dispatchEvent(e);
      }
    });
    const panned = await note(page); expect(panned.x).toBe(panBefore.x); expect(panned.y).toBe(panBefore.y);
    expect(panned.scrollX).toBeGreaterThan(panBefore.scrollX); expect(panned.textBoxes).toEqual(panBefore.textBoxes);
    await page.getByRole("button", { name: "Finish scrolling sticky content", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Finish scrolling sticky content", exact: true })).toHaveCount(0);
  });
}
