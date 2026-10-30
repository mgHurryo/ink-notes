import { compareStickyOrder, mergeSticky, normalizeSticky } from "./sticky-model";
import type { StickyNote } from "./sticky-model";

export type InkTool = "pen" | "highlighter" | "eraser" | "lasso" | "pointer" | "shape";
export type PaperStyle = "blank" | "ruled" | "grid" | "dot";
/** One-click triage flag on a page; absence means unflagged. */
export type PageFlag = "red" | "yellow" | "green";

export interface InkPoint {
  x: number;
  y: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  t: number;
}

export interface InkStroke {
  id: string;
  pageId: string;
  tool: "pen" | "highlighter";
  color: string;
  width: number;
  opacity: number;
  points: InkPoint[];
  /**
   * Pen dynamics captured with the stroke; render-only (points are never
   * rewritten). Absent on older strokes — every field defaults to the
   * pre-dynamics behavior (round ends, full pressure response, no speed
   * compensation).
   */
  dynamics?: StrokeDynamics;
  createdAt: number;
  updatedAt: number;
}

export interface StrokeDynamics {
  /** 0-100: end shape, 0 = round caps, 100 = tapered to a point. */
  taper?: number;
  /** 0-100: pressure response amplitude, 0 = uniform width, 100 = full. */
  pressure?: number;
  /** 0-100: speed-based thinning amplitude, 0 = off. */
  speed?: number;
  /**
   * Pressure mapping curve: control points [inputPressure, outputPressure]
   * with x in [0,1] monotonic (endpoints pinned) and y in [0,1]. Applied
   * before the response amplitude. Absent = linear identity.
   */
  pressureCurve?: number[][];
}

export interface InkImage {
  id: string;
  pageId: string;
  /** Immutable managed vault copy, independent of the original file. */
  assetPath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  foreground: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface InkPage {
  id: string;
  title: string;
  paper: PaperStyle;
  strokes: InkStroke[];
  /** Stroke ids removed locally; retained so sync cannot resurrect them. */
  deletedStrokeIds: string[];
  images?: InkImage[];
  deletedImageIds?: string[];
  stickyNotes?: StickyNote[];
  deletedStickyNotes?: Record<string, number>;
  /** Free-text labels. Merged as a union across devices (additive; removal is
   *  a local refinement only), so a page can carry several at once. */
  tags?: string[];
  /**
   * Triage flag. Single-valued, so it merges last-writer-wins on page
   * updatedAt exactly like title/paper; a newer side without one clears it.
   */
  flag?: PageFlag;
  createdAt: number;
  updatedAt: number;
}

export interface InkNotebook {
  schema: 2;
  title: string;
  pageWidth: number;
  pageHeight: number;
  pages: InkPage[];
  pageOrder: string[];
  deletedPages: Record<string, number>;
  pageOrderUpdatedAt: number;
  updatedAt: number;
}

export const DEFAULT_PAGE_WIDTH = 1600;
export const DEFAULT_PAGE_HEIGHT = 2200;

export function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function createNotebook(title = "Ink Notebook"): InkNotebook {
  const now = Date.now();
  const page = createPage("Page 1", "ruled", now);
  return {
    schema: 2,
    title,
    pageWidth: DEFAULT_PAGE_WIDTH,
    pageHeight: DEFAULT_PAGE_HEIGHT,
    pages: [page],
    pageOrder: [page.id],
    deletedPages: {},
    pageOrderUpdatedAt: now,
    updatedAt: now,
  };
}

export function createPage(title: string, paper: PaperStyle = "ruled", now = Date.now()): InkPage {
  return { id: newId("page"), title, paper, strokes: [], deletedStrokeIds: [], createdAt: now, updatedAt: now };
}

export function normalizeNotebook(value: unknown): InkNotebook {
  if (!value || typeof value !== "object") return createNotebook();
  const raw = value as Partial<InkNotebook>;
  const pages = Array.isArray(raw.pages) ? raw.pages : [];
  const normalizedPages = pages.map(normalizePage).filter((page): page is InkPage => page !== null);
  const pageIds = new Set(normalizedPages.map((page) => page.id));
  const legacyOrder = [...normalizedPages].sort((a, b) => a.createdAt - b.createdAt).map((page) => page.id);
  const requestedOrder = Array.isArray(raw.pageOrder) ? raw.pageOrder.filter((id): id is string => typeof id === "string") : legacyOrder;
  const pageOrder = [...new Set([...requestedOrder.filter((id) => pageIds.has(id)), ...legacyOrder.filter((id) => !requestedOrder.includes(id))])];
  const deletedPages = raw.deletedPages && typeof raw.deletedPages === "object"
    ? Object.fromEntries(Object.entries(raw.deletedPages).filter((entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number" && Number.isFinite(entry[1])))
    : {};
  const visiblePages = normalizedPages.filter((page) => !(page.id in deletedPages));
  const visibleIds = new Set(visiblePages.map((page) => page.id));
  const byId = new Map(visiblePages.map((page) => [page.id, page]));
  const orderedPages = pageOrder.map((id) => byId.get(id)).filter((page): page is InkPage => page !== undefined);
  if (orderedPages.length === 0) orderedPages.push(createPage("Page 1"));
  return {
    schema: 2,
    title: typeof raw.title === "string" ? raw.title : "Ink Notebook",
    pageWidth: finitePositive(raw.pageWidth, DEFAULT_PAGE_WIDTH),
    pageHeight: finitePositive(raw.pageHeight, DEFAULT_PAGE_HEIGHT),
    pages: orderedPages,
    pageOrder: orderedPages.map((page) => page.id).filter((id) => visibleIds.has(id) || orderedPages.length === 1),
    deletedPages,
    pageOrderUpdatedAt: finitePositive(raw.pageOrderUpdatedAt, finitePositive(raw.updatedAt, Date.now())),
    updatedAt: finitePositive(raw.updatedAt, Date.now()),
  };
}

export function mergeNotebooks(base: InkNotebook, incoming: InkNotebook): InkNotebook {
  const pages = new Map<string, InkPage>();
  for (const page of base.pages) pages.set(page.id, page);
  for (const page of incoming.pages) {
    const existing = pages.get(page.id);
    pages.set(page.id, existing ? mergePages(existing, page) : page);
  }
  const deletedPages: Record<string, number> = { ...(base.deletedPages ?? {}) };
  for (const [id, timestamp] of Object.entries(incoming.deletedPages ?? {})) deletedPages[id] = Math.max(deletedPages[id] ?? 0, timestamp);
  for (const id of Object.keys(deletedPages)) pages.delete(id);
  const orderSource = incoming.pageOrderUpdatedAt > base.pageOrderUpdatedAt
    || incoming.pageOrderUpdatedAt === base.pageOrderUpdatedAt && compareNotebookOrder(incoming, base) >= 0
    ? incoming : base;
  const preferred = orderSource.pageOrder ?? [];
  const known = preferred.map((id) => pages.get(id)).filter((page): page is InkPage => page !== undefined);
  const additions = [...pages.values()].filter((page) => !preferred.includes(page.id)).sort((a, b) => a.createdAt - b.createdAt);
  const ordered = [...known];
  for (const page of additions) {
    const inBase = (base.pageOrder ?? []).includes(page.id);
    const inIncoming = (incoming.pageOrder ?? []).includes(page.id);
    const source = inBase && !inIncoming ? base : incoming;
    const sourceOrder = source.pageOrder ?? source.pages.map((candidate) => candidate.id);
    const sourceIndex = sourceOrder.indexOf(page.id);
    let inserted = false;
    for (let index = sourceIndex - 1; index >= 0; index--) {
      const anchor = ordered.findIndex((candidate) => candidate.id === sourceOrder[index]);
      if (anchor >= 0) { ordered.splice(anchor + 1, 0, page); inserted = true; break; }
    }
    if (!inserted) for (let index = sourceIndex + 1; index < sourceOrder.length; index++) {
      const anchor = ordered.findIndex((candidate) => candidate.id === sourceOrder[index]);
      if (anchor >= 0) { ordered.splice(anchor, 0, page); inserted = true; break; }
    }
    if (!inserted) {
      const at = ordered.findIndex((candidate) => page.createdAt < candidate.createdAt);
      ordered.splice(at < 0 ? ordered.length : at, 0, page);
    }
  }
  const safePages = ordered.length ? ordered : [createPage("Page 1")];
  const pageOrder = safePages.map((page) => page.id);
  return {
    ...incoming,
    schema: 2,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    pageWidth: incoming.pageWidth || base.pageWidth,
    pageHeight: incoming.pageHeight || base.pageHeight,
    pages: safePages,
    pageOrder,
    deletedPages,
    pageOrderUpdatedAt: Math.max(base.pageOrderUpdatedAt, incoming.pageOrderUpdatedAt),
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
  };
}

function compareNotebookOrder(left: InkNotebook, right: InkNotebook): number {
  const leftOrder = JSON.stringify(left.pageOrder ?? []);
  const rightOrder = JSON.stringify(right.pageOrder ?? []);
  return leftOrder < rightOrder ? -1 : leftOrder > rightOrder ? 1 : 0;
}

function mergePages(base: InkPage, incoming: InkPage): InkPage {
  const stickyNotes = new Map<string, StickyNote>();
  for (const note of [...(base.stickyNotes ?? []), ...(incoming.stickyNotes ?? [])]) {
    const previous = stickyNotes.get(note.id); stickyNotes.set(note.id, previous ? mergeSticky(previous, note) : note);
  }
  const deletedStickyNotes = { ...base.deletedStickyNotes };
  for (const [id, time] of Object.entries(incoming.deletedStickyNotes ?? {})) deletedStickyNotes[id] = Math.max(deletedStickyNotes[id] ?? 0, time);
  for (const [id, note] of stickyNotes) if (note.updatedAt <= (deletedStickyNotes[id] ?? 0)) stickyNotes.delete(id);
  const images = new Map<string, InkImage>();
  for (const image of [...(base.images ?? []), ...(incoming.images ?? [])]) {
    const previous = images.get(image.id);
    if (!previous || image.updatedAt > previous.updatedAt
      || image.updatedAt === previous.updatedAt && JSON.stringify(image) > JSON.stringify(previous)) images.set(image.id, image);
  }
  const deletedImageIds = [...new Set([...(base.deletedImageIds ?? []), ...(incoming.deletedImageIds ?? [])])];
  for (const id of deletedImageIds) images.delete(id);
  const strokes = new Map<string, InkStroke>();
  for (const stroke of base.strokes) strokes.set(stroke.id, stroke);
  for (const stroke of incoming.strokes) {
    const existing = strokes.get(stroke.id);
    if (!existing || stroke.updatedAt >= existing.updatedAt) strokes.set(stroke.id, stroke);
  }
  const deletedStrokeIds = [...new Set([...(base.deletedStrokeIds ?? []), ...(incoming.deletedStrokeIds ?? [])])];
  for (const id of deletedStrokeIds) strokes.delete(id);
  // Tags are append-only across devices: union in base order first, then
  // incoming-only tags (the spread above would otherwise replace wholesale,
  // and a wholesale replace would silently drop the other device's labels).
  const tags = [...(base.tags ?? [])];
  for (const tag of incoming.tags ?? []) if (!tags.includes(tag)) tags.push(tag);
  return {
    ...base,
    ...incoming,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    paper: incoming.updatedAt >= base.updatedAt ? incoming.paper : base.paper,
    // Flag is single-valued; the newest side decides, including "cleared"
    // (an absent flag on the newer side must override the older flag).
    flag: incoming.updatedAt >= base.updatedAt ? incoming.flag : base.flag,
    strokes: [...strokes.values()].sort((a, b) => a.createdAt - b.createdAt),
    deletedStrokeIds,
    ...(base.tags || incoming.tags ? { tags } : {}),
    ...(base.stickyNotes || incoming.stickyNotes || base.deletedStickyNotes || incoming.deletedStickyNotes ? {
      stickyNotes: [...stickyNotes.values()].sort(compareStickyOrder), deletedStickyNotes,
    } : {}),
    ...(base.images || incoming.images || base.deletedImageIds || incoming.deletedImageIds ? {
      images: [...images.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), deletedImageIds,
    } : {}),
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
  };
}

function normalizePage(value: unknown): InkPage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<InkPage>;
  const strokes = Array.isArray(raw.strokes) ? raw.strokes : [];
  const deletedStrokeIds = Array.isArray(raw.deletedStrokeIds) ? raw.deletedStrokeIds.filter((id): id is string => typeof id === "string") : [];
  const deleted = new Set(deletedStrokeIds);
  const pageId = typeof raw.id === "string" ? raw.id : newId("page");
  const deletedImageIds = Array.isArray(raw.deletedImageIds) ? raw.deletedImageIds.filter((id): id is string => typeof id === "string") : [];
  const deletedStickyNotes = Object.fromEntries(Object.entries(raw.deletedStickyNotes ?? {}).filter(([id, time]) => typeof id === "string" && Number.isFinite(time)));
  return {
    id: pageId,
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    paper: isPaperStyle(raw.paper) ? raw.paper : "ruled",
    strokes: strokes.map(normalizeStroke).filter((stroke): stroke is InkStroke => stroke !== null && !deleted.has(stroke.id)),
    deletedStrokeIds,
    ...(Array.isArray(raw.stickyNotes) || raw.deletedStickyNotes ? {
      stickyNotes: (Array.isArray(raw.stickyNotes) ? raw.stickyNotes : []).map((note) => normalizeSticky(note, pageId))
        .filter((note): note is StickyNote => !!note && note.updatedAt > (deletedStickyNotes[note.id] ?? 0)).sort(compareStickyOrder), deletedStickyNotes,
    } : {}),
    ...(Array.isArray(raw.images) || Array.isArray(raw.deletedImageIds) ? {
      images: (Array.isArray(raw.images) ? raw.images : []).map((image) => normalizeImage(image, pageId))
        .filter((image): image is InkImage => !!image && !deletedImageIds.includes(image.id)),
      deletedImageIds,
    } : {}),
    // Legacy files carry neither field; garbage values are dropped instead of
    // being round-tripped, so an unknown writer can never poison the model.
    ...(Array.isArray(raw.tags) ? { tags: normalizeTagList(raw.tags) } : {}),
    ...(isPageFlag(raw.flag) ? { flag: raw.flag } : {}),
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now()),
  };
}

/** Trimmed, non-empty, de-duplicated free-text tags in first-seen order. */
function normalizeTagList(value: unknown[]): string[] {
  const tags: string[] = [];
  for (const tag of value) {
    if (typeof tag !== "string") continue;
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed)) tags.push(trimmed);
  }
  return tags;
}

export function isPageFlag(value: unknown): value is PageFlag {
  return value === "red" || value === "yellow" || value === "green";
}

export function isManagedImagePath(path: unknown): path is string {
  return typeof path === "string" && /^Ink Notes\/Images\/assets\/[a-zA-Z0-9-]+\.png$/.test(path);
}

function normalizeImage(value: unknown, pageId: string): InkImage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<InkImage>;
  if (typeof raw.id !== "string" || !isManagedImagePath(raw.assetPath)) return null;
  if (![raw.x, raw.y, raw.width, raw.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const width = clamp(raw.width!, 0.01, 1), height = clamp(raw.height!, 0.01, 1);
  return { id: raw.id, pageId, assetPath: raw.assetPath, x: clamp(raw.x!, 0, 1 - width), y: clamp(raw.y!, 0, 1 - height),
    width, height, foreground: raw.foreground === true, createdAt: finitePositive(raw.createdAt, Date.now()), updatedAt: finitePositive(raw.updatedAt, Date.now()) };
}

function normalizeStroke(value: unknown): InkStroke | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<InkStroke>;
  if (typeof raw.id !== "string" || typeof raw.pageId !== "string") return null;
  const points = Array.isArray(raw.points) ? raw.points : [];
  return {
    id: raw.id,
    pageId: raw.pageId,
    tool: raw.tool === "highlighter" ? "highlighter" : "pen",
    color: typeof raw.color === "string" ? raw.color : "#1b1b1b",
    width: finitePositive(raw.width, 3),
    opacity: clamp(finitePositive(raw.opacity, 1), 0.05, 1),
    points: points.map(normalizePoint).filter((point): point is InkPoint => point !== null),
    dynamics: normalizeDynamics(raw.dynamics),
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now()),
  };
}

export function normalizeDynamics(value: unknown): StrokeDynamics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<StrokeDynamics>;
  const percent = (candidate: unknown, fallback: number): number =>
    typeof candidate === "number" && Number.isFinite(candidate) ? clamp(Math.round(candidate), 0, 100) : fallback;
  const curve = Array.isArray(raw.pressureCurve) && raw.pressureCurve.length >= 2
    ? raw.pressureCurve.map((point) => (Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [NaN, NaN]))
    : undefined;
  const dynamics: StrokeDynamics = {
    taper: percent(raw.taper, 0),
    pressure: percent(raw.pressure, 100),
    speed: percent(raw.speed, 0),
  };
  if (curve) dynamics.pressureCurve = curve;
  const defaults: StrokeDynamics = { taper: 0, pressure: 100, speed: 0 };
  const plain = dynamics.taper === defaults.taper && dynamics.pressure === defaults.pressure && dynamics.speed === defaults.speed;
  return plain && !curve ? undefined : dynamics;
}

function normalizePoint(value: unknown): InkPoint | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<InkPoint>;
  if (typeof raw.x !== "number" || typeof raw.y !== "number") return null;
  return {
    x: clamp(raw.x, 0, 1),
    y: clamp(raw.y, 0, 1),
    pressure: clamp(typeof raw.pressure === "number" ? raw.pressure : 0.5, 0.05, 1),
    tiltX: typeof raw.tiltX === "number" ? raw.tiltX : undefined,
    tiltY: typeof raw.tiltY === "number" ? raw.tiltY : undefined,
    t: finitePositive(raw.t, Date.now()),
  };
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isPaperStyle(value: unknown): value is PaperStyle {
  return value === "blank" || value === "ruled" || value === "grid" || value === "dot";
}
