import { expect, test } from "@playwright/test";

test("Chrome zoom keeps grid, page text, sticky text and ink present during a burst", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 1000 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
  await expect.poll(() => page.locator(".ink-tile-layer canvas").count()).toBeGreaterThan(0);

  await page.locator(".ink-toolbar-section-draw").getByRole("button", { name: "Add text box", exact: true }).click();
  const pageInput = page.getByRole("textbox", { name: "Text box Markdown", exact: true });
  await pageInput.fill("Page text stays visible");
  await pageInput.press("Control+Enter");

  await page.evaluate(() => {
    const view = (window as any).__inkNotesPreview.view;
    view.addSticky();
    const note = view.currentPage().stickyNotes.find((item: any) => item.kind !== "text");
    view.changeSticky(note, { ...note, x: 0.55, y: 0.55, width: 0.35, height: 0.3 });
    document.querySelector<HTMLElement>(".ink-page")!.className = "ink-page ink-paper-grid";
  });
  const sticky = page.locator(".ink-sticky-note:not(.ink-page-text)");
  await sticky.getByRole("button", { name: "Add text box", exact: true }).click();
  const stickyInput = page.getByRole("textbox", { name: "Sticky Markdown", exact: true });
  await stickyInput.fill("Sticky text stays visible");
  await stickyInput.press("Control+Enter");

  const samples = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    const paper = document.querySelector<HTMLElement>(".ink-page")!;
    const gridSize = getComputedStyle(paper).backgroundSize;
    const scale = paper.style.getPropertyValue("--ink-page-scale");
    const sample: { transform: string; gridSize: string; scale: string; pageText: boolean; stickyText: boolean; inkTiles: number }[] = [];
    for (let index = 0; index < 8; index += 1) {
      const rect = scroller.getBoundingClientRect();
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true,
        deltaY: -8, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const pageText = document.querySelector<HTMLElement>(".ink-page-text .ink-sticky-text-box");
      const stickyText = document.querySelector<HTMLElement>(".ink-sticky-note:not(.ink-page-text) .ink-sticky-text-box");
      const hasLayout = (element: HTMLElement | null) => !!element?.isConnected && element.getBoundingClientRect().height > 0;
      sample.push({ transform: paper.style.transform, gridSize: getComputedStyle(paper).backgroundSize,
        scale: paper.style.getPropertyValue("--ink-page-scale"), pageText: hasLayout(pageText),
        stickyText: hasLayout(stickyText), inkTiles: document.querySelectorAll(".ink-tile-layer canvas").length });
    }
    return { gridSize, scale, sample };
  });

  expect(samples.sample).toHaveLength(8);
  for (const frame of samples.sample) {
    expect(frame.transform).not.toBe("none");
    expect(frame.gridSize).toBe(samples.gridSize);
    expect(frame.scale).toBe(samples.scale);
    expect(frame.pageText).toBe(true);
    expect(frame.stickyText).toBe(true);
    expect(frame.inkTiles).toBeGreaterThan(0);
  }
  await expect(page.locator(".ink-page")).toHaveCSS("transform", "none");
  await expect(page.locator(".ink-page-text .ink-sticky-text-box")).toContainText("Page text stays visible");
  await expect(sticky.locator(".ink-sticky-text-box")).toContainText("Sticky text stays visible");
});
