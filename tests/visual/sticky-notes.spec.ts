import { expect, test } from "@playwright/test";

for (const width of [360, 1280]) {
  test(`sticky note text/ink, resize without content mutation, fold and link at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 1000 }); await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    await page.getByRole("button", { name: "Add sticky note", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit sticky note", exact: true });
    await editor.getByRole("textbox", { name: "Note title", exact: true }).fill("复习卡");
    await editor.getByRole("textbox", { name: "Note keywords", exact: true }).fill("牛顿 力学");
    await editor.getByLabel("Note color", { exact: true }).fill("#a8e6ff");
    await editor.getByRole("textbox", { name: "Sticky note text", exact: true }).fill("第一行\n第二行");
    const board = editor.getByLabel("Sticky handwriting board", { exact: true }); const rect = (await board.boundingBox())!;
    await page.mouse.move(rect.x + 30, rect.y + 70); await page.mouse.down();
    await page.mouse.move(rect.x + 160, rect.y + 100, { steps: 20 }); await page.mouse.up();
    await editor.getByRole("button", { name: "Save note", exact: true }).click(); await expect(editor).toHaveCount(0);
    const state = () => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
    const original = await state(); expect(original.strokes).toHaveLength(1); expect(original.text).toBe("第一行\n第二行"); expect(original.color).toBe("#a8e6ff");
    const card = page.locator(".ink-sticky-note"); await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Edit note", exact: true }).click();
    await editor.getByRole("spinbutton", { name: "Note width percent", exact: true }).fill("20");
    await editor.getByRole("spinbutton", { name: "Note height percent", exact: true }).fill("10");
    await editor.getByRole("button", { name: "Save note", exact: true }).click();
    const resized = await state(); expect(resized.width).toBe(.2); expect(resized.strokes).toEqual(original.strokes); expect(resized.text).toBe(original.text);
    await page.getByRole("button", { name: "Undo", exact: true }).click(); expect((await state()).width).toBe(.5);
    await page.getByRole("button", { name: "Redo", exact: true }).click(); expect((await state()).width).toBe(.2);
    await card.getByRole("button", { name: "Fold", exact: true }).click(); expect((await state()).collapsed).toBe(true);
    await expect(card.locator("canvas")).toBeVisible();
    await card.getByRole("button", { name: "Edit note", exact: true }).click();
    await editor.getByRole("checkbox", { name: "Preview when folded", exact: true }).uncheck();
    const link = await editor.getByRole("textbox", { name: "Sticky note Markdown link", exact: true }).inputValue();
    expect(link).toContain("obsidian://ink-notes-sticky?"); expect(link).toContain(`sticky=${original.id}`);
    await editor.getByRole("button", { name: "Save note", exact: true }).click(); await expect(card.locator("canvas")).toHaveCount(0);
    await card.getByRole("button", { name: "Expand", exact: true }).click(); await expect(card.locator("canvas")).toBeVisible();
    await page.screenshot({ path: `test-results/sticky-note-content-${width}.png` });
    await card.getByRole("button", { name: "Edit note", exact: true }).click();
    await page.screenshot({ path: `test-results/sticky-editor-${width}.png` });
    await editor.getByRole("button", { name: "More space below", exact: true }).click();
    await board.evaluate((el) => el.scrollTop = 1000);
    await editor.getByRole("button", { name: "Save note", exact: true }).click();
    expect((await state()).scrollY).toBeGreaterThan(900); expect((await state()).strokes).toEqual(original.strokes);
    await card.getByRole("button", { name: "Edit note", exact: true }).click();
    expect(await board.evaluate((el) => el.scrollTop)).toBeGreaterThan(900);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.screenshot({ path: `test-results/sticky-note-${width}.png` });
    await page.evaluate(() => (window as any).__inkNotesPreview.findStickies());
    const search = page.getByRole("dialog", { name: "Find sticky notes", exact: true });
    await search.getByRole("searchbox", { name: "Search sticky notes", exact: true }).fill("牛顿");
    await expect(search.getByRole("button", { name: /复习卡/ })).toHaveCount(1);
    await search.getByRole("button", { name: /复习卡/ }).click(); await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const rotation of [undefined, 0, 90, 180, 270]) {
      const result = await page.evaluate((rotation) => (window as any).__inkNotesPreview.exportStickies(rotation), rotation);
      expect(result.images).toBe(1); expect(result.bytes).toBeGreaterThan(1000);
    }
    expect(errors).toEqual([]);
  });
}

test("sticky board expands without moving content; erasing, undo and stale drafts are safe", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 }); await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.getByRole("button", { name: "Add sticky note", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit sticky note", exact: true }), board = editor.getByLabel("Sticky handwriting board", { exact: true });
  const draw = async () => {
    const rect = (await board.boundingBox())!;
    await page.mouse.move(rect.x + 30, rect.y + 70); await page.mouse.down(); await page.mouse.move(rect.x + 130, rect.y + 90, { steps: 12 }); await page.mouse.up();
  };
  await editor.getByRole("button", { name: "More space right", exact: true }).click(); await board.evaluate((el) => el.scrollLeft = 1200);
  await draw();
  await editor.getByRole("textbox", { name: "Sticky note text", exact: true }).fill("Typed after handwriting");
  await editor.getByRole("button", { name: "Undo ink", exact: true }).click();
  await expect(editor.getByRole("textbox", { name: "Sticky note text", exact: true })).toHaveValue("Typed after handwriting");
  await editor.getByRole("button", { name: "Redo ink", exact: true }).click();
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  const state = () => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
  const original = await state(); expect(original.strokes[0].points[0].x).toBeGreaterThan(1);
  const card = page.locator(".ink-sticky-note"); await card.getByRole("button", { name: "Edit note", exact: true }).click();
  await editor.getByRole("button", { name: "Erase", exact: true }).click(); await draw();
  await editor.getByRole("button", { name: "Save note", exact: true }).click(); expect((await state()).strokes).toHaveLength(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click(); expect((await state()).strokes).toHaveLength(1);
  expect((await state()).strokes[0].points).toEqual(original.strokes[0].points);
  await card.getByRole("button", { name: "Edit note", exact: true }).click();
  await editor.getByRole("textbox", { name: "Sticky note text", exact: true }).fill("Stale draft");
  await page.evaluate(() => {
    const view = (window as any).__inkNotesPreview.view, before = view.currentPage().stickyNotes[0];
    view.changeSticky(before, { ...before, text: "Peer edit" });
  });
  await editor.getByRole("button", { name: "Save note", exact: true }).click(); await expect(editor).toBeVisible();
  expect((await state()).text).toBe("Peer edit"); await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  const header = card.locator(".ink-sticky-header"); const rect = (await header.boundingBox())!, beforeMove = await state();
  await page.mouse.move(rect.x + 20, rect.y + 10); await page.mouse.down(); await page.mouse.move(rect.x + 100, rect.y + 40, { steps: 8 }); await page.mouse.up();
  expect((await state()).x).toBeGreaterThan(beforeMove.x);
  const handle = card.getByRole("button", { name: "Resize note", exact: true }), resize = (await handle.boundingBox())!, beforeResize = await state();
  await page.mouse.move(resize.x + 10, resize.y + 10); await page.mouse.down(); await page.mouse.move(resize.x + 40, resize.y + 40, { steps: 6 }); await page.mouse.up();
  expect((await state()).width).toBeGreaterThan(beforeResize.width); expect((await state()).strokes).toEqual(beforeResize.strokes);
  // Reflow an existing wide-screen note into a narrow pane. Its raster must
  // retain the same horizontal/vertical scale rather than compressing ink.
  await page.setViewportSize({ width: 360, height: 1000 });
  await expect.poll(async () => card.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect();
    return Math.abs(canvas.width / rect.width - canvas.height / rect.height);
  })).toBeLessThan(.04);
  expect((await state()).strokes).toEqual(beforeResize.strokes);
});

test("sticky board accepts native Pencil input, keeps fingers for scrolling and supports read-only lookup", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1100 }); await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.getByRole("button", { name: "Add sticky note", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit sticky note", exact: true });
  await editor.getByLabel("Sticky handwriting board", { exact: true }).evaluate((el) => {
    const r = el.getBoundingClientRect();
    const touch = (id: number, x: number, y: number, stylus: boolean) => {
      const t = new Touch({ target: el, identifier: id, clientX: x, clientY: y, force: .5 });
      if (stylus) Object.defineProperty(t, "touchType", { value: "stylus" }); return t;
    };
    for (const stylus of [false, true]) {
      const t = touch(stylus ? 11 : 10, r.x + 50, r.y + 80, stylus), moved = touch(stylus ? 11 : 10, r.x + 100, r.y + 100, stylus);
      el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] }));
      el.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [moved], changedTouches: [moved] }));
      el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [moved] }));
    }
  });
  await editor.getByRole("button", { name: "Save note", exact: true }).click();
  const original = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
  expect(original.strokes).toHaveLength(1); expect(original.strokes[0].points).toHaveLength(2);
  await page.locator(".ink-sticky-header").evaluate((el) => {
    const r = el.getBoundingClientRect(), t = new Touch({ target: el, identifier: 40, clientX: r.x + 10, clientY: r.y + 10 });
    const moved = new Touch({ target: el, identifier: 40, clientX: r.x + 50, clientY: r.y + 30 });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] }));
    document.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [moved], changedTouches: [moved] }));
    document.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [moved] }));
  });
  const moved = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
  expect(moved.x).toBeGreaterThan(original.x); expect(moved.strokes).toEqual(original.strokes);
  await page.evaluate(() => (window as any).__inkNotesPreview.view.setReadingMode(true));
  await page.locator(".ink-sticky-note").getByRole("button", { name: "Read note", exact: true }).click();
  const reader = page.getByRole("dialog", { name: "Read sticky note", exact: true });
  await expect(reader.getByRole("textbox", { name: "Note title", exact: true })).toBeDisabled();
  await expect(reader.getByRole("button", { name: "Save note", exact: true })).toHaveCount(0);
  await reader.getByRole("button", { name: "Cancel", exact: true }).click();
});
