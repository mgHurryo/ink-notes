import { expect, test } from "@playwright/test";

const previewUrl = `http://127.0.0.1:${process.env.PREVIEW_PORT || 4173}`;

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
    const inkPixels = () => page.locator(".ink-tile-layer").evaluate(async (layer) => {
      let count = 0, blue = 0;
      for (const canvas of Array.from(layer.querySelectorAll("canvas"))) {
        let pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels && typeof OffscreenCanvas !== "undefined") {
          const bitmap = await createImageBitmap(canvas);
          const copy = new OffscreenCanvas(canvas.width, canvas.height);
          const context = copy.getContext("2d");
          context?.drawImage(bitmap, 0, 0);
          pixels = context?.getImageData(0, 0, copy.width, copy.height).data;
          bitmap.close();
        }
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
    for (const [theme, variables] of Object.entries(themes)) {
      await page.evaluate((values) => {
        for (const [property, value] of Object.entries(values)) document.documentElement.style.setProperty(property, value);
      }, variables);
      await expect(page.locator(".ink-notes-view")).toHaveScreenshot(`editor-${viewport.width}-${theme}.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.01,
      });
    }
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
  for (const label of ["Move current page up", "Move current page down", "Duplicate current page", "Delete current page"]) {
    const action = page.getByRole("button", { name: label, exact: true });
    await expect(action).toBeVisible();
    const actionBox = await action.boundingBox();
    expect(actionBox?.width).toBeGreaterThanOrEqual(44);
    expect(actionBox?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator(".ink-notes-view")).toHaveScreenshot("page-rail-360.png", {
    animations: "disabled", maxDiffPixelRatio: 0.01,
  });
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Tool settings" });
  await expect(popover).toBeVisible();
  await expect(page.getByRole("slider", { name: "Pen size", exact: true })).toBeFocused();
  await expect(page.locator(".ink-notes-view")).toHaveScreenshot("tool-popover-360.png", {
    animations: "disabled", maxDiffPixelRatio: 0.01,
  });
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toBeFocused();
});

test("pen and highlighter keep independent tool settings", async ({ page }) => {
  await page.goto("/");
  const pen = page.getByRole("button", { name: "Pen", exact: true });
  await pen.click();
  await page.getByRole("slider", { name: "Pen size", exact: true }).fill("6");
  await page.getByRole("button", { name: "Pen blue", exact: true }).click();

  const highlighter = page.getByRole("button", { name: "Highlight", exact: true });
  await highlighter.click();
  await expect(page.getByRole("slider", { name: "Highlighter size", exact: true })).toHaveValue("18");
  await expect(page.getByRole("button", { name: "Highlighter yellow", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("slider", { name: "Highlighter size", exact: true }).fill("26");
  await page.getByRole("button", { name: "Highlighter green", exact: true }).click();

  await pen.click();
  await expect(page.getByRole("slider", { name: "Pen size", exact: true })).toHaveValue("6");
  await expect(page.getByRole("button", { name: "Pen blue", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('input[aria-label="Highlighter size"]')).toHaveValue("26");
  await expect(page.locator('button[aria-label="Highlighter green"]')).toHaveAttribute("aria-pressed", "true");
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
  await page.getByRole("slider", { name: "Highlighter size", exact: true }).fill("24");
  await page.getByRole("button", { name: "Highlighter yellow", exact: true }).click();
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
  const previewLayers = page.locator(".ink-confirmed-preview-canvas, .ink-preview-canvas");
  await expect(preview).toHaveClass(/is-highlighter-preview/);
  await expect.poll(async () => previewLayers.evaluateAll((canvases: HTMLCanvasElement[]) => {
    let minX = Number.POSITIVE_INFINITY, maxX = -1, width = 1;
    for (const canvas of canvases) {
      const context = canvas.getContext("2d");
      if (!context || canvas.width <= 1) continue;
      width = canvas.width;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) {
        const x = ((index - 3) / 4) % canvas.width;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      }
    }
    return maxX < minX ? 0 : (maxX - minX) / width;
  })).toBeGreaterThan(0.55);

  await page.mouse.up();
  await expect(preview).not.toHaveClass(/is-highlighter-preview/);
  await expect.poll(async () => previewLayers.evaluateAll((canvases: HTMLCanvasElement[]) => {
    for (const canvas of canvases) {
      const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels) return -1;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) return 1;
    }
    return 0;
  })).toBe(0);
  expect(await preview.evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(1);
  await expect.poll(async () => page.locator(".ink-tile-layer").evaluate(async (layer) => {
    let yellow = 0;
    for (const canvas of Array.from(layer.querySelectorAll("canvas"))) {
      let pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
      if (!pixels && typeof OffscreenCanvas !== "undefined") {
        const bitmap = await createImageBitmap(canvas);
        const copy = new OffscreenCanvas(canvas.width, canvas.height);
        const context = copy.getContext("2d");
        context?.drawImage(bitmap, 0, 0);
        pixels = context?.getImageData(0, 0, copy.width, copy.height).data;
        bitmap.close();
      }
      if (pixels) for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 150 && pixels[index + 1] > 100 && pixels[index + 2] < 150 && pixels[index + 3] > 0) yellow++;
      }
    }
    return yellow;
  })).toBeGreaterThan(0);
});

test("pen contact and release are visible without waiting for tile commit", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  const paper = page.locator(".ink-page");
  const box = await paper.boundingBox();
  if (!box) throw new Error("Ink page has no layout box");
  const point = { x: box.x + box.width * 0.82, y: box.y + box.height * 0.62 };
  const alphaNearPoint = () => page.locator(".ink-confirmed-preview-canvas, .ink-preview-canvas, .ink-tile-layer canvas")
    .evaluateAll((canvases: HTMLCanvasElement[], clientPoint) => {
      let alpha = 0;
      for (const canvas of canvases) {
        const context = canvas.getContext("2d");
        const rect = canvas.getBoundingClientRect();
        if (!context || rect.width <= 0 || rect.height <= 0 || canvas.width <= 1) continue;
        const centerX = Math.round((clientPoint.x - rect.left) / rect.width * canvas.width);
        const centerY = Math.round((clientPoint.y - rect.top) / rect.height * canvas.height);
        const x = Math.max(0, centerX - 8), y = Math.max(0, centerY - 8);
        const width = Math.min(17, canvas.width - x), height = Math.min(17, canvas.height - y);
        if (width <= 0 || height <= 0) continue;
        const pixels = context.getImageData(x, y, width, height).data;
        for (let index = 3; index < pixels.length; index += 4) alpha += pixels[index];
      }
      return alpha;
    }, point);

  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  expect(await alphaNearPoint()).toBeGreaterThan(0);
  await page.mouse.up();
  expect(await alphaNearPoint()).toBeGreaterThan(0);
});

test("stroke eraser updates mounted tiles before pointerup", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto("/");
  await expect.poll(() => page.locator(".ink-tile-layer canvas").count()).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Erase", exact: true }).click();
  const box = await page.locator(".ink-page").boundingBox();
  if (!box) throw new Error("Ink page has no layout box");
  await page.mouse.move(box.x + box.width * 0.49, box.y + box.height * 0.31);
  await page.mouse.down();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const liveTiles = await page.locator(".ink-tile-layer canvas").evaluateAll((canvases: HTMLCanvasElement[]) => {
    let count = 0, alpha = 0;
    for (const canvas of canvases) {
      const context = canvas.getContext("2d");
      if (!context) continue;
      count++;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 3; index < pixels.length; index += 4) alpha += pixels[index];
    }
    return { count, alpha };
  });
  expect(liveTiles.count).toBeGreaterThan(0);
  expect(liveTiles.alpha).toBe(0);
  await page.mouse.up();
});

test("iPad-sized writing stays at full 2x backing density", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 1366 }, deviceScaleFactor: 2,
    baseURL: previewUrl });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const paper = page.locator(".ink-page");
    const box = await paper.boundingBox();
    if (!box) throw new Error("Ink page has no layout box");
    await expect.poll(async () => paper.evaluate((element: HTMLElement) => ({
      transform: getComputedStyle(element).transform,
      zoom: getComputedStyle(element).zoom,
    }))).toEqual({ transform: "none", zoom: "1" });
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.35, { steps: 12 });
    const previewDensity = await page.locator(".ink-preview-canvas").evaluate((canvas: HTMLCanvasElement) =>
      canvas.width / canvas.getBoundingClientRect().width);
    expect(previewDensity).toBeGreaterThanOrEqual(1.95);
    await page.mouse.up();
    await expect.poll(async () => page.locator(".ink-tile-layer canvas").evaluateAll((canvases: HTMLCanvasElement[]) =>
      Math.max(0, ...canvases.map(canvas => canvas.width / parseFloat(canvas.style.width))))).toBeGreaterThanOrEqual(1.95);
  } finally {
    await context.close();
  }
});

test("zoom keeps right-side ink and tile geometry aligned", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(() => {
    const hook = (window as typeof window & { __inkNotesPreview?: { view: object } }).__inkNotesPreview;
    (hook?.view as { setZoom(value: number): void }).setZoom(1.5);
  });
  const paper = page.locator(".ink-page");
  const box = await paper.boundingBox();
  if (!box) throw new Error("Ink page has no layout box");
  const x = box.x + box.width * 0.72;
  const y = box.y + box.height * 0.3;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 40, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => page.locator(".ink-confirmed-preview-canvas").evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext("2d");
    if (!context) return 0;
    return context.getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0) ? 1 : 0;
  })).toBe(1);
  await expect.poll(async () => page.locator(".ink-tile-layer [data-cell]").count()).toBeGreaterThan(0);
  const geometry = await page.locator(".ink-tile-layer [data-cell]").first().evaluate((node: HTMLElement) => ({
    left: parseFloat(node.style.left), width: parseFloat(node.style.width),
  }));
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.width).toBeGreaterThanOrEqual(128);
});

test("large-notebook tile and save work does not block the writing thread", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/?performance");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready"), { timeout: 15_000 }).toBe("true");
  await expect.poll(() => page.locator(".ink-tile-layer canvas").count(), { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(750);
  await page.evaluate(() => {
    const scope = window as typeof window & { __inkLongTasks?: number[]; __inkLongTaskObserver?: PerformanceObserver };
    scope.__inkLongTasks = [];
    scope.__inkLongTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) scope.__inkLongTasks!.push(entry.duration);
    });
    scope.__inkLongTaskObserver.observe({ type: "longtask", buffered: false });
  });
  const paper = page.locator(".ink-page");
  const box = await paper.boundingBox();
  if (!box) throw new Error("Ink page has no layout box");
  await page.mouse.move(box.x + box.width * 0.12, box.y + box.height * 0.12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.18, { steps: 20 });
  await page.mouse.up();
  await page.waitForTimeout(2_250);
  const longTasks = await page.evaluate(() => {
    const scope = window as typeof window & { __inkLongTasks?: number[]; __inkLongTaskObserver?: PerformanceObserver };
    scope.__inkLongTaskObserver?.disconnect();
    return scope.__inkLongTasks ?? [];
  });
  expect(longTasks, `main-thread long tasks: ${longTasks.join(", ")}`).toEqual([]);
});

test("Worker and fallback ink operations remain pixel-equivalent at high DPR", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  const comparisons = await page.evaluate(async () => {
    type Mode = "pen" | "highlighter" | "stroke-eraser" | "circle-eraser" | "square-eraser" | "lasso";
    const hook = (window as typeof window & { __inkNotesPreview?: { compareRenderer(mode?: Mode): Promise<{
      compared: number; different: number; inkPixels: number; expectedInkPixels: number; totalPixels: number }> } })
      .__inkNotesPreview;
    if (!hook) throw new Error("Ink preview test hook is unavailable");
    const modes: Mode[] = ["pen", "highlighter", "stroke-eraser", "circle-eraser", "square-eraser", "lasso"];
    const results = [];
    for (const mode of modes) results.push(await hook.compareRenderer(mode));
    return results;
  });
  for (const comparison of comparisons) {
    expect(comparison.inkPixels).toBeGreaterThan(0);
    expect(comparison.different / comparison.totalPixels).toBeLessThan(0.01);
    expect(Math.abs(comparison.inkPixels - comparison.expectedInkPixels) / comparison.expectedInkPixels).toBeLessThan(0.1);
  }
});

test("Markdown ink embed renders a targeted read-only page preview", async ({ page }) => {
  await page.goto("/");
  const embed = page.locator(".preview-embed-fixture");
  await expect(embed.locator('canvas[aria-label="Ink preview: Page 1"]')).toHaveJSProperty("width", 1200);
  await expect(embed.getByRole("button", { name: "Open Ink notebook" })).toHaveCount(1);
  const pixels = await embed.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!data) return 0;
    let count = 0;
    for (let index = 3; index < data.length; index += 4) if (data[index] > 0) count++;
    return count;
  });
  expect(pixels).toBeGreaterThan(0);
  await embed.evaluate((element: HTMLElement) => {
    element.style.cssText = "position:relative;left:0;top:0;width:320px;padding:12px;background:var(--background-primary)";
  });
  await expect(embed).toHaveScreenshot("markdown-embed.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});
