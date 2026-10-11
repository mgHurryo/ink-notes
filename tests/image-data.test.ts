import { describe, expect, it } from "vitest";
import { PDFDocument, PDFRawStream, PDFArray, decodePDFRawStream, degrees } from "pdf-lib";
import { createNotebook, InkImage, mergeNotebooks, normalizeNotebook } from "../src/model";
import { applyNotebookOperation } from "../src/worker-core";
import { clonePageValue } from "../src/worker-protocol";
import { exportNotebookPdf, notebookHasInk, exportHandwrittenPdf } from "../src/pdf-export";
import { createSidecar } from "../src/pdf-sidecar";

const image = (pageId: string, id = "placed-a"): InkImage => ({ id, pageId, assetPath: "Ink Notes/Images/assets/image-a.png",
  x: .2, y: .25, width: .4, height: .3, foreground: false, createdAt: 1, updatedAt: 1 });
const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64")).buffer;

describe("placed image persistence", () => {
  it("roundtrips images, normalizes page ownership and rejects unsafe asset paths", () => {
    const book = createNotebook(); const page = book.pages[0]; page.images = [image("wrong")];
    expect(normalizeNotebook(JSON.parse(JSON.stringify(book))).pages[0].images![0].pageId).toBe(page.id);
    page.images.push({ ...image(page.id, "bad"), assetPath: "../../secret.png" });
    page.images.push({ ...image(page.id, "nan"), x: NaN });
    expect(normalizeNotebook(book).pages[0].images).toHaveLength(1);
    expect(normalizeNotebook(createNotebook()).pages[0].images).toBeUndefined();
  });
  it("merges independent image edits and makes deletion win over stale peers", () => {
    const a = createNotebook(); a.pages[0].images = [image(a.pages[0].id)]; const b = structuredClone(a);
    b.pages[0].images![0].x = .4; b.pages[0].images![0].updatedAt = 2;
    a.pages[0].images!.push(image(a.pages[0].id, "placed-b"));
    const merged = mergeNotebooks(a, b); expect(merged.pages[0].images).toHaveLength(2);
    expect(merged.pages[0].images!.find((i) => i.id === "placed-a")!.x).toBe(.4);
    b.pages[0].deletedImageIds = ["placed-a"];
    expect(mergeNotebooks(a, b).pages[0].images!.map((i) => i.id)).toEqual(["placed-b"]);
    expect(mergeNotebooks(b, a).pages[0].images).toEqual(mergeNotebooks(a, b).pages[0].images);
  });
  it("keeps worker image patches and snapshots isolated from UI arrays", () => {
    const book = createNotebook(), page = book.pages[0], original = image(page.id);
    applyNotebookOperation(book, { type: "patch-images", pageId: page.id, upsert: [original], remove: [], deletedImageIds: [], pageUpdatedAt: 2, notebookUpdatedAt: 2 });
    original.x = .6; expect(page.images![0].x).toBe(.2);
    const copy = clonePageValue(page); copy.images![0].x = .7; expect(page.images![0].x).toBe(.2);
    applyNotebookOperation(book, { type: "patch-images", pageId: page.id, upsert: [], remove: [original.id], deletedImageIds: [original.id], pageUpdatedAt: 3, notebookUpdatedAt: 3 });
    applyNotebookOperation(book, { type: "patch-images", pageId: page.id, upsert: [original], remove: [], deletedImageIds: [], pageUpdatedAt: 4, notebookUpdatedAt: 4 });
    expect(page.images).toEqual([]); expect(page.deletedImageIds).toEqual([original.id]);
  });
});

async function content(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes), streams = doc.getPage(0).node.Contents()! as PDFArray;
  return Array.from({ length: streams.size() }, (_, index) => Buffer.from(decodePDFRawStream(doc.context.lookup(streams.get(index)) as PDFRawStream).decode()).toString()).join("\n");
}

describe("PDF image export", () => {
  it("exports image-only notebooks and fails explicitly if asset bytes are unavailable", async () => {
    const book = createNotebook(); book.pages[0].images = [image(book.pages[0].id)];
    expect(notebookHasInk(book)).toBe(true);
    await expect(exportNotebookPdf(book, "Image")).rejects.toThrow("Image library unavailable");
    await expect(exportNotebookPdf(book, "Image", undefined, async () => { throw new Error("missing asset"); })).rejects.toThrow("missing asset");
    const bytes = await exportNotebookPdf(book, "Image", undefined, async () => png);
    expect(await content(bytes)).toContain(" Do");
  });
  it("draws below and above images on either side of vector ink", async () => {
    const book = createNotebook(), page = book.pages[0]; page.images = [image(page.id), { ...image(page.id, "placed-b"), foreground: true }];
    page.strokes = [{ id: "s", pageId: page.id, tool: "pen", color: "#000000", width: 4, opacity: 1, points: [{ x: .2, y: .3, pressure: .5, t: 1 }], createdAt: 1, updatedAt: 1 }];
    const operators = await content(await exportNotebookPdf(book, "Layers", undefined, async () => png));
    const drawings = operators.split("\n").filter((line) => / Do$|^f$/.test(line));
    expect(drawings[0]).toContain(" Do"); expect(drawings[1]).toBe("f"); expect(drawings[drawings.length - 1]).toContain(" Do");
  });
  it.each([0, 90, 180, 270] as const)("places images in display coordinates on rotated %i degree PDF pages", async (rotation) => {
    const source = await PDFDocument.create(); source.addPage([600, 800]).setRotation(degrees(rotation));
    const sidecar = createSidecar("Source.pdf", { byteLength: 10, sha256: "test" }, [{ width: 600, height: 800, rotation }]);
    sidecar.notebook.pages[0].images = [image(sidecar.notePages[0].id)];
    const bytes = await exportHandwrittenPdf((await source.save()).buffer as ArrayBuffer, sidecar, "Rotated", undefined, async () => png);
    const ops = await content(bytes);
    expect(ops).toContain(" Do");
    const expectedOrigin = rotation === 0 ? [120, 360] : rotation === 90 ? [330, 160] : rotation === 180 ? [480, 440] : [270, 640];
    const match = /1 0 0 1 ([\d.]+) ([\d.]+) cm/.exec(ops)!;
    expect(Number(match[1])).toBeCloseTo(expectedOrigin[0]); expect(Number(match[2])).toBeCloseTo(expectedOrigin[1]);
  });
});
