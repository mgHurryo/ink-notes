import { InkNotebook, InkStroke, mergeNotebooks, normalizeNotebook } from "./model";
import { parseStoredJson, serializeStoredJson } from "./storage-codec";
import { cloneSticky, compareStickyOrder } from "./sticky-model";
import { drawInkStroke, penOutlineRings } from "./rendering";
import {
  InkWorkerRequest,
  InkWorkerResponse,
  NotebookOperation,
  WorkerCapabilities,
  WorkerReply,
  cloneStrokeValue,
  clonePageValue,
  serializeNotebook,
} from "./worker-protocol";

interface SaveCandidate {
  notebook: InkNotebook;
  revision: number;
  reconcile: boolean;
}

interface WorkerSessionState {
  generation: number;
  notebook: InkNotebook;
  revision: number;
  pendingSave: Map<string, SaveCandidate>;
  indexes: Map<string, WorkerPageIndex>;
  outlineCache: OutlineCache;
}

interface IndexedWorkerStroke {
  stroke: InkStroke;
  order: number;
  cells: string[];
}

class WorkerPageIndex {
  private entries = new Map<string, IndexedWorkerStroke>();
  private cells = new Map<string, Set<IndexedWorkerStroke>>();
  private strokeWidths = new Map<number, number>();
  private maximumStrokeWidth = 0;

  constructor(private readonly width: number, private readonly height: number) {}

  sync(page: InkNotebook["pages"][number]): void {
    this.entries.clear();
    this.cells.clear();
    this.strokeWidths.clear();
    this.maximumStrokeWidth = 0;
    page.strokes.forEach((stroke, order) => this.upsert(stroke, order));
  }

  upsert(stroke: InkStroke, order: number): void {
    this.remove(stroke.id);
    const entry = { stroke, order, cells: workerStrokeCells(stroke, this.width, this.height) };
    this.entries.set(stroke.id, entry);
    this.strokeWidths.set(stroke.width, (this.strokeWidths.get(stroke.width) ?? 0) + 1);
    this.maximumStrokeWidth = Math.max(this.maximumStrokeWidth, stroke.width);
    for (const cell of entry.cells) {
      let bucket = this.cells.get(cell);
      if (!bucket) this.cells.set(cell, bucket = new Set());
      bucket.add(entry);
    }
  }

  remove(strokeId: string): void {
    const entry = this.entries.get(strokeId);
    if (!entry) return;
    this.entries.delete(strokeId);
    const widthCount = (this.strokeWidths.get(entry.stroke.width) ?? 1) - 1;
    if (widthCount > 0) this.strokeWidths.set(entry.stroke.width, widthCount);
    else this.strokeWidths.delete(entry.stroke.width);
    if (entry.stroke.width === this.maximumStrokeWidth && widthCount <= 0) {
      this.maximumStrokeWidth = 0;
      for (const width of this.strokeWidths.keys()) this.maximumStrokeWidth = Math.max(this.maximumStrokeWidth, width);
    }
    for (const cell of entry.cells) {
      const bucket = this.cells.get(cell);
      bucket?.delete(entry);
      if (bucket?.size === 0) this.cells.delete(cell);
    }
  }

  updateOrder(page: InkNotebook["pages"][number]): void {
    page.strokes.forEach((stroke, order) => {
      const entry = this.entries.get(stroke.id);
      if (entry) entry.order = order;
    });
  }

  getStroke(strokeId: string): InkStroke | undefined { return this.entries.get(strokeId)?.stroke; }
  getOrder(strokeId: string): number | undefined { return this.entries.get(strokeId)?.order; }

  query(cell: string, queryWidth = this.width, queryHeight = this.height): InkStroke[] {
    if (queryWidth === this.width && queryHeight === this.height) {
      return [...(this.cells.get(cell) ?? [])]
        .sort((left, right) => left.order - right.order)
        .map((entry) => entry.stroke);
    }
    const [column, row] = cell.split(":").map(Number);
    const x = column * 128;
    const y = row * 128;
    const padding = this.maximumStrokeWidth * 0.7 + 4;
    const paddingX = padding * this.width / queryWidth;
    const paddingY = padding * this.height / queryHeight;
    const keys = workerCellKeys({
      x: x * this.width / queryWidth - paddingX,
      y: y * this.height / queryHeight - paddingY,
      width: Math.min(128, queryWidth - x) * this.width / queryWidth + paddingX * 2,
      height: Math.min(128, queryHeight - y) * this.height / queryHeight + paddingY * 2,
    }, this.width, this.height);
    const found = new Set<IndexedWorkerStroke>();
    for (const key of keys) for (const entry of this.cells.get(key) ?? []) found.add(entry);
    return [...found]
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.stroke);
  }
}

const OUTLINE_CACHE_LIMIT = 512;
interface CachedOutline { signature: string; points: Float32Array }
type OutlineCache = Map<string, CachedOutline>;

class ProtocolError extends Error {
  constructor(readonly code: "invalid-format" | "stale-generation" | "revision-gap" | "missing-session", message: string) {
    super(message);
  }
}

export class InkWorkerCore {
  private readonly sessions = new Map<string, WorkerSessionState>();

  constructor(private readonly capabilities: WorkerCapabilities) {}

  ready(): InkWorkerResponse {
    return { type: "ready", requestId: 0, sessionId: "", generation: 0, notebookRevision: 0, capabilities: this.capabilities };
  }

  async handle(request: InkWorkerRequest): Promise<WorkerReply> {
    try {
      const response = await this.dispatch(request);
      return response.type === "tile-rendered"
        ? { response, transfer: [response.bitmap] }
        : response.type === "operation-applied" && response.outline
          ? { response, transfer: [response.outline.buffer] }
        : { response };
    } catch (error) {
      return { response: {
        type: "error",
        requestId: request.requestId,
        sessionId: request.sessionId,
        generation: request.generation,
        notebookRevision: this.sessions.get(request.sessionId)?.revision ?? request.notebookRevision,
        code: error instanceof ProtocolError ? error.code : "internal",
        message: error instanceof Error ? error.message : String(error),
      } };
    }
  }

  private async dispatch(request: InkWorkerRequest): Promise<InkWorkerResponse> {
    if (request.type === "initialize-raw") {
      if (request.notebookRevision !== request.revision) {
        throw new ProtocolError("revision-gap", "Initialize request revision metadata does not match its notebook revision");
      }
      const notebook = parseNotebook(request.raw);
      this.sessions.set(request.sessionId, {
        generation: request.generation,
        notebook,
        revision: request.revision,
        pendingSave: new Map(),
        indexes: workerIndexes(notebook),
        outlineCache: new Map(),
      });
      return this.response(request, { type: "initialized", notebook, revision: request.revision });
    }
    if (request.type === "initialize-notebook") {
      if (request.notebookRevision !== request.revision) {
        throw new ProtocolError("revision-gap", "Initialize request revision metadata does not match its notebook revision");
      }
      const notebook = normalizeNotebook(request.notebook);
      this.sessions.set(request.sessionId, {
        generation: request.generation,
        notebook,
        revision: request.revision,
        pendingSave: new Map(),
        indexes: workerIndexes(notebook),
        outlineCache: new Map(),
      });
      return this.response(request, { type: "initialized", notebook, revision: request.revision });
    }

    const session = this.sessions.get(request.sessionId);
    if (!session) throw new ProtocolError("missing-session", "Ink worker session is not initialized");
    if (session.generation !== request.generation) throw new ProtocolError("stale-generation", "Ink worker request belongs to a stale file generation");
    if (request.type !== "apply-operation" && request.notebookRevision > session.revision) {
      throw new ProtocolError("revision-gap", `Worker revision ${session.revision} is behind request revision ${request.notebookRevision}`);
    }

    if (request.type === "serialize-storage") {
      return this.response(request, { type: "storage-serialized", content: serializeStoredJson(request.value) });
    }
    if (request.type === "apply-operation") {
      if (request.notebookRevision !== request.revision) {
        throw new ProtocolError("revision-gap", "Operation revision metadata does not match its notebook revision");
      }
      if (request.revision !== session.revision + 1) {
        throw new ProtocolError("revision-gap", `Expected revision ${session.revision + 1}, received ${request.revision}`);
      }
      const operation = request.operation;
      invalidateOperationOutlines(session.outlineCache, operation);
      const operationIndex = "pageId" in operation && typeof operation.pageId === "string"
        ? session.indexes.get(operation.pageId)
        : undefined;
      const outline = applyNotebookOperation(session.notebook, operation, session.outlineCache, operationIndex);
      if (operation.type === "replace-notebook" || operation.type === "history-restore" || operation.type === "page-operation") {
        session.indexes = workerIndexes(session.notebook);
        session.outlineCache.clear();
      } else {
        const pageId = operation.pageId;
        const page = session.notebook.pages.find((candidate) => candidate.id === pageId);
        if (page) {
          let index = session.indexes.get(pageId);
          if (!index) session.indexes.set(pageId, index = new WorkerPageIndex(session.notebook.pageWidth, session.notebook.pageHeight));
          updateWorkerIndex(index, page, operation, outline?.stroke);
        }
      }
      session.revision = request.revision;
      return this.response(request, {
        type: "operation-applied",
        revision: session.revision,
        ...(outline ? { strokeId: outline.strokeId, sampleCount: outline.sampleCount, outline: outline.points, outlineMode: outline.mode } : {}),
      });
    }
    if (request.type === "barrier") {
      if (session.revision < request.minimumRevision) {
        throw new ProtocolError("revision-gap", `Worker revision ${session.revision} is behind ${request.minimumRevision}`);
      }
      return this.response(request, { type: "barrier-complete", revision: session.revision });
    }
    if (request.type === "prepare-save") {
      if (session.revision < request.minimumRevision) {
        throw new ProtocolError("revision-gap", `Worker revision ${session.revision} is behind ${request.minimumRevision}`);
      }
      const disk = parseNotebook(request.raw);
      const local = normalizeNotebook(session.notebook);
      const merged = mergeNotebooks(disk, local);
      const token = `${request.sessionId}:${request.generation}:${request.requestId}`;
      session.pendingSave.clear();
      session.pendingSave.set(token, {
        notebook: normalizeNotebook(merged),
        revision: session.revision,
        reconcile: JSON.stringify(merged) !== JSON.stringify(local),
      });
      return this.response(request, { type: "save-prepared", token, content: serializeNotebook(merged), revision: session.revision });
    }
    if (request.type === "render-tile") {
      const rendered = renderTile(session.notebook, session.indexes.get(request.pageId), session.outlineCache,
        request.pageId, request.cell, request.density, request.revision, request.renderGeneration, request.width, request.height,
        request.excludedStrokeIds);
      return this.response(request, { type: "tile-rendered", ...rendered });
    }
    if (request.type === "cancel-render-generation") {
      return this.response(request, { type: "renders-cancelled", renderGeneration: request.renderGeneration });
    }
    if (request.type === "commit-save") {
      const candidate = session.pendingSave.get(request.token);
      if (!candidate) throw new ProtocolError("missing-session", "Prepared save is no longer available");
      session.pendingSave.delete(request.token);
      session.notebook = mergeNotebooks(candidate.notebook, session.notebook);
      session.indexes = workerIndexes(session.notebook);
      session.outlineCache.clear();
      return this.response(request, {
        type: "save-committed",
        revision: candidate.revision,
        merged: candidate.reconcile ? candidate.notebook : undefined,
      });
    }
    if (request.type === "abort-save") {
      session.pendingSave.delete(request.token);
      return this.response(request, { type: "save-aborted" });
    }
    if (request.type === "merge-external") {
      const merged = mergeNotebooks(parseNotebook(request.raw), session.notebook);
      const changed = JSON.stringify(merged) !== JSON.stringify(session.notebook);
      session.notebook = normalizeNotebook(merged);
      // Rebuild unconditionally like commit-save: the assignment above swaps in
      // a fresh object graph even when the content is unchanged, and stale
      // indexes would send index-first operations (append/complete/translate)
      // into the orphaned graph, silently dropping the edits from the next save.
      session.indexes = workerIndexes(session.notebook);
      session.outlineCache.clear();
      return this.response(request, { type: "external-merged", notebook: changed ? session.notebook : undefined, revision: session.revision });
    }
    this.sessions.delete(request.sessionId);
    return this.response(request, { type: "session-disposed" });
  }

  private response<T extends Omit<InkWorkerResponse, "requestId" | "sessionId" | "generation" | "notebookRevision">>(
    request: InkWorkerRequest,
    response: T,
  ): InkWorkerResponse {
    return {
      ...response,
      requestId: request.requestId,
      sessionId: request.sessionId,
      generation: request.generation,
      notebookRevision: this.sessions.get(request.sessionId)?.revision ?? request.notebookRevision,
    } as InkWorkerResponse;
  }
}

interface RasterCanvas {
  width: number;
  height: number;
  getContext(type: "2d"): unknown;
  transferToImageBitmap(): ImageBitmap;
}

interface RasterCanvasConstructor {
  new(width: number, height: number): RasterCanvas;
}

interface RenderedTile {
  pageId: string;
  cell: string;
  density: number;
  revision: number;
  x: number;
  y: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
  renderGeneration: number;
  bitmap: ImageBitmap;
}

function renderTile(notebook: InkNotebook, index: WorkerPageIndex | undefined, outlineCache: OutlineCache,
  pageId: string, cell: string, density: number, revision: number, renderGeneration: number, pageWidth: number, pageHeight: number,
  excludedStrokeIds?: readonly string[]): RenderedTile {
  const page = notebook.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error(`Ink worker page is unavailable: ${pageId}`);
  const Canvas = (globalThis as unknown as { OffscreenCanvas?: RasterCanvasConstructor }).OffscreenCanvas;
  if (!Canvas) throw new Error("OffscreenCanvas is not supported by this device");
  const [column, row] = cell.split(":").map(Number);
  const x = column * 128;
  const y = row * 128;
  const width = Math.min(128, pageWidth - x);
  const height = Math.min(128, pageHeight - y);
  if (width <= 0 || height <= 0) throw new Error(`Ink worker tile is outside page bounds: ${cell}`);
  const safeDensity = Math.max(0.5, Math.min(9, density));
  const bleedPixels = Math.ceil(4 * safeDensity);
  const canvasWidth = Math.ceil(width * safeDensity) + bleedPixels * 2;
  const canvasHeight = Math.ceil(height * safeDensity) + bleedPixels * 2;
  const canvas = new Canvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("Ink worker could not create a 2D tile context");
  ctx.setTransform(safeDensity, 0, 0, safeDensity, bleedPixels - x * safeDensity, bleedPixels - y * safeDensity);
  const candidates = index?.query(cell, pageWidth, pageHeight) ?? [];
  for (const stroke of candidates) {
    // The mirror received these strokes via complete-stroke while the main
    // thread still renders them from its preview layer; skipping them here
    // keeps the tile free of that ink until the commit lands and revisions
    // move the tile over.
    if (excludedStrokeIds?.includes(stroke.id)) continue;
    drawWorkerStroke(ctx, stroke, pageWidth, pageHeight, outlineCache);
  }
  return {
    pageId, cell, density: safeDensity, revision, renderGeneration, x, y, width, height,
    canvasWidth, canvasHeight, bitmap: canvas.transferToImageBitmap(),
  };
}

function workerIndexes(notebook: InkNotebook): Map<string, WorkerPageIndex> {
  const indexes = new Map<string, WorkerPageIndex>();
  for (const page of notebook.pages) {
    const index = new WorkerPageIndex(notebook.pageWidth, notebook.pageHeight);
    index.sync(page);
    indexes.set(page.id, index);
  }
  return indexes;
}

function workerStrokeCells(stroke: InkStroke, pageWidth: number, pageHeight: number): string[] {
  if (stroke.points.length === 0) return [];
  const padding = stroke.width * 0.7 + 4;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x * pageWidth);
    minY = Math.min(minY, point.y * pageHeight);
    maxX = Math.max(maxX, point.x * pageWidth);
    maxY = Math.max(maxY, point.y * pageHeight);
  }
  return workerCellKeys({ x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 }, pageWidth, pageHeight);
}

function workerCellKeys(rect: { x: number; y: number; width: number; height: number }, pageWidth: number, pageHeight: number): string[] {
  if (!Number.isFinite(rect.x + rect.y + rect.width + rect.height) || rect.width <= 0 || rect.height <= 0
    || rect.x >= pageWidth || rect.y >= pageHeight || rect.x + rect.width <= 0 || rect.y + rect.height <= 0) return [];
  const cells: string[] = [];
  for (let row = Math.floor(Math.max(0, rect.y) / 128); row < Math.ceil(Math.min(pageHeight, rect.y + rect.height) / 128); row++) {
    for (let column = Math.floor(Math.max(0, rect.x) / 128); column < Math.ceil(Math.min(pageWidth, rect.x + rect.width) / 128); column++) {
      cells.push(`${column}:${row}`);
    }
  }
  return cells;
}

function drawWorkerStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, width: number, height: number, cache: OutlineCache): void {
  if (stroke.tool !== "pen") {
    drawInkStroke(ctx, stroke, width, height);
    return;
  }
  const signature = `${stroke.updatedAt}:${stroke.points.length}:${stroke.width}:${width}:${height}`;
  let cached = cache.get(stroke.id);
  let outline = cached?.signature === signature ? cached.points : undefined;
  if (!outline) {
    // NaN separators between the stamped rings (discs + trapezoids, all
    // wound the same direction): one nonzero fill ADDS the overlaps instead
    // of cancelling them, so retraces and hooks stay solid with no seams.
    const generated = penOutlineRings(stroke, width, height);
    const separators = Math.max(0, generated.length - 1);
    const buffer = new Float32Array((generated.reduce((total, ring) => total + ring.length, 0) + separators) * 2);
    let cursor = 0;
    generated.forEach((ring, ringIndex) => {
      if (ringIndex > 0) { buffer[cursor] = Number.NaN; buffer[cursor + 1] = Number.NaN; cursor += 2; }
      for (const [x, y] of ring) { buffer[cursor] = x; buffer[cursor + 1] = y; cursor += 2; }
    });
    outline = buffer;
    cache.delete(stroke.id);
    cache.set(stroke.id, { signature, points: outline });
    while (cache.size > OUTLINE_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  } else {
    cache.delete(stroke.id);
    cache.set(stroke.id, cached!);
  }
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.fillStyle = stroke.color;
  ctx.globalCompositeOperation = "source-over";
  if (outline.length >= 2) {
    ctx.beginPath();
    let tracing = false;
    for (let index = 0; index < outline.length; index += 2) {
      const x = outline[index];
      const y = outline[index + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) { tracing = false; continue; }
      if (!tracing) { tracing = true; ctx.moveTo(x, y); continue; }
      ctx.lineTo(x, y);
    }
    ctx.fill();
  }
  ctx.restore();
}

function parseNotebook(raw: string): InkNotebook {
  try {
    return normalizeNotebook(parseStoredJson(raw));
  } catch {
    throw new ProtocolError("invalid-format", "Existing ink notebook is corrupt or uses an unsupported encoding");
  }
}

interface OperationOutline {
  strokeId: string;
  sampleCount: number;
  points: Float32Array;
  mode: "pen" | "highlighter";
  stroke: InkStroke;
}

export function applyNotebookOperation(notebook: InkNotebook, operation: NotebookOperation, cache?: OutlineCache,
  index?: WorkerPageIndex): OperationOutline | undefined {
  if (operation.type === "replace-notebook" || operation.type === "history-restore") {
    Object.assign(notebook, normalizeNotebook(operation.notebook));
    return undefined;
  }
  if (operation.type === "page-operation") {
    const page = operation.page;
    if ((operation.action === "add" || operation.action === "duplicate" || operation.action === "restore") && page) {
      // A tombstoned page ID must never be revived. History restoration remaps
      // such pages to fresh IDs before it reaches the Worker.
      if (!(page.id in notebook.deletedPages)) {
        notebook.pages = notebook.pages.filter((candidate) => candidate.id !== page.id);
        notebook.pages.push(clonePageValue(page));
      }
    } else if (operation.action === "delete" && operation.pageId) {
      if (notebook.pages.length > 1) {
        notebook.pages = notebook.pages.filter((candidate) => candidate.id !== operation.pageId);
        notebook.deletedPages[operation.pageId] = Math.max(notebook.deletedPages[operation.pageId] ?? 0, operation.deletedAt ?? Date.now());
      }
    }
    const order = new Map(operation.pageOrder.map((id, index) => [id, index]));
    notebook.pages.sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
    notebook.pageOrder = notebook.pages.map((candidate) => candidate.id);
    notebook.pageOrderUpdatedAt = operation.pageOrderUpdatedAt;
    notebook.updatedAt = operation.notebookUpdatedAt;
    return undefined;
  }
  const page = notebook.pages.find((candidate) => candidate.id === operation.pageId);
  if (!page) return undefined;
  let outlinedStroke: InkStroke | undefined;
  if (operation.type === "start-stroke") {
    const position = index?.getOrder(operation.stroke.id) ?? -1;
    const stroke = cloneStrokeValue(operation.stroke);
    if (position >= 0) page.strokes[position] = stroke;
    else page.strokes.push(stroke);
    outlinedStroke = stroke;
  } else if (operation.type === "append-stroke-points") {
    const stroke = index?.getStroke(operation.strokeId) ?? page.strokes.find((candidate) => candidate.id === operation.strokeId);
    if (stroke) {
      for (let index = 0; index + 5 < operation.points.length; index += 6) {
        stroke.points.push({
          x: operation.points[index],
          y: operation.points[index + 1],
          pressure: operation.points[index + 2],
          tiltX: Number.isNaN(operation.points[index + 3]) ? undefined : operation.points[index + 3],
          tiltY: Number.isNaN(operation.points[index + 4]) ? undefined : operation.points[index + 4],
          t: operation.points[index + 5],
        });
      }
      outlinedStroke = stroke;
    }
  } else if (operation.type === "complete-stroke") {
    const stroke = index?.getStroke(operation.strokeId) ?? page.strokes.find((candidate) => candidate.id === operation.strokeId);
    if (stroke) stroke.updatedAt = operation.pageUpdatedAt;
  } else if (operation.type === "finalize-stroke") {
    const position = index?.getOrder(operation.stroke.id) ?? -1;
    const stroke = cloneStrokeValue(operation.stroke);
    if (position >= 0) page.strokes[position] = stroke;
    else page.strokes.push(stroke);
    page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    outlinedStroke = stroke;
  } else if (operation.type === "patch-strokes") {
    const removed = new Set(operation.remove);
    const upsert = new Map(operation.upsert.map((stroke) => [stroke.id, cloneStrokeValue(stroke)]));
    page.strokes = page.strokes.filter((stroke) => !removed.has(stroke.id) && !upsert.has(stroke.id));
    page.strokes.push(...upsert.values());
    page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    page.deletedStrokeIds = [...new Set([...page.deletedStrokeIds, ...operation.deletedStrokeIds])];
  } else if (operation.type === "translate-strokes") {
    for (const strokeId of operation.strokeIds) {
      const stroke = index?.getStroke(strokeId) ?? page.strokes.find((candidate) => candidate.id === strokeId);
      if (!stroke) continue;
      stroke.points = stroke.points.map((point) => ({ ...point, x: point.x + operation.dx, y: point.y + operation.dy }));
      stroke.updatedAt = operation.pageUpdatedAt;
    }
  } else if (operation.type === "patch-sticky-notes") {
    const removed = new Set(operation.remove), upsert = new Map(operation.upsert.map((note) => [note.id, cloneSticky(note)]));
    page.deletedStickyNotes = { ...page.deletedStickyNotes };
    for (const [id, time] of Object.entries(operation.deletedStickyNotes)) page.deletedStickyNotes[id] = Math.max(page.deletedStickyNotes[id] ?? 0, time);
    page.stickyNotes = [...(page.stickyNotes ?? []).filter((note) => !removed.has(note.id) && !upsert.has(note.id)), ...upsert.values()]
      .filter((note) => note.updatedAt > (page.deletedStickyNotes![note.id] ?? 0)).sort(compareStickyOrder);
  } else if (operation.type === "patch-images") {
    const removed = new Set(operation.remove);
    const upsert = new Map(operation.upsert.map((image) => [image.id, { ...image }]));
    page.deletedImageIds = [...new Set([...(page.deletedImageIds ?? []), ...operation.deletedImageIds])];
    page.images = [...(page.images ?? []).filter((image) => !removed.has(image.id) && !upsert.has(image.id)), ...upsert.values()]
      .filter((image) => !page.deletedImageIds!.includes(image.id));
  } else {
    if (operation.title !== undefined) page.title = operation.title;
    if (operation.paper !== undefined) page.paper = operation.paper;
  }
  page.updatedAt = operation.pageUpdatedAt;
  notebook.updatedAt = operation.notebookUpdatedAt;
  if (!outlinedStroke || outlinedStroke.tool !== "pen" && outlinedStroke.tool !== "highlighter") return undefined;
  const previewWidth = operation.type === "start-stroke" || operation.type === "append-stroke-points"
    ? Math.max(1, operation.previewWidth ?? notebook.pageWidth)
    : notebook.pageWidth;
  const previewHeight = operation.type === "start-stroke" || operation.type === "append-stroke-points"
    ? Math.max(1, operation.previewHeight ?? notebook.pageHeight)
    : notebook.pageHeight;
  const signature = `${outlinedStroke.updatedAt}:${outlinedStroke.points.length}:${outlinedStroke.width}:${previewWidth}:${previewHeight}`;
  if (outlinedStroke.tool === "highlighter") {
    const line = new Float32Array(outlinedStroke.points.length * 2);
    for (let index = 0; index < outlinedStroke.points.length; index++) {
      // Operation outlines use normalized coordinates. This keeps the live
      // preview independent from the persisted notebook dimensions while the
      // stroke width is still calculated for the actual displayed canvas.
      line[index * 2] = outlinedStroke.points[index].x;
      line[index * 2 + 1] = outlinedStroke.points[index].y;
    }
    return { strokeId: outlinedStroke.id, sampleCount: outlinedStroke.points.length, points: line, mode: "highlighter", stroke: outlinedStroke };
  }
  const cached = cache?.get(outlinedStroke.id);
  let outline = cached?.signature === signature ? cached.points : undefined;
  if (!outline) {
    // NaN separators between the stamped rings survive the transfer so the
    // main thread can trace each ring without stitching them together.
    const generated = penOutlineRings(outlinedStroke, previewWidth, previewHeight);
    const separators = Math.max(0, generated.length - 1);
    const buffer = new Float32Array((generated.reduce((total, ring) => total + ring.length, 0) + separators) * 2);
    let cursor = 0;
    generated.forEach((ring, ringIndex) => {
      if (ringIndex > 0) { buffer[cursor] = Number.NaN; buffer[cursor + 1] = Number.NaN; cursor += 2; }
      for (const [x, y] of ring) { buffer[cursor] = x; buffer[cursor + 1] = y; cursor += 2; }
    });
    outline = buffer;
    if (cache) {
      cache.delete(outlinedStroke.id);
      cache.set(outlinedStroke.id, { signature, points: outline });
      while (cache.size > OUTLINE_CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    }
  }
  const normalized = new Float32Array(outline.length);
  for (let index = 0; index < outline.length; index += 2) {
    normalized[index] = outline[index] / previewWidth;
    normalized[index + 1] = outline[index + 1] / previewHeight;
  }
  return { strokeId: outlinedStroke.id, sampleCount: outlinedStroke.points.length, points: normalized, mode: "pen", stroke: outlinedStroke };
}

function invalidateOperationOutlines(cache: OutlineCache, operation: NotebookOperation): void {
  if (operation.type === "replace-notebook" || operation.type === "history-restore" || operation.type === "page-operation") {
    cache.clear();
    return;
  }
  if (operation.type === "start-stroke" || operation.type === "finalize-stroke") cache.delete(operation.stroke.id);
  else if (operation.type === "append-stroke-points" || operation.type === "complete-stroke") cache.delete(operation.strokeId);
  else if (operation.type === "patch-strokes") {
    for (const id of operation.remove) cache.delete(id);
    for (const stroke of operation.upsert) cache.delete(stroke.id);
  } else if (operation.type === "translate-strokes") {
    for (const id of operation.strokeIds) cache.delete(id);
  }
}

function updateWorkerIndex(index: WorkerPageIndex, page: InkNotebook["pages"][number], operation: Exclude<NotebookOperation,
  { type: "replace-notebook" } | { type: "history-restore" } | { type: "page-operation" }>, outlinedStroke?: InkStroke): void {
  if (operation.type === "start-stroke" || operation.type === "finalize-stroke") {
    const stroke = outlinedStroke;
    if (stroke) index.upsert(stroke, operation.type === "start-stroke"
      ? index.getOrder(stroke.id) ?? page.strokes.length - 1
      : Number.MAX_SAFE_INTEGER);
    if (operation.type === "finalize-stroke") index.updateOrder(page);
  } else if (operation.type === "complete-stroke") {
    const stroke = outlinedStroke ?? index.getStroke(operation.strokeId);
    if (stroke) index.upsert(stroke, index.getOrder(operation.strokeId) ?? page.strokes.length - 1);
  } else if (operation.type === "append-stroke-points") {
    // The indexed entry owns the same mutable Worker stroke reference, so ID
    // lookup remains O(1). Its spatial cells are recomputed only once when the
    // stroke completes; active ink is rendered by the separate preview layer.
  } else if (operation.type === "patch-strokes") {
    for (const id of operation.remove) index.remove(id);
    const positions = new Map(page.strokes.map((stroke, position) => [stroke.id, position]));
    const strokes = new Map(page.strokes.map((stroke) => [stroke.id, stroke]));
    for (const replacement of operation.upsert) {
      const stroke = strokes.get(replacement.id);
      if (stroke) index.upsert(stroke, positions.get(stroke.id) ?? Number.MAX_SAFE_INTEGER);
    }
    index.updateOrder(page);
  } else if (operation.type === "translate-strokes") {
    for (const id of operation.strokeIds) {
      const stroke = index.getStroke(id);
      if (stroke) index.upsert(stroke, index.getOrder(id) ?? Number.MAX_SAFE_INTEGER);
    }
  }
}
