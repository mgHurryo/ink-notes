import { expect, test } from "@playwright/test";

interface ResponsivenessProbe {
  intentAt: number | null;
  pagesClickAt: number | null;
  highlightClickAt: number | null;
  highlightFrameAt: number | null;
  pageFrameAt: number | null;
  longTasks: number[];
}
type WindowWithProbe = Window & { __inkResponsiveness?: ResponsivenessProbe };

test("opening a large page rail keeps direct tool input responsive", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const probe: ResponsivenessProbe = {
      intentAt: null, pagesClickAt: null, highlightClickAt: null, highlightFrameAt: null, pageFrameAt: null, longTasks: [],
    };
    (window as WindowWithProbe).__inkResponsiveness = probe;
    if (typeof PerformanceObserver === "function") {
      new PerformanceObserver((list) => probe.longTasks.push(...list.getEntries().map((entry) => entry.duration)))
        .observe({ type: "longtask", buffered: true });
    }
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (target?.getAttribute("aria-label") === "Pages") probe.pagesClickAt = performance.now();
      if (target?.getAttribute("aria-label") === "Highlight") {
        probe.highlightClickAt = performance.now();
        requestAnimationFrame(() => { probe.highlightFrameAt = performance.now(); });
      }
    }, true);
  });
  await page.goto("/?performance");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready"), { timeout: 15_000 }).toBe("true");
  await page.waitForTimeout(750);
  await page.evaluate(() => {
    const probe = (window as WindowWithProbe).__inkResponsiveness!;
    probe.longTasks.length = 0;
  });

  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await expect(page.locator(".ink-notes-view")).not.toHaveClass(/ink-rail-hidden/);
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    (window as WindowWithProbe).__inkResponsiveness!.intentAt = performance.now();
  });
  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect(page.locator('.ink-tool-button[data-tool="highlighter"]')).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => (window as WindowWithProbe).__inkResponsiveness?.highlightFrameAt !== null);

  const result = await page.evaluate(() => {
    const probe = (window as WindowWithProbe).__inkResponsiveness!;
    return {
      inputDelayMs: probe.highlightClickAt! - probe.intentAt!,
      feedbackFrameMs: probe.highlightFrameAt! - probe.highlightClickAt!,
      longTasks: probe.longTasks.filter((duration) => duration >= 50),
    };
  });
  expect(result.inputDelayMs).toBeLessThan(50);
  expect(result.feedbackFrameMs).toBeLessThan(20);
  expect(result.longTasks).toEqual([]);
});

test("direct page selection updates before a dirty notebook finishes saving", async ({ page }) => {
  await page.addInitScript(() => {
    const probe: ResponsivenessProbe & { saving: { started: boolean; done: boolean } } = {
      intentAt: null, pagesClickAt: null, highlightClickAt: null, highlightFrameAt: null, pageFrameAt: null,
      longTasks: [], saving: { started: false, done: false },
    };
    (window as unknown as { __inkSavingProbe: typeof probe }).__inkSavingProbe = probe;
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (target?.getAttribute("aria-label") !== "1: Page 1") return;
      probe.intentAt = performance.now();
      requestAnimationFrame(() => { probe.pageFrameAt = performance.now(); });
    }, true);
  });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(() => {
    const win = window as unknown as { __inkSavingProbe: ResponsivenessProbe & { saving: { started: boolean; done: boolean } } };
    const view = (window as unknown as { __inkNotesPreview: { view: { store: { writeIfUnchanged: (...args: unknown[]) => Promise<boolean> } } } }).__inkNotesPreview.view;
    const store = view.store;
    const write = store.writeIfUnchanged.bind(store);
    store.writeIfUnchanged = async (...args: unknown[]) => {
      win.__inkSavingProbe.saving.started = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
      const result = await write(...args);
      win.__inkSavingProbe.saving.done = true;
      return result;
    };
  });
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.getByRole("button", { name: "Add page after current", exact: true }).click();
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: "1: Page 1", exact: true }).click();
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
  await page.waitForFunction(() => (window as unknown as { __inkSavingProbe: ResponsivenessProbe & { saving: { started: boolean; done: boolean } } })
    .__inkSavingProbe.saving.started);
  const result = await page.evaluate(() => {
    const probe = (window as unknown as { __inkSavingProbe: ResponsivenessProbe & { saving: { started: boolean; done: boolean } } }).__inkSavingProbe;
    return { feedbackMs: probe.pageFrameAt! - probe.intentAt!, saving: probe.saving };
  });
  expect(result.feedbackMs).toBeLessThan(20);
  expect(result.saving).toEqual({ started: true, done: false });
});

test("opening feedback appears in one frame and toolbar input stays live", async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { startedAt: 0, visibleFrameAt: 0, clickAt: 0, clickFrameAt: 0, longTasks: [] as { start: number; duration: number }[] };
    (window as unknown as { __inkLoadProbe: typeof probe }).__inkLoadProbe = probe;
    if (typeof PerformanceObserver === "function") new PerformanceObserver((list) => {
      probe.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
    }).observe({ type: "longtask", buffered: true });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (target?.getAttribute("aria-label") !== "Highlight") return;
      probe.clickAt = performance.now();
      requestAnimationFrame(() => { probe.clickFrameAt = performance.now(); });
    }, true);
  });
  await page.goto("/?performance");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready"), { timeout: 15_000 }).toBe("true");
  await page.evaluate(() => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    const store = view.store;
    const readRaw = store.readRaw.bind(store);
    store.readRaw = async (...args: unknown[]) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      return readRaw(...args);
    };
    const probe = (window as unknown as { __inkLoadProbe: { startedAt: number; visibleFrameAt: number } }).__inkLoadProbe;
    probe.startedAt = performance.now();
    void view.onLoadFile(view.file);
    requestAnimationFrame(() => { probe.visibleFrameAt = performance.now(); });
  });
  await expect(page.locator(".ink-notebook-load-feedback")).toBeVisible();
  await expect(page.locator(".ink-notebook-load-feedback")).toContainText("Opening Preview");
  await expect(page.locator(".ink-notes-view")).toHaveAttribute("aria-busy", "true");

  await page.getByRole("button", { name: "Highlight", exact: true }).click();
  await expect(page.locator('.ink-tool-button[data-tool="highlighter"]')).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => (window as unknown as { __inkLoadProbe: { clickFrameAt: number } }).__inkLoadProbe.clickFrameAt > 0);
  const result = await page.evaluate(() => (window as unknown as { __inkLoadProbe: {
    startedAt: number; visibleFrameAt: number; clickAt: number; clickFrameAt: number; longTasks: { start: number; duration: number }[];
  } }).__inkLoadProbe);
  expect(result.visibleFrameAt - result.startedAt).toBeLessThan(20);
  expect(result.clickFrameAt - result.clickAt).toBeLessThan(20);
  await expect(page.locator(".ink-notes-view")).toHaveAttribute("aria-busy", "false", { timeout: 5_000 });
  await expect(page.locator(".ink-notebook-load-feedback")).toBeHidden();
});

test("large notebook shows load feedback immediately and paints its first tile within 100ms", async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { feedbackAt: 0, firstTileAt: 0,
      longTasks: [] as { start: number; duration: number }[] };
    (window as unknown as { __inkOpenProbe: typeof probe }).__inkOpenProbe = probe;
    if (typeof PerformanceObserver === "function") new PerformanceObserver((list) => {
      probe.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
    }).observe({ type: "longtask", buffered: true });
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof HTMLElement ? record.target : null;
        if (target?.matches(".ink-notebook-load-feedback") && !target.hidden && probe.feedbackAt === 0)
          probe.feedbackAt = performance.now();
        if (target?.matches(".ink-tile-layer") && target.childElementCount > 0 && probe.firstTileAt === 0)
          probe.firstTileAt = performance.now();
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const layer = node.matches(".ink-tile-layer") ? node : node.querySelector<HTMLElement>(".ink-tile-layer");
          if (layer?.childElementCount && probe.firstTileAt === 0) probe.firstTileAt = performance.now();
        }
      }
    }).observe(document, { attributes: true, childList: true, subtree: true, attributeFilter: ["hidden"] });
  });
  await page.goto("/?performance");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true", { timeout: 15_000 });
  await page.waitForFunction(() => (window as unknown as { __inkOpenProbe: { firstTileAt: number } }).__inkOpenProbe.firstTileAt > 0,
    undefined, { timeout: 5_000 });
  const result = await page.evaluate(() => (window as unknown as { __inkOpenProbe: {
    feedbackAt: number; firstTileAt: number; longTasks: { start: number; duration: number }[];
  } }).__inkOpenProbe);
  const firstTileMs = result.firstTileAt - result.feedbackAt;
  const openingLongTasks = result.longTasks.filter((task) => task.start >= result.feedbackAt && task.start < result.firstTileAt);
  expect(result.feedbackAt).toBeGreaterThan(0);
  expect(firstTileMs).toBeGreaterThanOrEqual(0);
  expect(firstTileMs).toBeLessThan(100);
  expect(openingLongTasks).toEqual([]);
});

test("large notebook gives synchronous feedback and keeps input live without Worker", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 900 });
  await page.addInitScript(() => {
    const nativeWorker = window.Worker;
    window.Worker = new Proxy(nativeWorker, {
      construct(target, args) {
        const fixtureWorker = Reflect.construct(target, args);
        // The preview fixture is generated outside the measured path; make
        // the application itself exercise its documented no-Worker fallback.
        window.Worker = undefined as unknown as typeof Worker;
        (window as unknown as { __inkFallbackProbe: { workerUnavailable: boolean } }).__inkFallbackProbe.workerUnavailable = true;
        return fixtureWorker;
      },
    });
    const probe = { workerUnavailable: false, loadCallAt: 0, feedbackAt: 0, feedbackShownSynchronously: false,
      feedbackSyncMs: 0, clickDurationMs: 0, highlighterPressedAfterClick: false, firstTileAt: 0,
      longTasks: [] as { start: number; duration: number }[] };
    (window as unknown as { __inkFallbackProbe: typeof probe }).__inkFallbackProbe = probe;
    if (typeof PerformanceObserver === "function") new PerformanceObserver((list) => {
      probe.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
    }).observe({ type: "longtask", buffered: true });
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof HTMLElement ? record.target : null;
        if (target?.matches(".ink-notebook-load-feedback") && !target.hidden && probe.feedbackAt === 0) {
          probe.feedbackAt = performance.now();
        }
        if (target?.matches(".ink-tile-layer") && target.childElementCount > 0 && probe.firstTileAt === 0)
          probe.firstTileAt = performance.now();
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const layer = node.matches(".ink-tile-layer") ? node : node.querySelector<HTMLElement>(".ink-tile-layer");
          if (layer?.childElementCount && probe.firstTileAt === 0) probe.firstTileAt = performance.now();
        }
      }
    });
    observer.observe(document, { attributes: true, childList: true, subtree: true, attributeFilter: ["hidden"] });
  });

  await page.goto("/?performance");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true", { timeout: 15_000 });
  await page.evaluate(() => {
    const probe = (window as unknown as { __inkFallbackProbe: {
      loadCallAt: number; feedbackAt: number; feedbackShownSynchronously: boolean; feedbackSyncMs: number;
      clickDurationMs: number; highlighterPressedAfterClick: boolean; firstTileAt: number;
      longTasks: { start: number; duration: number }[];
    } }).__inkFallbackProbe;
    probe.firstTileAt = 0;
    probe.feedbackAt = 0;
    probe.longTasks.length = 0;
    const view = (window as unknown as { __inkNotesPreview: { view: { file: unknown; onLoadFile(file: unknown): Promise<void> } } })
      .__inkNotesPreview.view;
    probe.loadCallAt = performance.now();
    void view.onLoadFile(view.file);
    const overlay = document.querySelector<HTMLElement>(".ink-notebook-load-feedback");
    const root = document.querySelector<HTMLElement>(".ink-notes-view");
    probe.feedbackShownSynchronously = !!overlay && !overlay.hidden && root?.getAttribute("aria-busy") === "true";
    probe.feedbackSyncMs = performance.now() - probe.loadCallAt;

    const button = document.querySelector<HTMLButtonElement>('[aria-label="Highlight"]');
    const clickStartedAt = performance.now();
    button?.click();
    probe.clickDurationMs = performance.now() - clickStartedAt;
    probe.highlighterPressedAfterClick = button?.getAttribute("aria-pressed") === "true";
  });
  await page.waitForFunction(() => (window as unknown as { __inkFallbackProbe: { firstTileAt: number } })
    .__inkFallbackProbe.firstTileAt > 0, undefined, { timeout: 5_000 });
  const result = await page.evaluate(() => (window as unknown as { __inkFallbackProbe: {
    workerUnavailable: boolean; loadCallAt: number; feedbackAt: number; feedbackShownSynchronously: boolean;
    feedbackSyncMs: number; clickDurationMs: number; highlighterPressedAfterClick: boolean; firstTileAt: number;
    longTasks: { start: number; duration: number }[];
  } }).__inkFallbackProbe);
  const firstTileMs = result.firstTileAt - result.feedbackAt;
  const openingLongTasks = result.longTasks.filter((task) => task.start >= result.loadCallAt && task.start < result.firstTileAt);
  expect(result.workerUnavailable).toBe(true);
  expect(result.feedbackShownSynchronously).toBe(true);
  expect(result.feedbackSyncMs).toBeLessThan(5);
  expect(result.highlighterPressedAfterClick).toBe(true);
  expect(result.clickDurationMs).toBeLessThan(5);
  expect(firstTileMs).toBeLessThan(100);
  expect(openingLongTasks).toEqual([]);
});
