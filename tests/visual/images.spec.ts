import { expect, test } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");

for (const width of [360, 1280]) {
  test(`image library batch move, filtered deletion, cancellation and undo at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 900 }); await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    await page.getByRole("button", { name: "Image library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Image library", exact: true });
    const move = library.getByRole("combobox", { name: "Move selected images to group", exact: true });
    await expect(library.getByRole("button", { name: "Delete selected (0)", exact: true })).toBeDisabled();
    await expect(move).toBeDisabled();
    await library.locator('input[type="file"]').setInputFiles(["One", "Two", "Three"].map((name) => ({ name: `${name}.png`, mimeType: "image/png", buffer: png })));
    await expect(library.locator(".ink-image-library-card")).toHaveCount(3);
    await library.locator('.ink-image-library-card input[type="checkbox"]').first().check();
    await library.getByRole("button", { name: "Insert selected (1)", exact: true }).click();
    const placed = page.locator(".ink-placed-image"); await expect(placed).toHaveCount(1);
    const original = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().images[0]);
    const originalBytes = await page.evaluate(async (path) => Array.from(new Uint8Array(await (window as any).__inkNotesPreview.view.imageLibrary.bytes(path))), original.assetPath);
    await page.getByRole("button", { name: "Image library", exact: true }).click();
    await library.getByRole("button", { name: "New group", exact: true }).click();
    const group = page.getByRole("dialog", { name: "New group", exact: true });
    await group.getByRole("textbox", { name: "Group name" }).fill("Keep");
    await group.getByRole("button", { name: "Save", exact: true }).click();
    await expect(group).toHaveCount(0);
    await library.getByRole("button", { name: "Select visible", exact: true }).click();
    await move.selectOption({ label: "Keep" });
    await expect.poll(() => page.evaluate(async () => {
      const data = await (window as any).__inkNotesPreview.view.imageLibrary.read();
      return data.assets.every((asset: any) => asset.groupId === data.groups[0].id);
    })).toBe(true);
    await library.getByRole("button", { name: "Clear selection", exact: true }).click();
    await expect(move).toBeDisabled();
    await library.locator('.ink-image-library-card input[type="checkbox"]').nth(0).check();
    await library.locator('.ink-image-library-card input[type="checkbox"]').nth(1).check();
    const search = library.getByRole("searchbox", { name: "Search images", exact: true });
    await search.fill("Three"); await search.press("Tab");
    await expect(library.locator(".ink-image-library-card")).toHaveCount(1);
    await expect(library.getByRole("status")).toHaveText("2 selected (2 hidden by filter)");
    await library.getByRole("button", { name: "Delete selected (2)", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "Delete library images", exact: true });
    await expect(confirmation.getByRole("list")).toHaveText("One.pngTwo.png");
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.screenshot({ path: `test-results/image-library-delete-${width}.png` });
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await page.evaluate(async () => (await (window as any).__inkNotesPreview.view.imageLibrary.read()).assets.length)).toBe(3);
    await library.getByRole("button", { name: "Delete selected (2)", exact: true }).click();
    await confirmation.getByRole("button", { name: "Delete 2 images", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(library.getByRole("button", { name: "Delete selected (0)", exact: true })).toBeDisabled();
    await library.getByRole("button", { name: "Undo last deletion (2)", exact: true }).click();
    await expect(library.getByRole("button", { name: /Undo last deletion/ })).toHaveCount(0);
    await search.fill(""); await search.press("Tab");
    await expect(library.locator(".ink-image-library-card")).toHaveCount(3);
    await library.getByRole("button", { name: "Select visible", exact: true }).click();
    await library.getByRole("button", { name: "Delete selected (3)", exact: true }).click();
    await confirmation.getByRole("button", { name: "Delete 3 images", exact: true }).click();
    await expect(library.locator(".ink-image-library-card")).toHaveCount(0);
    await library.press("Escape"); await expect(library).toHaveCount(0);
    await expect(placed).toBeVisible();
    expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().images[0])).toEqual(original);
    expect(await page.evaluate(async (path) => Array.from(new Uint8Array(await (window as any).__inkNotesPreview.view.imageLibrary.bytes(path))), original.assetPath)).toEqual(originalBytes);
    await page.getByRole("button", { name: "Image library", exact: true }).click();
    await expect(library.locator(".ink-image-library-card")).toHaveCount(0);
    await expect(library.getByRole("button", { name: /Undo last deletion/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("failed library deletion and undo keep the selection and recoverable batch for retry", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.getByRole("button", { name: "Image library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Image library", exact: true });
  await library.locator('input[type="file"]').setInputFiles(["One", "Two"].map((name) => ({ name: `${name}.png`, mimeType: "image/png", buffer: png })));
  await expect(library.locator(".ink-image-library-card")).toHaveCount(2);
  await library.getByRole("button", { name: "Select visible", exact: true }).click();
  const failNextWrite = () => page.evaluate(() => {
    const vault = (window as any).__inkNotesPreview.view.imageLibrary.app.vault, process = vault.process;
    vault.process = async () => { vault.process = process; throw new Error("Simulated disk full"); };
  });
  await library.getByRole("button", { name: "Delete selected (2)", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Delete library images", exact: true });
  await failNextWrite(); await confirmation.getByRole("button", { name: "Delete 2 images", exact: true }).click();
  await expect(confirmation.getByRole("button", { name: "Delete 2 images", exact: true })).toBeEnabled();
  await expect(library.locator(".ink-image-library-card")).toHaveCount(2);
  await expect(library.getByRole("status")).toHaveText("2 selected");
  await confirmation.getByRole("button", { name: "Delete 2 images", exact: true }).click();
  await expect(confirmation).toHaveCount(0); await expect(library.locator(".ink-image-library-card")).toHaveCount(0);
  const undo = library.getByRole("button", { name: "Undo last deletion (2)", exact: true });
  await failNextWrite(); await undo.click();
  await expect(undo).toBeEnabled(); await expect(library.locator(".ink-image-library-card")).toHaveCount(0);
  await undo.click(); await expect(library.locator(".ink-image-library-card")).toHaveCount(2);
  await expect(undo).toHaveCount(0);
  // A peer removes a selected entry; the next render must not retain a phantom selection.
  await library.getByRole("button", { name: "Select visible", exact: true }).click();
  await page.evaluate(async () => {
    const store = (window as any).__inkNotesPreview.view.imageLibrary;
    await store.remove([(await store.read()).assets[0].id]);
  });
  const search = library.getByRole("searchbox", { name: "Search images", exact: true });
  await search.fill(".png"); await search.press("Tab");
  await expect(library.locator(".ink-image-library-card")).toHaveCount(1);
  await expect(library.getByRole("status")).toHaveText("1 selected");
  await expect(library.getByRole("button", { name: "Delete selected (1)", exact: true })).toBeEnabled();
});

for (const width of [360, 1280]) {
  test(`image library batch import, grouping, editing and history at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    await page.setViewportSize({ width, height: 900 }); await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    await page.getByRole("button", { name: "Image library", exact: true }).click();
    const library = page.getByRole("dialog", { name: "Image library", exact: true }); await expect(library).toBeVisible();
    await library.getByRole("button", { name: "New group", exact: true }).click();
    const group = page.getByRole("dialog", { name: "New group", exact: true });
    await group.getByRole("textbox", { name: "Group name" }).fill("Course diagrams"); await group.getByRole("button", { name: "Save", exact: true }).click();
    await expect(group).toHaveCount(0);
    await library.getByRole("combobox", { name: "Image group", exact: true }).selectOption({ label: "Course diagrams" });
    await library.locator('input[type="file"]').setInputFiles([{ name: "One.png", mimeType: "image/png", buffer: png }, { name: "Two.png", mimeType: "image/png", buffer: png }]);
    await expect(library.locator(".ink-image-library-card")).toHaveCount(2);
    await library.getByRole("button", { name: "Select visible", exact: true }).click();
    await library.getByRole("button", { name: "Insert selected (2)", exact: true }).click();
    await expect(page.locator(".ink-placed-image")).toHaveCount(2);
    await expect(page.getByRole("group", { name: "Image controls" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pointer", exact: true })).toHaveAttribute("aria-pressed", "true");
    const imageState = () => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().images);
    expect((await imageState()).every((i: any) => !i.foreground)).toBe(true);
    const inspector = page.getByRole("group", { name: "Image controls" });
    await inspector.getByRole("spinbutton", { name: "Image X percent" }).fill("10"); await inspector.getByRole("spinbutton", { name: "Image X percent" }).press("Tab");
    expect((await imageState())[1].x).toBe(.1);
    await inspector.getByRole("spinbutton", { name: "Image width percent" }).fill("25"); await inspector.getByRole("spinbutton", { name: "Image width percent" }).press("Tab");
    expect((await imageState())[1].width).toBe(.25);
    await inspector.getByRole("button", { name: "Above handwriting", exact: true }).click();
    expect((await imageState())[1].foreground).toBe(true);
    await inspector.getByRole("button", { name: "Done", exact: true }).click();
    const placed = page.locator(".ink-placed-image").last(); await placed.scrollIntoViewIfNeeded();
    const box = (await placed.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 25, box.y + box.height / 2 + 12, { steps: 5 }); await page.mouse.up();
    expect((await imageState())[1].x).toBeGreaterThan(.1);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    expect((await imageState())[1].x).toBe(.1);
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    expect((await imageState())[1].x).toBeGreaterThan(.1);
    await placed.click(); await inspector.getByRole("button", { name: "Delete image", exact: true }).click();
    await expect(page.locator(".ink-placed-image")).toHaveCount(1);
    await page.getByRole("button", { name: "Undo", exact: true }).click(); await expect(page.locator(".ink-placed-image")).toHaveCount(2);
    await page.getByRole("button", { name: "Redo", exact: true }).click(); await expect(page.locator(".ink-placed-image")).toHaveCount(1);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await placed.click();
    const handle = inspector.page().getByRole("button", { name: "Resize image", exact: true });
    const resizeBox = (await handle.boundingBox())!, beforeResize = (await imageState())[1];
    await page.mouse.move(resizeBox.x + 20, resizeBox.y + 20); await page.mouse.down();
    await page.mouse.move(resizeBox.x + 40, resizeBox.y + 40, { steps: 4 }); await page.mouse.up();
    const afterResize = (await imageState())[1];
    expect(afterResize.width).toBeGreaterThan(beforeResize.width);
    expect(afterResize.width / afterResize.height).toBeCloseTo(beforeResize.width / beforeResize.height);
    await page.screenshot({ path: `test-results/image-controls-${width}.png` });
    await page.getByRole("button", { name: "Pen", exact: true }).click();
    await expect(page.locator(".ink-image-inspector")).toBeHidden();
    expect(await placed.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
    await page.screenshot({ path: `test-results/images-${width}.png` });
    expect(errors).toEqual([]);
  });
}

test("vault and manual batch imports keep managed copies; touch edits cancel for pinch and page changes", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1100 }); await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async (bytes) => {
    const vault = (window as any).__inkNotesPreview.view.imageLibrary.app.vault;
    await vault.createBinary("A.png", new Uint8Array(bytes).buffer); await vault.createBinary("B.png", new Uint8Array(bytes).buffer);
  }, Array.from(png));
  await page.getByRole("button", { name: "Image library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Image library", exact: true });
  await library.getByRole("button", { name: "From vault", exact: true }).click();
  const vault = page.getByRole("dialog", { name: "Import images from vault", exact: true });
  await vault.getByRole("button", { name: "Select all", exact: true }).click(); await vault.getByRole("button", { name: "Import selected", exact: true }).click();
  await expect(library.locator(".ink-image-library-card")).toHaveCount(2);
  await library.getByRole("button", { name: "Enter vault paths", exact: true }).click();
  const manual = page.getByRole("dialog", { name: "Import vault paths", exact: true });
  await manual.getByRole("textbox", { name: "Image paths", exact: true }).fill("A.png\nB.png"); await manual.getByRole("button", { name: "Import all", exact: true }).click();
  await expect(library.locator(".ink-image-library-card")).toHaveCount(4);
  await library.getByRole("button", { name: "Select visible", exact: true }).click(); await library.getByRole("button", { name: "Insert selected (4)", exact: true }).click();
  await expect(page.locator(".ink-placed-image")).toHaveCount(4);
  const state = () => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().images);
  const before = (await state())[3];
  await page.locator(".ink-placed-image").last().evaluate((el) => {
    const r = el.getBoundingClientRect(), host = el.closest(".ink-page")!;
    const touch = (identifier: number, x: number, y: number) => new Touch({ identifier, target: host, clientX: x, clientY: y });
    const t = touch(1, r.x + 10, r.y + 10), end = touch(1, r.x + 40, r.y + 20);
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] }));
    document.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [end], changedTouches: [end] }));
    document.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [end] }));
  });
  expect((await state())[3].x).toBeGreaterThan(before.x);
  const beforePinch = (await state())[3];
  await page.locator(".ink-placed-image").last().evaluate((el) => {
    const r = el.getBoundingClientRect(), host = el.closest(".ink-page")!;
    const touch = (identifier: number, x: number, y: number) => new Touch({ identifier, target: host, clientX: x, clientY: y });
    const t = touch(1, r.x + 10, r.y + 10), moved = touch(1, r.x + 50, r.y + 20), second = touch(2, r.x + 80, r.y + 60);
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] }));
    document.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [moved], changedTouches: [moved] }));
    host.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [moved, second], changedTouches: [second] }));
    host.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [moved, second] }));
  });
  expect((await state())[3]).toEqual(beforePinch);
  await page.evaluate(() => {
    const view = (window as any).__inkNotesPreview.view; view.addPage();
  });
  await expect(page.locator(".ink-placed-image")).toHaveCount(0);
  await expect(page.locator(".ink-image-inspector")).toBeHidden();
  await page.evaluate(() => { const view = (window as any).__inkNotesPreview.view; view.navigateToPage(view.notebook.pages[0].id); });
  await expect(page.locator(".ink-placed-image")).toHaveCount(4);
});

test("image editing dismisses outside and excludes pen and native stylus input in drawing tools", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1100 }); await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.getByRole("button", { name: "Image library", exact: true }).click();
  const library = page.getByRole("dialog", { name: "Image library", exact: true });
  await library.locator('input[type="file"]').setInputFiles({ name: "One.png", mimeType: "image/png", buffer: png });
  await expect(library.locator(".ink-image-library-card")).toHaveCount(1);
  await library.getByRole("button", { name: "Select visible", exact: true }).click();
  await library.getByRole("button", { name: "Insert selected (1)", exact: true }).click();
  const inspector = page.getByRole("group", { name: "Image controls" }), placed = page.locator(".ink-placed-image");
  await expect(inspector).toBeVisible();
  const original = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().images[0]);
  const rect = (await page.locator(".ink-page:not(.ink-swipe-stage)").boundingBox())!;
  await page.mouse.click(rect.x + 12, rect.y + 12); await expect(inspector).toBeHidden();
  await page.locator('.ink-image-inspector input[aria-label="Image X percent"]').evaluate((el: HTMLInputElement) => {
    el.value = "70"; el.dispatchEvent(new Event("change"));
  });
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().images[0])).toEqual(original);
  const count = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length);
  await placed.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "pen", pointerId: 77, clientX: r.x + 12, clientY: r.y + 12, pressure: .5 }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "pen", pointerId: 77, clientX: r.x + 12, clientY: r.y + 12 }));
    const touch = new Touch({ target: el, identifier: 78, clientX: r.x + 12, clientY: r.y + 12 });
    Object.defineProperty(touch, "touchType", { value: "stylus" });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch] }));
  });
  await expect(inspector).toBeHidden();
  expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(count);
  for (const tool of ["Pen", "Highlight", "Erase", "Select"]) {
    await page.getByRole("button", { name: tool, exact: true }).click();
    await placed.evaluate((el) => {
      const r = el.getBoundingClientRect(), host = el.closest(".ink-page") as HTMLElement;
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "pen", pointerId: 90, clientX: r.x + 12, clientY: r.y + 12, pressure: .5 }));
      host.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "pen", pointerId: 90, clientX: r.x + 12, clientY: r.y + 12 }));
      const touch = new Touch({ target: el, identifier: 91, clientX: r.x + 16, clientY: r.y + 16 });
      Object.defineProperty(touch, "touchType", { value: "stylus" });
      el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));
      el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch] }));
    });
    await expect(inspector).toBeHidden();
    expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().images[0])).toEqual(original);
  }
  await page.getByRole("button", { name: "Pointer", exact: true }).click();
  await placed.evaluate((el) => {
    const r = el.getBoundingClientRect(); const t = new Touch({ target: el, identifier: 1, clientX: r.x + 12, clientY: r.y + 12 });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [t], changedTouches: [t] }));
    document.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [t] }));
  });
  await expect(inspector).toBeVisible();
  await page.locator(".ink-page-scroller").evaluate((el) => {
    const touch = new Touch({ target: el, identifier: 2, clientX: 1, clientY: 1 });
    el.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, cancelable: true, touches: [touch], changedTouches: [touch] }));
    el.dispatchEvent(new TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [], changedTouches: [touch] }));
  });
  await expect(inspector).toBeHidden();
});
