import { expect, test } from "@playwright/test";

interface PreviewScope extends Window {
  __inkNotesPreview: { view: {
    tiles: {
      active: { index: { hasCell(cell: string): boolean } };
      visible: Set<string>;
      jobs: unknown[];
      pendingTiles: Map<string, number>;
      host: HTMLElement;
    };
  } };
}

test("Chromium loads visible handwriting without waiting for pointer hover", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");

  const initial = await page.evaluate(() => {
    const view = (window as unknown as PreviewScope).__inkNotesPreview.view;
    const tiles = view.tiles;
    const occupied = [...tiles.visible].filter((cell) => tiles.active.index.hasCell(cell));
    return { visible: tiles.visible.size, occupied: occupied.length,
      outstanding: tiles.jobs.length + tiles.pendingTiles.size };
  });
  expect(initial.occupied).toBeGreaterThan(0);
  expect(initial.visible).toBeGreaterThan(initial.occupied);
  expect(initial.outstanding).toBeLessThanOrEqual(initial.occupied);

  await expect.poll(() => page.evaluate(() => {
    const tiles = (window as unknown as PreviewScope).__inkNotesPreview.view.tiles;
    return tiles.jobs.length === 0 && tiles.pendingTiles.size === 0
      && [...tiles.visible].filter((cell) => tiles.active.index.hasCell(cell))
        .every((cell) => tiles.host.querySelector(`[data-cell="${cell}"]`) !== null);
  }), { timeout: 5_000 }).toBe(true);
});
