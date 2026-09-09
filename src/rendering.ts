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
  return getStroke(stroke.points.map((point) => [point.x * width, point.y * height, point.pressure]), {
    // Preserve the existing diameter: width * (0.55 + pressure * 0.75).
    size: stroke.width * 0.925,
    thinning: 0.75 / 1.85,
    simulatePressure: false,
    streamline: 0.35,
    smoothing: 0.65,
    last: true,
    start: { cap: true, taper: 0 },
    end: { cap: true, taper: 0 },
  });
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
    const last = outline[outline.length - 1];
    path.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
    for (let index = 0; index < outline.length; index++) {
      const point = outline[index];
      const next = outline[(index + 1) % outline.length];
      path.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
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
