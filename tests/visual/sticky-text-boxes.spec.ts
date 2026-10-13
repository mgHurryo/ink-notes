import { expect, test, type Page, type Locator } from "@playwright/test";

test.use({ hasTouch: true, deviceScaleFactor: 2 });
const state = (page: Page) => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
async function ready(page: Page, mode: "ink" | "pdf") {
  await page.setViewportSize({ width: 1000, height: 1000 }); await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
  await page.evaluate(() => {
    const v = (window as any).__inkNotesPreview.view; v.addSticky();
    const n = v.currentPage().stickyNotes[0]; v.changeSticky(n, { ...n, x: .1, y: .1, width: .8, height: .7 });
  });
}
async function add(page: Page, text: string) {
  await page.locator(".ink-sticky-header").getByRole("button", { name: "Add text box", exact: true }).tap();
  const input = page.getByRole("textbox", { name: "Sticky Markdown", exact: true });
  await input.fill(text); await input.press("Control+Enter");
}
async function fingerDrag(element: Locator, dx: number, dy: number, stylus = false) {
  await element.evaluate((el, { dx, dy, stylus }) => {
    const r = el.getBoundingClientRect();
    // Plain contact objects work with both Chromium and WebKit (whose Touch constructor differs).
    const a = { target: el, identifier: 79, clientX: r.x + 8, clientY: r.y + 8, force: .5, touchType: stylus ? "stylus" : "direct" };
    const b = { ...a, clientX: a.clientX + dx, clientY: a.clientY + dy };
    for (const [type, contact] of [["touchstart", a], ["touchmove", b], ["touchend", b]] as const) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(e, { touches: { value: type === "touchend" ? [] : [contact] }, changedTouches: { value: [contact] } });
      (stylus || type === "touchstart" ? el : document).dispatchEvent(e);
    }
  }, { dx, dy, stylus });
}

for (const mode of ["ink", "pdf"] as const) {
  test(`${mode}: text formatting persists, scales with touch resize, and exports`, async ({ page }) => {
    await ready(page, mode); await add(page, "Styled 中文 text");
    const frame = page.locator(".ink-sticky-text-box"), text = frame.locator(".ink-sticky-markdown");
    await frame.getByRole("button", { name: "Format text box", exact: true }).tap();
    const panel = page.getByRole("dialog", { name: "Text style", exact: true });
    await panel.getByLabel("Text font", { exact: true }).selectOption("serif");
    const size = panel.getByLabel("Text font size", { exact: true }); await size.fill("32"); await size.press("Tab");
    await panel.getByLabel("Bold", { exact: true }).check(); await panel.getByLabel("Italic", { exact: true }).check();
    await expect(text).toHaveCSS("font-size", "32px"); await expect(text).toHaveCSS("font-family", "serif");
    await expect(text).toHaveCSS("font-weight", "700"); await expect(text).toHaveCSS("font-style", "italic");
    await page.screenshot({ path: `.tmp/sticky-text-style/${mode}-format.png` });
    await panel.getByRole("button", { name: "Close text style", exact: true }).tap();
    await fingerDrag(frame.getByRole("button", { name: "Resize text box", exact: true }), 30, 20);
    expect((await state(page)).textBoxes[0].fontSize).toBe(32);
    await frame.getByRole("button", { name: "Format text box", exact: true }).tap();
    await panel.getByLabel("Scale text with box", { exact: true }).check();
    await panel.getByRole("button", { name: "Close text style", exact: true }).tap();
    const before = (await state(page)).textBoxes[0];
    await fingerDrag(frame.getByRole("button", { name: "Resize text box", exact: true }), 60, 40);
    const scaled = (await state(page)).textBoxes[0]; expect(scaled.fontSize).toBeGreaterThan(32); expect(scaled.text).toBe(before.text);
    await page.getByRole("button", { name: "Undo", exact: true }).tap(); expect((await state(page)).textBoxes[0].fontSize).toBe(32);
    await page.getByRole("button", { name: "Redo", exact: true }).tap(); expect((await state(page)).textBoxes[0].fontSize).toBe(scaled.fontSize);
    await frame.tap({ position: { x: 8, y: 8 } });
    await frame.getByRole("button", { name: "Edit text box", exact: true }).tap();
    await expect(page.getByRole("textbox", { name: "Sticky Markdown", exact: true })).toHaveCSS("font-family", "serif");
    await page.keyboard.press("Escape");
    const exported = await page.evaluate(async () => {
      const urls: string[] = [], descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
      Object.defineProperty(HTMLImageElement.prototype, "src", { ...descriptor, set(value: string) {
        if (value.startsWith("data:image/svg+xml")) urls.push(value); descriptor.set!.call(this, value);
      } });
      try {
        const result = await (window as any).__inkNotesPreview.exportStickies(90);
        const svg = new DOMParser().parseFromString(decodeURIComponent(urls[0].split(",").slice(1).join(",")), "image/svg+xml");
        const frame = Array.from(svg.querySelectorAll<HTMLElement>("div")).find((node) => node.style.position === "absolute")!;
        return { ...result, position: frame.style.position, font: frame.style.font };
      } finally { Object.defineProperty(HTMLImageElement.prototype, "src", descriptor); }
    });
    expect(exported.images).toBe(1); expect(exported.bytes).toBeGreaterThan(1000);
    expect(exported.position).toBe("absolute");
    expect(exported.font.replace(/\s/g, "")).toContain(`italicbold${scaled.fontSize}px/1.4serif`);
    await frame.getByRole("button", { name: "Format text box", exact: true }).tap();
    await frame.getByRole("button", { name: "Format text box", exact: true }).tap(); await expect(panel).toHaveCount(0);
    await frame.getByRole("button", { name: "Format text box", exact: true }).tap();
    await page.mouse.click(20, 950); await expect(panel).toHaveCount(0);
    await page.evaluate(() => (window as any).__inkNotesPreview.view.setReadingMode(true));
    await expect(page.getByRole("button", { name: "Format text box", exact: true })).toHaveCount(0);
  });
  test(`${mode}: primary fonts stay independent; style controls survive the keyboard viewport`, async ({ page }) => {
    await ready(page, mode);
    await page.locator(".ink-sticky-header").getByRole("button", { name: "Type on sticky note", exact: true }).tap();
    const input = page.getByRole("textbox", { name: "Sticky Markdown", exact: true });
    await input.fill("Primary text"); await input.press("Control+Enter");
    await add(page, "Second box"); await fingerDrag(page.locator(".ink-sticky-text-box").nth(1), 200, 150);
    const frame = page.locator('.ink-sticky-text-box[data-text-box-id="primary"]');
    await frame.tap({ position: { x: 8, y: 8 } });
    await frame.getByRole("button", { name: "Format text box", exact: true }).tap();
    const panel = page.getByRole("dialog", { name: "Text style", exact: true });
    const size = panel.getByLabel("Text font size", { exact: true }); await size.fill("28"); await size.press("Tab");
    await panel.getByLabel("Text font", { exact: true }).selectOption("kai");
    await panel.getByLabel("Scale text with box", { exact: true }).check();
    const second = (await state(page)).textBoxes[0];
    await size.focus(); await page.setViewportSize({ width: 1000, height: 420 });
    await expect(size).toBeFocused(); await expect(panel).toBeVisible();
    // The browser delivers resize after setViewportSize; wait for its layout.
    await expect.poll(async () => { const bounds = (await panel.boundingBox())!; return bounds.y >= 0 && bounds.y + bounds.height <= 420; }).toBe(true);
    await size.fill("30"); await size.press("Tab"); await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(frame.getByRole("button", { name: "Format text box", exact: true })).toBeFocused();
    await page.setViewportSize({ width: 1000, height: 1000 });
    // Let the host's scheduled viewport/layout pass finish before restoring
    // keyboard focus to a frame that it may replace at the new page scale.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await frame.focus(); await page.keyboard.press("Alt+Shift+ArrowDown");
    const changed = await state(page); expect(changed.textFontSize).toBeGreaterThan(30); expect(changed.textFontFamily).toBe("kai");
    expect(changed.textBoxes[0]).toEqual(second);
    await frame.getByRole("button", { name: "Edit text box", exact: true }).tap();
    await expect(input).toHaveCSS("font-size", `${changed.textFontSize}px`);
    await input.fill("Updated primary"); await input.press("Control+Enter");
    expect((await state(page)).textFontFamily).toBe("kai"); expect((await state(page)).textFontSize).toBe(changed.textFontSize);
  });
  test(`${mode}: open drafts preserve peer box edits and reject edits to the same box`, async ({ page }) => {
    await ready(page, mode); await add(page, "First box"); await add(page, "Second box");
    const frames = page.locator(".ink-sticky-text-box"), first = frames.nth(0), second = frames.nth(1);
    await fingerDrag(second, 190, 140);
    await page.getByRole("button", { name: "Pointer", exact: true }).click();
    await first.dblclick({ position: { x: 8, y: 8 } });
    const input = page.getByRole("textbox", { name: "Sticky Markdown", exact: true });
    await input.fill("First local draft");
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0];
      v.changeSticky(n, { ...n, textBoxes: n.textBoxes.map((box: any, i: number) => i === 1 ? { ...box, text: "Second peer edit" } : box) });
    });
    await input.press("Control+Enter");
    expect((await state(page)).textBoxes.map((box: any) => box.text)).toEqual(["First local draft", "Second peer edit"]);
    await first.dblclick({ position: { x: 8, y: 8 } }); await input.fill("Conflicting draft");
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0];
      v.changeSticky(n, { ...n, textBoxes: n.textBoxes.map((box: any, i: number) => i === 0 ? { ...box, text: "First peer edit" } : box) });
    });
    await input.press("Control+Enter"); await expect(input).toHaveValue("Conflicting draft");
    expect((await state(page)).textBoxes[0].text).toBe("First peer edit");
    await input.press("Escape"); await expect(first).toContainText("First peer edit");
  });
  test(`${mode}: moved Markdown boxes export into rotated PDF pages`, async ({ page }) => {
    await ready(page, mode); await add(page, "First **box**"); await add(page, "Second **box**");
    await fingerDrag(page.locator(".ink-sticky-text-box").nth(1), 180, 110);
    for (const rotation of [0, 90]) {
      const exported = await page.evaluate((rotation) => (window as any).__inkNotesPreview.exportStickies(rotation), rotation);
      expect(exported.images).toBe(1); expect(exported.bytes).toBeGreaterThan(1000);
    }
  });

  test(`${mode}: cropped boxes keep all selected actions inside a narrow note`, async ({ page }) => {
    await ready(page, mode); await add(page, "Narrow box");
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0];
      v.changeSticky(n, { ...n, width: .15, textBoxes: n.textBoxes.map((box: any) => ({ ...box, width: 60 })) });
    });
    const frame = page.locator(".ink-sticky-text-box"); await frame.tap({ position: { x: 8, y: 8 } });
    const board = (await page.getByLabel("Sticky handwriting board").boundingBox())!;
    for (const name of ["Move text box", "Edit text box", "Format text box", "Delete text box"]) {
      const bounds = (await frame.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(43.9); expect(bounds.height).toBeGreaterThanOrEqual(43.9);
      expect(bounds.x).toBeGreaterThanOrEqual(board.x - 1); expect(bounds.x + bounds.width).toBeLessThanOrEqual(board.x + board.width + 1);
      expect(bounds.y).toBeGreaterThanOrEqual(board.y - 1); expect(bounds.y + bounds.height).toBeLessThanOrEqual(board.y + board.height + 1);
    }
    await frame.getByRole("button", { name: "Edit text box", exact: true }).tap();
    await expect(page.getByRole("textbox", { name: "Sticky Markdown", exact: true })).toHaveValue("Narrow box");
  });
  test(`${mode}: multiple Markdown boxes move and resize independently; delete undo/redo persists`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message)); await ready(page, mode);
    await add(page, "First **box**"); await add(page, "Second *box* ^second-box");
    const frames = page.locator(".ink-sticky-text-box"), first = frames.nth(0), second = frames.nth(1);
    await expect(frames).toHaveCount(2); await expect(first.locator("strong")).toHaveText("box");
    const before = await state(page);
    await fingerDrag(second, 180, 110);
    const moved = await state(page);
    expect(moved.textBoxes[0]).toEqual(before.textBoxes[0]);
    expect(moved.textBoxes[1].x).toBeGreaterThan(before.textBoxes[1].x + 100);
    expect(moved.textBoxes[1].y).toBeGreaterThan(before.textBoxes[1].y + 80);
    expect(moved.strokes).toEqual(before.strokes);
    await expect(second).toHaveClass(/is-selected/);
    await fingerDrag(second.getByRole("button", { name: "Resize text box", exact: true }), 70, 50);
    const resized = await state(page);
    expect(resized.textBoxes[1].width).toBeGreaterThan(moved.textBoxes[1].width);
    expect(resized.textBoxes[1].height).toBeGreaterThan(moved.textBoxes[1].height);
    expect(resized.textBoxes.map((box: any) => box.text)).toEqual(before.textBoxes.map((box: any) => box.text));
    // Selecting a box never turns handwriting input into an object drag.
    await fingerDrag(second, 35, 20, true);
    const written = await state(page); expect(written.textBoxes).toEqual(resized.textBoxes); expect(written.strokes.length).toBeGreaterThan(resized.strokes.length);
    await page.mouse.click(20, 950); await expect(second).not.toHaveClass(/is-selected/);
    await second.tap({ position: { x: 8, y: 8 } });
    await second.getByRole("button", { name: "Delete text box", exact: true }).tap();
    await expect(frames).toHaveCount(1); const removed = await state(page);
    expect(removed.deletedTextBoxes[resized.textBoxes[1].id]).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Undo", exact: true }).tap(); await expect(frames).toHaveCount(2);
    const restored = await state(page); expect(restored.textBoxes[1].text).toBe(before.textBoxes[1].text);
    expect(restored.textBoxes[1].id).not.toBe(resized.textBoxes[1].id);
    await page.getByRole("button", { name: "Redo", exact: true }).tap(); await expect(frames).toHaveCount(1);
    expect((await state(page)).deletedTextBoxes[restored.textBoxes[1].id]).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Undo", exact: true }).tap();
    await page.locator(".ink-sticky-header").getByRole("button", { name: "Sticky note options", exact: true }).tap();
    await expect(page.locator(".menu").getByRole("button", { name: "Copy paragraph link: second-box", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `.tmp/sticky-text-boxes/${mode}-multiple.png` }); expect(errors).toEqual([]);
  });

  test(`${mode}: double tap edits the touched box, keyboard moves it, and read mode disables editing`, async ({ page }) => {
    await ready(page, mode); await add(page, "First box"); await add(page, "Second box");
    const frames = page.locator(".ink-sticky-text-box"), second = frames.nth(1);
    await fingerDrag(second, 190, 140);
    const bounds = (await second.boundingBox())!, x = bounds.x + 8, y = bounds.y + 8;
    await page.touchscreen.tap(x, y); await page.touchscreen.tap(x, y);
    const input = page.getByRole("textbox", { name: "Sticky Markdown", exact: true });
    await expect(input).toBeFocused(); await expect(input).toHaveValue("Second box");
    await input.fill("Changed second box"); await input.press("Control+Enter");
    const before = await state(page);
    await second.focus(); await page.keyboard.press("Shift+ArrowLeft"); await page.keyboard.press("Alt+ArrowDown");
    const after = await state(page);
    expect(after.textBoxes[1].x).toBe(before.textBoxes[1].x - 10);
    expect(after.textBoxes[1].height).toBe(before.textBoxes[1].height + 1);
    expect(after.textBoxes[0]).toEqual(before.textBoxes[0]);
    await page.keyboard.press("Escape"); await expect(second).not.toHaveClass(/is-selected/);
    await page.evaluate(() => (window as any).__inkNotesPreview.view.setReadingMode(true));
    await expect(page.locator(".ink-sticky-header").getByRole("button", { name: "Add text box", exact: true })).toHaveCount(0);
    await fingerDrag(second, 50, 20); await second.dblclick({ position: { x: 8, y: 8 } });
    await expect(input).toHaveCount(0); expect((await state(page)).textBoxes).toEqual(after.textBoxes);
  });
}
