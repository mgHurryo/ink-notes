import { expect, test } from "@playwright/test";

const viewports = [
  { width: 360, height: 720 },
  { width: 480, height: 720 },
  { width: 720, height: 900 },
  { width: 1280, height: 720 },
];
const primaryTools = ["Pages", "Pen", "Highlight", "Erase", "Select", "Undo", "Redo", "Page options"];

const themes = {
  light: {
    "--background-primary": "#f5f6f8", "--background-secondary": "#ffffff", "--background-modifier-border": "#8a8f98",
    "--background-modifier-hover": "#e2e5e9", "--text-normal": "#1d232a", "--text-muted": "#4f5965",
    "--text-on-accent": "#ffffff", "--interactive-accent": "#006b80",
  },
  dark: {
    "--background-primary": "#1b1c1d", "--background-secondary": "#282a2c", "--background-modifier-border": "#777d85",
    "--background-modifier-hover": "#3a3d40", "--text-normal": "#edf2fa", "--text-muted": "#b5bdc8",
    "--text-on-accent": "#ffffff", "--interactive-accent": "#286b80",
  },
  highContrast: {
    "--background-primary": "#000000", "--background-secondary": "#000000", "--background-modifier-border": "#ffffff",
    "--background-modifier-hover": "#252525", "--text-normal": "#ffffff", "--text-muted": "#ffffff",
    "--text-on-accent": "#000000", "--interactive-accent": "#ffff00",
  },
} as const;

function contrast(rgbA: number[], rgbB: number[]): number {
  const luminance = (rgb: number[]) => {
    const channels = rgb.map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [lighter, darker] = [luminance(rgbA), luminance(rgbB)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

for (const viewport of viewports) {
  test(`${viewport.width}px editor remains usable`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const toolbar = page.getByRole("toolbar", { name: "Ink tools" });
    await expect(toolbar).toBeVisible();
    await expect(toolbar).toHaveCSS("height", "56px");
    const boxes = [];
    for (const label of primaryTools) {
      const button = page.getByRole("button", { name: label, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.x).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
      if (box) boxes.push(box);
    }
    const ordered = boxes.sort((left, right) => left.x - right.x);
    for (let index = 1; index < ordered.length; index++) expect(ordered[index].x + 0.5).toBeGreaterThanOrEqual(ordered[index - 1].x + ordered[index - 1].width);
    const metrics = await page.locator(".ink-notes-view").evaluate((root) => ({
      overflow: root.scrollWidth > root.clientWidth,
      toolbarOverflow: root.querySelector(".ink-toolbar")!.scrollWidth > root.querySelector(".ink-toolbar")!.clientWidth,
      workspaceRatio: root.querySelector(".ink-workspace")!.getBoundingClientRect().height / window.innerHeight,
    }));
    expect(metrics.overflow).toBe(false);
    expect(metrics.toolbarOverflow).toBe(false);
    expect(metrics.workspaceRatio).toBeGreaterThanOrEqual(viewport.width >= 1000 ? 0.88 : 0.8);
    await expect(page.locator(".ink-page")).toBeVisible();
    const inkPixels = () => page.locator(".ink-tile-layer").evaluate((layer) => {
      let count = 0, blue = 0;
      for (const canvas of Array.from(layer.querySelectorAll("canvas"))) {
        const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (pixels) for (let index = 0; index < pixels.length; index += 4) if (pixels[index + 3]) {
          count++;
          if (pixels[index + 2] > pixels[index] + 80 && pixels[index + 2] > pixels[index + 1] + 80) blue++;
        }
      }
      return { count, blue };
    });
    await expect.poll(async () => (await inkPixels()).blue).toBeGreaterThan(0);
    const ink = await inkPixels();
    expect(ink.count).toBeGreaterThan(0);
    expect(ink.blue).toBeGreaterThan(0);
    await expect(page.locator(".ink-notes-view")).toHaveScreenshot(`editor-${viewport.width}.png`, {
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
    });
  });
}

test("page rail and brush popover are keyboard dismissible", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto("/");
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".ink-page-rail")).toBeVisible();
  const layout = await page.locator(".ink-workspace").evaluate((workspace) => {
    const rail = workspace.querySelector(".ink-page-rail")!.getBoundingClientRect();
    const scroller = workspace.querySelector(".ink-page-scroller")!.getBoundingClientRect();
    const paper = workspace.querySelector(".ink-page")!.getBoundingClientRect();
    return { railRight: rail.right, scrollerLeft: scroller.left, paperLeft: paper.left, paperRight: paper.right, scrollerRight: scroller.right };
  });
  expect(layout.railRight).toBeLessThanOrEqual(layout.scrollerLeft + 1);
  expect(layout.paperLeft).toBeGreaterThanOrEqual(layout.scrollerLeft);
  expect(layout.paperRight).toBeLessThanOrEqual(layout.scrollerRight + 1);
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Tool settings" });
  await expect(popover).toBeVisible();
  await expect(page.getByRole("slider", { name: "Brush size", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toBeFocused();
});

test("semantic themes keep toolbar text, borders, and selection readable", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  for (const [name, variables] of Object.entries(themes)) {
    await page.evaluate((values) => {
      for (const [property, value] of Object.entries(values)) document.documentElement.style.setProperty(property, value);
    }, variables);
    await page.getByRole("button", { name: "Erase", exact: true }).click();
    // Wait for the toolbar's intentional color transition before measuring
    // the final semantic-theme contrast.
    await page.waitForTimeout(200);
    const colors = await page.locator(".ink-notes-view").evaluate((root) => {
      const parse = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const view = getComputedStyle(root);
      const toolbar = getComputedStyle(root.querySelector(".ink-toolbar")!);
      const selected = getComputedStyle(root.querySelector('[data-tool="eraser"]')!);
      return {
        viewText: parse(view.color), viewBackground: parse(view.backgroundColor),
        toolbarBorder: parse(toolbar.borderBottomColor), toolbarBackground: parse(toolbar.backgroundColor),
        selectedText: parse(selected.color), selectedBackground: parse(selected.backgroundColor),
      };
    });
    expect(contrast(colors.viewText, colors.viewBackground), `${name} normal text contrast`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.selectedText, colors.selectedBackground), `${name} selected tool contrast`).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.toolbarBorder, colors.toolbarBackground), `${name} toolbar border contrast`).toBeGreaterThanOrEqual(name === "highContrast" ? 7 : 1.3);
  }
});

test("eraser reference follows hover and refreshes with local settings", async ({ page }) => {
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
  await expect(cursor).toHaveCSS("border-top-width", "2px");
  await expect(cursor).toHaveCSS("box-shadow", /rgba?\(255, 255, 255.*rgba?\(0, 0, 0/);
  await expect(cursor.locator(".ink-eraser-reference-point")).toBeVisible();
  await expect(cursor.locator(".ink-eraser-reference-point")).toHaveCSS("width", "11px");

  await page.evaluate(() => (document.querySelector('[aria-label="Erase"]') as HTMLButtonElement).click());
  await page.evaluate(() => (document.querySelector('[aria-label="Square eraser"]') as HTMLButtonElement).click());
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveClass(/is-square/);
  await expect(cursor.locator(".ink-eraser-reference-point")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(cursor).toBeHidden();
});

test("a long highlighter stroke stays complete before pointerup", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  const highlighter = page.getByRole("button", { name: "Highlight", exact: true });
  await highlighter.click();
  await highlighter.click();
  await page.getByRole("slider", { name: "Brush size", exact: true }).fill("24");
  await page.getByRole("button", { name: "Yellow", exact: true }).click();
  await page.keyboard.press("Escape");

  const paper = page.locator(".ink-page");
  const box = await paper.boundingBox();
  if (!box) throw new Error("Ink page has no layout box");
  const start = { x: box.x + box.width * 0.12, y: box.y + box.height * 0.52 };
  const end = { x: box.x + box.width * 0.88, y: box.y + box.height * 0.52 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 24 });

  const preview = page.locator(".ink-preview-canvas");
  await expect(preview).toHaveClass(/is-highlighter-preview/);
  await expect.poll(async () => preview.evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context || canvas.width <= 1) return 0;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width, maxX = -1;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) {
      const x = ((index - 3) / 4) % canvas.width;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    }
    return maxX < minX ? 0 : (maxX - minX) / canvas.width;
  })).toBeGreaterThan(0.55);

  await page.mouse.up();
  await expect(preview).not.toHaveClass(/is-highlighter-preview/);
  await expect(preview).toHaveJSProperty("width", 1);
  await expect.poll(async () => page.locator(".ink-tile-layer").evaluate((layer) => {
    let yellow = 0;
    for (const canvas of Array.from(layer.querySelectorAll("canvas"))) {
      const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (pixels) for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 150 && pixels[index + 1] > 100 && pixels[index + 2] < 150 && pixels[index + 3] > 0) yellow++;
      }
    }
    return yellow;
  })).toBeGreaterThan(0);
});
