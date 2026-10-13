import { describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "node:zlib";
import { createNotebook, type InkStroke, normalizeNotebook } from "../src/model";
import { normalizeSidecar, createSidecar } from "../src/pdf-sidecar";
import { serializeSidecar } from "../src/pdf-store";
import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";
import { penOutlineRings } from "../src/rendering";

function sampledStroke(pageId: string, count = 4000): InkStroke {
  return { id: "sampled", pageId, tool: "pen", color: "#263238", width: 3.25, opacity: .85,
    dynamics: { taper: 35, pressure: 75, speed: 40, pressureCurve: [[0,0],[.4,.25],[1,1]] },
    points: Array.from({length:count}, (_,i) => ({
      x: .2+i/count*.35, y: .3+Math.sin(i/20)*.04, pressure: .2+Math.sin(i/31)**2*.7,
      t: 1723456789000+i*1000/240, ...(i%3 ? {tiltX:23.25,tiltY:-14.5} : {}),
    })), createdAt: 1, updatedAt: 2 };
}

describe("lossless disk codec", () => {
  it("keeps old JSON and tiny notebooks readable and never mutates the model", () => {
    const notebook=createNotebook("中文"), before=structuredClone(notebook);
    expect(serializeStoredJson(notebook)).toBe(JSON.stringify(notebook)+"\n");
    expect(parseStoredJson(JSON.stringify(notebook,null,2))).toEqual(notebook);
    expect(notebook).toEqual(before);
  });

  it("roundtrips every number, sample and optional field with unchanged render geometry", () => {
    const book=createNotebook(), stroke=sampledStroke(book.pages[0].id,480);
    stroke.points.push({x:1/3,y:Math.PI/10,pressure:1,t:0,tiltX:-0});
    book.pages[0].strokes=[stroke];
    const json=JSON.stringify(book), raw=serializeStoredJson(book), loaded=parseStoredJson(raw);
    expect(raw.startsWith("INK-GZIP-1\n")).toBe(true);
    expect(JSON.stringify(loaded)).toBe(json);
    expect(loaded.pages[0].strokes[0].points).toEqual(JSON.parse(json).pages[0].strokes[0].points);
    expect(penOutlineRings(normalizeNotebook(loaded).pages[0].strokes[0],1600,2200))
      .toEqual(penOutlineRings(normalizeNotebook(book).pages[0].strokes[0],1600,2200));
    // Independent standard-library decoder checks the wire format/checksum.
    expect(gunzipSync(Buffer.from(raw.split("\n")[1],"base64")).toString("utf8")).toBe(json+"\n");
    expect(serializeStoredJson(loaded)).toBe(raw);
  });

  it("compresses representative high-frequency samples without losing tombstones, images or sticky content", () => {
    const book=createNotebook("Storage fixture"), page=book.pages[0];
    page.strokes=[sampledStroke(page.id)]; page.deletedStrokeIds=["deleted"];
    page.deletedStickyNotes={gone:123}; book.deletedPages={removed:345};
    page.stickyNotes=[{id:"sticky",pageId:page.id,x:.2,y:.3,width:.4,height:.2,title:"中文",text:"**Equation**",keywords:"exam",textUpdatedAt:1,
      color:"#fff1a8",collapsed:false,preview:true,scrollX:12,scrollY:24,boardPageWidth:600,textFontFamily:"serif",textFontSize:32,textScaleText:true,
      textBoxes:[{id:"extra",text:"Second box",x:10,y:20,width:120,height:80,createdAt:1,updatedAt:2}],
      strokes:[sampledStroke("sticky",200)],deletedStrokeIds:["erased-sticky"],createdAt:1,updatedAt:2}];
    page.images=[{id:"image",pageId:page.id,assetPath:"Ink Notes/Images/assets/image.png",x:.2,y:.3,width:.4,height:.2,foreground:true,createdAt:1,updatedAt:2}];
    const raw=serializeStoredJson(book);
    expect(Buffer.byteLength(raw)).toBeLessThan(Buffer.byteLength(JSON.stringify(book,null,2))*.3);
    expect(parseStoredJson(raw)).toEqual(book);
    const sidecar=createSidecar("中文.pdf",{sha256:"a".repeat(64),byteLength:123},[{width:600,height:800,rotation:90}]);
    sidecar.notebook=book;
    expect(parseStoredJson(serializeSidecar(sidecar))).toEqual(sidecar);
    expect(normalizeSidecar(parseStoredJson(serializeSidecar(sidecar))).source).toEqual(sidecar.source);
  });

  it("decodes independently written gzip and refuses corruption or unknown versions", () => {
    const encode=(text:string)=>"INK-GZIP-1\n"+gzipSync(text).toString("base64")+"\n";
    expect(parseStoredJson(encode('{"title":"中文"}'))).toEqual({title:"中文"});
    expect(()=>parseStoredJson(encode("not JSON"))).toThrow(SyntaxError);
    expect(()=>parseStoredJson("INK-GZIP-2\nAAAA")).toThrow(SyntaxError);
    expect(()=>parseStoredJson("INK-GZIP-1\n!bad")).toThrow(SyntaxError);
    const zipped=gzipSync('{"title":"中文"}');
    expect(()=>parseStoredJson("INK-GZIP-1\n"+zipped.subarray(0,-8).toString("base64"))).toThrow(SyntaxError);
    zipped[zipped.length-8]^=1;
    expect(()=>parseStoredJson("INK-GZIP-1\n"+zipped.toString("base64"))).toThrow(SyntaxError);
    const oversized=gzipSync("{}"); oversized.writeUInt32LE(256*1024*1024+1,oversized.length-4);
    expect(()=>parseStoredJson("INK-GZIP-1\n"+oversized.toString("base64"))).toThrow(/limit/);
    expect(()=>parseStoredJson("INK-GZIP-1\n"+Buffer.concat([gzipSync("{}"),Buffer.from([1])]).toString("base64"))).toThrow(SyntaxError);
  });
});
