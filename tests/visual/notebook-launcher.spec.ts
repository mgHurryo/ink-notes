import { expect, test } from "@playwright/test";

for (const width of [360, 1280]) {
  test(`notebook picker creates repeatedly, searches and renames at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/?notebooks");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const search = page.getByRole("textbox", { name: "Search Ink notebooks", exact: true });
    await search.fill("no matching book");
    await expect(page.locator(".ink-notebook-result")).toHaveCount(0);
    const create = page.getByRole("button", { name: "Create Ink notebook", exact: true });
    await expect(create).toBeVisible();
    const box = await create.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: `test-results/notebook-picker-empty-${width}.png` });
    await create.click();
    const name = page.getByRole("textbox", { name: "Notebook name", exact: true });
    await expect(name).toBeFocused();
    await name.fill("New Class Notes");
    await page.screenshot({ path: `test-results/notebook-name-${width}.png` });
    await name.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator("html")).toHaveAttribute("data-opened-notebook", "Ink Notes/New Class Notes.ink");
    await page.evaluate(() => (window as unknown as { openNotebookPicker(): void }).openNotebookPicker());
    await search.fill("New Class");
    await expect(page.locator(".ink-notebook-result")).toHaveCount(1);
    await page.getByRole("button", { name: "Rename New Class Notes", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(name).toHaveValue("New Class Notes");
    await name.fill("Renamed Notes");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => (window as unknown as { openNotebookPicker(): void }).openNotebookPicker());
    await search.fill("Renamed");
    await expect(page.locator(".ink-notebook-result-path")).toHaveText("Ink Notes/Renamed Notes.ink");
    await page.screenshot({ path: `test-results/notebook-picker-result-${width}.png` });
    await create.click();
    await name.fill("Second Book");
    await name.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-opened-notebook", "Ink Notes/Second Book.ink");
  });
}

test("an empty vault offers creation without writing on open or cancellation", async ({ page }) => {
  await page.goto("/?notebooks&empty");
  await expect(page.locator(".ink-notebook-result")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Create Ink notebook", exact: true })).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-opened-notebook");
  await page.getByRole("button", { name: "Create Ink notebook", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-opened-notebook");
});
