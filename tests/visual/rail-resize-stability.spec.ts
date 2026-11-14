import { expect, test } from "@playwright/test";

for (const editor of ["notebook", "pdf"] as const) {
  test(`${editor}: dragging the rail keeps the mounted page stable until release`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    if (editor === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
    const paper = page.locator(editor === "pdf" ? ".ink-pdf-ink-host" : ".ink-page-scroller .ink-page");
    const box = (await paper.boundingBox())!;
    await page.mouse.move(box.x + box.width * .25, box.y + box.height * .35);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height * .4, { steps: 12 });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.pendingInkStrokes.length)).toBe(0);
    await page.getByRole("button", { name: "Pages", exact: true }).click();
    await page.waitForTimeout(400); // Existing rail reveal transition and settle.
    await page.evaluate(async () => {
      const view = (window as any).__inkNotesPreview.view;
      while (view.tiles.jobs.length || view.tiles.pendingTiles.size) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const original = view.layoutPage;
      (window as any).__railResizeProbe = { layouts: 0, logicalWidth: view.canvasLogicalWidth,
        nodes: Array.from(document.querySelectorAll(".ink-tile-layer > div")) };
      view.layoutPage = function (...args: any[]) {
        (window as any).__railResizeProbe.layouts++;
        return original.apply(this, args);
      };
    });
    const grip = (await page.locator(".ink-rail-resizer").boundingBox())!;
    const x = grip.x + grip.width - 3, y = grip.y + grip.height * .6;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 15; step++) {
      await page.mouse.move(x + step * 8, y);
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    }
    await page.screenshot({ path: testInfo.outputPath("rail-drag.png") });
    const during = await page.evaluate(() => {
      const view = (window as any).__inkNotesPreview.view, probe = (window as any).__railResizeProbe;
      return { layouts: probe.layouts, sameWidth: view.canvasLogicalWidth === probe.logicalWidth,
        retained: probe.nodes.length > 0 && probe.nodes.every((node: HTMLElement) => node.isConnected) };
    });
    expect(during.layouts).toBe(0);
    expect(during.sameWidth).toBe(true);
    expect(during.retained).toBe(true);
    await page.evaluate(() => {
      const probe = (window as any).__railResizeProbe;
      probe.overlappingFrames = 0;
      probe.sampling = true;
      const sample = () => {
        const layer = document.querySelector<HTMLElement>(".ink-tile-layer")!;
        if (layer.querySelector(".ink-tile-resize-ghost") && Array.from(layer.children)
          .some((node) => (node as HTMLElement).dataset.cell && getComputedStyle(node).visibility !== "hidden")) {
          probe.overlappingFrames++;
        }
        if (probe.sampling) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.mouse.up();
    await expect.poll(() => page.evaluate(() => {
      const view = (window as any).__inkNotesPreview.view, probe = (window as any).__railResizeProbe;
      return probe.layouts > 0 && view.canvasLogicalWidth !== probe.logicalWidth;
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => {
      const tiles = (window as any).__inkNotesPreview.view.tiles;
      return tiles.jobs.length === 0 && tiles.pendingTiles.size === 0 && !tiles.ghost;
    })).toBe(true);
    expect(await page.evaluate(() => {
      const probe = (window as any).__railResizeProbe;
      probe.sampling = false;
      return probe.overlappingFrames;
    })).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("rail-released.png") });
  });
}
