import { expect, test } from "@playwright/test";

for (const mode of ["ink", "pdf"]) {
  test(`${mode}: peer changes retain the mounted frame and current viewport`, async ({ page }) => {
    await page.setViewportSize({ width:1100, height:900 }); await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-ink-ready", "true");
    if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
    const rect = await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view; v.state.tool = "pen";
      const r = v.inputRect(); return {x:r.left, y:r.top};
    });
    await page.mouse.move(rect.x+80, rect.y+100); await page.mouse.down();
    await page.mouse.move(rect.x+180, rect.y+100, {steps:12}); await page.mouse.up();
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.pendingInkStrokes.length)).toBe(0);
    await expect.poll(() => page.locator(".ink-tile-layer > div").count()).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() => {
      const tiles = (window as any).__inkNotesPreview.view.tiles;
      return tiles.jobs.length + tiles.pendingTiles.size + Number(tiles.frame !== null);
    })).toBe(0);
    await page.evaluate(() => {
      const v = (window as any).__inkNotesPreview.view, host = v.tiles.host as HTMLElement;
      const ink = Array.from(host.querySelectorAll<HTMLCanvasElement>("canvas")).find(c => {
        // Worker tiles use bitmaprenderer, so inspect a copy through 2D.
        const copy = document.createElement("canvas"); copy.width=c.width; copy.height=c.height;
        const ctx = copy.getContext("2d")!; ctx.drawImage(c,0,0);
        return ctx.getImageData(0,0,c.width,c.height).data.some((x,i) => i%4 === 3 && x>0);
      });
      if (!ink) throw new Error("Initial frame has no visible ink");
      const probe = {page:v.currentPage(), ink, bitmap:ink.toDataURL(), zoom:v.zoom,
        left:v.inputScroller().scrollLeft, top:v.inputScroller().scrollTop,
        thumbs:Array.from(v.toolbarRoot().querySelectorAll(".ink-page-thumb")), emptyFrames:0};
      (window as any).__syncProbe = probe;
      new MutationObserver(() => { if (host.childElementCount === 0) probe.emptyFrames++; }).observe(host,{childList:true});
    });
    for (let i=0; i<4; i++) {
      const result = await page.evaluate(async ({mode,i}) => {
        const v = (window as any).__inkNotesPreview.view, probe = (window as any).__syncProbe;
        const remote = structuredClone(mode === "pdf" ? v.sidecar : v.currentNotebook());
        const book = mode === "pdf" ? remote.notebook : remote;
        const p = book.pages.find((p: any) => p.id === v.currentPage().id);
        if (i<2) p.strokes.push({id:`peer-${i}`,pageId:p.id,tool:"pen",color:"#e02020",width:4,opacity:1,
          points:[{x:.65,y:.25+i*.03,pressure:.5,t:1},{x:.7,y:.25+i*.03,pressure:.5,t:2}],createdAt:Date.now(),updatedAt:Date.now()});
        else { p.strokes = p.strokes.filter((s: any) => s.id !== `peer-${i-2}`); p.deletedStrokeIds.push(`peer-${i-2}`); }
        if (mode === "pdf") v.receiveMergedSidecar(remote);
        else { const merged = await v.workerSession.mergeExternal(JSON.stringify(remote)); v.receiveMergedNotebook(merged,true); }
        const mountedImmediately = probe.ink.isConnected && v.tiles.host.childElementCount>0;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const thumbs = Array.from(v.toolbarRoot().querySelectorAll(".ink-page-thumb"));
        return {mountedImmediately, samePage:v.currentPage() === probe.page,
          retainedInk:probe.ink.isConnected && probe.ink.toDataURL() === probe.bitmap,
          stableViewport:v.zoom === probe.zoom && v.inputScroller().scrollLeft === probe.left && v.inputScroller().scrollTop === probe.top,
          sameThumbs:thumbs.length === probe.thumbs.length && thumbs.every((node,i) => node === probe.thumbs[i]),
          emptyFrames:probe.emptyFrames, peerCount:v.currentPage().strokes.filter((s: any) => s.id.startsWith("peer-")).length};
      }, {mode,i});
      expect(result).toMatchObject({mountedImmediately:true,samePage:true,retainedInk:true,stableViewport:true,sameThumbs:true,emptyFrames:0});
      expect(result.peerCount).toBe([1,2,1,0][i]);
    }
  });
}
