// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { createNotebook, mergeNotebooks, normalizeNotebook } from "../src/model";
import { type StickyNote, normalizeSticky, stickyTextBoxes } from "../src/sticky-model";
import { paintPageStickies } from "../src/sticky-rendering";
import { applyNotebookOperation } from "../src/worker-core";
import { clonePageValue } from "../src/worker-protocol";
import { createSidecar, normalizeSidecar } from "../src/pdf-sidecar";

function textObject(pageId: string, id = "text-a"): StickyNote {
  return { id, pageId, kind:"text", x:.2, y:.2, width:.4, height:.15,
    title:"Text box", keywords:"", text:"Hello 中文", textUpdatedAt:1, textX:0, textY:0, textWidth:240, textHeight:120,
    textFontSize:28, textFontFamily:"serif", textBold:true, textScaleText:true,
    color:"#ffffff", collapsed:false, preview:true, scrollX:0, scrollY:0, boardPageWidth:600,
    strokes:[], deletedStrokeIds:[], createdAt:1, updatedAt:1 };
}

describe("page text objects", () => {
  it("roundtrips text styling and frameless identity through Worker, notebook and PDF sidecar storage", () => {
    const book = createNotebook(), page = book.pages[0], text = textObject(page.id);
    applyNotebookOperation(book, {type:"patch-sticky-notes",pageId:page.id,upsert:[text],remove:[],
      deletedStickyNotes:{},pageUpdatedAt:2,notebookUpdatedAt:2});
    text.text = "Mutated caller";
    const saved = normalizeNotebook(JSON.parse(JSON.stringify(book)));
    expect(saved.pages[0].stickyNotes![0]).toMatchObject({kind:"text",text:"Hello 中文",textFontSize:28,textFontFamily:"serif",textBold:true,textScaleText:true});
    const cloned = clonePageValue(page); cloned.stickyNotes![0].text = "Copy";
    expect(page.stickyNotes![0].text).toBe("Hello 中文");
    const sidecar = createSidecar("Source.pdf",{sha256:"a".repeat(64),byteLength:2},[{width:600,height:800,rotation:0}]);
    sidecar.notebook.pages[0].stickyNotes = [textObject(sidecar.notebook.pages[0].id)];
    expect(normalizeSidecar(JSON.parse(JSON.stringify(sidecar)))!.notebook.pages[0].stickyNotes![0].kind).toBe("text");
  });

  it("merges independent boxes and text/position edits without reviving deleted objects", () => {
    const book = createNotebook(), p = book.pages[0]; p.stickyNotes = [textObject(p.id),textObject(p.id,"text-b")];
    const a = structuredClone(book), b = structuredClone(book);
    Object.assign(a.pages[0].stickyNotes![0],{text:"Edited A",textUpdatedAt:3,updatedAt:3});
    Object.assign(b.pages[0].stickyNotes![0],{x:.5,updatedAt:4});
    Object.assign(b.pages[0].stickyNotes![1],{text:"Edited B",textUpdatedAt:4,updatedAt:4});
    const merged = mergeNotebooks(a,b);
    expect(merged.pages[0].stickyNotes).toMatchObject([{kind:"text",text:"Edited A",x:.5},{kind:"text",text:"Edited B"}]);
    const removed = structuredClone(merged); removed.pages[0].stickyNotes!.shift(); removed.pages[0].deletedStickyNotes = {"text-a":5};
    expect(mergeNotebooks(merged,removed).pages[0].stickyNotes!.map(n=>n.id)).toEqual(["text-b"]);
    const restored = structuredClone(removed); restored.pages[0].stickyNotes!.push({...textObject(p.id),updatedAt:6});
    expect(mergeNotebooks(removed,restored).pages[0].stickyNotes).toHaveLength(2);
  });

  it("normalizes page text into a nonfolded, unscrolled box and preserves legacy sticky behavior", () => {
    const text = normalizeSticky({...textObject("p"),collapsed:true,scrollX:12,scrollY:25,textX:18,textY:20},"p")!;
    expect(text).toMatchObject({kind:"text",collapsed:false,scrollX:0,scrollY:0,textX:0,textY:0});
    expect(stickyTextBoxes(text)[0]).toMatchObject({width:240,height:120,fontSize:28,fontFamily:"serif"});
    expect(normalizeSticky({...textObject("p"),kind:undefined,collapsed:true},"p")!.collapsed).toBe(true);
  });

  it("paints text without a title, background or clearing the underlying page ink", () => {
    const calls: Record<string, ReturnType<typeof vi.fn>> = {};
    const ctx = new Proxy({measureText:(s:string)=>({width:s.length*10})} as any, {
      get(target,key:string) { return target[key] ?? (calls[key] ??= vi.fn()); },
    });
    paintPageStickies(ctx,[textObject("p")],600,800);
    expect(calls.fillRect).toBeUndefined(); expect(calls.clearRect).toBeUndefined();
    expect(calls.fillText).toHaveBeenCalledWith("Hello 中文",0,0);
    expect(calls.translate).toHaveBeenCalledWith(120,160);
    expect(ctx.font).toBe("bold 28px serif");
  });
});
