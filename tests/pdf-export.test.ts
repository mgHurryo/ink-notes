import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";
import { createSidecar, insertBlankNotePage, sourcePageId } from "../src/pdf-sidecar";
import type { PdfSidecarNotePage } from "../src/pdf-sidecar";
import { InkStroke } from "../src/model";
import {
  PdfExportError,
  displayToPdfPoint,
  exportHandwrittenPdf,
  exportPathFor,
  inkToSvgPath,
  looksDigitallySigned,
  parseHexColor,
  sidecarHasInk,
} from "../src/pdf-export";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function stroke(pageId: string, id: string): InkStroke {
  return {
    id, pageId, tool: "highlighter", color: "#ffe94a", width: 16, opacity: 0.4,
    points: [{ x: 0.1, y: 0.3, pressure: 0.5, t: 1 }, { x: 0.9, y: 0.3, pressure: 0.5, t: 2 }],
    createdAt: 1, updatedAt: 1,
  };
}

async function buildSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const a4 = doc.addPage([595.28, 841.89]);
  a4.drawText("portrait original", { x: 60, y: 700, size: 24, font });
  const rotated = doc.addPage([595.28, 841.89]);
  rotated.setRotation(degrees(90));
  rotated.drawText("rotated original", { x: 60, y: 700, size: 24, font });
  return doc.save();
}

function sidecarWithInk(sourceBytes: Uint8Array): ReturnType<typeof createSidecar> {
  const sidecar = createSidecar("docs/lecture.pdf", { sha256: sha256(sourceBytes), byteLength: sourceBytes.byteLength }, [
    { width: 595.28, height: 841.89, rotation: 0 },
    { width: 595.28, height: 841.89, rotation: 90 },
  ]);
  sidecar.notebook.pages[0].strokes.push(stroke(sourcePageId(0), "stroke-a"));
  return sidecar;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Collect every /ca and /CA value from a document's ExtGState resources. */
function collectAlphas(doc: PDFDocument): number[] {
  const alphas: number[] = [];
  for (const page of doc.getPages()) {
    const node = page.node as unknown as { Resources?: () => { lookup(name: PDFName): unknown } | undefined };
    const resources = node.Resources?.();
    if (!resources) continue;
    const extGState = resources.lookup(PDFName.of("ExtGState")) as PDFDict | undefined;
    if (!extGState) continue;
    for (const key of extGState.keys()) {
      const state = extGState.lookup(key) as PDFDict | undefined;
      if (!state) continue;
      for (const alphaKey of [PDFName.of("ca"), PDFName.of("CA")]) {
        const value = state.lookup(alphaKey);
        if (value instanceof PDFNumber) alphas.push(value.asNumber());
      }
    }
  }
  return alphas;
}

describe("displayToPdfPoint", () => {
  const page: PdfSidecarNotePage = { id: "p", width: 595.28, height: 841.89, rotation: 0 };
  const rotated: PdfSidecarNotePage = { id: "p", width: 595.28, height: 841.89, rotation: 90 };
  const upsideDown: PdfSidecarNotePage = { id: "p", width: 595.28, height: 841.89, rotation: 180 };
  const quarterTurn: PdfSidecarNotePage = { id: "p", width: 595.28, height: 841.89, rotation: 270 };

  // These formulas were cross-checked against pdf.js viewport.convertToPdfPoint
  // with zero error during the pdf-lib evaluation; this locks them in.
  it("maps normalized display coordinates for every rotation", () => {
    expect(displayToPdfPoint(0, 0, page)).toEqual({ x: 0, y: 841.89 });
    expect(displayToPdfPoint(1, 1, page)).toEqual({ x: 595.28, y: 0 });
    // rot 90: px = dy, py = dx
    expect(displayToPdfPoint(0, 0, rotated)).toEqual({ x: 0, y: 0 });
    expect(displayToPdfPoint(1, 1, rotated)).toEqual({ x: 595.28, y: 841.89 });
    expect(displayToPdfPoint(0.5, 0.5, rotated)).toEqual({ x: 297.64, y: 420.945 });
    // rot 180: px = W - dx, py = dy
    expect(displayToPdfPoint(0, 0, upsideDown)).toEqual({ x: 595.28, y: 0 });
    expect(displayToPdfPoint(1, 1, upsideDown)).toEqual({ x: 0, y: 841.89 });
    // rot 270: px = W - dy, py = H - dx
    expect(displayToPdfPoint(0, 0, quarterTurn)).toEqual({ x: 595.28, y: 841.89 });
    expect(displayToPdfPoint(1, 1, quarterTurn)).toEqual({ x: 0, y: 0 });
  });

  it("builds an SVG path in pdf-lib's y-down drawSvgPath space", () => {
    const path = inkToSvgPath(stroke("p", "s"), page);
    expect(path).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
    const parts = path.split(" ");
    const firstSvgY = Number(parts[2]);
    // svg y = pageHeight - pdfY, and pdfY = pageHeight - 0.3 * pageHeight.
    expect(firstSvgY).toBeCloseTo(0.3 * 841.89, 1);
  });

  it("parses colors and falls back to ink black on garbage", () => {
    expect(parseHexColor("#ff0000")).toEqual({ red: 1, green: 0, blue: 0 });
    expect(parseHexColor("nonsense")).toEqual(parseHexColor("#1b1b1b"));
  });
});

describe("exportHandwrittenPdf", () => {
  it("preserves source pages, appends blank note pages with neighbor geometry, and never touches the source bytes", async () => {
    const source = await buildSourcePdf();
    const sourceHash = sha256(source);
    const sidecar = sidecarWithInk(source);
    // Blank page inserted after the rotated source page: must carry rotation.
    insertBlankNotePage(sidecar, sourcePageId(1));
    sidecar.notebook.pages[2].strokes.push(stroke(sidecar.notePages[2].id, "stroke-blank"));

    const output = await exportHandwrittenPdf(toArrayBuffer(source), sidecar, "lecture");
    expect(sha256(source)).toBe(sourceHash);

    const out = await PDFDocument.load(output);
    expect(out.getPageCount()).toBe(3);
    expect(out.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 });
    expect(out.getPage(1).getRotation().angle).toBe(90);
    const blank = out.getPage(2);
    expect(blank.getSize()).toEqual({ width: 595.28, height: 841.89 });
    expect(blank.getRotation().angle).toBe(90);

    const reloadedSource = await PDFDocument.load(source);
    expect(out.getPage(0).getSize()).toEqual(reloadedSource.getPage(0).getSize());
  });

  it("keeps highlighter transparency in the output graphics state", async () => {
    const source = await buildSourcePdf();
    const output = await exportHandwrittenPdf(toArrayBuffer(source), sidecarWithInk(source), "lecture");
    const alphas = collectAlphas(await PDFDocument.load(output));
    expect(alphas).toContain(0.4);
  });

  it("rejects encrypted PDFs explicitly", async () => {
    const encrypted = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
4 0 obj << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -1 >> endobj
trailer << /Root 1 0 R /Encrypt 4 0 R /Size 5 >>
%%EOF`);
    const sidecar = sidecarWithInk(new Uint8Array(encrypted));
    await expect(exportHandwrittenPdf(toArrayBuffer(new Uint8Array(encrypted)), sidecar, "x"))
      .rejects.toMatchObject({ name: "PdfExportError", reason: "encrypted" });
  });

  it("rejects digitally signed PDFs before parsing", async () => {
    const source = await buildSourcePdf();
    const signed = Buffer.concat([Buffer.from(source), Buffer.from("/ByteRange [0 100 200 100]")]);
    const sidecar = sidecarWithInk(new Uint8Array(signed));
    await expect(exportHandwrittenPdf(toArrayBuffer(new Uint8Array(signed)), sidecar, "x"))
      .rejects.toMatchObject({ name: "PdfExportError", reason: "signed" });
    expect(looksDigitallySigned(toArrayBuffer(new Uint8Array(signed)))).toBe(true);
  });

  it("reports corrupt PDFs as a corrupt export failure", async () => {
    const garbage = new TextEncoder().encode("this is not a pdf");
    const sidecar = sidecarWithInk(garbage);
    await expect(exportHandwrittenPdf(toArrayBuffer(garbage), sidecar, "x"))
      .rejects.toMatchObject({ name: "PdfExportError", reason: "corrupt" });
  });
});

describe("helpers", () => {
  it("sidecarHasInk detects ink anywhere in the sequence", () => {
    const empty = createSidecar("a.pdf", { sha256: "a".repeat(64), byteLength: 1 }, [{ width: 100, height: 100, rotation: 0 }]);
    expect(sidecarHasInk(empty)).toBe(false);
    empty.notebook.pages[0].strokes.push(stroke(sourcePageId(0), "s"));
    expect(sidecarHasInk(empty)).toBe(true);
  });

  it("exportPathFor uniquifies without touching the source", () => {
    const exists = (path: string) => path === "docs/lecture (handwritten).pdf" || path === "docs/lecture (handwritten) 2.pdf";
    expect(exportPathFor("docs/lecture.pdf", exists)).toBe("docs/lecture (handwritten) 3.pdf");
    expect(exportPathFor("docs/other.pdf", exists)).toBe("docs/other (handwritten).pdf");
  });

  it("wraps failures in PdfExportError", () => {
    const error = new PdfExportError("signed", "no");
    expect(error.reason).toBe("signed");
    expect(error.name).toBe("PdfExportError");
  });
});
