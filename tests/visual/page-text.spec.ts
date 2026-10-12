import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({hasTouch:true,deviceScaleFactor:2});
const objects = (page:Page) => page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().stickyNotes?.filter((n:any)=>n.kind === "text") ?? []);
async function ready(page:Page,mode:string) {
  await page.setViewportSize({width:1100,height:1000}); await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-ink-ready","true");
  if (mode === "pdf") await page.evaluate(() => (window as any).__inkNotesPreview.openPdf());
}
async function add(page:Page,text:string) {
  await page.locator(".ink-toolbar-section-draw").getByRole("button",{name:"Add text box",exact:true}).click();
  const input = page.getByRole("textbox",{name:"Text box Markdown",exact:true});
  await expect(input).toBeFocused(); await input.fill(text); await input.press("Control+Enter");
}
async function fingerDrag(element:Locator,dx:number,dy:number,stylus=false) {
  await element.evaluate((el,{dx,dy,stylus}) => {
    const r=el.getBoundingClientRect(), a={target:el,identifier:71,clientX:r.x+8,clientY:r.y+8,force:.5,touchType:stylus?"stylus":"direct"};
    const b={...a,clientX:a.clientX+dx,clientY:a.clientY+dy};
    for (const [type,t] of [["touchstart",a],["touchmove",b],["touchend",b]] as const) {
      const e=new Event(type,{bubbles:true,cancelable:true});
      Object.defineProperties(e,{touches:{value:type==="touchend"?[]:[t]},changedTouches:{value:[t]}});
      (stylus || type==="touchstart"?el:document).dispatchEvent(e);
    }
  },{dx,dy,stylus});
}

for (const mode of ["ink","pdf"]) {
  test(`${mode}: consecutive insertion commits the draft and keyboard editing stays in the text box`,async ({page}) => {
    await ready(page,mode);
    const addButton=page.locator(".ink-toolbar-section-draw").getByRole("button",{name:"Add text box",exact:true});
    await addButton.click(); const input=page.getByRole("textbox",{name:"Text box Markdown",exact:true});
    await input.fill("Uncommitted first"); await addButton.click();
    await expect(input).toBeFocused(); await expect(input).toHaveValue("");
    await input.fill("Keyboard second"); await input.press("Control+Enter");
    expect((await objects(page)).map((n:any)=>n.text)).toEqual(["Uncommitted first","Keyboard second"]);
    const frame=page.locator(".ink-page-text .ink-sticky-text-box").nth(1);
    await frame.focus(); const before=await objects(page); await page.keyboard.press("Shift+ArrowRight");
    expect((await objects(page))[1].x).toBeGreaterThan(before[1].x);
    await frame.focus(); await page.keyboard.press("Alt+ArrowDown");
    expect((await objects(page))[1].textHeight).toBeGreaterThan(before[1].textHeight);
    await frame.focus(); await page.keyboard.press("Enter"); await expect(input).toHaveValue("Keyboard second");
    await input.press("Escape");
    // Resolve layout once so locator actionability waits cannot stretch a
    // deliberate double tap beyond the shared 300ms gesture interval.
    const bounds=(await frame.boundingBox())!;
    await page.touchscreen.tap(bounds.x+8,bounds.y+8); await page.touchscreen.tap(bounds.x+8,bounds.y+8);
    await expect(input).toHaveValue("Keyboard second");
    await input.fill("Second local draft");
    const peer = async (index:number,text:string) => page.evaluate(({mode,index,text}) => {
      const v=(window as any).__inkNotesPreview.view;
      const remote=structuredClone(mode==="pdf"?v.sidecar:v.currentNotebook()), book=mode==="pdf"?remote.notebook:remote;
      const n=book.pages[0].stickyNotes[index], now=Math.max(Date.now(),n.updatedAt+1);
      n.text=text; n.textUpdatedAt=now; n.updatedAt=now;
      if(mode==="pdf") v.receiveMergedSidecar(remote); else v.receiveMergedNotebook(remote);
    },{mode,index,text});
    await peer(0,"First peer edit"); await input.press("Control+Enter");
    expect((await objects(page)).map((n:any)=>n.text)).toEqual(["First peer edit","Second local draft"]);
    await frame.dblclick({position:{x:8,y:8}}); await input.fill("Conflicting draft");
    await peer(1,"Second peer edit"); await input.press("Control+Enter");
    await expect(input).toHaveValue("Conflicting draft"); expect((await objects(page))[1].text).toBe("Second peer edit");
    await input.press("Escape"); await expect(frame).toContainText("Second peer edit");
  });

  test(`${mode}: page text supports independent boxes, typography and direct manipulation`,async ({page}) => {
    await ready(page,mode); await add(page,"First **box**"); await add(page,"Second 中文");
    const cards=page.locator(".ink-page-text"), frames=cards.locator(".ink-sticky-text-box"), second=frames.nth(1);
    await expect(cards).toHaveCount(2); await expect(cards.locator(".ink-sticky-header,canvas")).toHaveCount(0);
    await expect(frames.nth(0).locator("strong")).toHaveText("box");
    await expect(cards.nth(1)).toHaveCSS("background-color","rgba(0, 0, 0, 0)");
    const before=await objects(page);
    const r=(await second.boundingBox())!;
    await page.mouse.move(r.x+8,r.y+8); await page.mouse.down(); await page.mouse.move(r.x+170,r.y+120,{steps:8}); await page.mouse.up();
    const moved=await objects(page); expect(moved[1].x).toBeGreaterThan(before[1].x); expect(moved[1].y).toBeGreaterThan(before[1].y);
    expect(moved[0]).toEqual(before[0]);
    await second.getByRole("button",{name:"Format text box",exact:true}).tap();
    const panel=page.getByRole("dialog",{name:"Text style",exact:true});
    await panel.getByLabel("Text font",{exact:true}).selectOption("kai");
    const size=panel.getByLabel("Text font size",{exact:true}); await size.fill("32"); await size.press("Tab");
    await panel.getByLabel("Bold",{exact:true}).check();
    await panel.getByRole("button",{name:"Close text style",exact:true}).tap();
    await fingerDrag(second.getByRole("button",{name:"Resize text box",exact:true}),30,20);
    expect((await objects(page))[1].textFontSize).toBe(32);
    await second.getByRole("button",{name:"Format text box",exact:true}).tap();
    await panel.getByLabel("Scale text with box",{exact:true}).check();
    await panel.getByRole("button",{name:"Close text style",exact:true}).tap();
    await fingerDrag(second.getByRole("button",{name:"Resize text box",exact:true}),40,30);
    const resized=await objects(page); expect(resized[1].textFontSize).toBeGreaterThan(32); expect(resized[1].text).toBe("Second 中文");
    await page.getByRole("button",{name:"Undo",exact:true}).tap(); expect((await objects(page))[1].textFontSize).toBe(32);
    await page.getByRole("button",{name:"Redo",exact:true}).tap(); expect((await objects(page))[1].textFontSize).toBe(resized[1].textFontSize);
    await second.dblclick({position:{x:8,y:8}}); await expect(page.getByRole("textbox",{name:"Text box Markdown",exact:true})).toHaveValue("Second 中文");
    await page.keyboard.press("Escape"); await page.mouse.click(20,950); await expect(second).not.toHaveClass(/is-selected/);
  });

  test(`${mode}: finger moves text, pen writes on the page, deletion undo and reading mode work`,async ({page}) => {
    await ready(page,mode); await add(page,"Page text");
    const frame=page.locator(".ink-page-text .ink-sticky-text-box");
    await page.getByRole("button",{name:"Pen",exact:true}).click();
    const before=await objects(page); await fingerDrag(frame,60,40);
    const moved=await objects(page); expect(moved[0].x).toBeGreaterThan(before[0].x);
    const strokes=await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length);
    await fingerDrag(frame,40,10,true);
    await expect.poll(() => page.evaluate(() => (window as any).__inkNotesPreview.view.pendingInkStrokes.length)).toBe(0);
    expect(await objects(page)).toEqual(moved);
    expect(await page.evaluate(() => (window as any).__inkNotesPreview.view.currentPage().strokes.length)).toBeGreaterThan(strokes);
    expect((await objects(page))[0].strokes).toEqual([]);
    await frame.tap({position:{x:8,y:8}}); await frame.getByRole("button",{name:"Delete text box",exact:true}).tap();
    await expect(frame).toHaveCount(0);
    await page.getByRole("button",{name:"Undo",exact:true}).tap(); await expect(frame).toHaveCount(1);
    expect((await objects(page))[0].text).toBe("Page text");
    await page.getByRole("button",{name:"Redo",exact:true}).tap(); await expect(frame).toHaveCount(0);
    await page.getByRole("button",{name:"Undo",exact:true}).tap();
    await page.getByRole("button",{name:"Reading mode",exact:true}).tap();
    await expect(page.locator(".ink-toolbar-section-draw").getByRole("button",{name:"Add text box",exact:true})).toBeHidden();
    await expect(frame.getByRole("button",{name:"Edit text box",exact:true})).toHaveCount(0);
    const locked=await objects(page); await fingerDrag(frame,60,40); expect(await objects(page)).toEqual(locked);
  });

  test(`${mode}: text exports with transparent background and no sticky header`,async ({page}) => {
    await ready(page,mode); await add(page,"Export **中文**");
    const result=await page.evaluate(async () => {
      const original=HTMLCanvasElement.prototype.toBlob, alpha:number[]=[];
      HTMLCanvasElement.prototype.toBlob=function(...args) {
        const ctx=this.getContext("2d"); if(ctx) alpha.push(ctx.getImageData(this.width-1,this.height-1,1,1).data[3]);
        return original.apply(this,args);
      };
      try { const exported=await (window as any).__inkNotesPreview.exportStickies(90); return {...exported,alpha}; }
      finally { HTMLCanvasElement.prototype.toBlob=original; }
    });
    expect(result.images).toBe(1); expect(result.bytes).toBeGreaterThan(1000);
    expect(result.alpha).toEqual([0]);
    await page.screenshot({path:`.tmp/page-text/${mode}.png`});
  });
}
