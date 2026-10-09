import { expect, test, type Page } from "@playwright/test";
import type { InkNotebook } from "../../src/model";

interface SwipeView {
  notebook: InkNotebook;
  pageIndex: number;
  duplicateCurrentPage(): void;
  navigateToPage(id: string): Promise<void>;
  swipeDrag(offset: number): void;
  swipeSettle(delta: number): void;
  destroySwipeStage(): void;
  flipSettling: boolean;
  workerSession: { barrier(revision: number): Promise<unknown> };
}

interface RapidSwipeScope {
  __inkNotesPreview: { view: SwipeView };
  swipeTest(delta: number, lift?: boolean): void;
  releaseSwipeBarrier?: () => void;
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

test("rapid swipes coalesce across a slow Worker barrier without dropping navigation", async ({ page }) => {
  await prepareRapidSwipes(page);
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    const original = view.workerSession.barrier.bind(view.workerSession);
    let held = false;
    view.workerSession.barrier = async (revision) => {
      await original(revision);
      if (!held) {
        held = true;
        await new Promise<void>((resolve) => { scope.releaseSwipeBarrier = resolve; });
      }
    };
    scope.swipeTest(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as RapidSwipeScope).releaseSwipeBarrier)).toBe("function");
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    for (const delta of [1, 1, -1, 1]) scope.swipeTest(delta);
  });
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 8");
  expect(await page.evaluate(() => (window as unknown as RapidSwipeScope).__inkNotesPreview.view.flipSettling)).toBe(true);
  await page.evaluate(() => (window as unknown as RapidSwipeScope).releaseSwipeBarrier!());
  await expect(page.locator(".ink-page-status")).toHaveText("4 / 8");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect(page.locator(".ink-page-extent")).toHaveCSS("visibility", "visible");
});

test("the next finger drag resumes as soon as the notebook finishes its barrier", async ({ page }) => {
  await prepareRapidSwipes(page);
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    const view = scope.__inkNotesPreview.view;
    const original = view.workerSession.barrier.bind(view.workerSession);
    let held = false;
    view.workerSession.barrier = async (revision) => {
      await original(revision);
      if (!held) {
        held = true;
        await new Promise<void>((resolve) => { scope.releaseSwipeBarrier = resolve; });
      }
    };
    scope.swipeTest(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as RapidSwipeScope).releaseSwipeBarrier)).toBe("function");
  await page.evaluate(() => {
    const scope = window as unknown as RapidSwipeScope;
    scope.swipeTest(1, false);
    scope.releaseSwipeBarrier!();
  });
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 8");
  await expect(page.locator(".ink-swipe-stage")).toHaveAttribute("data-neighbor", "2");
  const positions = await page.evaluate(() => ({
    live: document.querySelector<HTMLElement>(".ink-page-extent")!.style.transform,
    stage: document.querySelector<HTMLElement>(".ink-swipe-stage")!.style.transform,
  }));
  expect(positions.live).toBe(positions.stage);
  expect(positions.live).toMatch(/translateX\(-[\d.]+px\)/);
  await page.evaluate(() => document.querySelector(".ink-page-scroller")!
    .dispatchEvent(new TouchEvent("touchend", { touches: [], bubbles: true, cancelable: true })));
  await expect(page.locator(".ink-page-status")).toHaveText("3 / 8");
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
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

test("notebook handoff waits for its Worker barrier instead of a fixed timeout", async ({ page }) => {
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async () => {
    const scope = window as unknown as { __inkNotesPreview: { view: SwipeView & {
      workerSession: { barrier(revision: number): Promise<unknown> } } }; releaseSwipeBarrier?: () => void };
    const view = scope.__inkNotesPreview.view;
    view.duplicateCurrentPage();
    await view.navigateToPage(view.notebook.pages[0].id);
    const original = view.workerSession.barrier.bind(view.workerSession);
    view.workerSession.barrier = async (revision) => {
      await original(revision);
      await new Promise<void>((resolve) => { scope.releaseSwipeBarrier = resolve; });
    };
    view.swipeDrag(-180);
    view.swipeSettle(1);
    document.getAnimations().forEach((animation) => animation.finish());
  });
  await page.waitForTimeout(750);
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(1);
  await expect(page.locator(".ink-page-status")).toHaveText("1 / 2");
  await page.evaluate(() => (window as unknown as { releaseSwipeBarrier(): void }).releaseSwipeBarrier());
  await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
  await expect(page.locator(".ink-page-status")).toHaveText("2 / 2");
  await expect(page.locator(".ink-page-extent")).toHaveCSS("transform", "none");
});
