import { describe, expect, it } from "vitest";
import { InkStroke, createNotebook } from "../src/model";
import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";
import {
  PdfSidecar,
  PdfSidecarConflictError,
  PdfSidecarFormatError,
  createSidecar,
  deleteBlankNotePage,
  deleteNotePage,
  disambiguatedSidecarPathFor,
  exactCaseHash,
  insertBlankNotePage,
  insertBlankNotePageAt,
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

it("prepends a blank with the first PDF page's rotated geometry and aligned ink order", () => {
  const sidecar = makeSidecar();
  sidecar.notePages[0].rotation = 90;
  const original = sidecar.notePages.map((page) => ({ ...page }));
  const id = insertBlankNotePageAt(sidecar, 0);
  expect(sidecar.notePages[0]).toEqual({ id, width: 595.28, height: 841.89, rotation: 90 });
  expect(sidecar.notePages.slice(1)).toEqual(original);
  expect(sidecar.notebook.pages.map((page) => page.id)).toEqual(sidecar.notebook.pageOrder);
  expect(sidecar.notebook.pageOrder).toEqual(sidecar.notePages.map((page) => page.id));
});

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

  it("exactCaseHash separates case twins and stays separator-normalized", () => {
    expect(exactCaseHash("Docs/Notes.pdf")).not.toBe(exactCaseHash("docs/notes.pdf"));
    expect(exactCaseHash("Docs\\Notes.pdf")).toBe(exactCaseHash("Docs/Notes.pdf"));
    expect(exactCaseHash("docs/notes.pdf")).toBe(exactCaseHash("docs/notes.pdf"));
    expect(exactCaseHash("docs/notes.pdf")).toHaveLength(12);
  });

  it("disambiguatedSidecarPathFor gives case twins distinct stable slots", () => {
    const upper = disambiguatedSidecarPathFor("Docs/Notes.pdf");
    const lower = disambiguatedSidecarPathFor("docs/notes.pdf");
    expect(upper).not.toBe(lower);
    expect(upper.startsWith("A_pdfinkwrittern/")).toBe(true);
    expect(upper.endsWith(".pdfink.json")).toBe(true);
    // The disambiguator sits between the legacy hash and the extension, so
    // the legacy-compatible name never gains a doubled .pdfink.json suffix.
    expect(upper.match(/pdfink\.json/g)).toHaveLength(1);
    expect(upper).toBe(disambiguatedSidecarPathFor("Docs/Notes.pdf"));
    expect(lower).toBe(disambiguatedSidecarPathFor("docs/notes.pdf"));
  });

  it("disambiguated slots reuse the stem sanitizing and never collide", () => {
    expect(disambiguatedSidecarPathFor("docs/notes.pdf")).not.toBe(sidecarPathFor("docs/notes.pdf"));
    expect(disambiguatedSidecarPathFor("docs/other.pdf")).not.toBe(disambiguatedSidecarPathFor("docs/notes.pdf"));
    const hostile = disambiguatedSidecarPathFor('a/b:*c?"<>|.pdf');
    expect(hostile).not.toContain(":");
    expect(hostile).not.toContain("*");
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

  it("complementary page deletions keep the sequence non-empty", () => {
    const base = makeSidecar();
    const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
    expect(deleteNotePage(base, sourcePageId(0))).toBe(true);
    expect(deleteNotePage(incoming, sourcePageId(1))).toBe(true);
    base.deletedNotePages[sourcePageId(0)] = 100;
    incoming.deletedNotePages[sourcePageId(1)] = 200; // device B deleted last
    // Each device keeps writing on the page it still has.
    base.notebook.pages[0].strokes.push(stroke(sourcePageId(1), "stroke-b"));
    incoming.notebook.pages[0].strokes.push(stroke(sourcePageId(0), "stroke-a"));

    const merged = mergeSidecars(base, incoming);
    expect(merged.notePages.map((page) => page.id)).toEqual([sourcePageId(1)]);
    expect(merged.notebook.pages.map((page) => page.id)).toEqual([sourcePageId(1)]);
    expect(merged.notebook.pageOrder).toEqual([sourcePageId(1)]);
    expect(merged.deletedNotePages[sourcePageId(0)]).toBeGreaterThan(0);
    expect(merged.deletedNotePages[sourcePageId(1)]).toBeUndefined();

    // The saved sidecar must still carry the surviving page's ink on reload.
    const reparsed = normalizeSidecar(parseStoredJson(serializeStoredJson(merged)));
    expect(reparsed.notebook.pages[0].strokes.map((entry) => entry.id)).toContain("stroke-b");
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

  // Page tags/flags ride on the embedded notebook pages, so mergeSidecars must
  // preserve them through every realign it performs on notebook.pages.
  describe("page tag merge semantics", () => {
    it("unions tags added to different pages on different devices", () => {
      const base = makeSidecar();
      const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
      base.notebook.pages[0].tags = ["exam"];
      incoming.notebook.pages[1].tags = ["review"];
      const merged = mergeSidecars(base, incoming);
      expect(merged.notebook.pages[0].tags).toEqual(["exam"]);
      expect(merged.notebook.pages[1].tags).toEqual(["review"]);
    });

    it("unions tags added to the same page from both sides, keeping base order", () => {
      const base = makeSidecar();
      const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
      base.notebook.pages[0].tags = ["exam", "hard"];
      incoming.notebook.pages[0].tags = ["review", "exam"];
      const merged = mergeSidecars(base, incoming);
      expect(merged.notebook.pages[0].tags).toEqual(["exam", "hard", "review"]);
      const reverse = mergeSidecars(incoming, base);
      expect(reverse.notebook.pages[0].tags).toEqual(["review", "exam", "hard"]);
    });

    it("resolves a same-page flag conflict by last writer (page.updatedAt)", () => {
      const base = makeSidecar();
      const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
      base.notebook.pages[0].flag = "red";
      incoming.notebook.pages[0].flag = "green";
      incoming.notebook.pages[0].updatedAt = base.notebook.pages[0].updatedAt + 10;
      expect(mergeSidecars(base, incoming).notebook.pages[0].flag).toBe("green");
      expect(mergeSidecars(incoming, base).notebook.pages[0].flag).toBe("green");
    });

    it("lets a newer side clear a flag the older side still has", () => {
      const base = makeSidecar();
      const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
      base.notebook.pages[0].flag = "yellow";
      incoming.notebook.pages[0].updatedAt = base.notebook.pages[0].updatedAt + 10;
      expect(mergeSidecars(base, incoming).notebook.pages[0].flag).toBeUndefined();
    });

    it("keeps tags attached to their page id when the note sequence is realigned", () => {
      const base = makeSidecar();
      const id = insertBlankNotePage(base, null);
      moveBlankNotePage(base, id, 0);
      // Device B cloned the same sequence, then wrote ink later; device A
      // tagged the moved blank page (a real tag edit bumps page.updatedAt).
      const incoming = JSON.parse(JSON.stringify(base)) as PdfSidecar;
      base.notebook.pages[0].tags = ["moved"];
      base.notebook.pages[0].flag = "green";
      base.notebook.pages[0].updatedAt += 10;
      incoming.notebook.pages[2].strokes.push(stroke(sourcePageId(1), "stroke-c"));
      incoming.notebook.pages[2].updatedAt += 20;
      const merged = mergeSidecars(base, incoming);
      expect(merged.notePages.map((page) => page.id)).toEqual([id, sourcePageId(0), sourcePageId(1)]);
      expect(merged.notebook.pages[0].id).toBe(id);
      expect(merged.notebook.pages[0].tags).toEqual(["moved"]);
      expect(merged.notebook.pages[0].flag).toBe("green");
      expect(merged.notebook.pages[2].strokes.map((entry) => entry.id)).toContain("stroke-c");
    });

    it("survives a disk round-trip with tags and flags intact", () => {
      const base = makeSidecar();
      base.notebook.pages[0].tags = ["exam", " hard "];
      base.notebook.pages[0].flag = "red";
      const parsed = normalizeSidecar(parseStoredJson(serializeStoredJson(base)));
      expect(parsed.notebook.pages[0].tags).toEqual(["exam", "hard"]);
      expect(parsed.notebook.pages[0].flag).toBe("red");
    });
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
    expect(sidecar.notebook.pages.map((page) => page.id)).toEqual(sidecar.notePages.map((page) => page.id));
  });

  it("keeps a stroke written after a move on its sequence position through a round-trip", () => {
    const sidecar = makeSidecar();
    const id = insertBlankNotePage(sidecar, null);
    moveBlankNotePage(sidecar, id, 0);
    const target = sidecar.notebook.pages[1];
    target.strokes.push(stroke(target.id, "stroke-after-move"));
    const parsed = normalizeSidecar(JSON.parse(JSON.stringify(sidecar)));
    expect(parsed.notebook.pages.map((page) => page.id)).toEqual(parsed.notePages.map((page) => page.id));
    expect(parsed.notebook.pages[1].strokes.map((entry) => entry.id)).toContain("stroke-after-move");
  });
});
