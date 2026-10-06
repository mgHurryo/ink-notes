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
  const centerline = smoothOutlineCenterline(
    stroke.points.map((point, index) => [point.x * width, point.y * height, pressures[index], point.t]),
    stroke.width * 0.925,
  );
  return penRibbonPolygon(centerline, stroke);
}

/**
 * Flattens the variable-width stroke ribbon around the centerline into a
 * single polygon: left offsets forward, end cap, right offsets backward,
 * start cap. Nonzero-winding fill renders this correctly even where a stroke
 * crosses or doubles back on itself, unlike a strand-offset outline whose
 * inner boundary collapses on tight loops (small handwriting with a
 * comparatively thick nib filled loop interiors and folded hooks into dots).
 * Per-point diameter follows the established convention
 * width * (0.55 + pressure * 0.75), modulated by the stroke's captured
 * dynamics: end taper (round caps toward sharp points), pressure response
 * amplitude (uniform width toward full dynamics) and speed-based thinning
 * (relative to the stroke's own median pace, so it self-scales with zoom and
 * writing size).
 */
function penRibbonPolygon(points: number[][], stroke: InkStroke): number[][] {
  const taper = clampPercent(stroke.dynamics?.taper, 0);
  const pressureGain = clampPercent(stroke.dynamics?.pressure, 100) / 100;
  const speedGain = clampPercent(stroke.dynamics?.speed, 0) / 100;
  // Per-point travel speed (page px/s), smoothed over the immediate
  // neighbors to reject sample jitter.
  const speeds: number[] = new Array(points.length);
  for (let index = 0; index < points.length; index++) {
    const previous = points[Math.max(0, index - 1)];
    const following = points[Math.min(points.length - 1, index + 1)];
    const distance = Math.hypot(following[0] - previous[0], following[1] - previous[1]);
    const dt = Math.max(1, (following[3] - previous[3]) / 2);
    speeds[index] = distance / (dt / 1000);
  }
  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const medianSpeed = sortedSpeeds[Math.floor(sortedSpeeds.length / 2)] || 0;
  // Full thinning kicks in at ~2.5x the stroke's own median pace (floored so
  // near-stationary strokes still respond).
  const speedReference = Math.max(medianSpeed * 2.5, 60);
  const halfWidth = (point: number[], speed: number): number => {
    const pressure = point[2];
    const effectivePressure = 0.5 + (pressure - 0.5) * pressureGain;
    const speedFactor = 1 - speedGain * Math.min(speed / speedReference, 1) * 0.65;
    return Math.max(0.3, (brushWidth * (0.55 + 0.75 * effectivePressure)) / 2) * speedFactor;
  };
  const count = points.length;
  if (count === 0) return [];
  // End taper: the half-width ramps to zero over rampLen at both ends.
  let totalLength = 0;
  const cumulative: number[] = new Array(count);
  cumulative[0] = 0;
  for (let index = 1; index < count; index++) {
    totalLength += Math.hypot(points[index][0] - points[index - 1][0], points[index][1] - points[index - 1][1]);
    cumulative[index] = totalLength;
  }
  const brushWidth = stroke.width;
  const rampLength = taper * Math.min(totalLength * 0.25, brushWidth * 2);
  const taperFactor = (distanceFromEnd: number): number => {
    if (rampLength <= 0) return 1;
    const m = Math.min(1, distanceFromEnd / rampLength);
    return m * m * (3 - 2 * m);
  };
  const halfWidthAt = (index: number): number =>
    halfWidth(points[index], speeds[index]) * taperFactor(Math.min(cumulative[index], totalLength - cumulative[index]));
  if (count === 1) {
    const ring: number[][] = [];
    const radius = Math.max(0.3, (brushWidth * (0.55 + 0.75 * (0.5 + (points[0][2] - 0.5) * pressureGain))) / 2);
    for (let index = 0; index < 16; index++) {
      const angle = (index / 16) * Math.PI * 2;
      ring.push([points[0][0] + Math.cos(angle) * radius, points[0][1] + Math.sin(angle) * radius]);
    }
    return ring;
  }
  const left: number[][] = [];
  const right: number[][] = [];
  for (let index = 0; index < count; index++) {
    const point = points[index];
    const previous = points[Math.max(0, index - 1)];
    const following = points[Math.min(count - 1, index + 1)];
    let dx = following[0] - previous[0];
    let dy = following[1] - previous[1];
    if (index === 0) { dx = points[1][0] - point[0]; dy = points[1][1] - point[1]; }
    else if (index === count - 1) { dx = point[0] - points[index - 1][0]; dy = point[1] - points[index - 1][1]; }
    let length = Math.hypot(dx, dy);
    if (length < 1e-6) { dx = 1; dy = 0; length = 1; }
    const nx = -dy / length;
    const ny = dx / length;
    const radius = halfWidthAt(index);
    left.push([point[0] + nx * radius, point[1] + ny * radius]);
    right.push([point[0] - nx * radius, point[1] - ny * radius]);
  }
  const capSegments = 13;
  const endCap: number[][] = [];
  const lastIndex = count - 1;
  let ex = points[lastIndex][0] - points[lastIndex - 1][0];
  let ey = points[lastIndex][1] - points[lastIndex - 1][1];
  let endLength = Math.hypot(ex, ey);
  if (endLength < 1e-6) { ex = 1; ey = 0; endLength = 1; }
  ex /= endLength; ey /= endLength;
  const endRadius = halfWidthAt(lastIndex);
  for (let index = 1; index < capSegments; index++) {
    const angle = Math.PI * (index / capSegments);
    const across = Math.cos(angle), along = Math.sin(angle);
    endCap.push([
      points[lastIndex][0] + (-ey * across + ex * along) * endRadius,
      points[lastIndex][1] + (ex * across + ey * along) * endRadius,
    ]);
  }
  const startCap: number[][] = [];
  let sx = points[0][0] - points[1][0];
  let sy = points[0][1] - points[1][1];
  let startLength = Math.hypot(sx, sy);
  if (startLength < 1e-6) { sx = -1; sy = 0; startLength = 1; }
  sx /= startLength; sy /= startLength;
  const startRadius = halfWidthAt(0);
  for (let index = 1; index < capSegments; index++) {
    const angle = Math.PI * (index / capSegments);
    const across = Math.cos(angle), along = Math.sin(angle);
    startCap.push([
      points[0][0] + (-sy * across + sx * along) * startRadius,
      points[0][1] + (sx * across + sy * along) * startRadius,
    ]);
  }
  return [...left, ...endCap, ...right.slice().reverse(), ...startCap];
}

export function clampPercent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

/**
 * Connects the sampled centerline with curves instead of raw polylines, so a
 * fast hook sampled a handful of times renders as the curve the pen drew
 * rather than a straight-line kink. Corner-preserving by construction: a
 * vertex only participates while BOTH adjacent segments are short relative to
 * the nib, so deliberate sharp corners drawn with long strokes keep their
 * vertex exactly, and every displacement stays a small fraction of the nib
 * width. Endpoints never move, so strokes still start on the pen-down spot
 * and land on the lift position. Render-only: stored points are untouched.
 */
export function smoothOutlineCenterline(points: number[][], nib: number): number[][] {
  if (points.length < 3) return points;
  const maxSegment = nib * 0.75;
  let current = points;
  for (let pass = 0; pass < 2; pass++) {
    const next = current.map((point) => point.slice());
    for (let index = 1; index < current.length - 1; index++) {
      const point = current[index];
      const previous = current[index - 1];
      const following = current[index + 1];
      if (Math.hypot(point[0] - previous[0], point[1] - previous[1]) > maxSegment) continue;
      if (Math.hypot(following[0] - point[0], following[1] - point[1]) > maxSegment) continue;
      next[index][0] = (previous[0] + 2 * point[0] + following[0]) / 4;
      next[index][1] = (previous[1] + 2 * point[1] + following[1]) / 4;
      next[index][2] = (previous[2] + 2 * point[2] + following[2]) / 4;
    }
    current = next;
  }
  return current;
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
    const gain = clampPercent(stroke.dynamics?.pressure, 100) / 100;
    const effectivePressure = 0.5 + (point.pressure - 0.5) * gain;
    const diameter = stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + effectivePressure * 0.75);
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
