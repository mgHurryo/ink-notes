import type { InkPoint } from "./model";

export type ShapeKind = "line" | "arrow" | "rectangle" | "square" | "ellipse" | "circle" | "triangle";
export const SHAPES: readonly [ShapeKind, string, string][] = [
  ["line", "Line", "minus"], ["arrow", "Arrow", "move-up-right"],
  ["rectangle", "Rectangle", "rectangle-horizontal"], ["square", "Square", "square"],
  ["ellipse", "Ellipse", "ellipse"], ["circle", "Circle", "circle"], ["triangle", "Triangle", "triangle"],
];

/** Geometry stays in ordinary stroke points, so every existing consumer works. */
export function shapePoints(kind: ShapeKind, start: InkPoint, end: InkPoint, width: number, height: number): InkPoint[] {
  const x = start.x * width, y = start.y * height;
  let dx = (end.x - start.x) * width, dy = (end.y - start.y) * height;
  if (kind === "square" || kind === "circle") {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * size; dy = (dy < 0 ? -1 : 1) * size;
  }
  let vertices: number[][];
  if (kind === "line") vertices = [[x, y], [x + dx, y + dy]];
  else if (kind === "arrow") {
    const length = Math.hypot(dx, dy), head = Math.min(24, length * .25);
    const ux = length ? dx / length : 0, uy = length ? dy / length : 0;
    const tip = [x + dx, y + dy];
    // Retrace the first wing to avoid a spurious line joining the two wings.
    vertices = [[x, y], tip, [tip[0] - head * ux - head * .55 * uy, tip[1] - head * uy + head * .55 * ux],
      tip, [tip[0] - head * ux + head * .55 * uy, tip[1] - head * uy - head * .55 * ux]];
  } else if (kind === "ellipse" || kind === "circle") {
    const steps = Math.max(32, Math.min(192, Math.ceil(Math.PI * Math.max(Math.abs(dx), Math.abs(dy)) / 4)));
    vertices = Array.from({ length: steps + 1 }, (_, i) => {
      const angle = i / steps * Math.PI * 2;
      return [x + dx / 2 + dx / 2 * Math.cos(angle), y + dy / 2 + dy / 2 * Math.sin(angle)];
    });
    vertices[vertices.length - 1] = vertices[0];
  } else if (kind === "triangle") vertices = [[x + dx / 2, y], [x + dx, y + dy], [x, y + dy], [x + dx / 2, y]];
  else vertices = [[x, y], [x + dx, y], [x + dx, y + dy], [x, y + dy], [x, y]];
  return vertices.map(([px, py], i) => ({ x: px / width, y: py / height, pressure: .5, t: start.t + i }));
}

/** Reject short marks, curves, corners and retracing even if endpoints align. */
export function canStraighten(points: readonly InkPoint[], width: number, height: number): boolean {
  if (points.length < 2 || points.length >= 2048) return false;
  const first = points[0], last = points[points.length - 1];
  const dx = (last.x - first.x) * width, dy = (last.y - first.y) * height, chord = Math.hypot(dx, dy);
  if (chord < 40) return false;
  const tolerance = Math.max(2, Math.min(6, chord * .025));
  let travel = 0, previousProjection = 0;
  for (let i = 1; i < points.length; i++) {
    const px = (points[i].x - first.x) * width, py = (points[i].y - first.y) * height;
    if (Math.abs(px * dy - py * dx) / chord > tolerance) return false;
    const projection = (px * dx + py * dy) / chord;
    if (projection < previousProjection - 2 || projection < -2 || projection > chord + 2) return false;
    previousProjection = projection;
    travel += Math.hypot((points[i].x - points[i - 1].x) * width, (points[i].y - points[i - 1].y) * height);
  }
  return travel <= chord * 1.08;
}
