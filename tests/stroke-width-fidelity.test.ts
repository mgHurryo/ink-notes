import { afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFRawStream, PDFArray, decodePDFRawStream } from "pdf-lib";
import { createNotebook, InkStroke } from "../src/model";
import { drawInkStroke } from "../src/rendering";
import { exportNotebookPdf, inkToSvgOutlinePath } from "../src/pdf-export";
import { InkWorkerCore } from "../src/worker-core";
import type { InkWorkerRequest } from "../src/worker-protocol";

/**
 * Cross-renderer stroke-width fidelity matrix (regression harness for the
 * "same stored notebook renders the same stroke width everywhere" contract).
 *
 * One stored notebook is pushed through the three production render paths —
 * the main-thread canvas (drawInkStroke), the Worker tile mirror (renderTile)
 * and the PDF export (inkToSvgOutlinePath / exportNotebookPdf) — at several
 * canvasLogicalWidth × DPR combinations, and the rendered stroke width is
 * measured per pixel from the exact geometry each path fills. All cells must
 * agree on the stroke's width as a fraction of the page.
 */

const PAGE_WIDTH = 1600;
const PAGE_HEIGHT = 2200;
/** The canonical reference page box width stroke widths are authored against
 *  (mirrors STROKE_WIDTH_REFERENCE; kept local so the contract, not the
 *  constant, is what this file pins). */
const WIDTH_REFERENCE = 980;

const CELLS = [
  { name: "980 wide @ dpr 2", logicalWidth: 980, dpr: 2 },
  { name: "iPad split view @ dpr 2", logicalWidth: 764, dpr: 2 },
  { name: "export width @ dpr 1", logicalWidth: 595.28, dpr: 1 },
];

function logicalHeight(logicalWidth: number): number {
  return logicalWidth * PAGE_HEIGHT / PAGE_WIDTH;
}

function lineStroke(width: number, tool: "pen" | "highlighter"): InkStroke {
  return {
    id: `s-${tool}-${width}`, pageId: "page", tool, color: "#1b1b1b", width, opacity: 1,
    points: Array.from({ length: 61 }, (_, index) => ({ x: 0.3 + 0.4 * index / 60, y: 0.5, pressure: 0.5, t: index * 8 })),
    createdAt: 1, updatedAt: 1,
  };
}

// ---------------------------------------------------------------- rasterizer

type PathOp = { op: "moveTo" | "lineTo"; x: number; y: number } | { op: "closePath" };

/** The probe column sits mid-trapezoid (half a sample spacing past the
 *  center), where the stamped band's edges are the exact ±halfWidth lines —
 *  never on a 12-gon disc whose chord under-reads the nib. */
const PROBE_NX = 0.5 + 0.4 / 120;

/**
 * Exact filled height of the vertical line x = xc under the nonzero-winding
 * fill of the rings. The column's boundary y values partition it into gaps of
 * constant winding, so evaluating one midpoint per gap measures the true
 * filled height with no raster quantization. Horizontal edges (a horizontal
 * stroke's band boundaries) participate as boundary points; the winding test
 * itself is the standard horizontal-ray cast.
 */
function exactColumnFillWidth(rings: number[][][], xc: number): number {
  const boundaries: number[] = [];
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      const crosses = (a[0] <= xc && b[0] > xc) || (b[0] <= xc && a[0] > xc);
      if (!crosses) continue;
      const t = (xc - a[0]) / (b[0] - a[0]);
      boundaries.push(a[1] + t * (b[1] - a[1]));
    }
  }
  if (boundaries.length === 0) return 0;
  boundaries.sort((left, right) => left - right);
  let width = 0;
  let previous = boundaries[0];
  for (const boundary of boundaries.slice(1)) {
    const midY = (previous + boundary) / 2;
    if (nonzeroAtX(rings, xc, midY)) width += boundary - previous;
    previous = boundary;
  }
  return width;
}

function nonzeroAtX(rings: number[][][], x: number, y: number): boolean {
  let winding = 0;
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      if (a[1] <= y) { if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) > 0) winding += 1; }
      else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0) winding -= 1;
    }
  }
  return winding !== 0;
}

class FakePath2D {
  ops: PathOp[] = [];
  moveTo(x: number, y: number): void { this.ops.push({ op: "moveTo", x, y }); }
  lineTo(x: number, y: number): void { this.ops.push({ op: "lineTo", x, y }); }
  quadraticCurveTo(): void { throw new Error("pen outlines never emit curves"); }
  closePath(): void { this.ops.push({ op: "closePath" }); }
}

interface Matrix { a: number; b: number; c: number; d: number; e: number; f: number }

/** Records path calls and rasterizes them on demand with nonzero winding, so
 *  tests can pixel-measure the geometry each renderer actually fills. */
class RecordingContext {
  readonly canvas = { width: 0, height: 0 };
  transform: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  lineWidth = 1;
  globalAlpha = 1;
  fillStyle = "";
  strokeStyle = "";
  lineCap = "butt";
  lineJoin = "miter";
  globalCompositeOperation = "source-over";
  path: PathOp[] = [];
  readonly save = vi.fn();
  readonly restore = vi.fn();
  readonly beginPath = vi.fn(() => { this.path = []; });
  readonly moveTo = vi.fn((x: number, y: number) => { this.path.push({ op: "moveTo", x, y }); });
  readonly lineTo = vi.fn((x: number, y: number) => { this.path.push({ op: "lineTo", x, y }); });
  readonly quadraticCurveTo = vi.fn();
  readonly closePath = vi.fn(() => { this.path.push({ op: "closePath" }); });
  readonly arc = vi.fn();

  constructor(width: number, height: number) { this.canvas.width = width; this.canvas.height = height; }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = { a, b, c, d, e, f };
  }

  private device(x: number, y: number): [number, number] {
    const t = this.transform;
    return [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  }

  private deviceRings(ops: PathOp[]): number[][][] {
    const rings: number[][][] = [];
    let current: number[][] = [];
    for (const op of ops) {
      if (op.op === "closePath") { if (current.length >= 3) rings.push(current); current = []; continue; }
      const [x, y] = this.device(op.x, op.y);
      if (op.op === "moveTo") { if (current.length >= 3) rings.push(current); current = [[x, y]]; }
      else current.push([x, y]);
    }
    if (current.length >= 3) rings.push(current);
    return rings;
  }

  /**
   * Exact filled height of the vertical line x = xc under the nonzero-winding
   * fill of the rings — delegates to the standalone analytic integrator.
   */
  columnFillWidth(rings: number[][][], xc: number): number {
    return exactColumnFillWidth(rings, xc);
  }
  /** Coverage of a vertical column against a stroked round-cap polyline. */
  columnStrokeWidth(points: Array<[number, number]>, radius: number, xc: number, yc: number, margin: number): number {
    let total = 0;
    const subs = 4;
    for (let pixel = Math.floor(yc - margin); pixel <= Math.ceil(yc + margin); pixel++) {
      let covered = 0;
      for (let sy = 0; sy < subs; sy++) for (let sx = 0; sx < subs; sx++) {
        const x = xc + (sx + 0.5) / subs - 0.5;
        const y = pixel + (sy + 0.5) / subs - 0.5;
        if (this.nearPolyline(points, x, y, radius)) covered += 1;
      }
      total += covered / (subs * subs);
    }
    return total;
  }

  private nearPolyline(points: Array<[number, number]>, x: number, y: number, radius: number): boolean {
    for (let index = 0; index < points.length - 1; index++) {
      const [ax, ay] = points[index];
      const [bx, by] = points[index + 1];
      const dx = bx - ax, dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
      if (Math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= radius) return true;
    }
    return false;
  }

  fill(path?: FakePath2D): void {
    const ops = path ? path.ops : this.path;
    this.lastFillRings = this.deviceRings(ops);
  }

  stroke(): void {
    const points: Array<[number, number]> = [];
    for (const op of this.path) {
      if (op.op === "closePath") continue;
      points.push(this.device(op.x, op.y));
    }
    const t = this.transform;
    const scale = Math.hypot(t.a, t.b);
    // Vertical extent of the stroked band at the probe column (supersampled;
    // only used as a cross-check, the pen matrix measures exact fills).
    this.lastStrokeWidth = this.columnStrokeWidth(points, this.lineWidth * scale / 2, this.probeX, this.probeY, this.lineWidth * scale + 8);
  }

  // Measurement hooks: the probe column is registered before drawing so fill()
  // and stroke() can rasterize exactly what the renderer emitted.
  probeX = 0;
  probeY = 0;
  lastFillRings: number[][][] = [];
  lastStrokeWidth = 0;
}

// ------------------------------------------------------------ measurement

async function measureMainThread(stroke: InkStroke, cell: (typeof CELLS)[number], dprOverride?: number): Promise<number> {
  const dpr = dprOverride ?? cell.dpr;
  const height = logicalHeight(cell.logicalWidth);
  const deviceWidth = Math.ceil(cell.logicalWidth * dpr);
  const deviceHeight = Math.ceil(height * dpr);
  const ctx = new RecordingContext(deviceWidth, deviceHeight);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.probeX = PROBE_NX * cell.logicalWidth * dpr;
  ctx.probeY = 0.5 * height * dpr;
  vi.stubGlobal("Path2D", FakePath2D);
  try {
    drawInkStroke(ctx as unknown as CanvasRenderingContext2D, stroke, cell.logicalWidth, height);
  } finally {
    vi.unstubAllGlobals();
  }
  const devicePixels = stroke.tool === "highlighter" ? ctx.lastStrokeWidth : ctx.columnFillWidth(ctx.lastFillRings, ctx.probeX);
  // Page-width fraction: same stored note must fill the same slice of the page.
  return devicePixels / (cell.logicalWidth * dpr);
}

class FakeOffscreenCanvas {
  static last: FakeOffscreenCanvas | null = null;
  readonly width: number;
  readonly height: number;
  readonly ctx: RecordingContext;
  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.ctx = new RecordingContext(width, height);
    FakeOffscreenCanvas.last = this;
  }
  getContext(): RecordingContext { return this.ctx; }
  transferToImageBitmap(): { close(): void } { return { close: () => undefined }; }
}

async function measureWorkerTile(stroke: InkStroke, cell: (typeof CELLS)[number]): Promise<number> {
  const height = logicalHeight(cell.logicalWidth);
  const notebook = createNotebook();
  notebook.pageWidth = PAGE_WIDTH;
  notebook.pageHeight = PAGE_HEIGHT;
  const page = notebook.pages[0];
  page.strokes.push({ ...stroke, pageId: page.id });
  const core = new InkWorkerCore({ offscreenCanvas: true, imageBitmap: true });
  const column = Math.floor(0.5 * cell.logicalWidth / 128);
  const row = Math.floor(0.5 * height / 128);
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  let rendered = false;
  try {
    const init = await core.handle({ type: "initialize-notebook", sessionId: "t", generation: 1, requestId: 1, notebookRevision: 0, revision: 0, notebook } as InkWorkerRequest);
    if (init.response.type !== "initialized") throw new Error(`worker session failed: ${init.response.type}`);
    const reply = await core.handle({
      type: "render-tile", sessionId: "t", generation: 1, requestId: 2, notebookRevision: 0,
      pageId: page.id, cell: `${column}:${row}`, density: cell.dpr, revision: 0, renderGeneration: 1,
      priority: "visible", width: cell.logicalWidth, height,
    } as InkWorkerRequest);
    rendered = reply.response.type === "tile-rendered";
    if (!rendered) throw new Error(`worker tile render failed: ${reply.response.type} ${(reply.response as { message?: string }).message ?? ""}`);
  } finally {
    vi.unstubAllGlobals();
  }
  const canvas = FakeOffscreenCanvas.last!;
  const bleed = Math.ceil(4 * Math.max(0.5, Math.min(9, cell.dpr)));
  const ctx = canvas.ctx;
  const probeX = (PROBE_NX * cell.logicalWidth - column * 128) * cell.dpr + bleed;
  const devicePixels = stroke.tool === "pen"
    ? ctx.columnFillWidth(ctx.lastFillRings, probeX)
    : ctx.lastStrokeWidth;
  return devicePixels / (cell.logicalWidth * cell.dpr);
}

function parseOutlineRings(svgPath: string): number[][][] {
  return svgPath.split("M").filter(Boolean).map((chunk) => chunk.split("Z").filter(Boolean).map((ring) => {
    const numbers = ring.trim().split(/[\s,]+/).map(Number).filter((value) => Number.isFinite(value));
    const points: number[][] = [];
    for (let index = 0; index + 1 < numbers.length; index += 2) points.push([numbers[index], numbers[index + 1]]);
    return points;
  })).flat();
}

function measurePdfOutline(stroke: InkStroke, page: { width: number; height: number; rotation: 0 | 90 | 180 | 270 }, renderWidth: number): number {
  // Lift the point-space rings into device pixels once so the scan works in
  // one coordinate system, then integrate the probe column exactly.
  const scale = 2;
  const rings = parseOutlineRings(inkToSvgOutlinePath(stroke, { id: "p", ...page }, renderWidth))
    .map((ring) => ring.map(([x, y]) => [x * scale, y * scale]));
  const xc = PROBE_NX * page.width * scale;
  const devicePixels = exactColumnFillWidth(rings, xc);
  return devicePixels / (scale * page.width);
}

// ------------------------------------------------------------------ matrix

afterEach(() => vi.unstubAllGlobals());

describe("cross-renderer stroke width fidelity", () => {
  it("renders the same pen nib on the main thread, worker tiles and PDF export at every canvas width", async () => {
    for (const width of [1, 3, 8, 24]) {
      const stroke = lineStroke(width, "pen");
      const nominal = stroke.width * 0.925 / WIDTH_REFERENCE;
      const samples: Array<{ path: string; cell: string; fraction: number }> = [];
      for (const cell of CELLS) {
        samples.push({ path: "main", cell: cell.name, fraction: await measureMainThread(stroke, cell) });
        samples.push({ path: "worker", cell: cell.name, fraction: await measureWorkerTile(stroke, cell) });
        samples.push({ path: "pdf-notebook", cell: cell.name, fraction: measurePdfOutline(stroke, { width: PAGE_WIDTH, height: PAGE_HEIGHT, rotation: 0 }, cell.logicalWidth) });
        samples.push({ path: "pdf-sidecar-a4", cell: cell.name, fraction: measurePdfOutline(stroke, { width: 595.28, height: 841.89, rotation: 0 }, cell.logicalWidth) });
      }
      // DPR alone must not move the width either.
      samples.push({ path: "main", cell: "980 @ dpr 1", fraction: await measureMainThread(stroke, CELLS[0], 1) });
      const fractions = samples.map((sample) => sample.fraction);
      const spread = Math.max(...fractions) - Math.min(...fractions);
      // Every path × cell must land on the same slice of the page; 0.15
      // reference px of slack absorbs rasterization quantization only.
      expect(spread, `width ${width} spread ${spread * WIDTH_REFERENCE} ref px across ${JSON.stringify(samples.map((s) => [s.path, s.cell, +(s.fraction * WIDTH_REFERENCE).toFixed(3)]))}`)
        .toBeLessThan(0.15 / WIDTH_REFERENCE);
      for (const sample of samples) {
        expect(sample.fraction, `${sample.path} @ ${sample.cell} for width ${width}`)
          .toBeLessThan(nominal + Math.max(0.1 / WIDTH_REFERENCE, nominal * 0.1));
        expect(sample.fraction, `${sample.path} @ ${sample.cell} for width ${width}`)
          .toBeGreaterThan(Math.max(0, nominal - Math.max(0.1 / WIDTH_REFERENCE, nominal * 0.1)));
      }
    }
  });

  it("keeps the historical nib diameter at the reference width so stored notes render unchanged there", async () => {
    const stroke = lineStroke(8, "pen");
    const fraction = await measureMainThread(stroke, CELLS[0]);
    // 0.925 = the stamp's effective diameter for default dynamics at median
    // pressure; the reference cell must keep reproducing it (0.5 px slack
    // absorbs the rasterizer's quantization).
    expect(fraction * WIDTH_REFERENCE).toBeCloseTo(stroke.width * 0.925, 0);
  });

  it("scales highlighter widths identically on screen and in the exported PDF", async () => {
    const stroke = lineStroke(18, "highlighter");
    const lineWidths: number[] = [];
    for (const cell of CELLS) {
      const height = logicalHeight(cell.logicalWidth);
      const ctx = new RecordingContext(Math.ceil(cell.logicalWidth * cell.dpr), Math.ceil(height * cell.dpr));
      ctx.setTransform(cell.dpr, 0, 0, cell.dpr, 0, 0);
      vi.stubGlobal("Path2D", FakePath2D);
      try {
        drawInkStroke(ctx as unknown as CanvasRenderingContext2D, stroke, cell.logicalWidth, height);
      } finally {
        vi.unstubAllGlobals();
      }
      // Normalized back to the reference page: all cells must agree.
      lineWidths.push(ctx.lineWidth * WIDTH_REFERENCE / cell.logicalWidth);
    }
    expect(Math.min(...lineWidths)).toBeGreaterThan(0);
    expect(Math.max(...lineWidths) - Math.min(...lineWidths)).toBeLessThan(0.01);
    expect(lineWidths[0]).toBeCloseTo(18, 5);

    const notebook = createNotebook();
    notebook.pages[0].strokes.push({ ...stroke, pageId: notebook.pages[0].id });
    const borderWidths: number[] = [];
    for (const renderWidth of CELLS.map((cell) => cell.logicalWidth)) {
      const bytes = await exportNotebookPdf(notebook, "fidelity", renderWidth);
      const doc = await PDFDocument.load(bytes);
      const node = doc.getPage(0).node;
      const streams = node.Contents() as PDFArray;
      const content = Array.from({ length: streams.size() }, (_, index) =>
        Buffer.from(decodePDFRawStream(doc.context.lookup(streams.get(index)) as PDFRawStream).decode()).toString()).join("\n");
      const widths = [...content.matchAll(/([\d.]+) w\b/g)].map((match) => Number(match[1]));
      expect(widths.length).toBeGreaterThan(0);
      borderWidths.push(...widths);
    }
    // The stored 18 must export as 18/980 of the page width in points no
    // matter which device (renderWidth) produced the export.
    expect(Math.max(...borderWidths) - Math.min(...borderWidths)).toBeLessThan(0.05);
    expect(borderWidths[0]).toBeCloseTo(18 * PAGE_WIDTH / WIDTH_REFERENCE, 1);
  });
});
