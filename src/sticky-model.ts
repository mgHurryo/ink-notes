import type { InkPoint, InkStroke } from "./model";
import { normalizeDynamics } from "./model";

/** Fixed board units, independent of the note's frame size or page zoom. */
export const STICKY_UNIT = 1000;
export interface StickyNote {
  id: string; pageId: string;
  x: number; y: number; width: number; height: number;
  title: string; keywords: string; text: string; textUpdatedAt: number;
  /** Fixed text layout width; changing the frame only crops its viewport. */
  textWidth?: number;
  color: string; collapsed: boolean; preview: boolean;
  scrollX: number; scrollY: number;
  boardPageWidth: number;
  strokes: InkStroke[]; deletedStrokeIds: string[];
  createdAt: number; updatedAt: number;
}

/** Creation order is shared by DOM, ink ownership, workers and merged saves. */
export function compareStickyOrder(a: StickyNote, b: StickyNote): number {
  return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

export function cloneSticky(note: StickyNote): StickyNote {
  return { ...note, deletedStrokeIds: [...note.deletedStrokeIds], strokes: note.strokes.map((stroke) => ({ ...stroke,
    points: stroke.points.map((point) => ({ ...point })), dynamics: stroke.dynamics ? { ...stroke.dynamics,
      pressureCurve: stroke.dynamics.pressureCurve?.map((point) => [...point]) } : undefined })) };
}

export function mergeSticky(a: StickyNote, b: StickyNote): StickyNote {
  const latest = b.updatedAt > a.updatedAt || b.updatedAt === a.updatedAt && JSON.stringify(b) > JSON.stringify(a) ? b : a;
  const text = b.textUpdatedAt > a.textUpdatedAt || b.textUpdatedAt === a.textUpdatedAt && b.text > a.text ? b : a;
  const removed = new Set([...a.deletedStrokeIds, ...b.deletedStrokeIds]);
  const strokes = new Map<string, InkStroke>();
  for (const stroke of [...a.strokes, ...b.strokes]) {
    const previous = strokes.get(stroke.id);
    if (!removed.has(stroke.id) && (!previous || stroke.updatedAt > previous.updatedAt
      || stroke.updatedAt === previous.updatedAt && JSON.stringify(stroke) > JSON.stringify(previous))) strokes.set(stroke.id, stroke);
  }
  return { ...latest, text: text.text, textUpdatedAt: text.textUpdatedAt,
    strokes: [...strokes.values()].sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id)), deletedStrokeIds: [...removed] };
}

export function normalizeSticky(value: unknown, pageId: string): StickyNote | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StickyNote>;
  if (typeof raw.id !== "string" || ![raw.x, raw.y, raw.width, raw.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const positive = (n: unknown, fallback: number) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
  const string = (n: unknown) => typeof n === "string" ? n : "";
  const width = Math.min(1, Math.max(.05, raw.width!)), height = Math.min(1, Math.max(.05, raw.height!));
  const removed = Array.isArray(raw.deletedStrokeIds) ? raw.deletedStrokeIds.filter((id): id is string => typeof id === "string") : [];
  const strokes = (Array.isArray(raw.strokes) ? raw.strokes : []).filter((stroke) => stroke && typeof stroke.id === "string" && Array.isArray(stroke.points))
    .map((stroke): InkStroke => ({ ...stroke, pageId: raw.id!, tool: stroke.tool === "highlighter" ? "highlighter" : "pen",
      color: /^#[0-9a-f]{6}$/i.test(stroke.color) ? stroke.color : "#202020", width: positive(stroke.width, 3), opacity: Math.min(1, positive(stroke.opacity, 1)),
      dynamics: normalizeDynamics(stroke.dynamics),
      points: stroke.points.filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)).map((point): InkPoint => ({
        x: Math.max(0, point.x), y: Math.max(0, point.y), pressure: Math.min(1, Math.max(.05, positive(point.pressure, .5))), t: positive(point.t, 1),
        tiltX: typeof point.tiltX === "number" && Number.isFinite(point.tiltX) ? point.tiltX : undefined,
        tiltY: typeof point.tiltY === "number" && Number.isFinite(point.tiltY) ? point.tiltY : undefined,
      })), createdAt: positive(stroke.createdAt, 1), updatedAt: positive(stroke.updatedAt, 1) }))
    .filter((stroke) => !removed.includes(stroke.id));
  return { id: raw.id, pageId, x: Math.max(0, Math.min(1 - width, raw.x!)), y: Math.max(0, Math.min(1 - height, raw.y!)), width, height,
    title: string(raw.title), keywords: string(raw.keywords), text: string(raw.text), textUpdatedAt: positive(raw.textUpdatedAt, 1),
    textWidth: Math.max(60, positive(raw.textWidth, width * positive(raw.boardPageWidth, STICKY_UNIT) - 32)),
    color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : "#fff1a8",
    collapsed: raw.collapsed === true, preview: raw.preview !== false,
    scrollX: Math.max(0, positive(raw.scrollX, 0)), scrollY: Math.max(0, positive(raw.scrollY, 0)),
    boardPageWidth: positive(raw.boardPageWidth, STICKY_UNIT),
    strokes, deletedStrokeIds: removed, createdAt: positive(raw.createdAt, 1), updatedAt: positive(raw.updatedAt, 1) };
}

export function stickyLink(file: string, page: string, note: string, vault: string, block?: string): string {
  const params = new URLSearchParams({ vault, file, page, sticky: note });
  if (block) params.set("block", block);
  return `obsidian://ink-notes-sticky?${params.toString()}`;
}
