export type InkTool = "pen" | "highlighter" | "eraser" | "lasso";
export type PaperStyle = "blank" | "ruled" | "grid" | "dot";

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
  tool: Exclude<InkTool, "eraser" | "lasso">;
  color: string;
  width: number;
  opacity: number;
  points: InkPoint[];
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
  createdAt: number;
  updatedAt: number;
}

export interface InkNotebook {
  schema: 1;
  title: string;
  pageWidth: number;
  pageHeight: number;
  pages: InkPage[];
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
  return {
    schema: 1,
    title,
    pageWidth: DEFAULT_PAGE_WIDTH,
    pageHeight: DEFAULT_PAGE_HEIGHT,
    pages: [createPage("Page 1", "ruled", now)],
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
  return {
    schema: 1,
    title: typeof raw.title === "string" ? raw.title : "Ink Notebook",
    pageWidth: finitePositive(raw.pageWidth, DEFAULT_PAGE_WIDTH),
    pageHeight: finitePositive(raw.pageHeight, DEFAULT_PAGE_HEIGHT),
    pages: pages.map(normalizePage).filter((page): page is InkPage => page !== null),
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
  const ordered = [...pages.values()].sort((a, b) => a.createdAt - b.createdAt);
  return {
    ...incoming,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    pageWidth: incoming.pageWidth || base.pageWidth,
    pageHeight: incoming.pageHeight || base.pageHeight,
    pages: ordered.length ? ordered : [createPage("Page 1")],
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
  };
}

function mergePages(base: InkPage, incoming: InkPage): InkPage {
  const strokes = new Map<string, InkStroke>();
  for (const stroke of base.strokes) strokes.set(stroke.id, stroke);
  for (const stroke of incoming.strokes) {
    const existing = strokes.get(stroke.id);
    if (!existing || stroke.updatedAt >= existing.updatedAt) strokes.set(stroke.id, stroke);
  }
  const deletedStrokeIds = [...new Set([...(base.deletedStrokeIds ?? []), ...(incoming.deletedStrokeIds ?? [])])];
  for (const id of deletedStrokeIds) strokes.delete(id);
  return {
    ...base,
    ...incoming,
    title: incoming.updatedAt >= base.updatedAt ? incoming.title : base.title,
    paper: incoming.updatedAt >= base.updatedAt ? incoming.paper : base.paper,
    strokes: [...strokes.values()].sort((a, b) => a.createdAt - b.createdAt),
    deletedStrokeIds,
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
  };
}

function normalizePage(value: unknown): InkPage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<InkPage>;
  const strokes = Array.isArray(raw.strokes) ? raw.strokes : [];
  const deletedStrokeIds = Array.isArray(raw.deletedStrokeIds) ? raw.deletedStrokeIds.filter((id): id is string => typeof id === "string") : [];
  const deleted = new Set(deletedStrokeIds);
  return {
    id: typeof raw.id === "string" ? raw.id : newId("page"),
    title: typeof raw.title === "string" ? raw.title : "Untitled",
    paper: isPaperStyle(raw.paper) ? raw.paper : "ruled",
    strokes: strokes.map(normalizeStroke).filter((stroke): stroke is InkStroke => stroke !== null && !deleted.has(stroke.id)),
    deletedStrokeIds,
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now()),
  };
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
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now()),
  };
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
