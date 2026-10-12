import { InkPoint, InkStroke, newId } from "./model";
import { StickyNote, STICKY_UNIT } from "./sticky-model";

export const STICKY_HEADER = 44;
export interface PageGeometry { width: number; height: number }

export function stickyBounds(note: StickyNote, g: PageGeometry) {
  return { left: note.x, right: note.x + note.width,
    top: note.y + STICKY_HEADER * g.width / note.boardPageWidth / g.height, bottom: note.y + note.height };
}

export function stickyStrokeOnPage(stroke: InkStroke, note: StickyNote, g: PageGeometry): InkStroke {
  const scale = g.width / note.boardPageWidth;
  return { ...stroke, pageId: note.pageId, width: stroke.width * scale,
    points: stroke.points.map((p) => ({ ...p,
      x: note.x + (p.x * STICKY_UNIT - note.scrollX) / note.boardPageWidth,
      y: note.y + (STICKY_HEADER + p.y * STICKY_UNIT - note.scrollY) * scale / g.height })) };
}

export function stickyStrokeFromPage(stroke: InkStroke, note: StickyNote, g: PageGeometry): InkStroke {
  const scale = g.width / note.boardPageWidth;
  return { ...stroke, pageId: note.id, width: stroke.width / scale,
    points: stroke.points.map((p) => ({ ...p,
      x: ((p.x - note.x) * note.boardPageWidth + note.scrollX) / STICKY_UNIT,
      y: ((p.y - note.y) * g.height / scale - STICKY_HEADER + note.scrollY) / STICKY_UNIT })) };
}

/** Split at exact frame intersections, including sparsely sampled fast strokes.
 * Midpoint ownership chooses the topmost expanded note. Frame resizing never
 * rescales stored board coordinates. */
export function splitStickyStroke(stroke: InkStroke, notes: readonly StickyNote[], g: PageGeometry): { page: InkStroke[]; notes: Map<string, InkStroke[]> } {
  const frames = notes.filter((n) => !n.collapsed).map((note) => ({ note, ...stickyBounds(note, g) }));
  const topFirst = [...frames].reverse();
  const owner = (p: InkPoint) => topFirst.find((r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom)?.note;
  const runs: { note?: StickyNote; points: InkPoint[] }[] = [];
  const interpolate = (a: InkPoint, b: InkPoint, t: number): InkPoint => ({ ...a,
    x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    pressure: a.pressure + (b.pressure - a.pressure) * t, t: a.t + (b.t - a.t) * t });
  if (stroke.points.length === 1) runs.push({ note: owner(stroke.points[0]), points: stroke.points });
  for (let i = 1; i < stroke.points.length; i++) {
    const a = stroke.points[i - 1], b = stroke.points[i], cuts = [0, 1];
    for (const r of frames) {
      for (const x of [r.left, r.right]) if (b.x !== a.x) {
        const t = (x - a.x) / (b.x - a.x), y = a.y + (b.y - a.y) * t;
        if (t > 0 && t < 1 && y >= r.top && y <= r.bottom) cuts.push(t);
      }
      for (const y of [r.top, r.bottom]) if (b.y !== a.y) {
        const t = (y - a.y) / (b.y - a.y), x = a.x + (b.x - a.x) * t;
        if (t > 0 && t < 1 && x >= r.left && x <= r.right) cuts.push(t);
      }
    }
    const sorted = [...new Set(cuts)].sort((x, y) => x - y);
    for (let j = 1; j < sorted.length; j++) {
      const note = owner(interpolate(a, b, (sorted[j - 1] + sorted[j]) / 2));
      const start = interpolate(a, b, sorted[j - 1]), end = interpolate(a, b, sorted[j]);
      const last = runs[runs.length - 1];
      if (last && last.note?.id === note?.id) last.points.push(end);
      else runs.push({ note, points: [start, end] });
    }
  }
  const result = { page: [] as InkStroke[], notes: new Map<string, InkStroke[]>() };
  runs.forEach((run, index) => {
    const part = { ...stroke, id: index ? newId("stroke") : stroke.id, points: run.points };
    if (!run.note) result.page.push(part);
    else {
      const parts = result.notes.get(run.note.id) ?? []; parts.push(stickyStrokeFromPage(part, run.note, g)); result.notes.set(run.note.id, parts);
    }
  });
  return result;
}
