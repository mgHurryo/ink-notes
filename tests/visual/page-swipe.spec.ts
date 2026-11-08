import { expect, test, type Page } from "@playwright/test";
import type { InkNotebook } from "../../src/model";

interface SwipeView {
  notebook: InkNotebook;
  pageIndex: number;
  zoom: number;
  duplicateCurrentPage(): void;
  navigateToPage(id: string): Promise<void>;
  setZoom(value: number): void;
  swipeDrag(offset: number): void;
  swipeSettle(delta: number): void;
  destroySwipeStage(): void;
  flipSettling: boolean;
  dirtyRevision: number;
  savedRevision: number;
  activeSave: Promise<void> | null;
  save(file?: unknown): Promise<void>;
}

interface RapidSwipeScope {
  __inkNotesPreview: { view: SwipeView };
  swipeTest(delta: number, lift?: boolean): void;
  releaseSave?: () => void;
  saveStarted?: boolean;
  saveDone?: boolean;
}

async function prepareRapidSwipes(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    for (let index = 1; index < 8; index++) view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    scope.swipeTest = (delta, lift = true) => {
      const rect = scroller.getBoundingClientRect();
      const send = (type: string, x?: number) => {
        const touches = x === undefined ? [] : [new Touch({ identifier: 1, target: scroller,
          clientX: x, clientY: rect.top + 150 })];
        scroller.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches,
          bubbles: true, cancelable: true }));
      };
      send("touchstart", rect.left + rect.width / 2);
      send("touchmove", rect.left + rect.width / 2 - delta * rect.width * 0.7);
      if (lift) send("touchend");
    };
  });
}

test("a burst of real touch gestures interrupts animation and keeps every swipe", async ({ page }) => {
  await prepareRapidSwipes(page);
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    for (let index = 0; index < 6; index++) scope.swipeTest(1);
  });
  await expect(page.locator(".ink-page-status")).toHaveText("7 / 8");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    // Clamp at the last page, then immediately reverse twice.
    for (const delta of [1, 1, 1, -1, -1]) scope.swipeTest(delta);
  });
  await expect(page.locator(".ink-page-status")).toHaveText("6 / 8");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect(page.locator(".ink-page-extent")).toHaveCSS("transform", "none");
});

test("a notebook page switch resets the incoming page to 100%", async ({ page }) => {
  await prepareRapidSwipes(page);
  const before = await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
    view.setZoom(2);
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth;
    return { width: document.querySelector<HTMLElement>(".ink-page")!.style.width,
      scrollLeft: scroller.scrollLeft };
  });
  expect(before.width).not.toBe("");
  expect(before.scrollLeft).toBeGreaterThan(0);
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    view.swipeDrag(-180);
    const stage = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
    (window as unknown as { zoomedPreview: { width: string; scale: string; activeWidth: string } }).zoomedPreview = {
      width: stage.style.width,
      scale: getComputedStyle(stage).getPropertyValue("--ink-page-scale"),
      activeWidth: document.querySelector<HTMLElement>(".ink-page")!.style.width,
    };
    view.swipeSettle(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  const preview = await page.evaluate(() => (window as unknown as { zoomedPreview: { width: string; scale: string; activeWidth: string } }).zoomedPreview);
  expect(parseFloat(preview.activeWidth)).toBeCloseTo(parseFloat(preview.width) * 2, 1);
  expect(preview.scale).toBe("1");
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 8");
  await expect.poll(() => page.evaluate(() => (window as unknown as RapidSwipeScope).__inkNotesPreview.view.zoom)).toBe(1);
  await expect.poll(() => page.locator(".ink-page").evaluate((element: HTMLElement) => element.style.width))
    .toBe(parseFloat(before.width) / 2 + "px");
  await expect.poll(() => page.locator(".ink-page-scroller").evaluate((element: HTMLElement) => element.scrollLeft)).toBe(0);
});

test("rapid swipes coalesce while a slow save continues in the background", async ({ page }) => {
  await prepareRapidSwipes(page);
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    let release!: () => void;
    const pendingSave = new Promise<void>((resolve) => { release = resolve; });
    view.activeSave = pendingSave;
    scope.releaseSave = release;
    scope.saveStarted = false;
    scope.saveDone = false;
    view.dirtyRevision = Math.max(view.dirtyRevision, view.savedRevision) + 1;
    view.save = async () => { scope.saveStarted = true; await pendingSave; scope.saveDone = true; };
    scope.swipeTest(1);
    for (const delta of [1, 1, -1, 1]) scope.swipeTest(delta);
  });
  await expect(page.locator(".ink-page-status")).toHaveText("4 / 8");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect(page.locator(".ink-page-extent")).toHaveCSS("visibility", "visible");
  expect(await page.evaluate(() => ({ started: (window as unknown as RapidSwipeScope).saveStarted,
    done: (window as unknown as RapidSwipeScope).saveDone }))).toEqual({ started: true, done: false });
  await page.evaluate(() => (window as unknown as RapidSwipeScope).releaseSave!());
  await expect.poll(() => page.evaluate(() => (window as unknown as RapidSwipeScope).saveDone)).toBe(true);
});

test("the next finger drag resumes before the save finishes", async ({ page }) => {
  await prepareRapidSwipes(page);
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    let release!: () => void;
    const pendingSave = new Promise<void>((resolve) => { release = resolve; });
    view.activeSave = pendingSave;
    scope.releaseSave = release;
    scope.saveStarted = false;
    scope.saveDone = false;
    view.dirtyRevision = Math.max(view.dirtyRevision, view.savedRevision) + 1;
    view.save = async () => { scope.saveStarted = true; await pendingSave; scope.saveDone = true; };
    scope.swipeTest(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 8");
  expect(await page.evaluate(() => ({ started: (window as unknown as RapidSwipeScope).saveStarted,
    done: (window as unknown as RapidSwipeScope).saveDone }))).toEqual({ started: true, done: false });
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    scope.swipeTest(1);
  });
  await expect(page.locator(".ink-page-status")).toHaveText("3 / 8");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as RapidSwipeScope).releaseSave!());
  await expect.poll(() => page.evaluate(() => (window as unknown as RapidSwipeScope).saveDone)).toBe(true);
});

for (const width of [390, 1280]) {
  test(`gallery swipe keeps spacing and geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
    await page.evaluate(async () => {
      const view = (window as unknown as { __inkNotesPreview: { view: SwipeView } }).__inkNotesPreview.view;
      view.duplicateCurrentPage();
      await view.navigateToPage(view.notebook.pages[0].id);
    });

    for (const direction of [1, -1]) {
      const samples = await page.evaluate((direction) => {
        const view = (window as unknown as { __inkNotesPreview: { view: SwipeView } }).__inkNotesPreview.view;
        const scroller = document.querySelector<HTMLElement>(".ink-page-scroller")!;
        const current = document.querySelector<HTMLElement>(".ink-page-extent .ink-page")!;
        const before = current.getBoundingClientRect();
        const initialScrollWidth = scroller.scrollWidth;
        const extent = document.querySelector<HTMLElement>(".ink-page-extent")!;
        view.swipeDrag(-direction * 180);
        const stage = document.querySelector<HTMLElement>(".ink-swipe-stage")!;
        const dragged = stage.getBoundingClientRect();
        // Isolate the preview's scroll footprint from the live page's transform.
        const dragTransform = extent.style.transform;
        extent.style.transform = "";
        const previewScrollWidth = scroller.scrollWidth;
        extent.style.transform = dragTransform;
        view.swipeSettle(direction);
        const animations = [...extent.getAnimations(), ...stage.getAnimations()];
        animations.forEach((animation) => animation.pause());
        const duration = Number(animations[0].effect!.getTiming().duration);
        const samples = [0, 0.25, 0.5, 0.75, 0.99].map((progress) => {
          animations.forEach((animation) => { animation.currentTime = duration * progress; });
          const a = current.getBoundingClientRect(), b = stage.getBoundingClientRect();
          return { gap: direction === 1 ? b.left - a.right : a.left - b.right,
            width: b.width, height: b.height, left: a.left };
        });
        animations.forEach((animation) => animation.finish());
        return { samples, before: { width: before.width, height: before.height, left: before.left },
          dragged: { width: dragged.width, height: dragged.height }, initialScrollWidth, previewScrollWidth };
      }, direction);
      expect(samples.previewScrollWidth).toBe(samples.initialScrollWidth);
      expect(samples.dragged.width).toBeCloseTo(samples.before.width, 1);
      expect(samples.dragged.height).toBeCloseTo(samples.before.height, 1);
      for (const frame of samples.samples) {
        expect(frame.gap).toBeCloseTo(samples.samples[0].gap, 1);
        expect(frame.width).toBeCloseTo(samples.before.width, 1);
        expect(frame.height).toBeCloseTo(samples.before.height, 1);
      }
      expect(Math.abs(samples.samples[4].left - samples.samples[0].left)).toBeGreaterThan(20);
      await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
      await expect(page.locator(".ink-page-status")).toHaveText(direction === 1 ? "2 / 2" : "1 / 2");
      const landed = await page.locator(".ink-page-extent .ink-page").boundingBox();
      expect(landed!.x).toBeCloseTo(samples.before.left, 1);
      await expect(page.locator(".ink-page-extent")).toHaveCSS("transform", "none");
    }
  });
}

test("short drags rebound and a closed view cannot commit its animation", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const view = (window as unknown as { __inkNotesPreview: { view: SwipeView } }).__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    view.swipeDrag(-60);
    view.swipeSettle(0);
  });
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
  await page.evaluate(() => {
    const view = (window as unknown as { __inkNotesPreview: { view: SwipeView } }).__inkNotesPreview.view;
    view.swipeDrag(-180);
    view.swipeSettle(1);
    view.destroySwipeStage();
  });
  await expect(page.locator(".ink-page-extent")).toHaveCSS("transform", "none");
  await page.waitForTimeout(350);
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
});

test("notebook page handoff completes while its save remains pending", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    let release!: () => void;
    const pendingSave = new Promise<void>((resolve) => { release = resolve; });
    view.activeSave = pendingSave;
    scope.releaseSave = release;
    scope.saveStarted = false;
    scope.saveDone = false;
    view.dirtyRevision = Math.max(view.dirtyRevision, view.savedRevision) + 1;
    view.save = async () => { scope.saveStarted = true; await pendingSave; scope.saveDone = true; };
    view.swipeDrag(-180);
    view.swipeSettle(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  expect(await page.evaluate(() => ({ started: (window as unknown as RapidSwipeScope).saveStarted,
    done: (window as unknown as RapidSwipeScope).saveDone }))).toEqual({ started: true, done: false });
  await page.evaluate(() => (window as unknown as RapidSwipeScope).releaseSave!());
  await expect.poll(() => page.evaluate(() => (window as unknown as RapidSwipeScope).saveDone)).toBe(true);
  await expect(page.locator(".ink-page-extent")).toHaveCSS("transform", "none");
});
