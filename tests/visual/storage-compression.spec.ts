import { expect, test } from "@playwright/test";

for (const mode of ["ink","pdf"]) {
  test(`${mode}: native worker saves compressed handwriting and reads it back without sample changes`,async({page})=>{
    await page.setViewportSize({width:1100,height:900}); await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-ink-ready","true");
    if(mode==="pdf") await page.evaluate(()=>(window as any).__inkNotesPreview.openPdf());
    const r=await page.evaluate(()=>{const v=(window as any).__inkNotesPreview.view;v.selectWritingTool("pen");const r=v.inputRect();return {x:r.x,y:r.y};});
    await page.mouse.move(r.x+100,r.y+100); await page.mouse.down();
    await page.mouse.move(r.x+250,r.y+180,{steps:40}); await page.mouse.up();
    await expect.poll(()=>page.evaluate(()=>(window as any).__inkNotesPreview.view.pendingInkStrokes.length)).toBe(0);
    const result=await page.evaluate(async mode=>{
      const v=(window as any).__inkNotesPreview.view, codec=(window as any).__inkNotesStorage;
      if(!v.workerSession)throw new Error("Native worker unavailable");
      const points=JSON.stringify(v.currentPage().strokes.map((s:any)=>s.points));
      if(mode==="pdf") {const saved=await v.flushSaveNow();if(saved.status!=="saved")throw new Error(saved.message);}
      else await v.save();
      const raw=await v.store.readRaw(mode==="pdf"?v.sidecarFile:v.file), decoded=codec.decode(raw);
      const book=mode==="pdf"?decoded.notebook:decoded;
      const loadedPoints=JSON.stringify(book.pages[0].strokes.map((s:any)=>s.points));
      if(mode==="ink") {
        const file=v.file; await v.onUnloadFile(file); await v.onLoadFile(file);
      } else {
        decoded.notebook.pages[0].title="Compressed peer page";
        decoded.notebook.pages[0].updatedAt=Date.now()+1;
        await v.store.writeIfUnchanged(v.sidecarFile,raw,codec.encode(decoded));
        await v.reloadExternalSidecar(v.sidecarFile.path);
      }
      const stable=JSON.stringify(v.currentPage().strokes.map((s:any)=>s.points));
      return {compressed:raw.startsWith("INK-GZIP-1\n"),sameSamples:points===loadedPoints&&loadedPoints===stable,
        bytes:new TextEncoder().encode(raw).length,legacyBytes:new TextEncoder().encode(JSON.stringify(decoded,null,2)).length,
        title:v.currentPage().title,workerAvailable:!!v.workerSession};
    },mode);
    expect(result.compressed).toBe(true); expect(result.sameSamples).toBe(true); expect(result.workerAvailable).toBe(true);
    expect(result.bytes).toBeLessThan(result.legacyBytes*.5);
    if(mode==="pdf")expect(result.title).toBe("Compressed peer page");
    await expect.poll(()=>page.locator(".ink-tile-layer > div").count()).toBeGreaterThan(0);
  });
}

test("compressed notebook embed still paints the same read-only handwriting",async({page})=>{
  await page.goto("/"); await expect(page.locator("html")).toHaveAttribute("data-ink-ready","true");
  await expect.poll(()=>page.locator(".preview-embed-fixture canvas").evaluateAll(canvases=>canvases.some(el=>{
    const c=el as HTMLCanvasElement; return c.getContext("2d")!.getImageData(0,0,c.width,c.height).data.some((n,i)=>i%4===3&&n>0);
  }))).toBe(true);
  await expect(page.locator(".preview-embed-fixture")).not.toContainText("damaged");
});
