import { expect, test } from "@playwright/test";
import { scribbleLoops, scribbleWaves } from "../scribble-fixtures";
import type { InkStroke } from "../../src/model";

for (const mode of ["ink", "pdf"]) for (const layer of ["page", "sticky"]) {
  test(`${mode} ${layer}: native stylus scribbles erase locally and undo restores both tails`, async ({ page }) => {
    await page.setViewportSize({ width: 820, height: 1100 }); await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
    if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
    await page.evaluate((layer) => {
      const v = (window as any).__inkNotesPreview.view;
      v.currentPage().strokes = []; v.state.tool = "pen"; v.state.pen.smooth = 100; v.state.scribbleSensitivity = 25;
      v.state.eraserSize = 160; v.drawStrokes([]);
      if (layer === "sticky") v.addSticky();
    }, layer);
    const host = layer === "sticky" ? page.getByLabel("Sticky handwriting board") : page.locator(mode === "ink" ? ".ink-page" : ".ink-pdf-ink-host");
    await expect(host).toBeVisible();
    const r = (await host.boundingBox())!, cx = r.width / 2, cy = layer === "sticky" ? 85 : 140;
    const state = () => page.evaluate((layer) => {
      const v = (window as any).__inkNotesPreview.view, p = v.currentPage();
      return { strokes: (layer === "sticky" ? p.stickyNotes[0].strokes : p.strokes) as InkStroke[], history: v.undoStack.length, active: v.activePointerId };
    }, layer);
    const draw = async (path: { x: number; y: number }[]) => {
      await host.evaluate((el, path) => {
        const r = el.getBoundingClientRect();
        for (let i = 0; i < path.length; i++) {
          const type = i === 0 ? "touchstart" : i === path.length - 1 ? "touchend" : "touchmove";
          const touch = { target: el, identifier: 42, clientX: r.x + path[i].x, clientY: r.y + path[i].y, force: .5, touchType: "stylus" };
          const event = new Event(type, { bubbles: true, cancelable: true });
          Object.defineProperties(event, { touches: { value: type === "touchend" ? [] : [touch] }, changedTouches: { value: [touch] },
            timeStamp: { value: performance.now() + i * 4 } });
          el.dispatchEvent(event);
        }
      }, path);
    };
    await draw([{ x: 15, y: cy }, { x: r.width - 15, y: cy }]);
    const original = await state(); expect(original.strokes).toHaveLength(1);
    for (const fixture of [scribbleLoops(), scribbleWaves()]) {
      await draw(fixture.map((p) => ({ x: cx + p.x - 50, y: cy + p.y - 50 })));
      const clipped = await state(); expect(clipped.active).toBeNull(); expect(clipped.history).toBe(original.history + 1);
      expect(clipped.strokes).toHaveLength(2);
      const xs = clipped.strokes.flatMap((s) => s.points.map((p) => p.x));
      expect(Math.min(...xs)).toBeCloseTo(original.strokes[0].points[0].x);
      expect(Math.max(...xs)).toBeCloseTo(original.strokes[0].points.at(-1)!.x);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect((await state()).strokes.map((s) => s.points)).toEqual(original.strokes.map((s) => s.points));
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      expect((await state()).strokes.map((s) => s.points)).toEqual(clipped.strokes.map((s) => s.points));
      await page.getByRole("button", { name: "Undo", exact: true }).click();
    }
  });
}
