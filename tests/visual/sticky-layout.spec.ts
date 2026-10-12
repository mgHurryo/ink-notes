import { expect, test, type Page } from "@playwright/test";

test.use({ hasTouch: true, deviceScaleFactor: 2 });

async function ready(page: Page, mode: "ink" | "pdf") {
  await page.setViewportSize({ width: 820, height: 1000 }); await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
  await page.evaluate(() => (window as any).__inkNotesPreview.view.addSticky());
}

for (const mode of ["ink", "pdf"] as const) {
  test(`${mode}: host safe-area padding and keyboard leave the canvas usable for every inline field`, async ({ page }) => {
    await ready(page, mode);
    await page.evaluate(() => {
      document.querySelector("#host")!.classList.add("workspace-leaf-content");
      (window as any).__inkNotesPreview.view.contentEl.classList.add("view-content");
    });
    // Installed Obsidian 1.14.4 app.css: host padding is more specific than a view class.
    await page.addStyleTag({ content: `.workspace-leaf-content { display:flex; flex-direction:column; overflow:hidden; }
      .workspace-leaf-content .view-content { padding:12px 12px 32px; padding-bottom:max(var(--safe-area-inset-bottom),32px); overflow:auto; }` });
    const card = page.locator(".ink-sticky-note");
    for (const field of ["title", "text", "keywords"]) {
      if (field === "title") await card.locator(".ink-sticky-title").dblclick();
      else if (field === "text") await card.getByRole("button", { name: "Type on sticky note", exact: true }).click();
      else {
        await card.getByRole("button", { name: "Sticky note options", exact: true }).click();
        await page.locator(".menu").getByRole("button", { name: "Edit keywords", exact: true }).click();
      }
      const input = card.getByRole("textbox", { name: field === "text" ? "Sticky Markdown" : `Sticky ${field}` });
      await input.fill(`Keyboard draft: ${field}`);
      await page.evaluate(() => document.documentElement.style.setProperty("--safe-area-inset-bottom", "384px"));
      await page.setViewportSize({ width: 820, height: 420 });
      await expect(input).toBeFocused();
      await expect.poll(() => page.evaluate(() => {
        const v = (window as any).__inkNotesPreview.view, scroller = v.inputScroller(), root = v.contentEl;
        const viewport = scroller.getBoundingClientRect(), bounds = root.getBoundingClientRect(), input = document.activeElement!.getBoundingClientRect();
        return getComputedStyle(root).paddingBottom === "0px" && Math.abs(viewport.bottom - bounds.bottom) < 2
          && viewport.height > 300 && input.top >= viewport.top - 1 && input.top < viewport.bottom
          && root.scrollTop === 0 && document.querySelector("#host")!.scrollTop === 0 && window.scrollY === 0;
      })).toBe(true);
      if (field === "text") await page.screenshot({ path: `test-results/sticky-host-keyboard-${mode}.png` });
      await input.press(field === "text" ? "Control+Enter" : "Enter");
      await page.setViewportSize({ width: 820, height: 1000 });
      await page.evaluate(() => document.documentElement.style.setProperty("--safe-area-inset-bottom", "0px"));
      expect(await page.evaluate((field) => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0][field], field)).toBe(`Keyboard draft: ${field}`);
    }
  });

  test(`${mode}: folded icon previews content, opens on tap, edits on double tap and exposes actions on hold`, async ({ page }) => {
    await ready(page, mode);
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0];
      v.changeSticky(n, { ...n, text: "Preview words", title: "Reminder", collapsed: true });
    });
    const card = page.locator(".ink-sticky-note"), icon = card.getByRole("button", { name: "Expand", exact: true });
    await expect(card.locator("button")).toHaveCount(1); await expect(card.locator(".ink-sticky-header")).toHaveCount(0);
    const preview = await icon.locator("canvas").evaluate((el: HTMLCanvasElement) => el.toDataURL());
    await icon.click({ button: "right" });
    await page.locator(".menu").getByRole("button", { name: "Preview when folded", exact: true }).click();
    expect(await icon.locator("canvas").evaluate((el: HTMLCanvasElement) => el.toDataURL())).not.toBe(preview);
    const r = (await icon.boundingBox())!, x = r.x + r.width / 2, y = r.y + r.height / 2;
    await page.touchscreen.tap(x, y); await expect(card).not.toHaveClass(/is-collapsed/);
    await page.touchscreen.tap(x, y); await expect(card.getByRole("textbox", { name: "Sticky Markdown" })).toBeFocused();
    await card.getByRole("textbox", { name: "Sticky Markdown" }).press("Escape");
    await card.getByRole("button", { name: "Fold", exact: true }).tap();
    await icon.evaluate((el) => {
      const r = el.getBoundingClientRect(), t = { target: el, identifier: 20, clientX: r.x + 10, clientY: r.y + 10 };
      const e = new Event("touchstart", { bubbles: true, cancelable: true });
      Object.defineProperties(e, { touches: { value: [t] }, changedTouches: { value: [t] } }); el.dispatchEvent(e);
    });
    await expect(page.locator(".menu").getByRole("button", { name: "Copy link to sticky note", exact: true })).toBeVisible();
    await icon.evaluate((el) => {
      const e = new Event("touchend", { bubbles: true, cancelable: true });
      Object.defineProperties(e, { touches: { value: [] }, changedTouches: { value: [{ identifier: 20 }] } }); el.dispatchEvent(e);
    });
    await expect(card).toHaveClass(/is-collapsed/);
  });
  for (const locked of [false, true]) test(`${mode}: keyboard viewport preserves inline title, page scale and zoom lock (${locked})`, async ({ page }) => {
    await ready(page, mode);
    const card = page.locator(".ink-sticky-note");
    await page.evaluate((locked) => { (window as any).__inkNotesPreview.view.zoomLocked = locked; }, locked);
    const before = await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view;
      return { width: v.inputRect().width, height: v.inputRect().height, zoom: v.zoom, fit: v.fitZoom };
    });
    await card.locator(".ink-sticky-title").dblclick();
    const title = card.getByRole("textbox", { name: "Sticky title" });
    await title.fill("A title with the keyboard open");
    expect(await title.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
    // Simulate the host pane resize caused by an on-screen keyboard.
    await page.setViewportSize({ width: 820, height: 240 });
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.inputScroller().clientHeight)).toBeLessThan(220);
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.inputRect().width)).toBeCloseTo(before.width, 1);
    await expect(title).toBeFocused(); await expect(title).toHaveValue("A title with the keyboard open");
    await expect.poll(() => title.evaluate((el) => {
      const v = (window as any).__inkNotesPreview.view, field = el.getBoundingClientRect(), viewport = v.inputScroller().getBoundingClientRect();
      return field.top >= viewport.top - 1 && field.bottom <= viewport.bottom + 1;
    })).toBe(true);
    const after = await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view;
      return { height: v.inputRect().height, zoom: v.zoom, fit: v.fitZoom };
    });
    expect(after.height).toBeCloseTo(before.height, 1); expect(after.zoom).toBeCloseTo(before.zoom, 5); expect(after.fit).toBe(before.fit);
    await title.press("Enter"); await page.setViewportSize({ width: 820, height: 1000 });
    await expect(card.locator(".ink-sticky-title")).toHaveText("A title with the keyboard open");
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.inputRect().width)).toBeCloseTo(before.width, 1);
    await page.screenshot({ path: `test-results/sticky-title-${mode}-${locked}.png` });
  });

  test(`${mode}: folded label reaches all four edges and unfolds inward without changing content`, async ({ page }) => {
    await ready(page, mode);
    if (mode === "ink") await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view; v.zoom = .5; v.onRenderResize();
    });
    const board = (await page.getByLabel("Sticky handwriting board").boundingBox())!;
    await page.mouse.move(board.x + 30, board.y + 25); await page.mouse.down();
    await page.mouse.move(board.x + 70, board.y + 40, { steps: 10 }); await page.mouse.up();
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0];
      v.changeSticky(n, { ...n, text: "Content kept at each edge" });
    });
    const original = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
    expect(original.strokes).toHaveLength(1);
    const card = page.locator(".ink-sticky-note");
    for (const corner of ["bottom-right", "top-right", "bottom-left", "top-left"]) {
      await card.getByRole("button", { name: "Fold", exact: true }).click();
      const r = (await card.getByRole("button", { name: "Expand", exact: true }).boundingBox())!;
      const host = await page.evaluate(() => {
        const r = (window as any).__inkNotesPreview.view.inputRect(); return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      await page.mouse.move(r.x + 10, r.y + r.height / 2); await page.mouse.down();
      await page.mouse.move(host.x + (corner.endsWith("right") ? host.width - 1 : 1),
        host.y + (corner.startsWith("bottom") ? host.height - 1 : 1), { steps: 10 });
      await page.mouse.up();
      const folded = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
      const frame = (await card.boundingBox())!;
      if (corner.endsWith("right")) { expect(folded.x).toBeGreaterThan(1 - folded.width); expect(frame.x + frame.width).toBeCloseTo(host.x + host.width, 0); }
      else expect(folded.x).toBe(0);
      if (corner.startsWith("bottom")) { expect(folded.y).toBeGreaterThan(1 - folded.height); expect(frame.y + frame.height).toBeCloseTo(host.y + host.height, 0); }
      else expect(folded.y).toBe(0);
      await card.getByRole("button", { name: "Expand", exact: true }).click();
      const expanded = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]);
      expect(expanded.collapsed).toBe(false); expect(expanded.x).toBe(folded.x); expect(expanded.y).toBe(folded.y);
      const visible = (await card.boundingBox())!;
      expect(visible.x + visible.width).toBeLessThanOrEqual(host.x + host.width + 1);
      expect(visible.y + visible.height).toBeLessThanOrEqual(host.y + host.height + 1);
      await card.getByRole("button", { name: "Fold", exact: true }).click();
      expect(await page.evaluate(() => { const n = (window as any).__inkNotesPreview.view.currentPage().stickyNotes[0]; return { x: n.x, y: n.y }; })).toEqual({ x: folded.x, y: folded.y });
      await card.getByRole("button", { name: "Expand", exact: true }).click(); expect(expanded.width).toBe(original.width); expect(expanded.height).toBe(original.height);
      expect(expanded.strokes).toEqual(original.strokes); expect(expanded.text).toBe(original.text);
    }
  });

  test(`${mode}: fitted header leaves vertical breathing room around icons and the title field`, async ({ page }) => {
    await ready(page, mode);
    if (mode === "pdf") await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, n = v.currentPage().stickyNotes[0];
      v.changeSticky(n, { ...n, boardPageWidth: v.pageBaseWidth });
    });
    const card = page.locator(".ink-sticky-note"), header = (await card.locator(".ink-sticky-header").boundingBox())!;
    const icon = (await card.getByRole("button", { name: "Sticky note options" }).locator("svg").boundingBox())!;
    expect(icon.y - header.y).toBeGreaterThanOrEqual(6); expect(header.y + header.height - icon.y - icon.height).toBeGreaterThanOrEqual(6);
    await card.locator(".ink-sticky-title").dblclick();
    const field = (await card.getByRole("textbox", { name: "Sticky title" }).boundingBox())!;
    expect(field.y - header.y).toBeGreaterThanOrEqual(5); expect(header.y + header.height - field.y - field.height).toBeGreaterThanOrEqual(5);
  });
}
