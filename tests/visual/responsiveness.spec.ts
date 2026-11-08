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

test("opening the page rail keeps toolbar feedback live while thumbnails paint", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const probe = { intentAt: 0, interactions: [] as { label: string; intentAt: number; eventAt: number;
      appliedAt: number; frameAt: number; pressed: string | null }[], longTasks: [] as number[] };
    (window as unknown as { __inkResponsiveness: typeof probe }).__inkResponsiveness = probe;
    if (typeof PerformanceObserver === "function") {
      new PerformanceObserver((list) => probe.longTasks.push(...list.getEntries().map((entry) => entry.duration)))
        .observe({ type: "longtask", buffered: true });
    }
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      const label = target?.getAttribute("aria-label");
      if (label !== "Pages" && label !== "Highlight") return;
      const interaction = { label, intentAt: probe.intentAt, eventAt: performance.now(), appliedAt: 0,
        frameAt: 0, pressed: null as string | null };
      probe.interactions.push(interaction);
      requestAnimationFrame(() => {
        interaction.frameAt = performance.now();
        interaction.pressed = label === "Pages"
          ? document.querySelector<HTMLButtonElement>('button[aria-label="Pages"]')?.getAttribute("aria-pressed") ?? null
          : document.querySelector<HTMLButtonElement>('.ink-tool-button[data-tool="highlighter"]')?.getAttribute("aria-pressed") ?? null;
      });
    }, true);
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      const label = target?.getAttribute("aria-label");
      if (label !== "Pages" && label !== "Highlight") return;
      const interaction = probe.interactions[probe.interactions.length - 1];
      if (!interaction || interaction.label !== label) return;
      interaction.appliedAt = performance.now();
      interaction.pressed = label === "Pages"
        ? document.querySelector<HTMLButtonElement>('button[aria-label="Pages"]')?.getAttribute("aria-pressed") ?? null
        : document.querySelector<HTMLButtonElement>('.ink-tool-button[data-tool="highlighter"]')?.getAttribute("aria-pressed") ?? null;
    });
  });
  await page.goto("/?performance&pages=100");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready"), { timeout: 15_000 }).toBe("true");
  await page.evaluate(() => {
    const probe = (window as unknown as { __inkResponsiveness: { intentAt: number; interactions: unknown[]; longTasks: number[] } })
      .__inkResponsiveness;
    probe.interactions.length = 0;
    probe.longTasks.length = 0;
    probe.intentAt = performance.now();
    document.querySelector<HTMLButtonElement>('button[aria-label="Pages"]')?.click();
    window.setTimeout(() => {
      probe.intentAt = performance.now();
      document.querySelector<HTMLButtonElement>('[aria-label="Highlight"]')?.click();
    }, 0);
    // Exercise a second control while the delayed thumbnail repaint is active.
    window.setTimeout(() => {
      probe.intentAt = performance.now();
      document.querySelector<HTMLButtonElement>('button[aria-label="Pages"]')?.click();
    }, 300);
  });
  await page.waitForFunction(() => {
    const interactions = (window as unknown as { __inkResponsiveness: { interactions: { frameAt: number }[] } })
      .__inkResponsiveness.interactions;
    return interactions.length === 3 && interactions.every((interaction) => interaction.frameAt > 0);
  });
  await page.waitForTimeout(50);
  const result = await page.evaluate(() => {
    const probe = (window as unknown as { __inkResponsiveness: { interactions: {
      label: string; intentAt: number; eventAt: number; appliedAt: number; frameAt: number; pressed: string | null;
    }[]; longTasks: number[] } }).__inkResponsiveness;
    return {
      interactions: probe.interactions.map(({ label, intentAt, eventAt, appliedAt, frameAt, pressed }) => ({
        label, inputDelayMs: eventAt - intentAt, applyDelayMs: appliedAt - eventAt,
        feedbackFrameMs: frameAt - eventAt, pressed,
      })),
      longTasks: probe.longTasks.filter((duration) => duration >= 50),
    };
  });
  expect(result.interactions).toHaveLength(3);
  console.log("rail responsiveness", result.interactions);
  for (const interaction of result.interactions) {
    expect(interaction.inputDelayMs).toBeLessThan(5);
    expect(interaction.applyDelayMs).toBeLessThan(10);
    expect(interaction.feedbackFrameMs).toBeLessThan(45);
  }
  expect(result.interactions[0].pressed).toBe("true");
  expect(result.interactions[1].pressed).toBe("true");
  expect(result.interactions[2].pressed).toBe("false");
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

test("inserting a page and returning to large existing ink stays live while saving", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    const probe = { intentAt: 0, actions: [] as { label: string; intentAt: number; eventAt: number;
      frameAt: number; status: string }[], saveStarted: false, saveDone: false, longTasks: [] as number[] };
    (window as unknown as { __inkInsertProbe: typeof probe }).__inkInsertProbe = probe;
    if (typeof PerformanceObserver === "function") new PerformanceObserver((list) => {
      probe.longTasks.push(...list.getEntries().map((entry) => entry.duration));
    }).observe({ type: "longtask", buffered: true });
    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button") : null;
      const label = button?.getAttribute("aria-label") ?? button?.textContent?.trim();
      if (label !== "Add page after current" && label !== "1: Page 1") return;
      const action = { label, intentAt: probe.intentAt, eventAt: performance.now(), frameAt: 0, status: "" };
      probe.actions.push(action);
      requestAnimationFrame(() => {
        action.frameAt = performance.now();
        action.status = document.querySelector<HTMLElement>(".ink-page-status")?.textContent ?? "";
      });
    }, true);
  });
  await page.goto("/?performance");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true", { timeout: 15_000 });
  await page.evaluate(async () => {
    const win = window as unknown as { __inkInsertProbe: { saveStarted: boolean; saveDone: boolean;
      actions: unknown[]; longTasks: number[] };
      __inkNotesPreview: { view: { workerSession?: { initializationTail?: Promise<void> }; store: {
        writeIfUnchanged: (...args: unknown[]) => Promise<boolean>;
      } } } };
    await win.__inkNotesPreview.view.workerSession?.initializationTail;
    win.__inkInsertProbe.actions.length = 0;
    win.__inkInsertProbe.longTasks.length = 0;
    const store = win.__inkNotesPreview.view.store;
    const write = store.writeIfUnchanged.bind(store);
    store.writeIfUnchanged = async (...args: unknown[]) => {
      win.__inkInsertProbe.saveStarted = true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 800));
      const result = await write(...args);
      win.__inkInsertProbe.saveDone = true;
      return result;
    };
  });
  await page.getByRole("button", { name: "Add page", exact: true }).click();
  await page.evaluate(() => {
    const probe = (window as unknown as { __inkInsertProbe: { intentAt: number } }).__inkInsertProbe;
    const item = Array.from(document.querySelectorAll<HTMLButtonElement>(".preview-menu button"))
      .find((button) => button.textContent?.trim() === "Add page after current");
    probe.intentAt = performance.now();
    item?.click();
  });
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await page.getByRole("button", { name: "Pages", exact: true }).click();
  await page.evaluate(() => {
    const probe = (window as unknown as { __inkInsertProbe: { intentAt: number } }).__inkInsertProbe;
    probe.intentAt = performance.now();
    document.querySelector<HTMLButtonElement>('button[aria-label="1: Page 1"]')?.click();
  });
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
  await page.waitForFunction(() => (window as unknown as { __inkInsertProbe: { saveStarted: boolean } })
    .__inkInsertProbe.saveStarted);
  const result = await page.evaluate(() => (window as unknown as { __inkInsertProbe: {
    actions: { label: string; intentAt: number; eventAt: number; frameAt: number; status: string }[];
    saveStarted: boolean; saveDone: boolean; longTasks: number[];
  } }).__inkInsertProbe);
  expect(result.actions).toHaveLength(2);
  expect(result.actions[0].eventAt - result.actions[0].intentAt).toBeLessThan(5);
  expect(result.actions[1].eventAt - result.actions[1].intentAt).toBeLessThan(5);
  expect(result.actions[0].frameAt - result.actions[0].eventAt).toBeLessThan(20);
  expect(result.actions[1].frameAt - result.actions[1].eventAt).toBeLessThan(20);
  expect(result.actions[0].status).toBe("2 / 2");
  expect(result.actions[1].status).toBe("1 / 2");
  expect(result.saveStarted).toBe(true);
  expect(result.saveDone).toBe(false);
  expect(result.longTasks.filter((duration) => duration >= 50)).toEqual([]);
});

test("opening feedback appears in one frame and toolbar input stays live", async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { startedAt: 0, visibleFrameAt: 0, clickAt: 0, clickAppliedAt: 0, clickFrameAt: 0,
      longTasks: [] as { start: number; duration: number }[] };
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
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (target?.getAttribute("aria-label") === "Highlight") probe.clickAppliedAt = performance.now();
    });
  });
  await page.goto("/?performance");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready"), { timeout: 15_000 }).toBe("true");
  await page.evaluate(() => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    const store = view.store;
    const readRawSnapshot = store.readRawSnapshot.bind(store);
    store.readRawSnapshot = async (...args: unknown[]) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      return readRawSnapshot(...args);
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
    startedAt: number; visibleFrameAt: number; clickAt: number; clickAppliedAt: number; clickFrameAt: number;
    longTasks: { start: number; duration: number }[];
  } }).__inkLoadProbe);
  expect(result.visibleFrameAt - result.startedAt).toBeLessThan(20);
  expect(result.clickAppliedAt - result.clickAt).toBeLessThan(10);
  expect(result.clickFrameAt - result.clickAt).toBeLessThan(35);
  expect(result.longTasks.filter((task) => task.duration >= 50)).toEqual([]);
  await expect(page.locator(".ink-notes-view")).toHaveAttribute("aria-busy", "false", { timeout: 5_000 });
  await expect(page.locator(".ink-notebook-load-feedback")).toBeHidden();
});

test("reopening a large notebook paints visible ink and services input within strict latency budgets", async ({ page }) => {
  await page.addInitScript(() => {
    const probe = { openAt: 0, rawReadAt: 0, feedbackAt: 0, firstTileAt: 0, firstInkFrameAt: 0, fullTileAt: 0, inkStableFrameAt: 0,
      clickTaskAt: 0, clickAppliedAt: 0, highlighterPressed: false, feedbackShownSynchronously: false,
      stages: [] as { name: string; duration: number }[],
      longTasks: [] as { start: number; duration: number }[] };
    (window as unknown as { __inkOpenProbe: typeof probe }).__inkOpenProbe = probe;
    if (typeof PerformanceObserver === "function") new PerformanceObserver((list) => {
      probe.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
    }).observe({ type: "longtask", buffered: true });
    const scheduledInkChecks = new WeakSet<HTMLElement>();
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof HTMLElement ? record.target : null;
        if (target?.matches(".ink-notebook-load-feedback") && !target.hidden && probe.feedbackAt === 0) {
          probe.feedbackAt = performance.now();
          requestAnimationFrame(() => window.setTimeout(() => {
            probe.clickTaskAt = performance.now();
            document.querySelector<HTMLButtonElement>('[aria-label="Highlight"]')?.click();
            probe.highlighterPressed = document.querySelector<HTMLButtonElement>(
              '.ink-tool-button[data-tool="highlighter"]')?.getAttribute("aria-pressed") === "true";
            probe.clickAppliedAt = performance.now();
          }, 0));
        }
        const layers = new Set<HTMLElement>();
        if (target?.matches(".ink-tile-layer")) layers.add(target);
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const layer = node.matches(".ink-tile-layer") ? node : node.querySelector<HTMLElement>(".ink-tile-layer");
          if (layer) layers.add(layer);
        }
        for (const layer of layers) {
          if (!layer.childElementCount) continue;
          if (probe.firstTileAt === 0) probe.firstTileAt = performance.now();
          const scrollerRect = document.querySelector<HTMLElement>(".ink-page-scroller")?.getBoundingClientRect();
          const visibleCanvases = Array.from(layer.querySelectorAll<HTMLCanvasElement>("canvas")).filter((canvas) => {
            const rect = canvas.getBoundingClientRect();
            if (!scrollerRect || rect.width <= 0 || rect.height <= 0 || rect.right <= scrollerRect.left
              || rect.left >= scrollerRect.right || rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) return false;
            const cssWidth = Number.parseFloat(canvas.style.width);
            if (cssWidth > 0 && canvas.width / cssWidth >= 0.9 && probe.fullTileAt === 0) probe.fullTileAt = performance.now();
            return true;
          });
          if (visibleCanvases.length === 0 || probe.inkStableFrameAt > 0 || scheduledInkChecks.has(layer)) continue;
          scheduledInkChecks.add(layer);
          requestAnimationFrame(() => {
            scheduledInkChecks.delete(layer);
            const currentInk = Array.from(layer.querySelectorAll<HTMLCanvasElement>("canvas")).some((canvas) => {
              const rect = canvas.getBoundingClientRect();
              return canvas.isConnected && canvas.width > 0 && !!scrollerRect && rect.width > 0 && rect.height > 0
                && rect.right > scrollerRect.left && rect.left < scrollerRect.right
                && rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
            });
            if (!currentInk) return;
            if (probe.firstInkFrameAt === 0) probe.firstInkFrameAt = performance.now();
            requestAnimationFrame(() => {
              const stableInk = Array.from(layer.querySelectorAll<HTMLCanvasElement>("canvas")).some((canvas) => {
                const rect = canvas.getBoundingClientRect();
                return canvas.isConnected && canvas.width > 0 && !!scrollerRect && rect.width > 0 && rect.height > 0
                  && rect.right > scrollerRect.left && rect.left < scrollerRect.right
                  && rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
              });
              if (stableInk) probe.inkStableFrameAt = performance.now();
            });
          });
        }
      }
    }).observe(document, { attributes: true, childList: true, subtree: true, attributeFilter: ["hidden"] });
  });
  await page.goto("/?performance");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true", { timeout: 15_000 });
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const win = window as unknown as { __inkOpenProbe: {
      openAt: number; rawReadAt: number; feedbackAt: number; firstTileAt: number; firstInkFrameAt: number; fullTileAt: number; inkStableFrameAt: number;
      clickTaskAt: number; clickAppliedAt: number; highlighterPressed: boolean; feedbackShownSynchronously: boolean;
      stages: { name: string; duration: number }[]; longTasks: { start: number; duration: number }[];
    }; __inkNotesPreview: { view: any } };
    const probe = win.__inkOpenProbe;
    const view = win.__inkNotesPreview.view;
    const measured = (name: string, target: any, method: string) => {
      const original = target[method].bind(target);
      target[method] = (...args: unknown[]) => {
        const started = performance.now();
        const value = original(...args);
        probe.stages.push({ name, duration: performance.now() - started });
        return value;
      };
    };
    measured("renderPageRail", view, "renderPageRail");
    measured("renderPage", view, "renderPage");
    measured("renderAll", view, "renderAll");
    measured("tile.setPage", view.tiles, "setPage");
    measured("tile.update", view.tiles, "update");
    const readRawSnapshot = view.store.readRawSnapshot.bind(view.store);
    view.store.readRawSnapshot = async (...args: unknown[]) => {
      const raw = await readRawSnapshot(...args);
      probe.rawReadAt = performance.now();
      return raw;
    };
    probe.openAt = performance.now();
    probe.feedbackAt = 0;
    probe.stages.length = 0;
    probe.longTasks.length = 0;
    probe.firstTileAt = 0;
    probe.firstInkFrameAt = 0;
    probe.fullTileAt = 0;
    probe.inkStableFrameAt = 0;
    void view.onLoadFile(view.file);
    const overlay = document.querySelector<HTMLElement>(".ink-notebook-load-feedback");
    probe.feedbackShownSynchronously = !!overlay && !overlay.hidden;
  });
  await page.waitForFunction(() => (window as unknown as { __inkOpenProbe: { firstInkFrameAt: number } })
    .__inkOpenProbe.firstInkFrameAt > 0, undefined, { timeout: 5_000 });
  await page.waitForFunction(() => (window as unknown as { __inkOpenProbe: { fullTileAt: number } })
    .__inkOpenProbe.fullTileAt > 0, undefined, { timeout: 5_000 });
  const result = await page.evaluate(() => (window as unknown as { __inkOpenProbe: {
    openAt: number; rawReadAt: number; feedbackAt: number; firstTileAt: number; firstInkFrameAt: number; fullTileAt: number; inkStableFrameAt: number;
    clickTaskAt: number; clickAppliedAt: number; highlighterPressed: boolean; feedbackShownSynchronously: boolean;
    stages: { name: string; duration: number }[];
    longTasks: { start: number; duration: number }[];
  } }).__inkOpenProbe);
  await page.waitForTimeout(50);
  const inkVisibleMs = result.firstInkFrameAt - result.openAt;
  const clickReadyMs = result.clickTaskAt - result.feedbackAt;
  const openingLongTasks = result.longTasks.filter((task) => task.start >= result.openAt && task.start < result.firstInkFrameAt);
  console.log("large notebook reopen", { openToFeedbackMs: result.feedbackAt - result.openAt,
    openToRawReadMs: result.rawReadAt - result.openAt,
    feedbackToTileMs: result.firstTileAt - result.feedbackAt,
    feedbackToInkMs: result.firstInkFrameAt - result.feedbackAt, inkVisibleMs,
    fullTileMs: result.fullTileAt - result.openAt, clickReadyMs, stages: result.stages,
    clickApplyMs: result.clickAppliedAt - result.clickTaskAt,
    longTasks: openingLongTasks.map((task) => Math.round(task.duration)) });
  expect(result.feedbackAt).toBeGreaterThan(0);
  expect(result.feedbackShownSynchronously).toBe(true);
  expect(result.firstTileAt).toBeGreaterThan(0);
  expect(result.inkStableFrameAt).toBeGreaterThan(result.firstInkFrameAt);
  expect(result.highlighterPressed).toBe(true);
  expect(result.firstTileAt - result.feedbackAt).toBeLessThan(25);
  expect(inkVisibleMs).toBeLessThan(50);
  expect(result.fullTileAt - result.openAt).toBeLessThan(80);
  expect(clickReadyMs).toBeLessThan(50);
  expect(result.clickAppliedAt - result.clickTaskAt).toBeLessThan(5);
  expect(Math.max(...result.stages.map((stage) => stage.duration))).toBeLessThan(16.7);
  expect(openingLongTasks.filter((task) => task.duration >= 50)).toEqual([]);
});

test("large notebook paints visible ink and keeps input live without Worker", async ({ page }) => {
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
    const probe = { workerUnavailable: false, loadCallAt: 0, feedbackAt: 0, clickTaskAt: 0,
      feedbackShownSynchronously: false, feedbackSyncMs: 0, clickDurationMs: 0, fullTileAt: 0,
      highlighterPressedAfterClick: false, firstTileAt: 0, firstInkAt: 0, inkStableAt: 0,
      longTasks: [] as { start: number; duration: number }[] };
    (window as unknown as { __inkFallbackProbe: typeof probe }).__inkFallbackProbe = probe;
    if (typeof PerformanceObserver === "function") new PerformanceObserver((list) => {
      probe.longTasks.push(...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })));
    }).observe({ type: "longtask", buffered: true });
    const scheduledInkChecks = new WeakSet<HTMLElement>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof HTMLElement ? record.target : null;
        if (target?.matches(".ink-notebook-load-feedback") && !target.hidden && probe.feedbackAt === 0) {
          probe.feedbackAt = performance.now();
          requestAnimationFrame(() => window.setTimeout(() => {
            probe.clickTaskAt = performance.now();
            const button = document.querySelector<HTMLButtonElement>('[aria-label="Highlight"]');
            const clickStartedAt = performance.now();
            button?.click();
            probe.clickDurationMs = performance.now() - clickStartedAt;
            probe.highlighterPressedAfterClick = button?.getAttribute("aria-pressed") === "true";
          }, 0));
        }
        const layers = new Set<HTMLElement>();
        if (target?.matches(".ink-tile-layer")) layers.add(target);
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLElement)) continue;
          const layer = node.matches(".ink-tile-layer") ? node : node.querySelector<HTMLElement>(".ink-tile-layer");
          if (layer) layers.add(layer);
        }
        for (const layer of layers) {
          if (!layer.childElementCount) continue;
          if (probe.firstTileAt === 0) probe.firstTileAt = performance.now();
          const scroller = document.querySelector<HTMLElement>(".ink-page-scroller");
          const scrollerRect = scroller?.getBoundingClientRect();
          const visibleCanvases = Array.from(layer.querySelectorAll<HTMLCanvasElement>("canvas")).filter((canvas) => {
            const rect = canvas.getBoundingClientRect();
            if (!scrollerRect || rect.width <= 0 || rect.height <= 0 || rect.right <= scrollerRect.left
              || rect.left >= scrollerRect.right || rect.bottom <= scrollerRect.top || rect.top >= scrollerRect.bottom) return false;
            const cssWidth = Number.parseFloat(canvas.style.width);
            if (cssWidth > 0 && canvas.width / cssWidth >= 0.9 && probe.fullTileAt === 0) probe.fullTileAt = performance.now();
            return true;
          });
          if (visibleCanvases.length === 0 || probe.inkStableAt > 0 || scheduledInkChecks.has(layer)) continue;
          scheduledInkChecks.add(layer);
          requestAnimationFrame(() => {
            scheduledInkChecks.delete(layer);
            const currentInk = Array.from(layer.querySelectorAll<HTMLCanvasElement>("canvas")).some((canvas) => {
              const rect = canvas.getBoundingClientRect();
              return canvas.isConnected && canvas.width > 0 && !!scrollerRect && rect.width > 0 && rect.height > 0
                && rect.right > scrollerRect.left && rect.left < scrollerRect.right
                && rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
            });
            if (!currentInk) return;
            if (probe.firstInkAt === 0) probe.firstInkAt = performance.now();
            requestAnimationFrame(() => {
              const stableInk = Array.from(layer.querySelectorAll<HTMLCanvasElement>("canvas")).some((canvas) => {
                const rect = canvas.getBoundingClientRect();
                return canvas.isConnected && canvas.width > 0 && !!scrollerRect && rect.width > 0 && rect.height > 0
                  && rect.right > scrollerRect.left && rect.left < scrollerRect.right
                  && rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom;
              });
              if (stableInk) probe.inkStableAt = performance.now();
            });
          });
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
      clickTaskAt: number; clickDurationMs: number; highlighterPressedAfterClick: boolean;
      firstTileAt: number; firstInkAt: number; inkStableAt: number; fullTileAt: number;
      longTasks: { start: number; duration: number }[];
    } }).__inkFallbackProbe;
    probe.firstTileAt = 0;
    probe.firstInkAt = 0;
    probe.inkStableAt = 0;
    probe.fullTileAt = 0;
    probe.feedbackAt = 0;
    probe.clickTaskAt = 0;
    probe.longTasks.length = 0;
    const view = (window as unknown as { __inkNotesPreview: { view: { file: unknown; onLoadFile(file: unknown): Promise<void> } } })
      .__inkNotesPreview.view;
    probe.loadCallAt = performance.now();
    void view.onLoadFile(view.file);
    const overlay = document.querySelector<HTMLElement>(".ink-notebook-load-feedback");
    const root = document.querySelector<HTMLElement>(".ink-notes-view");
    probe.feedbackShownSynchronously = !!overlay && !overlay.hidden && root?.getAttribute("aria-busy") === "true";
    probe.feedbackSyncMs = performance.now() - probe.loadCallAt;

  });
  await page.waitForFunction(() => (window as unknown as { __inkFallbackProbe: { firstInkAt: number } })
    .__inkFallbackProbe.firstInkAt > 0, undefined, { timeout: 5_000 });
  await page.waitForFunction(() => (window as unknown as { __inkFallbackProbe: { fullTileAt: number } })
    .__inkFallbackProbe.fullTileAt > 0, undefined, { timeout: 5_000 });
  await page.waitForTimeout(50);
  const result = await page.evaluate(() => (window as unknown as { __inkFallbackProbe: {
    workerUnavailable: boolean; loadCallAt: number; feedbackAt: number; feedbackShownSynchronously: boolean; fullTileAt: number;
    feedbackSyncMs: number; clickTaskAt: number; clickDurationMs: number; highlighterPressedAfterClick: boolean;
    firstTileAt: number; firstInkAt: number; inkStableAt: number;
    longTasks: { start: number; duration: number }[];
  } }).__inkFallbackProbe);
  const openingLongTasks = result.longTasks.filter((task) => task.start >= result.loadCallAt && task.start < result.firstInkAt);
  const openToInkMs = result.firstInkAt - result.loadCallAt;
  const clickReadyMs = result.clickTaskAt - result.feedbackAt;
  console.log("large notebook without Worker", { openToInkMs, feedbackToTileMs: result.firstTileAt - result.feedbackAt,
    clickReadyMs, fullTileMs: result.fullTileAt - result.loadCallAt, clickDurationMs: result.clickDurationMs,
    longTasks: openingLongTasks.map((task) => Math.round(task.duration)) });
  expect(result.workerUnavailable).toBe(true);
  expect(result.feedbackShownSynchronously).toBe(true);
  expect(result.feedbackSyncMs).toBeLessThan(5);
  expect(result.highlighterPressedAfterClick).toBe(true);
  expect(result.clickDurationMs).toBeLessThan(5);
  expect(result.firstTileAt).toBeGreaterThan(0);
  expect(result.inkStableAt).toBeGreaterThan(result.firstInkAt);
  expect(result.firstTileAt - result.feedbackAt).toBeLessThan(25);
  expect(openToInkMs).toBeLessThan(50);
  expect(result.fullTileAt - result.loadCallAt).toBeLessThan(80);
  expect(clickReadyMs).toBeLessThan(50);
  expect(openingLongTasks.filter((task) => task.duration >= 50)).toEqual([]);
});
