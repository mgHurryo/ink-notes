import type { InkPoint, InkStroke } from "./model";

/**
 * Scaled stroke miniatures for thumbnails, keyed by the original stroke:
 * drawInkStroke caches its Path2D by stroke object identity, so reusing the
 * clone keeps that cache warm across redraws. Fresh clones recompute every
 * stroke's outline on each repaint (measured 2x~285ms main-thread stalls per
 * input settle on large notebooks). points/updatedAt guards discard a clone
 * whose stroke has been edited since.
 */
const scaledStrokes = new WeakMap<InkStroke, { scale: number; clone: InkStroke }>();

export function scaledStroke(stroke: InkStroke, scale: number): InkStroke {
  const cached = scaledStrokes.get(stroke);
  if (cached && cached.scale === scale && cached.clone.points === stroke.points && cached.clone.updatedAt === stroke.updatedAt) {
    return cached.clone;
  }
  const clone = { ...stroke, width: stroke.width * scale };
  scaledStrokes.set(stroke, { scale, clone });
  return clone;
}

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
  const geometry = penStampGeometry(stroke, width, height);
  if (geometry.count === 0) return [];
  return geometry.ringsFor(0, geometry.count, false);
}

interface PenStampGeometry {
  count: number;
  /**
   * Rings for discs [from, to) plus segment links joining i→i+1 while both
   * endpoints are inside the range. `linkAcrossEnd` extends the links one
   * sample past `to` so a settled range can anchor into the tip's first
   * sample and keep the two stamps seamless.
   */
  ringsFor(from: number, to: number, linkAcrossEnd: boolean): number[][][];
}

function penStampGeometry(stroke: InkStroke, width: number, height: number): PenStampGeometry {
  const pressures = smoothPenPressures(stroke.points);
  const centerline = smoothOutlineCenterline(
    stroke.points.map((point, index) => [point.x * width, point.y * height, pressures[index], point.t]),
    stroke.width * 0.925,
  );
  const count = centerline.length;
  if (count === 0) return { count, ringsFor: () => [] };
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
  const ringsFor = (from: number, to: number, linkAcrossEnd: boolean): number[][][] => {
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
    // A lone sample is a lone disc; the trapezoid normals need a neighbor.
    const lastLink = linkAcrossEnd ? to : to - 1;
    for (let index = from; index < to; index++) {
      const point = centerline[index];
      const radius = halfWidthAt(index);
      const [nx, ny] = normals[index];
      const ring: number[][] = [];
      for (let sample = 0; sample < discSegments; sample++) {
        const angle = (sample / discSegments) * Math.PI * 2;
        ring.push([point[0] + Math.cos(angle) * radius, point[1] + Math.sin(angle) * radius]);
      }
      emitRing(ring);
      if (index >= lastLink) continue;
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
  };
  return { count, ringsFor };
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

function applyStrokeStyle(ctx: CanvasRenderingContext2D, stroke: InkStroke): void {
  ctx.globalAlpha = stroke.opacity;
  ctx.fillStyle = stroke.color;
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.globalCompositeOperation = stroke.tool === "highlighter" ? "multiply" : "source-over";
}

function drawSampleDot(ctx: CanvasRenderingContext2D, stroke: InkStroke, width: number, height: number): void {
  const point = stroke.points[0];
  const gain = clampPercent(stroke.dynamics?.pressure, 100) / 100;
  const effectivePressure = 0.5 + (point.pressure - 0.5) * gain;
  const diameter = stroke.tool === "highlighter" ? stroke.width : stroke.width * (0.55 + effectivePressure * 0.75);
  ctx.beginPath();
  ctx.arc(point.x * width, point.y * height, diameter / 2, 0, Math.PI * 2);
  ctx.fill();
}

export function drawInkStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, width: number, height: number): void {
  if (stroke.points.length === 0) return;
  ctx.save();
  applyStrokeStyle(ctx, stroke);
  if (stroke.points.length === 1) {
    drawSampleDot(ctx, stroke, width, height);
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

/** Samples a settled ring depends on beyond itself: two centerline smoothing
 *  passes (±2) plus the segment/normal neighbor (±1). */
const TIP_SAMPLE_WINDOW = 3;

interface CachedTailPath {
  points: InkPoint[];
  startSample: number;
  /** First sample owned by the tip path; the settled path covers [startSample, settledCount). */
  settledCount: number;
  settledPath: Path2D;
  tipPath: Path2D;
  tipCount: number;
  size: number;
  width: number;
  height: number;
}

const tailPaths = new WeakMap<InkStroke, CachedTailPath>();

/**
 * Live-tail variant of drawInkStroke for the active stroke. The caller passes
 * a stable per-stroke view that SHARES the growing points array, plus the
 * first sample not covered by the Worker outline. The stamp is split into a
 * settled path covering [startSample, end-K) and a tip path covering the last
 * K samples: settled rings grow incrementally as samples arrive (a sample only
 * settles once its whole smoothing neighborhood exists), so a frame costs
 * O(window + new samples) instead of re-stamping the whole stroke. The
 * settled/tip junction overlaps in area like the Worker seam sample below —
 * two fills composite that small region twice, which is the live preview's
 * deliberate transparency seam; the startSample advance (per Worker reply)
 * and a wholesale points replacement rebuild once per event, not per frame.
 */
export function drawInkStrokeTail(ctx: CanvasRenderingContext2D, stroke: InkStroke, width: number, height: number, startSample: number): void {
  if (!Array.isArray(stroke.points) || stroke.points.length === 0) return;
  ctx.save();
  applyStrokeStyle(ctx, stroke);
  const count = stroke.points.length;
  if (count === 1) {
    drawSampleDot(ctx, stroke, width, height);
    ctx.restore();
    return;
  }
  if (stroke.tool === "highlighter") {
    ctx.lineWidth = stroke.width;
    drawSmoothPath(ctx, stroke.points, width, height, startSample, count);
    ctx.stroke();
    ctx.restore();
    return;
  }
  let cached = tailPaths.get(stroke);
  if (!cached || cached.points !== stroke.points || cached.startSample !== startSample
    || cached.size !== stroke.width || cached.width !== width || cached.height !== height) {
    const geometry = penStampGeometry(stroke, width, height);
    const settledCount = Math.max(startSample, count - TIP_SAMPLE_WINDOW);
    const settledPath = new Path2D();
    traceRings(settledPath, geometry.ringsFor(startSample, settledCount, true));
    const tipPath = new Path2D();
    traceRings(tipPath, geometry.ringsFor(settledCount, count, false));
    cached = { points: stroke.points, startSample, settledCount, settledPath, tipPath, tipCount: count,
      size: stroke.width, width, height };
    tailPaths.set(stroke, cached);
  } else if (cached.tipCount !== count) {
    // Fresh input samples only: bake the newly settled rings into the settled
    // path, then re-stamp just the tip window. The junction trapezoid anchors
    // into the tip's first sample, whose residual drift stays hidden under
    // that sample's tip disc until it settles.
    const geometry = penStampGeometry(stroke, width, height);
    const settledTarget = Math.max(startSample, count - TIP_SAMPLE_WINDOW);
    if (settledTarget > cached.settledCount) {
      traceRings(cached.settledPath, geometry.ringsFor(cached.settledCount, settledTarget, true));
      cached.settledCount = settledTarget;
    }
    cached.tipPath = new Path2D();
    traceRings(cached.tipPath, geometry.ringsFor(cached.settledCount, count, false));
    cached.tipCount = count;
  }
  ctx.fill(cached.settledPath);
  ctx.fill(cached.tipPath);
  ctx.restore();
}

function traceRings(path: Path2D, rings: number[][][]): void {
  for (const ring of rings) {
    path.moveTo(ring[0][0], ring[0][1]);
    for (let index = 1; index < ring.length; index++) path.lineTo(ring[index][0], ring[index][1]);
    path.closePath();
  }
}

function createPenPath(stroke: InkStroke, width: number, height: number): Path2D {
  const path = new Path2D();
  traceRings(path, penOutlineRings(stroke, width, height));
  return path;
}

function drawSmoothPath(ctx: CanvasRenderingContext2D, points: InkPoint[], width: number, height: number, from = 0, to = points.length): void {
  ctx.beginPath();
  ctx.moveTo(points[from].x * width, points[from].y * height);
  for (let index = from + 1; index < to; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const end = index === to - 1 ? point : { x: (previous.x + point.x) / 2, y: (previous.y + point.y) / 2 };
    ctx.quadraticCurveTo(previous.x * width, previous.y * height, end.x * width, end.y * height);
  }
  const last = points[to - 1];
  ctx.lineTo(last.x * width, last.y * height);
}
