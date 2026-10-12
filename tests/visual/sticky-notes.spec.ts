import { expect, test } from "@playwright/test";

const state = (page: any) => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage());
async function ready(page: any, width = 1280) {
  await page.setViewportSize({ width, height: 1000 }); await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(() => { const v = (window as any).__inkNotesPreview.view; v.currentPage().strokes = []; v.drawStrokes([]); });
  await page.getByRole("button", { name: "Add sticky note", exact: true }).click();
  await expect(page.locator(".ink-sticky-note")).toBeVisible();
}
async function draw(page: any, x1: number, y1: number, x2: number, y2: number) {
  await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 16 }); await page.mouse.up();
}
for (const width of [360, 1280]) test(`inline mixed sticky, fold, resize, Markdown and lookup at ${width}px`, async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message)); await ready(page, width);
  const card = page.locator(".ink-sticky-note"), board = card.getByLabel("Sticky handwriting board");
  await expect(page.locator(".ink-sticky-editor")).toHaveCount(0); await expect(card.locator('input[type="number"]')).toHaveCount(0);
  const r = (await board.boundingBox())!;
  await draw(page, r.x + 25, r.y + 55, r.x + 100, r.y + 75);
  expect((await state(page)).stickyNotes[0].strokes).toHaveLength(1);
  expect((await state(page)).strokes).toHaveLength(0);
  await card.getByRole("button", { name: "Type on sticky note", exact: true }).click();
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("# Revision\n**Force** and [reference](https://example.com)");
  await card.getByRole("textbox", { name: "Sticky Markdown" }).press("Control+Enter");
  await expect(card.locator("h1")).toHaveText("Revision"); await expect(card.locator("strong")).toHaveText("Force");
  const original = (await state(page)).stickyNotes[0];
  const handle = card.getByRole("button", { name: "Resize note", exact: true }), h = (await handle.boundingBox())!;
  await draw(page, h.x + 10, h.y + 10, h.x + 30, h.y + 35);
  const resized = (await state(page)).stickyNotes[0]; expect(resized.width).toBeGreaterThan(original.width);
  expect(resized.strokes).toEqual(original.strokes); expect(resized.text).toBe(original.text);
  await card.getByRole("button", { name: "Fold", exact: true }).click(); expect((await state(page)).stickyNotes[0].collapsed).toBe(true);
  await card.getByRole("button", { name: "Expand", exact: true }).click();
  expect((await state(page)).stickyNotes[0].height).toBe(resized.height);
  await card.locator(".ink-sticky-title").dblclick();
  await card.getByRole("textbox", { name: "Sticky title" }).fill("Physics"); await card.getByRole("textbox", { name: "Sticky title" }).press("Enter");
  await card.getByRole("button", { name: "Sticky note options", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copy link to sticky note", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `test-results/sticky-inline-${width}.png` });
  for (const rotation of [undefined, 0, 90, 180, 270]) {
    const result = await page.evaluate((rotation) => (window as any).__inkNotesPreview.exportStickies(rotation), rotation);
    expect(result.images).toBe(1); expect(result.bytes).toBeGreaterThan(1000);
  }
  expect(errors).toEqual([]);
});

test("one cross-boundary stroke routes both layers and undoes/redoes atomically", async ({ page }) => {
  await ready(page); const board = page.getByLabel("Sticky handwriting board"), r = (await board.boundingBox())!;
  await draw(page, r.x - 45, r.y + 65, r.x + 100, r.y + 65);
  let p = await state(page); expect(p.strokes).toHaveLength(1); expect(p.stickyNotes[0].strokes).toHaveLength(1);
  const note = p.stickyNotes[0], outside = p.strokes[0];
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  p = await state(page); expect(p.strokes).toHaveLength(0); expect(p.stickyNotes[0].strokes).toHaveLength(0);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  p = await state(page); expect(p.strokes[0].points).toEqual(outside.points); expect(p.stickyNotes[0].strokes[0].points).toEqual(note.strokes[0].points);
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  await draw(page, r.x + 30, r.y + 65, r.x + 60, r.y + 65);
  p = await state(page); expect(p.stickyNotes[0].strokes).toHaveLength(0); expect(p.strokes).toHaveLength(1);
  await page.getByRole("button", { name: "Undo", exact: true }).click(); expect((await state(page)).stickyNotes[0].strokes).toHaveLength(1);
});

test("native Pencil writes on the same board; finger drag and read mode keep content safe", async ({ page }) => {
  await ready(page, 820);
  await page.getByLabel("Sticky handwriting board").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const touch = (x: number) => { const t = new Touch({ target: el, identifier: 11, clientX: x, clientY: r.y + 65, force: .5 }); Object.defineProperty(t, "touchType", { value: "stylus" }); return t; };
    const a = touch(r.x + 30), b = touch(r.x + 100);
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [a], changedTouches: [a] }));
    el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [b], changedTouches: [b] }));
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [b] }));
  });
  const original = (await state(page)).stickyNotes[0]; expect(original.strokes).toHaveLength(1);
  await page.getByRole("button", { name: "Move sticky note", exact: true }).evaluate((el) => {
    const r = el.getBoundingClientRect(), a = new Touch({ target: el, identifier: 40, clientX: r.x + 5, clientY: r.y + 10 });
    const b = new Touch({ target: el, identifier: 40, clientX: r.x + 45, clientY: r.y + 30 });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [a], changedTouches: [a] }));
    document.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [b], changedTouches: [b] }));
    document.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [b] }));
  });
  const moved = (await state(page)).stickyNotes[0]; expect(moved.x).toBeGreaterThan(original.x); expect(moved.strokes).toEqual(original.strokes);
  await page.evaluate(() => (window as any).__inkNotesPreview.view.setReadingMode(true));
  await expect(page.getByRole("button", { name: "Type on sticky note", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Fold", exact: true }).click(); expect((await state(page)).stickyNotes[0].collapsed).toBe(false);
  await expect(page.locator(".ink-sticky-note")).toHaveClass(/is-collapsed/);
  await page.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(page.locator(".ink-sticky-note")).not.toHaveClass(/is-collapsed/);
});


test("shared lasso copies and removes board ink; paste uses destination layer", async ({ page }) => {
  await ready(page); const board = page.getByLabel("Sticky handwriting board"), r = (await board.boundingBox())!;
  await draw(page, r.x + 30, r.y + 80, r.x + 120, r.y + 90);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page.evaluate(() => (window as any).__inkNotesPreview.view.state.lasso.mode = "rectangle");
  await draw(page, r.x + 15, r.y + 60, r.x + 145, r.y + 110);
  await expect(page.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.evaluate(() => (window as any).__inkNotesPreview.view.deleteSelection());
  expect((await state(page)).stickyNotes[0].strokes).toHaveLength(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click(); expect((await state(page)).stickyNotes[0].strokes).toHaveLength(1);
  await page.evaluate(() => { const v = (window as any).__inkNotesPreview.view; v.clearSelection(); v.pasteTarget = { x: .8, y: .7 }; v.pasteSelection(); });
  expect((await state(page)).strokes).toHaveLength(1);
});

test("inline paragraph references and touch long press resolve without expanding accidentally", async ({ page }) => {
  await ready(page);
  const card = page.locator(".ink-sticky-note");
  await card.getByRole("button", { name: "Type on sticky note", exact: true }).click();
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("A definition ^definition-1");
  await card.getByRole("textbox", { name: "Sticky Markdown" }).press("Control+Enter");
  await expect(card.locator('[data-sticky-block="definition-1"]')).toHaveCount(1);
  await card.getByRole("button", { name: "Fold", exact: true }).click();
  await card.locator(".ink-sticky-title").evaluate((el) => {
    const r = el.getBoundingClientRect(), t = new Touch({ target: el, identifier: 23, clientX: r.x + 10, clientY: r.y + 10 });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [t], changedTouches: [t] }));
  });
  await expect(page.getByRole("button", { name: "Copy paragraph link: definition-1", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.evaluate(() => { const v = (window as any).__inkNotesPreview.view, p = v.currentPage(); return v.revealSticky(p.id, p.stickyNotes[0].id, "definition-1"); });
  await expect(card).not.toHaveClass(/is-collapsed/);
  await expect(card.locator(".ink-sticky-reference-target")).toContainText("A definition");
});


test("outside writing commits inline text first; panning and shrinking preserve fixed layout", async ({ page }) => {
  await ready(page); const card = page.locator(".ink-sticky-note"), board = page.getByLabel("Sticky handwriting board");
  await card.getByRole("button", { name: "Type on sticky note", exact: true }).click();
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("Words and handwritten diagrams share this board.");
  const r = (await board.boundingBox())!;
  await draw(page, r.x - 60, r.y + 40, r.x - 30, r.y + 60);
  expect((await state(page)).stickyNotes[0].text).toContain("handwritten diagrams");
  expect((await state(page)).strokes).toHaveLength(1);
  await card.getByRole("button", { name: "Type on sticky note", exact: true }).click();
  await card.getByRole("textbox", { name: "Sticky Markdown" }).fill("Updated draft");
  await card.getByRole("button", { name: "Fold", exact: true }).click();
  expect((await state(page)).stickyNotes[0].collapsed).toBe(true); expect((await state(page)).stickyNotes[0].text).toBe("Updated draft");
  await card.getByRole("button", { name: "Expand", exact: true }).click();
  await page.getByRole("button", { name: "Pointer", exact: true }).click();
  await draw(page, r.x + 100, r.y + 90, r.x + 50, r.y + 50);
  expect((await state(page)).stickyNotes[0].scrollY).toBeGreaterThan(30);
  const layoutWidth = await card.locator(".ink-sticky-markdown").evaluate((el) => el.style.width);
  const h = (await card.getByRole("button", { name: "Resize note", exact: true }).boundingBox())!;
  await draw(page, h.x + 10, h.y + 10, h.x - 70, h.y - 40);
  expect(await card.locator(".ink-sticky-markdown").evaluate((el) => el.style.width)).toBe(layoutWidth);
  const before = (await state(page)).stickyNotes[0];
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const b = (await board.boundingBox())!; await draw(page, b.x + 30, b.y + 50, b.x + 70, b.y + 65);
  const written = (await state(page)).stickyNotes[0]; expect(written.strokes).toHaveLength(1); expect(written.scrollY).toBe(before.scrollY);
});
