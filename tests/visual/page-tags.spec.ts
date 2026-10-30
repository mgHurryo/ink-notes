import { expect, test, type Page } from "@playwright/test";

/** Drives the notebook editor's page rail: tag page 1 (flag + text tag). */
async function tagNotebookPage(page: Page, thumb: string, flag: string, tag: string): Promise<void> {
  await page.getByRole("button", { name: thumb, exact: true }).click();
  await expect(page.locator(".ink-tag-popover")).toBeVisible();
  await page.getByRole("button", { name: flag, exact: true }).click();
  await page.getByLabel("Add tag").fill(tag);
  await page.getByLabel("Add tag").press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.locator(".ink-tag-popover")).toHaveCount(0);
}

test("notebook pages: tag from the rail, badges, stacked filters and undo", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".ink-page-thumb")).toHaveCount(1);
  // A second page (blank, untagged) gives the filters something to hide.
  // Added BEFORE tagging so the tag session sits on top of the undo stack.
  await page.evaluate(() => (window as unknown as {
    __inkNotesPreview: { view: { addPage(index: number): void } };
  }).__inkNotesPreview.view.addPage(1));
  await expect(page.locator(".ink-page-thumb")).toHaveCount(2);

  await tagNotebookPage(page, "Tag page 1", "Red flag", "exam");
  await expect(page.locator(".ink-thumb-flag.is-red")).toBeVisible();
  await expect(page.locator(".ink-thumb-tags")).toHaveText("1");

  // "With ink" alone: the written page stays, the blank page leaves.
  await page.getByRole("button", { name: "Pages with ink only" }).click();
  await expect(page.locator(".ink-page-thumb:not(.is-filtered-out)")).toHaveCount(1);
  await expect(page.locator(".ink-rail-count")).toHaveText("1 of 2");
  // Stacked "tagged": still the same page (ink + tag).
  await page.getByRole("button", { name: "Tagged pages only" }).click();
  await expect(page.locator(".ink-page-thumb:not(.is-filtered-out)")).toHaveCount(1);
  await expect(page.locator(".ink-rail-count")).toHaveText("1 of 2");
  await page.screenshot({ path: "test-results/page-tags-notebook.png" });

  await page.getByRole("button", { name: "Pages with ink only" }).click();
  await page.getByRole("button", { name: "Tagged pages only" }).click();
  await expect(page.locator(".ink-page-thumb")).toHaveCount(2);
  // Undo walks the tag session back: badge disappears with the model change.
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".ink-thumb-tags")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".ink-thumb-flag")).toHaveCount(0);
});

test("pdf pages: tag through the sidecar view with badges and filters", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(() => (window as unknown as {
    __inkNotesPreview: { openPdf(): Promise<void> };
  }).__inkNotesPreview.openPdf());
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".ink-page-thumb")).toHaveCount(1);

  await tagNotebookPage(page, "Tag page 1", "Yellow flag", "review");
  await expect(page.locator(".ink-thumb-flag.is-yellow")).toBeVisible();
  await expect(page.locator(".ink-thumb-tags")).toHaveText("1");

  // A blank note page: untagged and ink-free, so both filters hide it.
  await page.evaluate(() => (window as unknown as {
    __inkNotesPreview: { view: { addBlankPage(index: number): void } };
  }).__inkNotesPreview.view.addBlankPage(1));
  await expect(page.locator(".ink-page-thumb")).toHaveCount(2);

  await page.getByRole("button", { name: "Tagged pages only" }).click();
  await expect(page.locator(".ink-page-thumb:not(.is-filtered-out)")).toHaveCount(1);
  await expect(page.locator(".ink-rail-count")).toHaveText("1 of 2");
  await page.getByRole("button", { name: "Pages with ink only" }).click();
  // The tagged source page has no ink either: stacked filters empty the rail
  // while the counter keeps explaining the result.
  await expect(page.locator(".ink-page-thumb:not(.is-filtered-out)")).toHaveCount(0);
  await expect(page.locator(".ink-rail-count")).toHaveText("0 of 2");
  await page.screenshot({ path: "test-results/page-tags-pdf.png" });
  await page.getByRole("button", { name: "Pages with ink only" }).click();
  await page.getByRole("button", { name: "Tagged pages only" }).click();
  await expect(page.locator(".ink-page-thumb")).toHaveCount(2);
});
