import { expect, test, type Page } from "@playwright/test";

/** Drives the notebook editor's page rail: tag page 1 (flag + text tag). */
async function tagNotebookPage(page: Page, thumb: string, flag: string, tag: string): Promise<void> {
  await page.getByRole("button", { name: thumb, exact: true }).click();
  const popover = page.locator(".ink-tag-popover");
  await expect(popover).toBeVisible();
  // The panel belongs beside the thumbnail rail and overlaps the tagged
  // thumbnail vertically, even when the editor is an offset workspace pane.
  const anchor = page.locator(".ink-page-thumb").first();
  const railBox = (await page.locator(".ink-page-rail").boundingBox())!;
  const anchorBox = (await anchor.boundingBox())!;
  const popBox = (await popover.boundingBox())!;
  expect(popBox.x).toBeGreaterThanOrEqual(railBox.x + railBox.width + 6);
  expect(Math.min(popBox.y + popBox.height, anchorBox.y + anchorBox.height)
    - Math.max(popBox.y, anchorBox.y)).toBeGreaterThan(0);
  await page.getByRole("button", { name: flag, exact: true }).click();
  await page.getByLabel("Add tag").fill(tag);
  await page.getByLabel("Add tag").press("Enter");
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
}

test("notebook pages: tag from the rail, badges, stacked filters and undo", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".ink-page-thumb")).toHaveCount(1);
  const firstThumb = page.locator(".ink-page-thumb").first();
  const pageNumber = await firstThumb.locator(".ink-page-thumb-number").boundingBox();
  const tagButton = await firstThumb.locator(".ink-thumb-tag-button").boundingBox();
  expect(pageNumber).not.toBeNull();
  expect(tagButton).not.toBeNull();
  expect(pageNumber!.x >= tagButton!.x + tagButton!.width || tagButton!.x >= pageNumber!.x + pageNumber!.width)
    .toBe(true);
  await page.getByRole("button", { name: "Manage pages", exact: true }).click();
  const selectedThumb = page.locator(".ink-page-thumb").first();
  await selectedThumb.click();
  await expect(selectedThumb).toHaveClass(/is-selected/);
  const marker = await selectedThumb.evaluate((element) => {
    const style = getComputedStyle(element, "::after");
    return { width: parseFloat(style.width), height: parseFloat(style.height), radius: style.borderRadius };
  });
  expect(marker.width).toBe(marker.height);
  expect(marker.radius).toBe("2px");
  await page.getByRole("button", { name: "Done managing pages", exact: true }).click();
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
  await expect(page.locator(".ink-page-thumb")).toHaveCount(1);
  await expect(page.locator(".ink-rail-count")).toHaveText("1 of 2");
  // Stacked "tagged": still the same page (ink + tag).
  await page.getByRole("button", { name: "Tagged pages only" }).click();
  await expect(page.locator(".ink-page-thumb")).toHaveCount(1);
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

for (const editor of ["notebook", "pdf"] as const) {
  for (const reading of [false, true]) {
    test(`${editor}: tag entry stays visible and panel follows the rail in ${reading ? "reading" : "editing"} mode`, async ({ page, browserName }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/");
      await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
      await page.evaluate(async (kind) => {
        const preview = (window as any).__inkNotesPreview;
        if (kind === "pdf") await preview.openPdf();
        const view = preview.view;
        if (kind === "pdf") view.addBlankPage(1);
        else view.addPage(1);
        // Model an Obsidian pane below its tab bar and beside another pane.
        Object.assign(document.querySelector<HTMLElement>("#host")!.style, {
          position: "absolute", left: "180px", top: "64px", width: "calc(100% - 220px)",
          height: "calc(100% - 96px)", transform: "translateZ(0)",
        });
      }, editor);
      await page.getByRole("button", { name: "Pages", exact: true }).click();
      if (reading) await page.getByRole("button", { name: "Reading mode", exact: true }).click();
      const rail = page.locator(".ink-page-rail");
      const thumb = page.locator(".ink-page-thumb").first();
      const entry = page.getByRole("button", { name: "Tag page 1", exact: true });
      const currentId = await page.locator(".ink-page-thumb.is-active").getAttribute("data-page-id");
      await entry.scrollIntoViewIfNeeded();
      if (browserName === "webkit") await entry.tap({ timeout: 2000 });
      else await entry.click({ timeout: 2000 });
      const panel = page.getByRole("dialog", { name: "Page tags", exact: true });
      await expect(panel).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath("page-tags-panel.png") });
      await expect(entry.locator("svg")).toBeVisible();
      await expect(entry).toBeEnabled();
      expect(await entry.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
      await expect(page.locator(".ink-page-thumb.is-active")).toHaveAttribute("data-page-id", currentId!);

      const expectAligned = async () => {
        await expect.poll(async () => {
          const railBox = (await rail.boundingBox())!;
          const thumbBox = (await thumb.boundingBox())!;
          const panelBox = (await panel.boundingBox())!;
          return Math.abs(panelBox.x - (railBox.x + railBox.width + 8)) <= 1
            && Math.min(panelBox.y + panelBox.height, thumbBox.y + thumbBox.height)
              - Math.max(panelBox.y, thumbBox.y) > 0;
        }).toBe(true);
      };
      await expectAligned();
      await rail.evaluate((element: HTMLElement) => {
        element.style.setProperty("--ink-rail-width", "240px");
      });
      await expect.poll(async () => {
        const r = (await rail.boundingBox())!, p = (await panel.boundingBox())!;
        return Math.abs(p.x - (r.x + r.width + 8));
      }).toBeLessThanOrEqual(1);
      if (reading) {
        await expect(panel.getByRole("button", { name: "Red flag", exact: true })).toBeDisabled();
        await expect(panel.getByRole("status")).toContainText("Reading mode");
      } else {
        await panel.getByRole("button", { name: "Red flag", exact: true }).click();
        await expect(thumb.locator(".ink-thumb-flag.is-red")).toBeVisible();
        await expectAligned();
      }
      // Narrowing the workspace must keep the complete panel inside it.
      await page.setViewportSize({ width: 600, height: 560 });
      await expect.poll(async () => {
        const root = (await page.locator(editor === "pdf" ? ".ink-pdf-view" : ".ink-notes-view").boundingBox())!;
        const p = (await panel.boundingBox())!;
        return p.x >= root.x && p.y >= root.y && p.x + p.width <= root.x + root.width
          && p.y + p.height <= root.y + root.height;
      }).toBe(true);
      await expectAligned();
      await page.locator("#host").evaluate((element: HTMLElement) => Object.assign(element.style, {
        left: "0", top: "0", width: "100%", height: "100%",
      }));
      await page.setViewportSize({ width: 360, height: 720 });
      await expect.poll(async () => {
        const r = (await rail.boundingBox())!, p = (await panel.boundingBox())!;
        return Math.abs(p.x - (r.x + r.width + 8)) <= 1 && p.x + p.width <= 360;
      }).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("page-tags-panel-narrow.png") });
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
    });
  }
}

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
  await expect(page.locator(".ink-page-thumb.is-filtered-out")).toBeHidden();
  await expect(page.locator(".ink-rail-count")).toHaveText("1 of 2");
  await page.getByRole("button", { name: "Pages with ink only" }).click();
  // The tagged source page has no ink either: stacked filters empty the rail
  // while the counter keeps explaining the result.
  await expect(page.locator(".ink-page-thumb:not(.is-filtered-out)")).toHaveCount(0);
  await expect(page.locator(".ink-page-thumb.is-filtered-out")).toHaveCount(2);
  await expect(page.locator(".ink-page-thumb.is-filtered-out").first()).toBeHidden();
  await expect(page.locator(".ink-rail-count")).toHaveText("0 of 2");
  await page.screenshot({ path: "test-results/page-tags-pdf.png" });
  await page.getByRole("button", { name: "Pages with ink only" }).click();
  await page.getByRole("button", { name: "Tagged pages only" }).click();
  await expect(page.locator(".ink-page-thumb")).toHaveCount(2);
  await expect(page.locator(".ink-page-thumb.is-filtered-out")).toHaveCount(0);
});
