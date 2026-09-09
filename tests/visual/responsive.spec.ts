import { expect, test } from "@playwright/test";

const viewports = [
  { width: 360, height: 720 },
  { width: 480, height: 720 },
  { width: 720, height: 900 },
  { width: 1280, height: 720 },
];
const primaryTools = ["Pages", "Pen", "Highlight", "Erase", "Select", "Undo", "Redo", "Page options"];

for (const viewport of viewports) {
  test(`${viewport.width}px editor remains usable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const toolbar = page.getByRole("toolbar", { name: "Ink tools" });
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveCSS("height", "56px");
    for (const label of primaryTools) {
      const button = page.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
    }
    const metrics = await page.locator(".ink-notes-view").evaluate((root) => ({
      overflow: root.scrollWidth > root.clientWidth,
      workspaceRatio: root.querySelector(".ink-workspace")!.getBoundingClientRect().height / window.innerHeight,
    }));
    expect(metrics.overflow).toBe(false);
    expect(metrics.workspaceRatio).toBeGreaterThanOrEqual(viewport.width >= 1000 ? 0.88 : 0.8);
    await expect(page.locator(".ink-page")).toBeVisible();
    await expect.poll(() => page.locator(".ink-tile-layer").evaluate((layer) => {
      let count = 0;
      for (const canvas of Array.from(layer.querySelectorAll("canvas"))) {
        const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (pixels) for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) count++;
      }
      return count;
    })).toBeGreaterThan(0);
  });
}

test("page rail and brush popover are keyboard dismissible", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".ink-page-rail")).toBeVisible();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Tool settings" });
  await expect(popover).toBeVisible();
  await expect(page.getByRole("slider", { name: "Brush size", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toBeFocused();
});

test("eraser settings expose local sizes and a pointer reference", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  const eraser = page.getByRole("button", { name: "Erase", exact: true });
  await eraser.click();
  await eraser.click();
  const settings = page.getByRole("dialog", { name: "Tool settings" });
  const size = page.getByRole("slider", { name: "Eraser size" });
  await expect(settings).toBeVisible();
  await expect(page.getByText("Erases the entire touched stroke. Size is fixed.")).toBeVisible();
  await expect(size).toBeHidden();

  await page.getByRole("radio", { name: "Circle eraser" }).click();
  await expect(size).toBeVisible();
  await size.fill("48");
  await page.keyboard.press("Escape");
  const paper = page.locator(".ink-page");
  const box = await paper.boundingBox();
  if (!box) throw new Error("Ink page has no layout box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const cursor = page.locator(".ink-eraser-cursor");
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveCSS("width", "48px");
  await expect(cursor.locator(".ink-eraser-reference-point")).toBeVisible();

  await eraser.click();
  await page.getByRole("radio", { name: "Square eraser" }).click();
  await expect(cursor).toHaveClass(/is-square/);
});
