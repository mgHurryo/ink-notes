import type { InkPoint, InkStroke } from "./model";
import { normalizeDynamics } from "./model";

/** Fixed board units, independent of the note's frame size or page zoom. */
export const STICKY_UNIT = 1000;
export const PRIMARY_TEXT_BOX = "primary";
export const STICKY_FONTS = {
  sans: { label: "Sans serif", family: "sans-serif" },
  serif: { label: "Serif", family: "serif" },
  mono: { label: "Monospace", family: "monospace" },
  song: { label: "Song / 宋体", family: '"Songti SC", SimSun, serif' },
  kai: { label: "Kai / 楷体", family: 'KaiTi, STKaiti, serif' },
} as const;
export interface StickyTextStyle {
  fontSize?: number; fontFamily?: keyof typeof STICKY_FONTS;
  bold?: boolean; italic?: boolean; scaleText?: boolean;
}
export function stickyFontSize(size: unknown): number {
  return typeof size === "number" && Number.isFinite(size) ? Math.round(Math.max(8, Math.min(144, size)) * 10) / 10 : 20;
}
function normalizeTextStyle(style: StickyTextStyle): StickyTextStyle {
  return { fontSize: style.fontSize === undefined ? undefined : stickyFontSize(style.fontSize),
    fontFamily: style.fontFamily && Object.prototype.hasOwnProperty.call(STICKY_FONTS, style.fontFamily) ? style.fontFamily : undefined,
    bold: style.bold === true, italic: style.italic === true, scaleText: style.scaleText === true };
}
/** Only saved font presets are used in CSS, canvas and the sanitized snapshot. */
export function stickyFont(style: StickyTextStyle, markdown = false): string {
  const value = normalizeTextStyle(style);
  return `${value.italic ? "italic " : ""}${value.bold ? "bold " : ""}${stickyFontSize(value.fontSize)}px${markdown ? "/1.4" : ""} ${STICKY_FONTS[value.fontFamily ?? "sans"].family}`;
}
export function resizeStickyTextBox(box: StickyTextBox, width: number, height: number): Partial<StickyTextBox> {
  width = Math.max(60, width); height = Math.max(60, height);
  const patch: Partial<StickyTextBox> = { width, height };
  if (box.scaleText) {
    const horizontal = width / box.width, vertical = height / (box.height ?? 120);
    // Use the larger proportional edge movement; glyphs always scale uniformly.
    const ratio = Math.abs(horizontal - 1) >= Math.abs(vertical - 1) ? horizontal : vertical;
    patch.fontSize = stickyFontSize(stickyFontSize(box.fontSize) * ratio);
  }
  return patch;
}
export interface StickyTextBox extends StickyTextStyle {
  id: string; text: string; x: number; y: number; width: number; height?: number;
  createdAt: number; updatedAt: number;
}
export interface StickyNote {
  id: string; pageId: string;
  /** A frameless page text object reuses text editing, history and sync. */
  kind?: "text";
  x: number; y: number; width: number; height: number;
  title: string; keywords: string; text: string; textUpdatedAt: number;
  /** Fixed text layout width; changing the frame only crops its viewport. */
  textWidth?: number;
  textX?: number; textY?: number; textHeight?: number;
  textFontSize?: number; textFontFamily?: StickyTextStyle["fontFamily"];
  textBold?: boolean; textItalic?: boolean; textScaleText?: boolean;
  textBoxes?: StickyTextBox[];
  deletedTextBoxes?: Record<string, number>;
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

/** Keep legacy text as the first box without storing a duplicate copy. */
export function stickyTextBoxes(note: StickyNote): StickyTextBox[] {
  return [{ id: PRIMARY_TEXT_BOX, text: note.text, x: note.textX ?? 16, y: note.textY ?? 16,
    width: note.textWidth ?? Math.max(60, note.width * note.boardPageWidth - 32), height: note.textHeight,
    fontSize: note.textFontSize, fontFamily: note.textFontFamily, bold: note.textBold, italic: note.textItalic, scaleText: note.textScaleText,
    createdAt: note.createdAt, updatedAt: note.textUpdatedAt }, ...(note.textBoxes ?? [])];
}
export function stickyText(note: StickyNote): string { return stickyTextBoxes(note).map((box) => box.text).filter(Boolean).join("\n\n"); }

export function patchStickyTextBox(note: StickyNote, id: string, patch: Partial<StickyTextBox>): StickyNote {
  if (id === PRIMARY_TEXT_BOX) {
    const box = { ...stickyTextBoxes(note)[0], ...patch };
    return { ...note, text: box.text, textX: box.x, textY: box.y, textWidth: box.width, textHeight: box.height,
      textFontSize: box.fontSize, textFontFamily: box.fontFamily, textBold: box.bold, textItalic: box.italic, textScaleText: box.scaleText };
  }
  return { ...note, textBoxes: note.textBoxes?.map((box) => box.id === id ? { ...box, ...patch, id } : box) };
}

/** x/y remain the folded anchor. Expanded frames fit inward without saving a new anchor. */
export function stickyPosition(note: StickyNote): { x: number; y: number } {
  return note.collapsed ? { x: note.x, y: note.y }
    : { x: Math.min(note.x, 1 - note.width), y: Math.min(note.y, 1 - note.height) };
}

export function cloneSticky(note: StickyNote): StickyNote {
  return { ...note, textBoxes: note.textBoxes?.map((box) => ({ ...box })), deletedTextBoxes: { ...note.deletedTextBoxes },
    deletedStrokeIds: [...note.deletedStrokeIds], strokes: note.strokes.map((stroke) => ({ ...stroke,
    points: stroke.points.map((point) => ({ ...point })), dynamics: stroke.dynamics ? { ...stroke.dynamics,
      pressureCurve: stroke.dynamics.pressureCurve?.map((point) => [...point]) } : undefined })) };
}

export function mergeSticky(a: StickyNote, b: StickyNote): StickyNote {
  const latest = b.updatedAt > a.updatedAt || b.updatedAt === a.updatedAt && JSON.stringify(b) > JSON.stringify(a) ? b : a;
  const text = b.textUpdatedAt > a.textUpdatedAt || b.textUpdatedAt === a.textUpdatedAt && JSON.stringify(stickyTextBoxes(b)[0]) > JSON.stringify(stickyTextBoxes(a)[0]) ? b : a;
  const deletedTextBoxes = { ...a.deletedTextBoxes };
  for (const [id, time] of Object.entries(b.deletedTextBoxes ?? {})) deletedTextBoxes[id] = Math.max(deletedTextBoxes[id] ?? 0, time);
  const boxes = new Map<string, StickyTextBox>();
  for (const box of [...(a.textBoxes ?? []), ...(b.textBoxes ?? [])]) {
    const previous = boxes.get(box.id);
    if (!deletedTextBoxes[box.id] && (!previous || box.updatedAt > previous.updatedAt
      || box.updatedAt === previous.updatedAt && JSON.stringify(box) > JSON.stringify(previous))) boxes.set(box.id, { ...box });
  }
  const removed = new Set([...a.deletedStrokeIds, ...b.deletedStrokeIds]);
  const strokes = new Map<string, InkStroke>();
  for (const stroke of [...a.strokes, ...b.strokes]) {
    const previous = strokes.get(stroke.id);
    if (!removed.has(stroke.id) && (!previous || stroke.updatedAt > previous.updatedAt
      || stroke.updatedAt === previous.updatedAt && JSON.stringify(stroke) > JSON.stringify(previous))) strokes.set(stroke.id, stroke);
  }
  return { ...latest, text: text.text, textUpdatedAt: text.textUpdatedAt,
    textX: text.textX, textY: text.textY, textWidth: text.textWidth, textHeight: text.textHeight,
    textFontSize: text.textFontSize, textFontFamily: text.textFontFamily, textBold: text.textBold, textItalic: text.textItalic, textScaleText: text.textScaleText,
    textBoxes: [...boxes.values()].sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id)), deletedTextBoxes,
    strokes: [...strokes.values()].sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id)), deletedStrokeIds: [...removed] };
}

export function normalizeSticky(value: unknown, pageId: string): StickyNote | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<StickyNote>;
  if (typeof raw.id !== "string" || ![raw.x, raw.y, raw.width, raw.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const positive = (n: unknown, fallback: number) => typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback;
  const string = (n: unknown) => typeof n === "string" ? n : "";
  const position = (n: unknown, fallback: number) => typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : fallback;
  const deletedTextBoxes = Object.fromEntries(Object.entries(raw.deletedTextBoxes ?? {}).filter(([id, time]) => id !== PRIMARY_TEXT_BOX && typeof time === "number" && Number.isFinite(time) && time > 0));
  const boxes = new Map<string, StickyTextBox>();
  for (const box of Array.isArray(raw.textBoxes) ? raw.textBoxes : []) {
    if (!box || typeof box.id !== "string" || box.id === PRIMARY_TEXT_BOX || typeof box.text !== "string") continue;
    const normalized = { ...normalizeTextStyle(box), id: box.id, text: box.text, x: position(box.x, 16), y: position(box.y, 16), width: Math.max(60, positive(box.width, 240)),
      height: box.height === undefined ? undefined : Math.max(60, positive(box.height, 120)), createdAt: positive(box.createdAt, 1), updatedAt: positive(box.updatedAt, 1) };
    const previous = boxes.get(box.id);
    if (!deletedTextBoxes[box.id] && (!previous || normalized.updatedAt > previous.updatedAt
      || normalized.updatedAt === previous.updatedAt && JSON.stringify(normalized) > JSON.stringify(previous))) boxes.set(box.id, normalized);
  }
  const textOnly = raw.kind === "text";
  const width = Math.min(1, Math.max(textOnly ? .01 : .05, raw.width!)), height = Math.min(1, Math.max(textOnly ? .01 : .05, raw.height!));
  const textStyle = normalizeTextStyle({ fontSize: raw.textFontSize, fontFamily: raw.textFontFamily, bold: raw.textBold, italic: raw.textItalic, scaleText: raw.textScaleText });
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
  // The anchor survives unfolding and reloads; visible bounds belong to layout.
  return { id: raw.id, pageId, ...(textOnly ? { kind: "text" as const } : {}), x: Math.max(0, Math.min(1, raw.x!)),
    y: Math.max(0, Math.min(1, raw.y!)), width, height,
    title: string(raw.title), keywords: string(raw.keywords), text: string(raw.text), textUpdatedAt: positive(raw.textUpdatedAt, 1),
    textWidth: Math.max(60, positive(raw.textWidth, width * positive(raw.boardPageWidth, STICKY_UNIT) - 32)),
    textX: textOnly ? 0 : position(raw.textX, 16), textY: textOnly ? 0 : position(raw.textY, 16),
    textHeight: raw.textHeight === undefined ? undefined : Math.max(60, positive(raw.textHeight, 120)),
    textFontSize: textStyle.fontSize, textFontFamily: textStyle.fontFamily, textBold: textStyle.bold, textItalic: textStyle.italic, textScaleText: textStyle.scaleText,
    textBoxes: [...boxes.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), deletedTextBoxes,
    color: typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : "#fff1a8",
    collapsed: !textOnly && raw.collapsed === true, preview: raw.preview !== false,
    scrollX: textOnly ? 0 : Math.max(0, positive(raw.scrollX, 0)), scrollY: textOnly ? 0 : Math.max(0, positive(raw.scrollY, 0)),
    boardPageWidth: positive(raw.boardPageWidth, STICKY_UNIT),
    strokes, deletedStrokeIds: removed, createdAt: positive(raw.createdAt, 1), updatedAt: positive(raw.updatedAt, 1) };
}

export function stickyLink(file: string, page: string, note: string, vault: string, block?: string): string {
  const params = new URLSearchParams({ vault, file, page, sticky: note });
  if (block) params.set("block", block);
  return `obsidian://ink-notes-sticky?${params.toString()}`;
}
