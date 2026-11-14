import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const recording = JSON.parse(readFileSync(resolve("tests/fixtures/wheel-gestures/win-chrome-right-ptp.json"), "utf8")) as {
  wheelEvents: Array<{ deltaX: number; deltaY: number; timeStamp: number }>;
};

async function openFourPages(page: Page, mode: "ink" | "pdf") {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await expect.poll(() => page.locator("html").getAttribute("data-ink-ready")).toBe("true");
  await page.evaluate(async (mode) => {
    if (mode === "pdf") await (window as any).__inkNotesPreview.openPdf();
    const view = (window as any).__inkNotesPreview.view;
    for (let i = 0; i < 3; i++) {
      if (mode === "ink") view.duplicateCurrentPage();
      else view.addBlankPage(1);
    }
    if (mode === "ink") await view.navigateToPage(view.notebook.pages[0].id);
    else await view.navigatePages(-view.noteIndex);
  }, mode);
  const scroller = page.locator(mode === "ink" ? ".ink-page-scroller" : ".ink-pdf-scroller");
  const status = page.locator(mode === "ink" ? ".ink-page-status" : ".ink-pdf-page-indicator");
  await expect(status).toHaveText("1 / 4");
  return { scroller, status };
}

async function replayWindows(page: Page, axis: "x" | "y") {
  await page.evaluate(async ({ samples, axis }) => {
    const view = (window as any).__inkNotesPreview.view;
    const scroller = view.inputScroller();
    scroller.scrollTop = scroller.scrollHeight;
    let previous = samples[0].timeStamp;
    const base = performance.now() - previous;
    for (const raw of samples) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, raw.timeStamp - previous)));
      const lift = raw.deltaX === 0 && raw.deltaY === 0 && Object.is(raw.deltaX, -0);
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true,
        deltaX: lift ? -0 : -(axis === "x" ? raw.deltaX : raw.deltaY),
        deltaY: -(axis === "x" ? raw.deltaY : raw.deltaX) });
      Object.defineProperty(event, "timeStamp", { value: base + raw.timeStamp });
      // These traces predate the native momentum property. A modern synthetic
      // WheelEvent defaults it to false, so explicitly model the absent API.
      Object.defineProperty(event, "momentum", { value: undefined });
      scroller.dispatchEvent(event);
      previous = raw.timeStamp;
    }
  }, { samples: recording.wheelEvents, axis });
}

for (const mode of ["ink", "pdf"] as const) {
  for (const axis of ["x", "y"] as const) {
    test(`${mode}, ${axis}: recorded Windows swipes rearm and inertia never adds a page`, async ({ page }, testInfo) => {
      const { status } = await openFourPages(page, mode);
      await replayWindows(page, axis);
      await expect(status).toHaveText("2 / 4");
      await page.waitForTimeout(120); // A completed recording's quiet interval.
      await replayWindows(page, axis);
      await expect(status).toHaveText("3 / 4");
      await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
      await page.screenshot({ path: resolve(`plan/status/CHROMIUM-13/${testInfo.project.use.browserName ?? "chromium"}/${mode}-${axis}-recorded.png`) });
    });

    test(`${mode}, ${axis}: real native wheel pans a zoomed page before boundary navigation`, async ({ page }) => {
      const { scroller, status } = await openFourPages(page, mode);
      await page.evaluate(() => {
        const view = (window as any).__inkNotesPreview.view;
        view.setZoom(2); view.zoomLocked = true;
        view.inputScroller().scrollLeft = view.inputScroller().scrollTop = 100;
      });
      const box = (await scroller.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const before = await scroller.evaluate((el, axis) => axis === "x" ? el.scrollLeft : el.scrollTop, axis);
      await page.mouse.wheel(axis === "x" ? 40 : 0, axis === "y" ? 40 : 0);
      await expect.poll(() => scroller.evaluate((el, axis) => axis === "x" ? el.scrollLeft : el.scrollTop, axis)).toBeGreaterThan(before);
      await expect(status).toHaveText("1 / 4");
      await page.waitForTimeout(1100); // Let the recognizer end the first input.
      // Exercise the last real 10px too: a gutter correction must neither
      // strand input at the edge nor navigate before reaching the edge.
      const nearEnd = await scroller.evaluate((el, axis) => {
        if (axis === "x") { el.scrollLeft = el.scrollWidth; el.scrollLeft -= 10; return el.scrollLeft; }
        el.scrollTop = el.scrollHeight; el.scrollTop -= 10; return el.scrollTop;
      }, axis);
      await page.mouse.wheel(axis === "x" ? 2 : 0, axis === "y" ? 2 : 0);
      await expect.poll(() => scroller.evaluate((el, axis) => axis === "x" ? el.scrollLeft : el.scrollTop, axis)).toBeGreaterThan(nearEnd);
      await expect(status).toHaveText("1 / 4");
      await page.waitForTimeout(1100);
      await scroller.evaluate((el, axis) => {
        if (axis === "x") el.scrollLeft = el.scrollWidth - el.clientWidth;
        else el.scrollTop = el.scrollHeight - el.clientHeight;
      }, axis);
      await page.mouse.wheel(axis === "x" ? 80 : 0, axis === "y" ? 80 : 0);
      await expect(status).toHaveText("2 / 4");
      await expect(page.locator(".ink-swipe-stage")).toHaveCount(0);
    });

    test(`${mode}, ${axis}: recognized momentum cannot continue native page panning`, async ({ page }) => {
      const { scroller, status } = await openFourPages(page, mode);
      await page.evaluate(() => {
        const scope = window as any, view = scope.__inkNotesPreview.view;
        view.setZoom(2); view.zoomLocked = true;
        const surface = view.inputScroller() as HTMLElement;
        surface.scrollLeft = surface.scrollTop = 100;
        scope.testMomentum = false;
        scope.cancelledMomentum = [];
        // Keep the browser's real default wheel action, supplying only the
        // OS phase metadata so cancellation is tested against native scroll.
        surface.addEventListener("wheel", event => {
          Object.defineProperty(event, "momentum", { value: scope.testMomentum });
        }, true);
        window.addEventListener("wheel", event => {
          if (scope.testMomentum) scope.cancelledMomentum.push(event.defaultPrevented);
        });
      });
      const box = (await scroller.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const position = () => scroller.evaluate((el, axis) => axis === "x" ? el.scrollLeft : el.scrollTop, axis);
      const send = (movement: number) => page.mouse.wheel(axis === "x" ? movement : 0, axis === "y" ? movement : 0);
      await send(40);
      await expect.poll(position).toBeGreaterThan(100);
      const stopped = await position();
      await page.evaluate(() => { (window as any).testMomentum = true; });
      for (const movement of [30, 20, 10, 5]) await send(movement);
      await expect.poll(() => page.evaluate(() => (window as any).cancelledMomentum)).toEqual([true, true, true, true]);
      expect(await position()).toBe(stopped);
      await page.evaluate(() => { (window as any).testMomentum = false; });
      await send(40);
      await expect.poll(position).toBeGreaterThan(stopped);
      await expect(status).toHaveText("1 / 4");
    });

    test(`${mode}, ${axis}: fast native phases reveal the preview rail and selection keeps it open`, async ({ page }, testInfo) => {
      const { status } = await openFourPages(page, mode);
      await page.evaluate(async (axis) => {
        const view = (window as any).__inkNotesPreview.view;
        const scroller = view.inputScroller();
        scroller.scrollTop = scroller.scrollHeight;
        const send = (movement: number, momentum: boolean) => {
          const event = new WheelEvent("wheel", { bubbles: true, cancelable: true,
            deltaX: axis === "x" ? movement : 0, deltaY: axis === "y" ? movement : 0 });
          Object.defineProperty(event, "momentum", { value: momentum });
          scroller.dispatchEvent(event);
        };
        for (let i = 0; i < 3; i++) {
          send(60, false); send(10, true);
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }, axis);
      await expect(status).toHaveText("4 / 4");
      const root = page.locator(mode === "ink" ? ".ink-notes-view" : ".ink-pdf-view");
      await expect(root).not.toHaveClass(/ink-rail-hidden/);
      await page.locator(".ink-page-thumb").nth(1).click();
      await expect(status).toHaveText("2 / 4");
      await page.waitForTimeout(3300); // Existing three-second quiet hand-back.
      await expect(root).not.toHaveClass(/ink-rail-hidden/);
      await page.screenshot({ path: resolve(`plan/status/CHROMIUM-13/${testInfo.project.use.browserName ?? "chromium"}/${mode}-${axis}-preview.png`) });
    });
  }
}
