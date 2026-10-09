import { PDFDocument, PDFPage, degrees, rgb } from "pdf-lib";
import { InkNotebook, InkStroke } from "./model";
import { PdfSidecar, PdfSidecarNotePage } from "./pdf-sidecar";
import { penOutlineRings } from "./rendering";

/**
 * Vector ink export: re-renders the sidecar's note pages on top of the source
 * PDF without ever touching the source bytes. The display->PDF coordinate
 * transform below was verified against pdf.js (the renderer Obsidian itself
 * uses) with zero error for rotations 0/90/180/270 on mixed page sizes, and
 * the pipeline passed content-preservation, highlighter-transparency, and
 * rotation pixel checks during the pdf-lib evaluation (rotated pages, Letter
 * landscape, an added blank page carrying the neighbor's geometry).
 */

export type PdfExportFailureReason = "signed" | "encrypted" | "corrupt";

export class PdfExportError extends Error {
  constructor(readonly reason: PdfExportFailureReason, message: string) {
    super(message);
    this.name = "PdfExportError";
  }
}

/**
 * Digitally signed PDFs must fail export explicitly: rewriting them would
 * invalidate the signature. pdf-lib has no signature API, so detect the
 * Adobe-style /ByteRange marker in the raw bytes and refuse before parsing.
 */
export function looksDigitallySigned(bytes: ArrayBuffer): boolean {
  const data = new Uint8Array(bytes);
  const marker = "/ByteRange";
  // Windowed scan with a small overlap so a marker straddling two chunks is
  // still found without materializing the whole file as a string.
  const windowSize = 4096;
  let tail = "";
  for (let start = 0; start < data.length; start += windowSize - (marker.length - 1)) {
    const chunk = data.subarray(start, Math.min(start + windowSize, data.length));
    tail += String.fromCharCode(...chunk);
    if (tail.includes(marker)) return true;
    tail = tail.slice(-(marker.length - 1));
  }
  return false;
}

/**
 * Stroke widths are authored in PDF points: the PDF ink view uses the page's
 * point size as its logical canvas size, so a stored width of 3 renders as
 * 3/595 of an A4 page width on screen and exports as exactly 3 pt.
 */
export function inkToSvgPath(stroke: InkStroke, page: PdfSidecarNotePage): string {
  const points = stroke.points.map((point) => displayToPdfPoint(point.x, point.y, page));
  // pdf-lib draws SVG paths with y pointing down from the anchor; the anchor
  // below pins (0,0) to the page's top-left, so flip y here.
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${fmt(point.x)} ${fmt(page.height - point.y)}`).join(" ");
}

/** Build a closed PDF fill path from the same pressure/speed outline used on screen. */
export function inkToSvgOutlinePath(stroke: InkStroke, page: PdfSidecarNotePage, renderWidth?: number): string {
  const rotated = page.rotation === 90 || page.rotation === 270;
  const displayWidth = rotated ? page.height : page.width;
  const displayHeight = rotated ? page.width : page.height;
  const logicalWidth = renderWidth && Number.isFinite(renderWidth) && renderWidth > 0 ? renderWidth : displayWidth;
  const logicalHeight = Math.max(1, Math.round((logicalWidth * displayHeight / displayWidth) * 64) / 64);
  return penOutlineRings(stroke, logicalWidth, logicalHeight).map((ring) => {
    const points = ring.map(([x, y]) => {
      const point = displayToPdfPoint(x / logicalWidth, y / logicalHeight, page);
      return `${fmt(point.x)} ${fmt(page.height - point.y)}`;
    });
    return `M ${points.join(" L ")} Z`;
  }).join(" ");
}

function inkToSvgHighlighterPath(stroke: InkStroke, page: PdfSidecarNotePage): string {
  const map = (x: number, y: number): { x: number; y: number } => {
    const point = displayToPdfPoint(x, y, page);
    return { x: point.x, y: page.height - point.y };
  };
  const first = map(stroke.points[0].x, stroke.points[0].y);
  const commands = [`M ${fmt(first.x)} ${fmt(first.y)}`];
  for (let index = 1; index < stroke.points.length; index++) {
    const previous = stroke.points[index - 1];
    const point = stroke.points[index];
    const end = index === stroke.points.length - 1
      ? point
      : { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
    const control = map(previous.x, previous.y);
    const mappedEnd = map(end.x, end.y);
    commands.push(`Q ${fmt(control.x)} ${fmt(control.y)} ${fmt(mappedEnd.x)} ${fmt(mappedEnd.y)}`);
  }
  const last = map(stroke.points[stroke.points.length - 1].x, stroke.points[stroke.points.length - 1].y);
  commands.push(`L ${fmt(last.x)} ${fmt(last.y)}`);
  return commands.join(" ");
}

/** Display-space (normalized, y down) to PDF user space (points, y up, un-rotated). */
export function displayToPdfPoint(nx: number, ny: number, page: PdfSidecarNotePage): { x: number; y: number } {
  const rotated = page.rotation === 90 || page.rotation === 270;
  const displayWidth = rotated ? page.height : page.width;
  const displayHeight = rotated ? page.width : page.height;
  const dx = nx * displayWidth;
  const dy = ny * displayHeight;
  switch (page.rotation) {
    case 90: return { x: dy, y: dx };
    case 180: return { x: page.width - dx, y: dy };
    case 270: return { x: page.width - dy, y: page.height - dx };
    default: return { x: dx, y: page.height - dy };
  }
}

/**
 * Export a whole notebook as a new PDF: one page per notebook page at the
 * notebook's own dimensions, handwriting drawn as vector paths. Shares the
 * stroke drawing with the PDF sidecar exporter.
 */
export async function exportNotebookPdf(notebook: InkNotebook, sourceName: string, renderWidth?: number): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  output.setTitle(`${sourceName} (handwritten)`);
  for (const page of notebook.pages) {
    const geometry = { id: page.id, width: notebook.pageWidth, height: notebook.pageHeight, rotation: 0 as const };
    const pdfPage = output.addPage([notebook.pageWidth, notebook.pageHeight]);
    for (const stroke of page.strokes) drawStroke(pdfPage, stroke, geometry, renderWidth);
  }
  return output.save();
}

/** True when the notebook contains at least one stroke to export. */
export function notebookHasInk(notebook: InkNotebook): boolean {
  return notebook.pages.some((page) => page.strokes.length > 0);
}

/** True when the note sequence contains at least one stroke to export. */
export function sidecarHasInk(sidecar: PdfSidecar): boolean {
  return sidecar.notebook.pages.some((page) => page.strokes.length > 0);
}

export async function exportHandwrittenPdf(sourceBytes: ArrayBuffer, sidecar: PdfSidecar, sourceName: string, renderWidth?: number): Promise<Uint8Array> {
  if (looksDigitallySigned(sourceBytes)) {
    throw new PdfExportError("signed", "This PDF is digitally signed; exporting would invalidate the signature");
  }
  let source: PDFDocument;
  try {
    source = await PDFDocument.load(sourceBytes, { ignoreEncryption: false, updateMetadata: false });
  } catch (error) {
    if (/\bencrypted\b/i.test(String((error as Error)?.message))) {
      throw new PdfExportError("encrypted", "Encrypted PDFs cannot be exported with handwriting");
    }
    throw new PdfExportError("corrupt", `This PDF could not be read for export: ${(error as Error)?.message ?? String(error)}`);
  }
  const sourcePages = source.getPages();
  const output = await PDFDocument.create();
  output.setTitle(`${sourceName} (handwritten)`);

  const strokesByPage = new Map(sidecar.notebook.pages.map((page) => [page.id, page.strokes]));
  for (const notePage of sidecar.notePages) {
    let page: PDFPage;
    if (notePage.sourceIndex !== undefined) {
      if (notePage.sourceIndex >= sourcePages.length) continue;
      const [copied] = await output.copyPages(source, [notePage.sourceIndex]);
      page = output.addPage(copied);
    } else {
      // Blank note pages carry geometry copied from a neighbor — including
      // rotation, so the page displays exactly like its surroundings.
      page = output.addPage([notePage.width, notePage.height]);
      if (notePage.rotation !== 0) page.setRotation(degrees(notePage.rotation));
    }
    for (const stroke of strokesByPage.get(notePage.id) ?? []) {
      drawStroke(page, stroke, notePage, renderWidth);
    }
  }
  return output.save();
}

function drawStroke(page: PDFPage, stroke: InkStroke, notePage: PdfSidecarNotePage, renderWidth?: number): void {
  const { red, green, blue } = parseHexColor(stroke.color);
  const color = rgb(red, green, blue);
  const rotated = notePage.rotation === 90 || notePage.rotation === 270;
  const displayWidth = rotated ? notePage.height : notePage.width;
  const logicalWidth = renderWidth && Number.isFinite(renderWidth) && renderWidth > 0 ? renderWidth : displayWidth;
  const widthScale = displayWidth / logicalWidth;
  if (stroke.tool !== "highlighter") {
    page.drawSvgPath(inkToSvgOutlinePath(stroke, notePage, logicalWidth), {
      color,
      opacity: stroke.opacity,
      x: 0,
      y: notePage.height,
    });
    return;
  }
  if (stroke.points.length === 1) {
    const center = displayToPdfPoint(stroke.points[0].x, stroke.points[0].y, notePage);
    page.drawCircle({ x: center.x, y: center.y, size: stroke.width * widthScale / 2, color, opacity: stroke.opacity });
    return;
  }
  page.drawSvgPath(inkToSvgHighlighterPath(stroke, notePage), {
    borderColor: color,
    borderWidth: stroke.width * widthScale,
    borderOpacity: stroke.opacity,
    borderLineCap: 1, // round caps, matching the on-screen renderer
    x: 0,
    y: notePage.height,
  });
}

export function parseHexColor(value: string): { red: number; green: number; blue: number } {
  const hex = /^#?([0-9a-f]{6})$/i.exec(value.trim())?.[1] ?? "1b1b1b";
  return {
    red: parseInt(hex.slice(0, 2), 16) / 255,
    green: parseInt(hex.slice(2, 4), 16) / 255,
    blue: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/** `<name> (handwritten).pdf` next to the source, uniquified, never the source. */
export function exportPathFor(pdfPath: string, exists: (candidate: string) => boolean): string {
  const slash = pdfPath.lastIndexOf("/");
  const directory = slash >= 0 ? pdfPath.slice(0, slash) : "";
  const file = slash >= 0 ? pdfPath.slice(slash + 1) : pdfPath;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  let candidate = joinPath(directory, `${stem} (handwritten).pdf`);
  let count = 2;
  while (exists(candidate)) candidate = joinPath(directory, `${stem} (handwritten) ${count++}.pdf`);
  return candidate;
}

function joinPath(directory: string, file: string): string {
  return directory ? `${directory}/${file}` : file;
}

function fmt(value: number): string {
  return String(Math.round(value * 100) / 100);
}
