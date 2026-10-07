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
  return penOutlineRings(stroke, width, height).flat();
}

/**
 * Stamped ink geometry: every centerline point contributes a disc and every
 * segment a connecting trapezoid, each as its own ring, ALL normalized to
 * the same winding direction. Consumers append every ring to one path and
 * fill once: same-winding overlaps add their winding number instead of
 * cancelling, so retraces, hooks and loops can never produce holes, while
 * the single fill keeps translucent strokes from double-darkening at the
 * (deliberate, area-level) overlaps that make the joins seamless.
 */
export function penOutlineRings(stroke: InkStroke, width: number, height: number): number[][][] {
  const pressures = smoothPenPressures(stroke.points);
  const centerline = smoothOutlineCenterline(
    stroke.points.map((point, index) => [point.x * width, point.y * height, pressures[index], point.t]),
    stroke.width * 0.925,
  );
  const count = centerline.length;
  if (count === 0) return [];
  // Per-point travel speed (page px/s), smoothed over the immediate
  // neighbors to reject sample jitter.
  const speeds: number[] = new Array(count);
  for (let index = 0; index < count; index++) {
    const previous = centerline[Math.max(0, index - 1)];
    const following = centerline[Math.min(count - 1, index + 1)];
    const distance = Math.hypot(following[0] - previous[0], following[1] - previous[1]);
    const dt = Math.max(1, (following[3] - previous[3]) / 2);
    speeds[index] = distance / (dt / 1000);
  }
  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const medianSpeed = sortedSpeeds[Math.floor(sortedSpeeds.length / 2)] || 0;
  // Full thinning kicks in at ~2.5x the stroke's own median pace (floored so
  // near-stationary strokes still respond).
  const speedReference = Math.max(medianSpeed * 2.5, 60);
  const pressureGain = clampPercent(stroke.dynamics?.pressure, 100) / 100;
  const speedGain = clampPercent(stroke.dynamics?.speed, 0) / 100;
  const pressureCurve = normalizePressureCurve(stroke.dynamics?.pressureCurve);
  const taper = clampPercent(stroke.dynamics?.taper, 0) / 100;
  const brushWidth = stroke.width;
  const fullDiameter = brushWidth * 1.3;
  let totalLength = 0;
  const cumulative: number[] = new Array(count);
  cumulative[0] = 0;
  for (let index = 1; index < count; index++) {
    totalLength += Math.hypot(centerline[index][0] - centerline[index - 1][0], centerline[index][1] - centerline[index - 1][1]);
    cumulative[index] = totalLength;
  }
  const rampLength = taper * Math.min(totalLength * 0.25, brushWidth * 2);
  const envelopeAt = (distanceFromEnd: number): number => {
    if (rampLength <= 0) return 1;
    const m = Math.min(1, distanceFromEnd / rampLength);
    const smoothstep = m * m * (3 - 2 * m);
    return 1 - taper * (1 - smoothstep);
  };
  const halfWidthAt = (index: number): number => {
    const point = centerline[index];
    const pressure = samplePressureCurve(Math.max(0, Math.min(1, point[2])), pressureCurve);
    const effectivePressure = 0.5 + (pressure - 0.5) * pressureGain;
    // (0.55 + 0.75 * p) / 1.3 maps the response onto 0.42..1 of the
    // full-pressure diameter, so dynamics stay visible next to the taper.
    const modulation = (0.55 + 0.75 * effectivePressure) / 1.3;
    // Quadratic speed profile, capped at -35%: fast segments thin, but the
    // pressure response stays clearly visible when both channels are active.
    const speedNorm = Math.min(speeds[index] / speedReference, 1);
    const speedFactor = 1 - speedGain * speedNorm * speedNorm * 0.35;
    const envelope = envelopeAt(Math.min(cumulative[index], totalLength - cumulative[index]));
    return Math.max(0.3, (fullDiameter / 2) * envelope * modulation * speedFactor);
  };
  // Per-point normals from the neighbor chord (endpoints clamp to their own
  // segment), matching the band direction the quads use.
  const normals: Array<[number, number]> = new Array(count);
  for (let index = 0; index < count; index++) {
    const point = centerline[index];
    const previous = centerline[Math.max(0, index - 1)];
    const following = centerline[Math.min(count - 1, index + 1)];
    let dx = following[0] - previous[0];
    let dy = following[1] - previous[1];
    if (index === 0 && count > 1) { dx = centerline[1][0] - point[0]; dy = centerline[1][1] - point[1]; }
    else if (index === count - 1 && count > 1) { dx = point[0] - centerline[index - 1][0]; dy = point[1] - centerline[index - 1][1]; }
    let length = Math.hypot(dx, dy);
    if (length < 1e-6) { dx = 1; dy = 0; length = 1; }
    normals[index] = [-dy / length, dx / length];
  }
  const discSegments = 12;
  // Single-point strokes are a lone disc; the normals below need a neighbor.
  if (count === 1) {
    const point = centerline[0];
    const radius = halfWidthAt(0);
    const ring: number[][] = [];
    for (let index = 0; index < discSegments; index++) {
      const angle = (index / discSegments) * Math.PI * 2;
      ring.push([point[0] + Math.cos(angle) * radius, point[1] + Math.sin(angle) * radius]);
    }
    let area = 0;
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    return [area < 0 ? ring.slice().reverse() : ring];
  }
  const rings: number[][][] = [];
  const emitRing = (ring: number[][]): void => {
    if (ring.length < 3) return;
    // Winding normalization: every ring must share one orientation so the
    // nonzero fill of the combined path ADDS overlaps instead of cancelling
    // them - this is what makes retraces and loops hole-free.
    let area = 0;
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    rings.push(area < 0 ? ring.slice().reverse() : ring);
  };
  for (let index = 0; index < count; index++) {
    const point = centerline[index];
    const radius = halfWidthAt(index);
    const [nx, ny] = normals[index];
    const ring: number[][] = [];
    for (let sample = 0; sample < discSegments; sample++) {
      const angle = (sample / discSegments) * Math.PI * 2;
      ring.push([point[0] + Math.cos(angle) * radius, point[1] + Math.sin(angle) * radius]);
    }
    emitRing(ring);
    if (index === count - 1) continue;
    const following = centerline[index + 1];
    const followingRadius = halfWidthAt(index + 1);
    const [fnx, fny] = normals[index + 1];
    emitRing([
      [point[0] + nx * radius, point[1] + ny * radius],
      [following[0] + fnx * followingRadius, following[1] + fny * followingRadius],
      [following[0] - fnx * followingRadius, following[1] - fny * followingRadius],
      [point[0] - nx * radius, point[1] - ny * radius],
    ]);
  }
  return rings;
}


export function clampPercent(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

/**
 * Sanitizes a user-drawn pressure mapping curve: 2-8 control points with
 * x clamped into [0,1] and forced monotonic (endpoints pinned to x=0 and
 * x=1), y clamped into [0,1]. Returns undefined for absent or identity
 * curves so storage stays clean.
 */
export function normalizePressureCurve(raw: unknown): number[][] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const cleaned = raw
    .filter((point): point is number[] => Array.isArray(point) && point.length >= 2
      && typeof point[0] === "number" && Number.isFinite(point[0])
      && typeof point[1] === "number" && Number.isFinite(point[1]))
    .map((point) => [Math.max(0, Math.min(1, point[0])), Math.max(0, Math.min(1, point[1]))]
      .map((value) => Math.round(value * 1000) / 1000))
    .sort((a, b) => a[0] - b[0]);
  if (cleaned.length < 2) return undefined;
  cleaned[0][0] = 0;
  cleaned[cleaned.length - 1][0] = 1;
  const monotonic: number[][] = [cleaned[0]];
  for (let index = 1; index < cleaned.length; index++) {
    if (cleaned[index][0] <= monotonic[monotonic.length - 1][0]) continue;
    monotonic.push(cleaned[index]);
  }
  if (monotonic.length < 2) return undefined;
  // Pressure mappings must be non-decreasing: more pressure maps to equal or
  // more width. A dip would make harder presses render thinner.
  for (let index = 1; index < monotonic.length; index++) {
    monotonic[index][1] = Math.max(monotonic[index][1], monotonic[index - 1][1]);
  }
  // An all-points-on-the-diagonal curve is the identity mapping.
  const identity = monotonic.every(([x, y]) => Math.abs(x - y) <= 0.001);
  return identity ? undefined : monotonic;
}

/** Samples the mapping curve with linear interpolation between control points. */
export function samplePressureCurve(pressure: number, curve: number[][] | undefined): number {
  if (!curve || curve.length < 2) return pressure;
  if (pressure <= curve[0][0]) return curve[0][1];
  for (let index = 1; index < curve.length; index++) {
    if (pressure <= curve[index][0]) {
      const span = curve[index][0] - curve[index - 1][0];
      const amount = span > 0 ? (pressure - curve[index - 1][0]) / span : 0;
      return curve[index - 1][1] + (curve[index][1] - curve[index - 1][1]) * amount;
    }
  }
  return curve[curve.length - 1][1];
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
    // All rings share one winding direction, so one nonzero fill adds the
    // overlaps instead of cancelling them: retraces stay solid while the
    // whole stroke still composites once (no alpha stacking at joins).
    ctx.fill(cached.path);
  }
  ctx.restore();
}

function createPenPath(stroke: InkStroke, width: number, height: number): Path2D {
  const path = new Path2D();
  for (const ring of penOutlineRings(stroke, width, height)) {
    path.moveTo(ring[0][0], ring[0][1]);
    for (let index = 1; index < ring.length; index++) path.lineTo(ring[index][0], ring[index][1]);
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
