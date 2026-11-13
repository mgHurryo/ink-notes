import { expect, test, type Page } from "@playwright/test";

type PreviewScope = {
  __inkNotesPreview: {
    view: { duplicateCurrentPage(): void; addBlankPage(index: number): void };
    openPdf(): Promise<void>;
  };
};

async function prepareLongNotebookRail(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(() => {
    const view = (window as unknown as PreviewScope).__inkNotesPreview.view;
    for (let index = 1; index < 24; index++) view.duplicateCurrentPage();
  });
}

async function expectRailControlsToStayFixed(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  const rail = page.locator(".ink-page-rail");
  const list = rail.locator(".ink-rail-thumbs");
  await expect(list.locator(".ink-page-thumb")).toHaveCount(24);
  const before = await rail.evaluate((element) => {
    const top = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect().top;
    return {
      header: top(".ink-rail-header"),
      filters: top(".ink-rail-filters"),
      actions: top(".ink-rail-actions"),
    };
  });
  const extent = await list.evaluate((element: HTMLElement) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(extent.scrollHeight).toBeGreaterThan(extent.clientHeight);

  await list.evaluate((element: HTMLElement) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(() => list.evaluate((element: HTMLElement) => element.scrollTop)).toBeGreaterThan(0);
  const after = await rail.evaluate((element) => {
    const top = (selector: string) => element.querySelector<HTMLElement>(selector)!.getBoundingClientRect().top;
    return {
      railScrollTop: element.scrollTop,
      header: top(".ink-rail-header"),
      filters: top(".ink-rail-filters"),
      actions: top(".ink-rail-actions"),
    };
  });
  expect(after.railScrollTop).toBe(0);
  expect(after.header).toBe(before.header);
  expect(after.filters).toBe(before.filters);
  expect(after.actions).toBe(before.actions);
}

test("notebook rail keeps page filters and actions fixed while thumbnails scroll", async ({ page }) => {
  await prepareLongNotebookRail(page);
  await expectRailControlsToStayFixed(page);
});

test("PDF rail keeps page filters and actions fixed while thumbnails scroll", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = (window as unknown as PreviewScope).__inkNotesPreview;
    await scope.openPdf();
    for (let index = 1; index < 24; index++) scope.view.addBlankPage(index);
  });
  await expectRailControlsToStayFixed(page);
});
