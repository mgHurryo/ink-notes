import { InkNotebook, InkPage, PaperStyle, createPage, mergeNotebooks, newId, normalizeNotebook } from "./model";

/**
 * Sidecar wrapper model for PDF handwriting.
 *
 * A sidecar is a Vault JSON file under `A_pdfinkwrittern/` that pairs one PDF
 * with an embedded standard ink notebook (schema 2). The wrapper carries the
 * source fingerprint (so a changed or swapped PDF can never be silently
 * overwritten), the per-page geometry observed at load time, and the note page
 * sequence. The sequence starts as one entry per source PDF page with a
 * deterministic id (`pdfp-<index>`), so the mapping survives cross-device
 * sync without a global index; inserted blank pages get random ids.
 *
 * Stroke coordinates stay normalized 0..1 per note page exactly like .ink
 * notebooks; per-page display geometry lives on the note page entry, which is
 * the one place the shared notebook model cannot represent (its width/height
 * are notebook-level).
 */

export const PDF_SIDECAR_FORMAT = 1;
export const PDF_SIDECAR_EXTENSION = "pdfink.json";
export const PDF_INK_FOLDER = "A_pdfinkwrittern";

export class PdfSidecarFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfSidecarFormatError";
  }
}

/** Thrown when two sidecars for the same PDF cannot be merged safely. */
export class PdfSidecarConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfSidecarConflictError";
  }
}

export interface PdfSourcePageGeometry {
  /** Un-rotated page box in PDF points. */
  width: number;
  height: number;
  /** 0 | 90 | 180 | 270 — how viewers rotate the page for display. */
  rotation: number;
}

export interface PdfSidecarNotePage extends PdfSourcePageGeometry {
  id: string;
  /** Index into the source PDF pages; absent for inserted blank pages. */
  sourceIndex?: number;
}

export interface PdfSidecar {
  format: typeof PDF_SIDECAR_FORMAT;
  createdAt: number;
  updatedAt: number;
  source: {
    /** Vault path recorded at creation; migrated on rename events. */
    path: string;
    sha256: string;
    byteLength: number;
    pageCount: number;
  };
  /** Geometry of every source PDF page, as observed when it was opened. */
  sourcePages: PdfSourcePageGeometry[];
  /** The note page sequence shown to the user (source pages + blank pages). */
  notePages: PdfSidecarNotePage[];
  /** Tombstones so page deletions stay deleted during cross-device merges. */
  deletedNotePages: Record<string, number>;
  noteOrderUpdatedAt: number;
  /** Standard schema-2 ink notebook; page ids mirror notePages ids. */
  notebook: InkNotebook;
}

/** Deterministic source-page id: same on every device without any registry. */
export function sourcePageId(index: number): string {
  return `pdfp-${index}`;
}

export function isSourcePageId(id: string): boolean {
  return id.startsWith("pdfp-");
}

/**
 * Sidecar file name for a PDF vault path: sanitized PDF name plus a hash of
 * the normalized lowercased path, so same-named PDFs in different folders
 * never collide. Pure and synchronous — the hash is only a namespace, not a
 * security primitive.
 */
export function sidecarFileNameFor(pdfPath: string): string {
  const normalized = pdfPath.replace(/\\/g, "/");
  const dot = normalized.lastIndexOf("/");
  const file = dot >= 0 ? normalized.slice(dot + 1) : normalized;
  const stem = file.includes(".") ? file.slice(0, file.lastIndexOf(".")) : file;
  // The stem is lowercased so path-case differences (Windows/macOS vaults)
  // keep producing the same name; the hash normalizes the folder part.
  const safe = stem.trim().toLowerCase().replace(/[\\/:*?"<>|#^[\]]/g, "-").slice(0, 80) || "pdf";
  return `${safe}--${pathHash(normalized)}.pdfink.json`;
}

export function sidecarPathFor(pdfPath: string): string {
  return `${PDF_INK_FOLDER}/${sidecarFileNameFor(pdfPath)}`;
}

/** FNV-1a over the normalized path, rendered as 12 hex chars (target-safe). */
export function pathHash(pdfPath: string): string {
  const normalized = pdfPath.replace(/[\\]+/g, "/").toLowerCase();
  const fnv1a = (seed: number): number => {
    let hash = seed | 0;
    for (let index = 0; index < normalized.length; index++) {
      hash ^= normalized.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  };
  return (fnv1a(0x811c9dc5).toString(16).padStart(8, "0") + fnv1a(0x1b873593).toString(16).padStart(8, "0")).slice(0, 12);
}

export function createSidecar(
  sourcePath: string,
  fingerprint: { sha256: string; byteLength: number },
  sourcePages: PdfSourcePageGeometry[],
): PdfSidecar {
  const now = Date.now();
  const notePages: PdfSidecarNotePage[] = sourcePages.map((geometry, index) => ({
    id: sourcePageId(index),
    sourceIndex: index,
    ...geometry,
  }));
  const notebook = notebookForNotePages("blank", notePages);
  return {
    format: PDF_SIDECAR_FORMAT,
    createdAt: now,
    updatedAt: now,
    source: {
      path: sourcePath.replace(/\\/g, "/"),
      sha256: fingerprint.sha256,
      byteLength: fingerprint.byteLength,
      pageCount: sourcePages.length,
    },
    sourcePages: sourcePages.map((geometry) => ({ ...geometry })),
    notePages,
    deletedNotePages: {},
    noteOrderUpdatedAt: now,
    notebook,
  };
}

/** The embedded notebook mirrored over the given note page sequence. */
export function notebookForNotePages(paper: PaperStyle, notePages: PdfSidecarNotePage[]): InkNotebook {
  const now = Date.now();
  const pages = notePages.map((notePage) => pageForNotePage(notePage, paper, now));
  const first = notePages[0];
  return {
    schema: 2,
    title: "PDF notes",
    pageWidth: finitePositive(first?.width, 595.28),
    pageHeight: finitePositive(first?.height, 841.89),
    pages,
    pageOrder: pages.map((page) => page.id),
    deletedPages: {},
    pageOrderUpdatedAt: now,
    updatedAt: now,
  };
}

export function pageForNotePage(notePage: PdfSidecarNotePage, paper: PaperStyle, now = Date.now()): InkPage {
  const page = createPage(notePage.id, paper, now);
  page.id = notePage.id;
  return page;
}

/**
 * Parse and repair a sidecar read from disk. Throws PdfSidecarFormatError for
 * corrupt JSON wrappers or unknown format versions — callers must stop
 * writing in that case instead of silently overwriting unreadable data.
 */
export function normalizeSidecar(value: unknown): PdfSidecar {
  if (!value || typeof value !== "object") {
    throw new PdfSidecarFormatError("Sidecar is not a JSON object");
  }
  const raw = value as Partial<PdfSidecar> & { format?: unknown };
  if (raw.format !== PDF_SIDECAR_FORMAT) {
    throw new PdfSidecarFormatError(`Unsupported sidecar format version: ${String(raw.format)}`);
  }
  const source = raw.source;
  const sha256 = typeof source?.sha256 === "string" && /^[0-9a-f]{64}$/i.test(source.sha256) ? source.sha256.toLowerCase() : null;
  const byteLength = source && typeof source.byteLength === "number" && Number.isFinite(source.byteLength) && source.byteLength >= 0 ? source.byteLength : null;
  const pageCount = source && typeof source.pageCount === "number" && Number.isInteger(source.pageCount) && source.pageCount >= 0 ? source.pageCount : null;
  if (!sha256 || byteLength === null || pageCount === null) {
    throw new PdfSidecarFormatError("Sidecar is missing a valid source fingerprint");
  }
  const sourcePages = Array.isArray(raw.sourcePages)
    ? raw.sourcePages.slice(0, pageCount).map(normalizeGeometry).filter((geometry): geometry is PdfSourcePageGeometry => geometry !== null)
    : [];
  const notePages = Array.isArray(raw.notePages)
    ? raw.notePages.map(normalizeNotePage).filter((notePage): notePage is PdfSidecarNotePage => notePage !== null && (notePage.sourceIndex === undefined || notePage.sourceIndex < pageCount))
    : [];
  if (notePages.length === 0 && pageCount > 0) {
    // Sequence lost (partial write of an older version): rebuild from source.
    for (let index = 0; index < pageCount; index++) {
      const geometry = sourcePages[index] ?? { width: 595.28, height: 841.89, rotation: 0 };
      notePages.push({ id: sourcePageId(index), sourceIndex: index, ...geometry });
    }
  }
  const deletedNotePages = normalizeTimestamps(raw.deletedNotePages);
  const notebook = normalizeNotebook(raw.notebook);
  const notebookPages = new Map(notebook.pages.map((page) => [page.id, page]));
  // Recreate notebook pages for sequence ids missing one, drop notebook pages
  // the sequence does not know (they would be unreachable anyway).
  const pages = notePages.map((notePage) => notebookPages.get(notePage.id) ?? pageForNotePage(notePage, "blank"));
  notebook.pages = pages;
  notebook.pageOrder = notePages.map((notePage) => notePage.id);
  notebook.deletedPages = {};
  notebook.pageWidth = finitePositive(notebook.pageWidth, 595.28);
  notebook.pageHeight = finitePositive(notebook.pageHeight, 841.89);
  return {
    format: PDF_SIDECAR_FORMAT,
    createdAt: finitePositive(raw.createdAt, Date.now()),
    updatedAt: finitePositive(raw.updatedAt, Date.now()),
    source: {
      path: typeof source?.path === "string" ? source.path.replace(/\\/g, "/") : "",
      sha256,
      byteLength,
      pageCount,
    },
    sourcePages,
    notePages,
    deletedNotePages,
    noteOrderUpdatedAt: finitePositive(raw.noteOrderUpdatedAt, finitePositive(raw.updatedAt, Date.now())),
    notebook,
  };
}

/**
 * Merge two sidecars of the same PDF. Strokes and stroke tombstones reuse the
 * standard notebook merge; the note page sequence merges with the same
 * tombstone and order-winner rules the notebook model uses for pages.
 * Throws PdfSidecarConflictError when the two sides disagree about the source
 * PDF — callers keep a conflict copy instead of overwriting.
 */
export function mergeSidecars(base: PdfSidecar, incoming: PdfSidecar): PdfSidecar {
  if (base.source.sha256 !== incoming.source.sha256 || base.source.byteLength !== incoming.source.byteLength) {
    throw new PdfSidecarConflictError(`Sidecars describe different source PDFs (${base.source.path} vs ${incoming.source.path})`);
  }
  const deletedNotePages = { ...base.deletedNotePages };
  for (const [id, timestamp] of Object.entries(incoming.deletedNotePages)) {
    deletedNotePages[id] = Math.max(deletedNotePages[id] ?? 0, timestamp);
  }
  const byId = new Map<string, PdfSidecarNotePage>();
  for (const notePage of base.notePages) byId.set(notePage.id, notePage);
  for (const notePage of incoming.notePages) {
    if (!byId.has(notePage.id)) byId.set(notePage.id, notePage);
  }
  for (const id of Object.keys(deletedNotePages)) byId.delete(id);
  const orderWinner = incoming.noteOrderUpdatedAt > base.noteOrderUpdatedAt
    || (incoming.noteOrderUpdatedAt === base.noteOrderUpdatedAt && compareNotePageOrder(incoming.notePages, base.notePages) >= 0)
    ? incoming
    : base;
  const preferred = orderWinner.notePages.filter((notePage) => byId.has(notePage.id)).map((notePage) => notePage.id);
  const additions = [...byId.values()].filter((notePage) => !preferred.includes(notePage.id))
    .sort((left, right) => {
      if (left.sourceIndex !== undefined && right.sourceIndex !== undefined) return left.sourceIndex - right.sourceIndex;
      if (left.sourceIndex !== undefined) return -1;
      if (right.sourceIndex !== undefined) return 1;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  const ordered: PdfSidecarNotePage[] = preferred.map((id) => byId.get(id)!);
  for (const notePage of additions) {
    const source = (base.notePages.some((candidate) => candidate.id === notePage.id) ? base : incoming).notePages;
    const sourceIndex = source.findIndex((candidate) => candidate.id === notePage.id);
    let inserted = false;
    for (let anchor = sourceIndex - 1; anchor >= 0 && !inserted; anchor--) {
      const position = ordered.findIndex((candidate) => candidate.id === source[anchor].id);
      if (position >= 0) { ordered.splice(position + 1, 0, notePage); inserted = true; }
    }
    for (let anchor = sourceIndex + 1; anchor < source.length && !inserted; anchor++) {
      const position = ordered.findIndex((candidate) => candidate.id === source[anchor].id);
      if (position >= 0) { ordered.splice(position, 0, notePage); inserted = true; }
    }
    if (!inserted) ordered.push(notePage);
  }
  const notePages = ordered;
  const notebook = mergeNotebooks(base.notebook, incoming.notebook);
  const pagesById = new Map(notebook.pages.map((page) => [page.id, page]));
  notebook.pages = notePages.map((notePage) => pagesById.get(notePage.id) ?? pageForNotePage(notePage, "blank"));
  notebook.pageOrder = notePages.map((notePage) => notePage.id);
  notebook.deletedPages = {};
  return {
    ...incoming,
    createdAt: Math.min(base.createdAt, incoming.createdAt),
    updatedAt: Math.max(base.updatedAt, incoming.updatedAt),
    source: { ...incoming.source, path: incoming.source.path || base.source.path },
    sourcePages: incoming.sourcePages.length >= base.sourcePages.length ? incoming.sourcePages : base.sourcePages,
    notePages,
    deletedNotePages,
    noteOrderUpdatedAt: Math.max(base.noteOrderUpdatedAt, incoming.noteOrderUpdatedAt),
    notebook,
  };
}

/** Created-at is not part of the note page shape; stable additions order by id. */
function compareNotePageOrder(left: PdfSidecarNotePage[], right: PdfSidecarNotePage[]): number {
  const serializedLeft = JSON.stringify(left.map((notePage) => notePage.id));
  const serializedRight = JSON.stringify(right.map((notePage) => notePage.id));
  return serializedLeft < serializedRight ? -1 : serializedLeft > serializedRight ? 1 : 0;
}

/**
 * Insert a blank note page after `afterId` (or at the end when null) using the
 * neighbor's geometry so the new page displays exactly like its surroundings.
 * Returns the new page id. Source pages and their order never change.
 */
export function insertBlankNotePage(sidecar: PdfSidecar, afterId: string | null): string {
  const index = afterId === null ? sidecar.notePages.length : sidecar.notePages.findIndex((notePage) => notePage.id === afterId) + 1;
  return insertBlankNotePageAt(sidecar, index);
}

/** Insert at a note sequence position, including before the first source page. */
export function insertBlankNotePageAt(sidecar: PdfSidecar, index: number): string {
  const clamped = Math.max(0, Math.min(index, sidecar.notePages.length));
  const neighbor = sidecar.notePages[Math.max(0, Math.min(clamped, sidecar.notePages.length) - 1)] ?? sidecar.notePages[0];
  const geometry = neighbor
    ? { width: neighbor.width, height: neighbor.height, rotation: neighbor.rotation }
    : { width: 595.28, height: 841.89, rotation: 0 };
  const notePage: PdfSidecarNotePage = { id: newId("page"), ...geometry };
  sidecar.notePages.splice(clamped, 0, notePage);
  sidecar.notebook.pages.splice(clamped, 0, pageForNotePage(notePage, "blank"));
  sidecar.notebook.pageOrder = sidecar.notePages.map((entry) => entry.id);
  touchNoteOrder(sidecar);
  return notePage.id;
}

/** Delete a blank note page (source pages are permanent). */
export function deleteBlankNotePage(sidecar: PdfSidecar, id: string): boolean {
  const index = sidecar.notePages.findIndex((notePage) => notePage.id === id);
  if (index < 0 || isSourcePageId(id)) return false;
  sidecar.notePages.splice(index, 1);
  sidecar.notebook.pages = sidecar.notebook.pages.filter((page) => page.id !== id);
  sidecar.notebook.pageOrder = sidecar.notePages.map((entry) => entry.id);
  sidecar.deletedNotePages[id] = Date.now();
  touchNoteOrder(sidecar);
  return true;
}

/** Move a blank note page to a new position in the sequence. */
export function moveBlankNotePage(sidecar: PdfSidecar, id: string, toIndex: number): boolean {
  const from = sidecar.notePages.findIndex((notePage) => notePage.id === id);
  if (from < 0 || isSourcePageId(id)) return false;
  const clamped = Math.max(0, Math.min(toIndex, sidecar.notePages.length - 1));
  if (clamped === from) return false;
  const [entry] = sidecar.notePages.splice(from, 1);
  sidecar.notePages.splice(clamped, 0, entry);
  sidecar.notebook.pageOrder = sidecar.notePages.map((entry) => entry.id);
  sidecar.notebook.pageOrderUpdatedAt = Date.now();
  touchNoteOrder(sidecar);
  return true;
}

function touchNoteOrder(sidecar: PdfSidecar): void {
  const now = Date.now();
  sidecar.noteOrderUpdatedAt = now;
  sidecar.notebook.pageOrderUpdatedAt = now;
  sidecar.notebook.updatedAt = Math.max(sidecar.notebook.updatedAt, now);
  sidecar.updatedAt = Math.max(sidecar.updatedAt, now);
}

function normalizeNotePage(value: unknown): PdfSidecarNotePage | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PdfSidecarNotePage>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  const geometry = normalizeGeometry(raw);
  if (!geometry) return null;
  const sourceIndex = typeof raw.sourceIndex === "number" && Number.isInteger(raw.sourceIndex) && raw.sourceIndex >= 0
    ? raw.sourceIndex
    : undefined;
  return { id: raw.id, sourceIndex, ...geometry };
}

function normalizeGeometry(value: unknown): PdfSourcePageGeometry | null {
  const raw = value as Partial<PdfSourcePageGeometry> | null;
  const width = raw && typeof raw.width === "number" && Number.isFinite(raw.width) && raw.width > 0 ? raw.width : null;
  const height = raw && typeof raw.height === "number" && Number.isFinite(raw.height) && raw.height > 0 ? raw.height : null;
  const rotation = raw && (raw.rotation === 0 || raw.rotation === 90 || raw.rotation === 180 || raw.rotation === 270) ? raw.rotation : null;
  return width !== null && height !== null && rotation !== null ? { width, height, rotation } : null;
}

function normalizeTimestamps(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
