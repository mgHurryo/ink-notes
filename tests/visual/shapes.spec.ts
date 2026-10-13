import { expect, test } from "@playwright/test";

for (const mode of ["ink", "pdf"]) {
  test(`${mode}: mouse shapes preview fully, retain geometry in Worker and undo once`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 }); await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
    if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
    await page.evaluate(() => { const v = (window as any).__inkNotesPreview.view; v.currentPage().strokes = []; v.drawStrokes([]); });
    for (const kind of ["Rectangle", "Square", "Circle", "Ellipse", "Line", "Arrow", "Triangle"]) {
      const rawBefore = await page.evaluate(() => JSON.stringify((window as any).__inkNotesPreview.view.currentNotebook()));
      await page.getByRole("button", { name: "Shapes", exact: true }).click();
      await page.locator(".menu").getByRole("button", { name: kind, exact: true }).click();
      const rect = await page.evaluate(() => { const r = (window as any).__inkNotesPreview.view.inputRect(); return { x:r.x, y:r.y }; });
      await page.mouse.move(rect.x + 100, rect.y + 150); await page.mouse.down();
      await page.mouse.move(rect.x + 300, rect.y + 300, { steps: 10 });
      expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.activeStroke.points.length)).toBeGreaterThan(1);
      const pixels = await page.evaluate(() => { const c = (window as any).__inkNotesPreview.view.previewCanvas as HTMLCanvasElement;
        return c.getContext("2d")!.getImageData(0,0,c.width,c.height).data.some((value,i) => i % 4 === 3 && value > 0); });
      expect(pixels).toBe(true);
      await page.mouse.up();
      const points = await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes[0].points);
      const worker = await page.evaluate(async raw => { const v = (window as any).__inkNotesPreview.view;
        const prepared = await v.workerSession.prepareSave(raw, v.workerRevision);
        await v.workerSession.abortSave(prepared.token); return prepared.content;
      }, rawBefore);
      const persisted = await page.evaluate(raw => (window as any).__inkNotesStorage.decode(raw), worker);
      expect(persisted.pages.flatMap((p: any) => p.strokes.map((s: any) => s.points))).toContainEqual(points);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBe(0);
    }
  });

  test(`${mode}: native stylus hold straightens while down and stays straight after lift`, async ({ page }) => {
    await page.goto("/"); await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
    if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
    await page.evaluate(() => { const v = (window as any).__inkNotesPreview.view; v.state.tool = "pen";
      v.state.pen.smooth = 80; v.currentPage().strokes = []; v.drawStrokes([]); });
    const host = page.locator(mode === "ink" ? ".ink-page" : ".ink-pdf-ink-host");
    const send = async (type: string, x: number, y: number) => host.evaluate((el, {type,x,y}) => {
      const r = el.getBoundingClientRect();
      const touch = { target: el, identifier: 42, clientX: r.x+x, clientY:r.y+y, force:.6, touchType:"stylus" };
      const event = new Event(type, { bubbles:true, cancelable:true });
      Object.defineProperties(event, { touches:{value:type === "touchend" ? [] : [touch]}, changedTouches:{value:[touch]} });
      el.dispatchEvent(event);
    }, {type,x,y});
    await send("touchstart", 60,140); await send("touchmove",130,141); await send("touchmove",220,139);
    await send("touchmove",300,140);
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.geometricStroke?.kind), {timeout:4000}).toBe("line");
    await send("touchmove",320,150); await send("touchend",320,150);
    expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes[0].points.length)).toBe(2);
  });
}
