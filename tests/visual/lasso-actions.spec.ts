import { expect, test } from "@playwright/test";

for (const { width, split } of [{ width: 360, split: false }, { width: 1280, split: false }, { width: 1280, split: true }]) {
  test(`lasso actions fit the viewport and paste with undo at ${width}px${split ? " split pane" : ""}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    if (split) {
      await page.locator(".ink-notes-view").evaluate((root: HTMLElement) => {
        root.style.marginLeft = "620px";
        root.style.width = "360px";
      });
      await expect.poll(async () => (await page.locator(".ink-notes-view").boundingBox())!.width).toBe(360);
    }
    await page.evaluate(() => {
      const view = (window as any).__inkNotesPreview.view;
      const ink = view.notebook.pages[0].strokes[0];
      ink.points = [{ x: 0.2, y: 0.15, pressure: 0.5, t: 1 }, { x: 0.4, y: 0.2, pressure: 0.8, t: 2 }];
      view.queueStrokePatch(view.currentPage(), [ink], []);
      view.renderAll();
    });
    await page.getByRole("button", { name: "Select", exact: true }).click();
    const rect = await page.locator(".ink-page").boundingBox();
    expect(rect).not.toBeNull();
    await page.mouse.move(rect!.x + rect!.width * 0.1, rect!.y + rect!.height * 0.1);
    await page.mouse.down();
    for (const [x, y] of [[0.5, 0.1], [0.5, 0.25], [0.1, 0.25], [0.1, 0.1]]) {
      await page.mouse.move(rect!.x + rect!.width * x, rect!.y + rect!.height * y, { steps: 3 });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
    await page.mouse.up();
    const actions = page.getByRole("group", { name: "Selection actions" });
    await expect(actions).toBeVisible();
    await actions.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    const bounds = await actions.boundingBox();
    const viewport = await page.locator(".ink-page-scroller").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(viewport!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport!.x + viewport!.width);
    expect(bounds!.y).toBeGreaterThanOrEqual(viewport!.y);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport!.y + viewport!.height);
    for (const name of ["Copy", "Cut", "Delete", "Paste"]) {
      const button = await actions.getByRole("button", { name, exact: true }).boundingBox();
      expect(button!.width).toBeGreaterThanOrEqual(44);
      expect(button!.height).toBeGreaterThanOrEqual(44);
      expect(await actions.getByRole("button", { name, exact: true }).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: `test-results/lasso-actions-${width}${split ? "-split" : ""}.png` });
    await actions.getByRole("button", { name: "Copy", exact: true }).click();
    await actions.getByRole("button", { name: "Paste", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(2);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(1);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Lasso settings" })).toBeVisible();
    await page.getByRole("checkbox", { name: "Copy and paste across files" }).check();
    await page.getByRole("dialog", { name: "Lasso settings" }).evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
    const settingsBounds = await page.getByRole("dialog", { name: "Lasso settings" }).boundingBox();
    const rootBounds = await page.locator(".ink-notes-view").boundingBox();
    expect(settingsBounds!.x).toBeGreaterThanOrEqual(rootBounds!.x);
    expect(settingsBounds!.x + settingsBounds!.width).toBeLessThanOrEqual(rootBounds!.x + rootBounds!.width);
    await page.screenshot({ path: `test-results/lasso-settings-${width}${split ? "-split" : ""}.png` });
  });
}

for (const width of [360, 1280]) {
  test(`rectangle lasso previews a box and keeps selection actions at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    await page.evaluate(() => {
      const view = (window as any).__inkNotesPreview.view;
      const ink = view.currentPage().strokes[0];
      ink.points = [{ x: 0.2, y: 0.15, pressure: 0.5, t: 1 }, { x: 0.4, y: 0.2, pressure: 0.8, t: 2 }];
      view.queueStrokePatch(view.currentPage(), [ink], []);
      view.renderAll();
    });
    const select = page.getByRole("button", { name: "Select", exact: true });
    await select.click(); await select.click();
    await page.getByRole("radio", { name: "Rectangle selection" }).click();
    await expect(page.getByRole("radio", { name: "Rectangle selection" })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Freehand selection" })).not.toBeChecked();
    await page.getByRole("dialog", { name: "Lasso settings" }).evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.screenshot({ path: `test-results/rectangle-lasso-mode-${width}.png` });
    await select.click();
    await expect(page.getByRole("dialog", { name: "Lasso settings" })).toHaveCount(0);
    const rect = (await page.locator(".ink-page").boundingBox())!;
    await page.mouse.move(rect.x + rect.width * 0.5, rect.y + rect.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width * 0.1, rect.y + rect.height * 0.1, { steps: 5 });
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.lassoPath.length)).toBe(2);
    await page.screenshot({ path: `test-results/rectangle-lasso-drag-${width}.png` });
    await page.mouse.up();
    const actions = page.getByRole("group", { name: "Selection actions" });
    await expect(actions.getByRole("button", { name: "Copy", exact: true })).toBeVisible();
    await actions.getByRole("button", { name: "Copy", exact: true }).click();
    await actions.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(1);
    await select.click();
    await expect(page.getByRole("radio", { name: "Rectangle selection" })).toBeChecked();
    await page.getByRole("radio", { name: "Freehand selection" }).click();
    await expect(page.getByRole("radio", { name: "Freehand selection" })).toBeChecked();
  });
}
