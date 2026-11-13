import { expect, test } from "@playwright/test";

test("dense notebook pages turn from a prewarmed full-resolution neighbor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/?performance&pages=8");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready"), { timeout: 15_000 }).toBe("true");

  const result = await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    view.swipeDrag(-180);
    view.swipeSettle(1);
    await new Promise<void>((resolve) => {
      const wait = () => view.pageIndex === 1 && !view.flipSettling ? resolve() : requestAnimationFrame(wait);
      wait();
    });
    const deadline = performance.now() + 15_000;
    while ((view.tiles.jobs.length > 0 || view.tiles.pendingTiles.size > 0) && performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    const neighbor = view.notebook.pages[0];
    const logicalWidth = view.canvasLogicalWidth, logicalHeight = view.canvasLogicalHeight;
    const previewContext = document.createElement("canvas").getContext("2d")!;
    const cachedPreviewReady = view.tiles.drawCachedPreview({ page: neighbor, width: logicalWidth,
      height: logicalHeight, viewport: view.viewport, density: window.devicePixelRatio || 1 }, previewContext);
    const previewScale = Math.min(window.devicePixelRatio || 1, 8192 / logicalWidth, 8192 / logicalHeight,
      Math.sqrt(16_000_000 / (logicalWidth * logicalHeight)));
    const expectedRaster = { width: Math.max(1, Math.round(logicalWidth * previewScale)),
      height: Math.max(1, Math.round(logicalHeight * previewScale)) };

    const frames: number[] = [];
    const longTasks: number[] = [];
    let running = true;
    let previous = performance.now();
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => entry.duration));
    });
    observer.observe({ type: "longtask", buffered: false });
    const sample = () => {
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const started = performance.now();
    view.swipeDrag(180);
    const stageCanvas = document.querySelector<HTMLCanvasElement>(".ink-swipe-stage canvas")!;
    const dragSetupMs = performance.now() - started;
    const raster = { width: stageCanvas.width, height: stageCanvas.height };
    view.swipeSettle(-1);
    await new Promise<void>((resolve) => {
      const wait = () => view.pageIndex === 0 && !view.flipSettling ? resolve() : requestAnimationFrame(wait);
      wait();
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    running = false;
    observer.disconnect();
    const sortedFrames = [...frames].sort((a, b) => a - b);
    return { cachedPreviewReady, dragSetupMs, maxFrameMs: Math.max(...frames),
      medianFrameMs: sortedFrames[Math.floor(sortedFrames.length / 2)], frameCount: frames.length,
      longTasks, raster, expectedRaster };
  });

  expect(result.cachedPreviewReady).toBe(true);
  expect(result.dragSetupMs).toBeLessThan(16);
  expect(result.longTasks).toEqual([]);
  expect(result.maxFrameMs).toBeLessThan(result.medianFrameMs * 3);
  expect(result.raster).toEqual(result.expectedRaster);
});

test("PDF note pages turn from a prewarmed full-resolution ink neighbor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready"), { timeout: 15_000 }).toBe("true");

  const result = await page.evaluate(async () => {
    await (window as any).__inkNotesPreview.openPdf();
    const view = (window as any).__inkNotesPreview.view;
    view.addBlankPage(1);
    const densePage = view.sidecar.notebook.pages[0];
    const points = Array.from({ length: 80 }, (_, pointIndex) => ({
      x: 0.02 + pointIndex / 80 * 0.035, y: 0.02 + Math.sin(pointIndex / 8) * 0.002,
      pressure: 0.35 + pointIndex / 200, t: pointIndex + 1,
    }));
    densePage.strokes = Array.from({ length: 1001 }, (_, strokeIndex) => ({
      id: `pdf-swipe-heavy-${strokeIndex}`, pageId: densePage.id, tool: "pen",
      color: strokeIndex % 3 === 0 ? "#195bff" : "#171717", width: 4, opacity: 1,
      points: points.map((point) => ({ ...point, x: point.x + (strokeIndex % 20) * 0.047,
        y: point.y + Math.floor(strokeIndex / 20) * 0.018 })),
      createdAt: 1, updatedAt: 1,
    }));
    densePage.updatedAt = Date.now();
    view.layoutPage();
    view.renderAll();
    await view.navigatePages(1);
    const deadline = performance.now() + 15_000;
    while ((view.tiles.jobs.length > 0 || view.tiles.pendingTiles.size > 0) && performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }

    const notePage = view.sidecar.notePages[0];
    const size = view.swipePageSize(notePage);
    const display = view.rotatedSize(notePage);
    const logicalWidth = Math.max(1, Math.round(size.baseWidth * 64) / 64);
    const logicalHeight = Math.max(1, Math.round(size.baseWidth * display.height / display.width * 64) / 64);
    const geometry = { page: densePage, width: logicalWidth, height: logicalHeight,
      viewport: { x: 0, y: 0, width: logicalWidth, height: logicalHeight },
      density: (window.devicePixelRatio || 1) * size.zoom };
    const context = document.createElement("canvas").getContext("2d")!;
    const cachedPreviewReady = view.tiles.drawCachedPreview(geometry, context);
    const scale = Math.min(geometry.density, 8192 / logicalWidth, 8192 / logicalHeight,
      Math.sqrt(16_000_000 / (logicalWidth * logicalHeight)));
    const expectedRaster = { width: Math.max(1, Math.round(logicalWidth * scale)),
      height: Math.max(1, Math.round(logicalHeight * scale)) };

    const frames: number[] = [];
    const longTasks: number[] = [];
    let running = true;
    let previous = performance.now();
    const observer = new PerformanceObserver((list) => {
      longTasks.push(...list.getEntries().map((entry) => entry.duration));
    });
    observer.observe({ type: "longtask", buffered: false });
    const sample = () => {
      const now = performance.now();
      frames.push(now - previous);
      previous = now;
      if (running) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const started = performance.now();
    view.swipeDrag(180);
    const inkCanvases = document.querySelectorAll<HTMLCanvasElement>(".ink-swipe-stage canvas.ink-swipe-canvas");
    const inkCanvas = inkCanvases[inkCanvases.length - 1];
    const dragSetupMs = performance.now() - started;
    const raster = { width: inkCanvas.width, height: inkCanvas.height };
    view.swipeSettle(-1);
    await new Promise<void>((resolve) => {
      const wait = () => view.noteIndex === 0 && !view.flipSettling ? resolve() : requestAnimationFrame(wait);
      wait();
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    running = false;
    observer.disconnect();
    const sortedFrames = [...frames].sort((a, b) => a - b);
    return { cachedPreviewReady, dragSetupMs, maxFrameMs: Math.max(...frames),
      medianFrameMs: sortedFrames[Math.floor(sortedFrames.length / 2)], longTasks, raster, expectedRaster };
  });

  expect(result.cachedPreviewReady).toBe(true);
  expect(result.dragSetupMs).toBeLessThan(16);
  expect(result.longTasks).toEqual([]);
  expect(result.maxFrameMs).toBeLessThan(result.medianFrameMs * 3);
  expect(result.raster).toEqual(result.expectedRaster);
});
