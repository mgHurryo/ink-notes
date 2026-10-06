import { describe, expect, it } from "vitest";
import { InkStroke, createNotebook } from "../src/model";
import {
  PdfSidecar,
  PdfSidecarConflictError,
  PdfSidecarFormatError,
  createSidecar,
  deleteBlankNotePage,
  insertBlankNotePage,
  isSourcePageId,
  mergeSidecars,
  moveBlankNotePage,
  normalizeSidecar,
  pathHash,
  sidecarFileNameFor,
  sidecarPathFor,
  sourcePageId,
} from "../src/pdf-sidecar";

const SOURCE_PAGES = [
  { width: 595.28, height: 841.89, rotation: 0 },
  { width: 792, height: 612, rotation: 90 },
];

function makeSidecar(): PdfSidecar {
  return createSidecar("docs/lecture.pdf", { sha256: "a".repeat(64), byteLength: 1234 }, SOURCE_PAGES);
}

function stroke(pageId: string, id: string): InkStroke {
  return {
    id, pageId, tool: "pen", color: "#1b1b1b", width: 3, opacity: 1,
    points: [{ x: 0.1, y: 0.1, pressure: 0.5, t: 1 }, { x: 0.2, y: 0.2, pressure: 0.5, t: 2 }],
    createdAt: 1, updatedAt: 1,
  };
}

describe("sidecar file naming", () => {
  it("derives distinct names for same-named PDFs in different folders", () => {
    const first = sidecarFileNameFor("docs/lecture.pdf");
    const second = sidecarFileNameFor("other/lecture.pdf");
    expect(first).not.toBe(second);
    expect(first.startsWith("lecture--")).toBe(true);
    expect(first.endsWith(".pdfink.json")).toBe(true);
  });

  it("is stable across path separators and case", () => {
    expect(sidecarFileNameFor("Docs\\Lecture.PDF")).toBe(sidecarFileNameFor("docs/lecture.pdf"));
  });

  it("sanitizes hostile basenames", () => {
    const name = sidecarFileNameFor("a/b:*c?\"<>|.pdf");
    expect(name).not.toContain(":");
    expect(name).not.toContain("*");
    expect(name.endsWith(".pdfink.json")).toBe(true);
  });

  it("sidecarPathFor uses the dedicated folder", () => {
    expect(sidecarPathFor("docs/lecture.pdf")).toBe(`A_pdfinkwrittern/${sidecarFileNameFor("docs/lecture.pdf")}`);
  });

  it("pathHash is a stable non-cryptographic digest", () => {
    expect(pathHash("docs/lecture.pdf")).toBe(pathHash("docs/lecture.pdf"));
    expect(pathHash("docs/lecture.pdf")).toHaveLength(12);
  });
});

describe("create + normalize", () => {
  it("creates one note page per source page with deterministic ids", () => {
    const sidecar = makeSidecar();
    expect(sidecar.format).toBe(1);
    expect(sidecar.notePages.map((page) => page.id)).toEqual([sourcePageId(0), sourcePageId(1)]);
    expect(sidecar.notePages[1]).toMatchObject({ width: 792, height: 612, rotation: 90, sourceIndex: 1 });
    expect(sidecar.notebook.pages.map((page) => page.id)).toEqual(sidecar.notePages.map((page) => page.id));
    expect(sidecar.source.pageCount).toBe(2);
  });

  it("roundtrips through JSON without changes", () => {
    const sidecar = makeSidecar();
    const parsed = normalizeSidecar(JSON.parse(JSON.stringify(sidecar)));
    expect(parsed.source).toEqual(sidecar.source);
    expect(parsed.notePages).toEqual(sidecar.notePages);
    expect(parsed.notebook.pages).toEqual(sidecar.notebook.pages);
  });

  it("rejects unknown format versions instead of guessing", () => {
    expect(() => normalizeSidecar({ ...JSON.parse(JSON.stringify(makeSidecar())), format: 99 }))
      .toThrow(PdfSidecarFormatError);
  });

  it("rejects corrupt wrappers and missing fingerprints", () => {
    expect(() => normalizeSidecar(null)).toThrow(PdfSidecarFormatError);
    expect(() => normalizeSidecar({ format: 1 })).toThrow(PdfSidecarFormatError);
    const raw = JSON.parse(JSON.stringify(makeSidecar()));
    delete raw.source.sha256;
    expect(() => normalizeSidecar(raw)).toThrow(PdfSidecarFormatError);
  });

  it("rebuilds a lost note sequence from source pages", () => {
    const raw = JSON.parse(JSON.stringify(makeSidecar()));
    raw.notePages = [];
    const parsed = normalizeSidecar(raw);
    expect(parsed.notePages.map((page) => page.id)).toEqual([sourcePageId(0), sourcePageId(1)]);
  });

  it("repairs notebook pages that the sequence lost and drops strays", () => {
    const raw = JSON.parse(JSON.stringify(makeSidecar()));
    raw.notebook.pages = [raw.notebook.pages[0]];
    const parsed = normalizeSidecar(raw);
    expect(parsed.notebook.pages.map((page) => page.id)).toEqual([sourcePageId(0), sourcePageId(1)]);
    expect(parsed.notebook.pageOrder).toEqual(parsed.notePages.map((page) => page.id));

    const stray = JSON.parse(JSON.stringify(makeSidecar()));
    stray.notebook.pages.push({ ...createNotebook().pages[0], id: "page-stray" });
    const cleaned = normalizeSidecar(stray);
    expect(cleaned.notebook.pages.some((page) => page.id === "page-stray")).toBe(false);
  });
});

describe("merge", () => {
  it("unions strokes and keeps both sides' page additions", () => {
    const base = makeSidecar();
    const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
    incoming.notebook.pages[0].strokes.push(stroke(sourcePageId(0), "stroke-a"));
    incoming.noteOrderUpdatedAt += 10;
    const merged = mergeSidecars(base, incoming);
    expect(merged.notebook.pages[0].strokes.map((stroke) => stroke.id)).toContain("stroke-a");
  });

  it("merges deleted-page tombstones with max timestamps", () => {
    const base = makeSidecar();
    const blankId = insertBlankNotePage(base, null);
    const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
    incoming.deletedNotePages[blankId] = 500;
    base.noteOrderUpdatedAt += 10; // base wins the order, tombstones still merge
    const merged = mergeSidecars(base, incoming);
    expect(merged.deletedNotePages[blankId]).toBe(500);
    expect(merged.notePages.some((page) => page.id === blankId)).toBe(false);
  });

  it("throws when the two sides describe different source PDFs", () => {
    const base = makeSidecar();
    const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
    incoming.source.sha256 = "b".repeat(64);
    expect(() => mergeSidecars(base, incoming)).toThrow(PdfSidecarConflictError);
  });

  it("splices an addition next to its anchor when the winner lacks it", () => {
    const base = makeSidecar();
    const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
    incoming.notebook.pages[1].strokes.push(stroke(sourcePageId(1), "stroke-b"));
    const merged = mergeSidecars(base, incoming);
    expect(merged.notePages.map((page) => page.id)).toEqual([sourcePageId(0), sourcePageId(1)]);
  });
});

describe("note page operations", () => {
  it("inserts a blank page after the anchor with the neighbor geometry (incl. rotation)", () => {
    const sidecar = makeSidecar();
    const id = insertBlankNotePage(sidecar, sourcePageId(0));
    expect(isSourcePageId(id)).toBe(false);
    expect(sidecar.notePages.map((page) => page.id)).toEqual([sourcePageId(0), id, sourcePageId(1)]);
    // Neighbor (index 0) is portrait rot 0 — geometry copied verbatim.
    expect(sidecar.notePages[1]).toMatchObject({ width: 595.28, height: 841.89, rotation: 0 });
    expect(sidecar.notebook.pages.map((page) => page.id)).toEqual(sidecar.notePages.map((page) => page.id));
  });

  it("copies rotation when inserting after a rotated neighbor", () => {
    const sidecar = makeSidecar();
    const id = insertBlankNotePage(sidecar, sourcePageId(1));
    expect(sidecar.notePages[2]).toMatchObject({ rotation: 90, width: 792, height: 612 });
  });

  it("appends to the end when afterId is null", () => {
    const sidecar = makeSidecar();
    const id = insertBlankNotePage(sidecar, null);
    expect(sidecar.notePages[sidecar.notePages.length - 1].id).toBe(id);
  });

  it("deletes only blank pages and tombstones them", () => {
    const sidecar = makeSidecar();
    expect(deleteBlankNotePage(sidecar, sourcePageId(0))).toBe(false);
    const id = insertBlankNotePage(sidecar, null);
    expect(deleteBlankNotePage(sidecar, id)).toBe(true);
    expect(sidecar.notePages).toHaveLength(2);
    expect(sidecar.deletedNotePages[id]).toBeGreaterThan(0);
  });

  it("moves only blank pages within the sequence", () => {
    const sidecar = makeSidecar();
    const id = insertBlankNotePage(sidecar, null);
    expect(moveBlankNotePage(sidecar, id, 0)).toBe(true);
    expect(sidecar.notePages[0].id).toBe(id);
    expect(moveBlankNotePage(sidecar, sourcePageId(0), 2)).toBe(false);
  });
});
