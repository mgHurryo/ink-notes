import { DEFAULT_PAGE_HEIGHT, DEFAULT_PAGE_WIDTH } from "./model";
import type { InkPoint } from "./model";

export interface StrokeOptimizationOptions {
  /** 0 keeps the captured geometry untouched, mirroring the capture opt-out. */
  strength?: number;
  /** Page units per normalized axis; thresholds are expressed in page units. */
  scaleX?: number;
  scaleY?: number;
  /** Nib diameter in page units; sample spacing stays proportional to it. */
  nibWidth?: number;
  /** Minimum spacing kept between samples, in page units. */
  minimumSampleDistance?: number;
  /** Arc length used to decide whether a turn is deliberate structure. */
  cornerArcLength?: number;
  /** Turn angle in degrees at or above which a vertex is a corner. */
  cornerTurnDegrees?: number;
}

// Handwriting produces everything from 1-unit hairlines to wide highlighter
// nibs, so sub-nib spacing is kept proportional to the nib instead of fixed.
const DEFAULT_NIB_WIDTH = 3;
const MINIMUM_SAMPLE_SPAN = 0.6;
const NIB_SAMPLE_FRACTION = 0.35;
// The corner window scales with the stroke's own extent so hooks register at
// any handwriting size, from margin notes to page-filling strokes. Below 8
// page units the angle becomes noise-sensitive; above 38 it averages over
// several unrelated turns.
const MINIMUM_CORNER_ARC = 8;
const MAXIMUM_CORNER_ARC = 38;
const CORNER_ARC_FRACTION = 0.12;
// Matches the tail beautifier: a turn of roughly 60 degrees or sharper is
// intentional handwriting structure (折/勾), not noise.
const DEFAULT_CORNER_TURN_DEGREES = 60;

/**
 * Refines a finished stroke once the whole trajectory is known. Capture-time
 * stabilization is causal: it can only blend short moves because it cannot see
 * the stroke ahead, so residual sensor jitter survives into the saved points.
 * With the stroke complete the same smoothing budget can be spent without
 * sacrificing structure:
 *
 * 1. Sub-nib sample jitter is dropped, which also trims the saved file. The
 *    spacing floor follows the nib diameter because writing switches nibs
 *    between a hairline and a highlighter on the same page.
 * 2. Deliberate corners are detected over an arc-length window that scales
 *    with the stroke's own extent, so a hook registers as one protected
 *    vertex whether the writing is margin-sized or page-filling.
 * 3. Relaxation smooths only between corners, and the first/last samples stay
 *    exact so pen-down positions and hook tips never drift.
 *
 * Returns a new point array, or the input reference when there is nothing to
 * do (strength <= 0, or fewer than three points). Callers must treat the
 * input as immutable either way.
 */
export function optimizeStrokePoints(points: readonly InkPoint[], options: StrokeOptimizationOptions = {}): InkPoint[] {
  const strength = clampUnit(options.strength ?? 0);
  if (strength <= 0 || points.length < 3) return points as InkPoint[];
  const scaleX = positiveOr(options.scaleX, DEFAULT_PAGE_WIDTH);
  const scaleY = positiveOr(options.scaleY, DEFAULT_PAGE_HEIGHT);
  const nibWidth = positiveOr(options.nibWidth, DEFAULT_NIB_WIDTH);
  const minimumSampleDistance = positiveOr(options.minimumSampleDistance,
    Math.max(MINIMUM_SAMPLE_SPAN, nibWidth * NIB_SAMPLE_FRACTION));
  const kept = deduplicateSamples(points, minimumSampleDistance, scaleX, scaleY);
  if (kept.length < 3) return kept;
  const cornerArcLength = positiveOr(options.cornerArcLength, adaptiveCornerArc(kept, scaleX, scaleY));
  const corners = detectCorners(kept, cornerArcLength,
    positiveOr(options.cornerTurnDegrees, DEFAULT_CORNER_TURN_DEGREES), scaleX, scaleY);
  const passes = Math.max(1, Math.min(3, Math.round(strength * 4)));
  return relaxBetweenCorners(kept, corners, passes, scaleX, scaleY);
}

function adaptiveCornerArc(points: readonly InkPoint[], scaleX: number, scaleY: number): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  const extent = Math.hypot((maxX - minX) * scaleX, (maxY - minY) * scaleY);
  return Math.max(MINIMUM_CORNER_ARC, Math.min(MAXIMUM_CORNER_ARC, extent * CORNER_ARC_FRACTION));
}

function deduplicateSamples(points: readonly InkPoint[], minimumSampleDistance: number, scaleX: number, scaleY: number): InkPoint[] {
  const kept: InkPoint[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index++) {
    const last = kept[kept.length - 1];
    // The pen-up sample pins hook tips, so it is kept even when it sits
    // inside the minimum spacing.
    const isFinalSample = index === points.length - 1;
    if (isFinalSample || scaledDistance(last, points[index], scaleX, scaleY) >= minimumSampleDistance) {
      kept.push({ ...points[index] });
    }
  }
  return kept;
}

function detectCorners(points: readonly InkPoint[], arcLength: number, turnDegrees: number, scaleX: number, scaleY: number): boolean[] {
  const corners = new Array<boolean>(points.length).fill(false);
  const straightnessLimit = Math.cos(turnDegrees * Math.PI / 180);
  for (let index = 1; index < points.length - 1; index++) {
    const start = walkArc(points, index, arcLength, -1, scaleX, scaleY);
    const end = walkArc(points, index, arcLength, 1, scaleX, scaleY);
    const incomingX = (points[index].x - points[start].x) * scaleX;
    const incomingY = (points[index].y - points[start].y) * scaleY;
    const outgoingX = (points[end].x - points[index].x) * scaleX;
    const outgoingY = (points[end].y - points[index].y) * scaleY;
    const incomingLength = Math.hypot(incomingX, incomingY);
    const outgoingLength = Math.hypot(outgoingX, outgoingY);
    if (incomingLength === 0 || outgoingLength === 0) continue;
    // 1 means straight; at or below the limit the vertex turns sharply enough
    // that the smoother must protect it.
    const straightness = (incomingX * outgoingX + incomingY * outgoingY) / (incomingLength * outgoingLength);
    if (straightness <= straightnessLimit) corners[index] = true;
  }
  return corners;
}

function walkArc(points: readonly InkPoint[], index: number, arcLength: number, direction: -1 | 1, scaleX: number, scaleY: number): number {
  let travelled = 0;
  let cursor = index;
  while (cursor > 0 && cursor < points.length - 1 && travelled < arcLength) {
    const next = cursor + direction;
    travelled += scaledDistance(points[cursor], points[next], scaleX, scaleY);
    cursor = next;
  }
  return cursor;
}

// Second differences below this (page units) are float dust on an already
// straight run of samples; relaxing there only adds rounding noise.
const STRAIGHT_EPSILON = 0.01;

function relaxBetweenCorners(points: InkPoint[], corners: readonly boolean[], passes: number, scaleX: number, scaleY: number): InkPoint[] {
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    const next = current.map((point) => ({ ...point }));
    for (let index = 1; index < current.length - 1; index++) {
      // Corners and their immediate neighbors keep the captured trajectory;
      // everything between them relaxes toward the local mean.
      if (corners[index] || corners[index - 1] || corners[index + 1]) continue;
      const before = current[index - 1];
      const point = current[index];
      const after = current[index + 1];
      if (Math.abs((before.x - 2 * point.x + after.x) * scaleX) < STRAIGHT_EPSILON
        && Math.abs((before.y - 2 * point.y + after.y) * scaleY) < STRAIGHT_EPSILON) continue;
      next[index] = {
        x: before.x * 0.25 + point.x * 0.5 + after.x * 0.25,
        y: before.y * 0.25 + point.y * 0.5 + after.y * 0.25,
        pressure: before.pressure * 0.25 + point.pressure * 0.5 + after.pressure * 0.25,
        tiltX: point.tiltX,
        tiltY: point.tiltY,
        t: point.t,
      };
    }
    current = next;
  }
  return current;
}

function scaledDistance(a: InkPoint, b: InkPoint, scaleX: number, scaleY: number): number {
  return Math.hypot((a.x - b.x) * scaleX, (a.y - b.y) * scaleY);
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
