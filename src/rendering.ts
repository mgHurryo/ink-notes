import { getStroke } from "perfect-freehand";
import type { InkPoint, InkStroke } from "./model";

interface CachedPath {
  points: InkPoint[];
  count: number;
  updatedAt: number;
  size: number;
  width: number;
  height: number;
  path: Path2D;
}

const paths = new WeakMap<InkStroke, CachedPath>();

export function canvasResolution(width: number, height: number, dpr: number, zoom: number, maxPixels = 16_000_000): { width: number; height: number } {
  // Limit allocation, not device density or zoom independently.
  const scale = Math.min(dpr * zoom, 8192 / width, 8192 / height, Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function penOutline(stroke: InkStroke, width: number, height: number): number[][] {
  const pressures = smoothPenPressures(stroke.points);
  return getStroke(stroke.points.map((point, index) => [point.x * width, point.y * height, pressures[index]]), {
    // Preserve the existing diameter: width * (0.55 + pressure * 0.75).
    size: stroke.width * 0.925,
    thinning: 0.75 / 1.85,
    simulatePressure: false,
    // Input is already stabilized by the user's smoothing control. A second
    // position filter pulls sparse fast corners away from the saved trajectory.
    streamline: 0,
    smoothing: 0.65,
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  });
}

export function smoothPenPressures(points: readonly InkPoint[]): number[] {
  if (points.length < 3) return points.map((point) => point.pressure);
  // Pencil hardware can emit isolated pressure drops even while its position
  // remains continuous. Those one-sample dips become visible bites on both
  // sides of perfect-freehand's outline and persist after Vault sync. A local
  // median rejects the spike while retaining sustained pressure changes.
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point.pressure;
    return median3(points[index - 1].pressure, point.pressure, points[index + 1].pressure);
  });
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

export function drawInkStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, width: number, height: number): void {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.fillStyle = stroke.color;
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
  if (stroke.points.length === 1) {
    const point = stroke.points[0];
    const diameter = stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + point.pressure * 0.75);
    ctx.beginPath();
    ctx.arc(point.x * width, point.y * height, diameter / 2, 0, Math.PI * 2);
    ctx.fill();
  } else if (stroke.tool === "highlighter") {
    ctx.lineWidth = stroke.width;
    drawSmoothPath(ctx, stroke.points, width, height);
    ctx.stroke();
  } else {
    let cached = paths.get(stroke);
    if (!cached || cached.points !== stroke.points || cached.count !== stroke.points.length
      || cached.updatedAt !== stroke.updatedAt || cached.size !== stroke.width || cached.width !== width || cached.height !== height) {
      cached = { points: stroke.points, count: stroke.points.length, updatedAt: stroke.updatedAt, size: stroke.width,
        width, height, path: createPenPath(stroke, width, height) };
      paths.set(stroke, cached);
    }
    // Composite once so segment overlaps cannot accumulate alpha at their edges.
    ctx.fill(cached.path);
  }
  ctx.restore();
}

function createPenPath(stroke: InkStroke, width: number, height: number): Path2D {
  const path = new Path2D();
  const outline = penOutline(stroke, width, height);
  if (outline.length > 0) {
    const first = outline[0];
    // The outline already contains rounded caps and pressure geometry and is
    // the final ink shape. Render it as a plain polygon: with dense input it
    // is already smooth, and curve fitting across the long segments of a
    // sparsely sampled fast stroke would cut its corners into arcs.
    path.moveTo(first[0], first[1]);
    for (let index = 1; index < outline.length; index++) {
      const point = outline[index];
      path.lineTo(point[0], point[1]);
    }
    path.closePath();
  }
  return path;
}

function drawSmoothPath(ctx: CanvasRenderingContext2D, points: InkPoint[], width: number, height: number): void {
  ctx.beginPath();
  ctx.moveTo(points[0].x * width, points[0].y * height);
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const end = index === points.length - 1 ? point : { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
    ctx.quadraticCurveTo(previous.x * width, previous.y * height, end.x * width, end.y * height);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last.x * width, last.y * height);
}
