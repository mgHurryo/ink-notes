/**
 * Pure ink geometry and stroke transformations shared by the notebook and PDF editors.
 * Kept independent of the view class so eraser and selection rules can be read and tested in isolation.
 */
import type { InkPoint, InkStroke } from "./model";

export type EraserMode = "stroke" | "circle" | "square";

// ---------------------------------------------------------------------------
// Pure geometry / model helpers
// ---------------------------------------------------------------------------

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointInsideRect(point: { clientX: number; clientY: number }, rect: DOMRect): boolean {
  return point.clientX >= rect.left && point.clientX <= rect.right
    && point.clientY >= rect.top && point.clientY <= rect.bottom;
}

export function strokeIntersectsEraser(stroke: InkStroke, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  if (stroke.points.some((point) => pointInsideEraser(point, center, radius, mode, width, height))) return true;
  for (let index = 1; index < stroke.points.length; index++) {
    if (segmentIntersectsEraser(stroke.points[index - 1], stroke.points[index], center, radius, mode, width, height)) return true;
  }
  return false;
}

export function isScribbleEraseGesture(points: InkPoint[], eraserSize: number, width: number, height: number, sensitivity: number): boolean {
  if (points.length < 8) return false;
  const filtered = [points[0]];
  for (const point of points.slice(1)) {
    const previous = filtered[filtered.length - 1];
    if (Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height) >= 2) filtered.push(point);
  }
  if (filtered.length < 8) return false;

  let pathLength = 0;
  let distanceSinceTurn = 0;
  let turns = 0;
  for (let index = 1; index < filtered.length; index++) {
    const previous = filtered[index - 1], point = filtered[index];
    const segmentLength = Math.hypot((point.x - previous.x) * width, (point.y - previous.y) * height);
    pathLength += segmentLength;
    distanceSinceTurn += segmentLength;
    if (index < 2) continue;
    const before = filtered[index - 2];
    const ax = (previous.x - before.x) * width, ay = (previous.y - before.y) * height;
    const bx = (point.x - previous.x) * width, by = (point.y - previous.y) * height;
    const lengths = Math.hypot(ax, ay) * Math.hypot(bx, by);
    // These are raw pointer samples: ordinary corners and small backhooks
    // must not count as deliberate scrubbing reversals.
    if (lengths > 0 && (ax * bx + ay * by) / lengths < -0.35 && distanceSinceTurn >= Math.max(8, eraserSize * 0.25)) {
      turns++;
      distanceSinceTurn = 0;
    }
  }

  let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
  for (const point of filtered) {
    const x = point.x * width, y = point.y * height;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const boundsWidth = maxX - minX;
  const boundsHeight = maxY - minY;
  const boundsDiagonal = Math.hypot(boundsWidth, boundsHeight);
  const duration = filtered[filtered.length - 1].t - filtered[0].t;
  const ease = Math.max(0, Math.min(100, sensitivity)) / 100;
  const minimumTurns = Math.round(6 - 3 * ease);
  // Connected writing often has many corners but advances across the page.
  // Require repeated substantial traversals of the same bounding region,
  // ignoring short backhooks and sample jitter between those traversals.
  const countTraversals = (axisX: number, axisY: number): number => {
    const coordinates = filtered.map((point) => point.x * width * axisX + point.y * height * axisY);
    let minimum = Number.POSITIVE_INFINITY, maximum = Number.NEGATIVE_INFINITY;
    for (const value of coordinates) { minimum = Math.min(minimum, value); maximum = Math.max(maximum, value); }
    let extreme = coordinates[0], initialMinimum = extreme, initialMaximum = extreme, direction = 0, traversals = 0;
    const travel = Math.max(8, (maximum - minimum) * 0.6);
    for (const value of coordinates.slice(1)) {
      if (direction === 0) {
        // A wave can start halfway between its peaks. Track its first range
        // instead of requiring it to travel a full range from pointerdown.
        initialMinimum = Math.min(initialMinimum, value); initialMaximum = Math.max(initialMaximum, value);
        if (initialMaximum - initialMinimum >= travel) {
          direction = value === initialMaximum ? 1 : -1; extreme = value; traversals++;
        }
      } else if ((value - extreme) * direction >= 0) {
        extreme = value;
      } else if ((extreme - value) * direction >= travel) {
        direction *= -1; extreme = value; traversals++;
      }
    }
    return traversals;
  };
  if (pathLength < Math.max(96, eraserSize * 3) || boundsDiagonal < eraserSize * 0.5
    || duration < 0 || duration > 1_800) return false;
  const density = pathLength / Math.max(1, boundsDiagonal);
  const horizontalTraversals = countTraversals(1, 0);
  const verticalTraversals = countTraversals(0, 1);
  const dominantTraversals = boundsWidth >= boundsHeight ? horizontalTraversals : verticalTraversals;
  if (turns >= minimumTurns && dominantTraversals >= minimumTurns + 1 && density >= 4.8 - 1.6 * ease) return true;

  // Smooth loops and waves do not have sharp sample-to-sample corners. Count
  // substantial excursions on either axis (also diagonals for rotated marks).
  // More repetitions and higher density keep isolated circles, ordinary waves
  // and handwriting that advances across a line from becoming erase commands.
  const diagonal = Math.SQRT1_2;
  return density >= 5.2 - 1.2 * ease && Math.max(horizontalTraversals, verticalTraversals,
    countTraversals(diagonal, diagonal), countTraversals(diagonal, -diagonal)) >= minimumTurns + 2;
}

export function eraseStrokeSegmentsByScribble(stroke: InkStroke, path: InkPoint[], radius: number, width: number, height: number,
  canErasePoint: (point: InkPoint) => boolean = () => true): InkPoint[][] | null {
  const bounds = boundsForPointSets([path]);
  if (!bounds) return null;
  // Fill the complete gesture bounds as well as the nib path. Testing only
  // the sampled path leaves islands between successive loops, which render as
  // tiny dots. A rectangle is deterministic for circles, waves and rotated
  // scribbles and matches the user's visible scrub area.
  const result = splitErasedStrokeSamples(sampleStrokeForEraser(stroke.points, radius, width, height), (point) =>
    point.x >= bounds.minX - radius / width && point.x <= bounds.maxX + radius / width
    && point.y >= bounds.minY - radius / height && point.y <= bounds.maxY + radius / height
    && canErasePoint(point));
  return result.erased ? result.segments : null;
}

export function eraseStrokeSegments(stroke: InkStroke, center: InkPoint, radius: number, mode: Exclude<EraserMode, "stroke">, width: number, height: number): InkPoint[][] {
  return splitErasedStrokeSamples(sampleStrokeForEraser(stroke.points, radius, width, height),
    (point) => pointInsideEraser(point, center, radius, mode, width, height)).segments;
}

function splitErasedStrokeSamples(samples: InkPoint[], contains: (point: InkPoint) => boolean): { segments: InkPoint[][]; erased: boolean } {
  const segments: InkPoint[][] = [];
  let segment: InkPoint[] = [];
  let erased = false;
  const flush = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  for (const point of samples) {
    if (contains(point)) { flush(); erased = true; }
    else segment.push({ ...point });
  }
  flush();
  return { segments, erased };
}

function pointInsideEraser(point: InkPoint, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  const dx = (point.x - center.x) * width;
  const dy = (point.y - center.y) * height;
  return mode === "square" ? Math.abs(dx) <= radius && Math.abs(dy) <= radius : Math.hypot(dx, dy) <= radius;
}

function segmentIntersectsEraser(start: InkPoint, end: InkPoint, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  const ax = (start.x - center.x) * width;
  const ay = (start.y - center.y) * height;
  const bx = (end.x - center.x) * width;
  const by = (end.y - center.y) * height;
  if (mode === "square") return segmentIntersectsBox(ax, ay, bx, by, radius);
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + dx * t, ay + dy * t) <= radius;
}

function segmentIntersectsBox(ax: number, ay: number, bx: number, by: number, radius: number): boolean {
  let minimum = 0, maximum = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [origin, delta] of [[ax, dx], [ay, dy]] as const) {
    if (delta === 0) { if (origin < -radius || origin > radius) return false; continue; }
    const near = (-radius - origin) / delta;
    const far = (radius - origin) / delta;
    minimum = Math.max(minimum, Math.min(near, far));
    maximum = Math.min(maximum, Math.max(near, far));
    if (minimum > maximum) return false;
  }
  return true;
}

export function sampleStrokeForEraser(points: InkPoint[], radius: number, width: number, height: number,
  maxSamples = Number.POSITIVE_INFINITY, spacingDivisor = 3): InkPoint[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const sampled: InkPoint[] = [{ ...points[0] }];
  const step = Math.max(1, radius / spacingDivisor);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1], end = points[index];
    const pixels = Math.hypot((end.x - start.x) * width, (end.y - start.y) * height);
    const count = Math.max(1, Math.ceil(pixels / step));
    if (sampled.length + count > maxSamples) return [];
    for (let sample = 1; sample <= count; sample++) sampled.push(interpolateInkPoint(start, end, sample / count));
  }
  return sampled;
}

export function interpolateInkPoint(start: InkPoint, end: InkPoint, amount: number): InkPoint {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    pressure: start.pressure + (end.pressure - start.pressure) * amount,
    tiltX: start.tiltX === undefined || end.tiltX === undefined ? end.tiltX : start.tiltX + (end.tiltX - start.tiltX) * amount,
    tiltY: start.tiltY === undefined || end.tiltY === undefined ? end.tiltY : start.tiltY + (end.tiltY - start.tiltY) * amount,
    t: start.t + (end.t - start.t) * amount,
  };
}

export function cloneStroke(stroke: InkStroke): InkStroke {
  return { ...stroke, points: clonePoints(stroke.points), dynamics: stroke.dynamics ? { ...stroke.dynamics } : undefined };
}

export function clonePoints(points: InkPoint[]): InkPoint[] {
  return points.map((point) => ({ ...point }));
}

export function translatePoints(points: InkPoint[], dx: number, dy: number): InkPoint[] {
  // Translation is an isometry: keep the sampled timestamps so the speed
  // dynamics channel still sees the original writing pace after a lasso move
  // (the spread operator already carries `t` over).
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
}

export function selectionBounds(strokes: InkStroke[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  return boundsForPointSets(strokes.map((stroke) => stroke.points));
}

export function boundsForPointSets(pointSets: InkPoint[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const points of pointSets) for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function pointInPolygon(point: InkPoint, polygon: InkPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function constrainDelta(delta: number, minimum: number, maximum: number): number {
  return Math.max(-minimum, Math.min(1 - maximum, delta));
}
