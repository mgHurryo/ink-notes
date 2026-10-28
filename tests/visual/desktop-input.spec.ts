import { expect, test } from "@playwright/test";

for (const mode of ["ink", "pdf"] as const) {
for (const reducedMotion of ["no-preference", "reduce"] as const) {
test(`${mode}, ${reducedMotion}: vertical native wheel scrolls the page, then flips at its boundary and returns to the previous bottom`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async (mode) => {
    if (mode === "pdf") await (window as any).__inkNotesPreview.openPdf();
    const view = (window as any).__inkNotesPreview.view;
    if (mode === "ink") {
      view.duplicateCurrentPage();
      await view.navigateToPage(view.notebook.pages[0].id);
    } else {
      view.addBlankPage(1); await view.navigatePages(-view.noteIndex);
    }
    view.setZoom(2); view.zoomLocked = true;
    const scroller = view.inputScroller() as HTMLElement;
    scroller.scrollTop = 100;
  }, mode);
  const scroller = page.locator(mode === "ink" ? ".ink-page-scroller" : ".ink-pdf-scroller");
  const status = page.locator(mode === "ink" ? ".ink-page-status" : ".ink-pdf-page-indicator");
  const box = await scroller.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 120);
  await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
  await expect(status).toHaveText("1 / 2");
  await scroller.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await page.mouse.wheel(0, 140);
  await expect(status).toHaveText("2 / 2");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  expect(await scroller.evaluate(el => el.scrollTop)).toBe(0);
  await page.mouse.wheel(0, -140);
  await expect(status).toHaveText("1 / 2");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect.poll(() => scroller.evaluate(el => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)))).toBeLessThan(2);
});
}
}

for (const mode of ["ink", "pdf"] as const) {
  test(`${mode}: small desktop scrolls keep the mounted handwriting tiles`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    // Empty visible cells skip rasterization, so the blank PDF fixture mounts
    // no tiles on its own; draw ink first to exercise real mounted tiles.
    if (mode === "pdf") {
      await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
      await page.evaluate(() => { (window as any).__inkNotesPreview.view.state.tool = "pen"; });
      const page0 = await page.locator(".ink-page").boundingBox();
      if (!page0) throw new Error("Ink page has no layout box");
      await page.mouse.move(page0.x + page0.width * 0.25, page0.y + page0.height * 0.4);
      await page.mouse.down();
      await page.mouse.move(page0.x + page0.width * 0.7, page0.y + page0.height * 0.45, { steps: 10 });
      await page.mouse.up();
      await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.pendingInkStrokes.length)).toBe(0);
    }
    const result = await page.evaluate(async (mode) => {
      const view = (window as any).__inkNotesPreview.view;
      const scroller = document.querySelector<HTMLElement>(mode === "ink" ? ".ink-page-scroller" : ".ink-pdf-scroller")!;
      const layer = document.querySelector<HTMLElement>(".ink-tile-layer")!;
      scroller.scrollTop = 20;
      for (let attempt = 0; attempt < 50; attempt++) {
        if (view.tiles.jobs.length === 0 && view.tiles.pendingTiles.size === 0) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const before = [...view.tiles.visible];
      let changes = 0;
      const observer = new MutationObserver((records) => { changes += records.reduce((sum, record) => sum + record.addedNodes.length + record.removedNodes.length, 0); });
      observer.observe(layer, { childList: true });
      scroller.scrollTop += 1;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      observer.disconnect();
      return { changes, tiles: layer.childElementCount, before, after: [...view.tiles.visible] };
    }, mode);
    expect(result.tiles).toBeGreaterThan(0);
    expect(result.after).toEqual(result.before);
    expect(result.changes).toBe(0);
  });
}

test("separate trackpad flicks and page keys queue while the previous page is still saving", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = window as any, view = scope.__inkNotesPreview.view;
    for (let i = 1; i < 5; i++) view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const barrier = view.workerSession.barrier.bind(view.workerSession);
    let held = false;
    view.workerSession.barrier = async (revision: number) => {
      await barrier(revision);
      if (!held) { held = true; await new Promise<void>(resolve => { scope.releaseWheelBarrier = resolve; }); }
    };
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.focus();
    scope.flick = (direction = 1) => {
      for (const deltaX of [140, 90, 60, 30, 10, 4]) scroller.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaX: direction * deltaX,
      }));
    };
    scope.flick();
    document.getAnimations().forEach(animation => animation.finish());
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseWheelBarrier)).toBe("function");
  await page.waitForTimeout(200);
  await page.evaluate(async () => {
    (window as any).flick();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
    (window as any).flick();
    await new Promise<void>(resolve => setTimeout(resolve, 200));
  });
  await page.keyboard.press("PageDown");
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 5");
  await page.evaluate(() => (window as any).releaseWheelBarrier());
  await expect(page.locator(".ink-page-status")).toHaveText("5 / 5");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  // Reverse without waiting for a quiet wheel interval.
  await page.evaluate(() => (window as any).flick(-1));
  await expect(page.locator(".ink-page-status")).toHaveText("4 / 5");
});

test("desktop mouse middle button and space drag pan without creating ink", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  const state = await page.evaluate(() => {
    const scope = window as unknown as { __inkNotesPreview: { view: any } };
    const view = scope.__inkNotesPreview.view;
    view.setZoom(2);
    const pageEl = document.querySelector<HTMLElement>(".ink-page")!;
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = 100; scroller.scrollTop = 100;
    return { before: view.notebook.pages[0].strokes.length, page: scroller.getBoundingClientRect(), scroll: { x: scroller.scrollLeft, y: scroller.scrollTop } };
  });
  const x = state.page.left + state.page.width / 2, y = state.page.top + state.page.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x - 80, y - 50);
  await page.mouse.up({ button: "middle" });
  const middle = await page.evaluate(() => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    return { strokes: view.notebook.pages[0].strokes.length, x: scroller.scrollLeft, y: scroller.scrollTop };
  });
  expect(middle.strokes).toBe(state.before);
  expect(middle.x).toBeGreaterThan(state.scroll.x);
  expect(middle.y).toBeGreaterThan(state.scroll.y);
  await page.keyboard.down("Space");
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y - 25);
  await page.mouse.up();
  await page.keyboard.up("Space");
  const space = await page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.notebook.pages[0].strokes.length);
  expect(space).toBe(state.before);
  await page.mouse.move(x - 100, y - 100);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x - 80, y - 80);
  await page.mouse.up({ button: "right" });
  expect(await page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.notebook.pages[0].strokes.length)).toBe(state.before);
  await page.mouse.move(x - 100, y - 100);
  await page.mouse.down();
  await page.mouse.move(x - 70, y - 80);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.notebook.pages[0].strokes.length)).toBe(state.before + 1);
});

test("keyboard page navigation, zoom, history and tool shortcuts stay in the editor", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    document.querySelector<HTMLElement>(".ink-page-scroller")!.focus();
  });
  await page.keyboard.press("PageDown");
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await page.keyboard.press("Home");
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
  await page.keyboard.press("Control+=");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.zoom)).toBe(1.1);
  await page.keyboard.press("0");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.zoom)).toBe(1);
  await page.keyboard.press("e");
  await expect(page.getByRole("button", { name: "Erase", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("b");
  await expect(page.getByRole("button", { name: "Pen", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+z");
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 1");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
});

test("touchpad-like ctrl wheel zooms at the cursor and horizontal wheel flips once per burst", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
  });
  const pageEl = page.locator(".ink-page");
  const box = await pageEl.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -80);
  await page.keyboard.up("Control");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view.zoom)).toBeGreaterThan(1);
  const scroller = page.locator(".ink-page-scroller");
  await scroller.evaluate((el) => { el.scrollLeft = el.scrollWidth - el.clientWidth; });
  await page.mouse.wheel(140, 0);
  await page.mouse.wheel(140, 0);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await page.mouse.wheel(140, 0);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
});

test("horizontal trackpad input passes a vertically scrollable nested target", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
    const nested = document.createElement("div");
    nested.style.cssText = "position: absolute; width: 100px; height: 2000px; overflow-y: auto; overflow-x: hidden";
    scroller.append(nested);
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 140, deltaY: 140 });
    nested.dispatchEvent(event);
    (window as any).nestedHorizontalWheelPrevented = event.defaultPrevented;
  });
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await expect.poll(() => page.evaluate(() => (window as any).nestedHorizontalWheelPrevented)).toBe(true);
});

test("horizontal trackpad input turns pages instead of scrolling the fit page", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    view.setZoom(1);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = 0;
    const wideContent = document.createElement("div");
    wideContent.style.cssText = "position: absolute; left: 0; top: 0; width: 3000px; height: 1px; pointer-events: none";
    scroller.append(wideContent);
    (window as any).trackpadHorizontalRange = scroller.scrollWidth - scroller.clientWidth;
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 140 });
    scroller.dispatchEvent(event);
    (window as any).trackpadHorizontalWheelPrevented = event.defaultPrevented;
  });
  await expect.poll(() => page.evaluate(() => (window as any).trackpadHorizontalRange)).toBeGreaterThan(140);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await expect.poll(() => page.evaluate(() => (window as any).trackpadHorizontalWheelPrevented)).toBe(true);
});

test("horizontal wheel still pans zoomed content before turning at the edge", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    view.setZoom(2);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = 0;
    const send = () => scroller.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaX: 140,
    }));
    (window as any).zoomedHorizontalRange = scroller.scrollWidth - scroller.clientWidth;
    send();
    (window as any).zoomedHorizontalPan = scroller.scrollLeft;
    (window as any).sendHorizontalAtEdge = () => {
      scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
      send();
    };
  });
  await expect.poll(() => page.evaluate(() => (window as any).zoomedHorizontalRange)).toBeGreaterThan(140);
  await expect.poll(() => page.evaluate(() => (window as any).zoomedHorizontalPan)).toBeGreaterThan(0);
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
  await page.evaluate(() => (window as any).sendHorizontalAtEdge());
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
});

test("a trackpad flick advances one page and fast mouse-wheel notches are dampened", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    for (let index = 1; index < 6; index++) view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = scroller.scrollWidth;
    // The tail must decay monotonically: since #264 a mid-tail sample jumping
    // over the decayed envelope is contracted as a renewed flick and flips a
    // second page, so a rising tail would make this burst two gestures.
    for (const deltaX of [140, 90, 60, 30, 20, 14, 10]) scroller.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaX,
    }));
  });
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 6");

  await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    await view.navigateToPage(view.notebook.pages[0].id);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollTop = scroller.scrollHeight;
    // One synchronous task hands all five notches the same real Event.timeStamp;
    // a colliding 0ms gap keeps notch sensitivity at 1.0, so pin the 40ms
    // cadence the 0.8 damping expects. The sub-180ms stream stays one gesture,
    // so the discrete per-gesture page budget caps the burst at two pages.
    for (let index = 0; index < 5; index++) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      Object.defineProperty(event, "timeStamp", { configurable: true, value: 10000 + index * 40 });
      scroller.dispatchEvent(event);
    }
  });
  await expect(page.locator(".ink-page-status")).toHaveText("3 / 6");
});

test("repeated horizontal trackpad swipes rearm and queued wheel pages each animate", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = window as any, view = scope.__inkNotesPreview.view;
    for (let index = 1; index < 8; index++) view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
    let timeStamp = 100;
    const send = (deltaX: number, at: number) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX });
      Object.defineProperty(event, "timeStamp", { configurable: true, value: at });
      scroller.dispatchEvent(event);
    };
    for (const delta of [140, 90, 60, 30, 10, 4]) send(delta, timeStamp += 10);
    send(140, timeStamp + 60);
  });
  await expect(page.locator(".ink-page-status")).toHaveText("3 / 8");

  await page.evaluate(() => {
    const scope = window as any;
    const originalAnimate = Element.prototype.animate;
    scope.pageSwipeAnimationCount = 0;
    scope.pageSwipeAnimationDurations = [];
    Element.prototype.animate = function (...args: Parameters<Element["animate"]>) {
      if (this.classList.contains("ink-page-extent")) {
        scope.pageSwipeAnimationCount++;
        scope.pageSwipeAnimationDurations.push((args[1] as KeyframeAnimationOptions).duration);
      }
      return originalAnimate.apply(this, args);
    };
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    for (let index = 0; index < 8; index++) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
      Object.defineProperty(event, "timeStamp", { configurable: true, value: 300 + index * 100 });
      scroller.dispatchEvent(event);
    }
  });
  // The 100ms cadence stays one gesture (the idle boundary is 180ms), so the
  // discrete per-gesture page budget queues two page swipes; each still
  // animates, the first at its travel-derived duration, the follow-up at the
  // 64ms floor.
  await expect(page.locator(".ink-page-status")).toHaveText("5 / 8");
  await expect.poll(() => page.evaluate(() => (window as any).pageSwipeAnimationCount)).toBe(2);
  const durations = await page.evaluate(() => (window as any).pageSwipeAnimationDurations as number[]);
  expect(durations[0]).toBeGreaterThan(64);
  expect(durations.slice(1)).toEqual([64]);
});

test("separate renewed trackpad swipes each get a fresh two-page limit", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    for (let index = 1; index < 6; index++) view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
    const samples: Array<[number, number]> = [
      [140, 100], [90, 110], [60, 120], [30, 130], [10, 140], [4, 150], [140, 210],
      [90, 220], [60, 230], [30, 240], [10, 250], [4, 260], [140, 320],
    ];
    for (const [deltaX, timeStamp] of samples) {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX });
      Object.defineProperty(event, "timeStamp", { configurable: true, value: timeStamp });
      scroller.dispatchEvent(event);
    }
  });
  await expect(page.locator(".ink-page-status")).toHaveText("4 / 6");
});

test("desktop reader drag flips at the page edge without waiting on the animation", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as unknown as { __inkNotesPreview: { view: any } }).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
  });
  await page.getByRole("button", { name: "Reading mode" }).click();
  const box = await page.locator(".ink-page").boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - box!.width * 0.7, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  // A second drag starts immediately after the first settle and must still
  // reach the edge rather than being discarded by the previous animation.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + box!.width * 0.7, y, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
});

test("desktop wheel zoom keeps mounted ink stable until the burst ends", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await expect.poll(() => page.locator(".ink-tile-layer canvas").count()).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    const scope = window as any;
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scope.wheelTiles = new Map(Array.from(document.querySelectorAll<HTMLElement>(".ink-tile-layer [data-cell]"))
      .map(tile => [tile.dataset.cell, tile]));
    scope.sendDesktopZoom = () => {
      const rect = scroller.getBoundingClientRect();
      scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY: -20, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
    };
  });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => (window as any).sendDesktopZoom());
    await page.waitForTimeout(70);
    const replaced = await page.evaluate(() => {
      const initial = (window as any).wheelTiles as Map<string, Element>;
      return Array.from(document.querySelectorAll<HTMLElement>(".ink-tile-layer [data-cell]"))
        .filter(tile => initial.has(tile.dataset.cell!) && initial.get(tile.dataset.cell!) !== tile).length;
    });
    expect(replaced).toBe(0);
  }
  await expect(page.locator(".ink-page-extent > .ink-page")).toHaveCSS("transform", "none");
  const inkPixels = await page.locator(".ink-tile-layer canvas").evaluateAll((canvases: HTMLCanvasElement[]) => {
    let pixels = 0;
    for (const canvas of canvases) {
      const copy = document.createElement("canvas");
      copy.width = canvas.width; copy.height = canvas.height;
      const ctx = copy.getContext("2d")!;
      ctx.drawImage(canvas, 0, 0);
      const data = ctx.getImageData(0, 0, copy.width, copy.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i]) pixels++;
    }
    return pixels;
  });
  expect(inkPixels).toBeGreaterThan(0);
  await page.screenshot({ path: "test-results/desktop-wheel-zoom.png" });
});

test("a zoomed mouse pan continues into a page swipe at the edge and cancellation rebounds", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as any).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    view.setReadingMode(true);
    view.setZoom(2);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scroller.scrollLeft = scroller.scrollWidth;
    scroller.scrollLeft -= 100;
  });
  const box = await page.locator(".ink-page-scroller").boundingBox();
  const x = box!.x + box!.width * 0.9, y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 800, y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await page.mouse.move(x - 700, y);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 5 });
  await page.evaluate(() => {
    const view = (window as any).__inkNotesPreview.view;
    const pointerId = view.desktopPan.pointerId;
    document.dispatchEvent(new PointerEvent("pointercancel", { pointerId, pointerType: "mouse", bubbles: true }));
  });
  await page.mouse.up();
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await expect(page.locator(".ink-page-extent")).toHaveCSS("transform", "none");
});

test("separate trackpad bursts keep every destination across a slow notebook save barrier", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = window as any;
    const view = scope.__inkNotesPreview.view;
    for (let i = 1; i < 6; i++) view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const barrier = view.workerSession.barrier.bind(view.workerSession);
    let held = false;
    view.workerSession.barrier = async (revision: number) => {
      await barrier(revision);
      if (!held) {
        held = true;
        await new Promise<void>(resolve => { scope.releaseDesktopBarrier = resolve; });
      }
    };
    scope.sendPageWheel = () => document.querySelector(".ink-page-scroller")!.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaX: 150, deltaY: 0,
    }));
    scope.sendPageWheel();
    document.getAnimations().forEach(animation => animation.finish());
  });
  await expect.poll(() => page.evaluate(() => typeof (window as any).releaseDesktopBarrier)).toBe("function");
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(220);
    await page.evaluate(() => (window as any).sendPageWheel());
  }
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 6");
  await page.evaluate(() => (window as any).releaseDesktopBarrier());
  await expect(page.locator(".ink-page-status")).toHaveText("5 / 6");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
});
