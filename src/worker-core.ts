import { InkNotebook, mergeNotebooks, normalizeNotebook } from "./model";
import { drawInkStroke } from "./rendering";
import {
  InkWorkerRequest,
  InkWorkerResponse,
  NotebookOperation,
  WorkerCapabilities,
  WorkerReply,
  cloneStrokeValue,
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
}

class ProtocolError extends Error {
  constructor(readonly code: "invalid-format" | "stale-generation" | "revision-gap" | "missing-session", message: string) {
    super(message);
  }
}

export class InkWorkerCore {
  private readonly sessions = new Map<string, WorkerSessionState>();

  constructor(private readonly capabilities: WorkerCapabilities) {}

  ready(): InkWorkerResponse {
    return { type: "ready", requestId: 0, sessionId: "", generation: 0, capabilities: this.capabilities };
  }

  async handle(request: InkWorkerRequest): Promise<WorkerReply> {
    try {
      const response = await this.dispatch(request);
      return response.type === "tile-rendered"
        ? { response, transfer: [response.bitmap] }
        : { response };
    } catch (error) {
      return { response: {
        type: "error",
        requestId: request.requestId,
        sessionId: request.sessionId,
        generation: request.generation,
        code: error instanceof ProtocolError ? error.code : "internal",
        message: error instanceof Error ? error.message : String(error),
      } };
    }
  }

  private async dispatch(request: InkWorkerRequest): Promise<InkWorkerResponse> {
    if (request.type === "initialize-raw") {
      const notebook = parseNotebook(request.raw);
      this.sessions.set(request.sessionId, {
        generation: request.generation,
        notebook,
        revision: request.revision,
        pendingSave: new Map(),
      });
      return this.response(request, { type: "initialized", notebook, revision: request.revision });
    }
    if (request.type === "initialize-notebook") {
      const notebook = normalizeNotebook(request.notebook);
      this.sessions.set(request.sessionId, {
        generation: request.generation,
        notebook,
        revision: request.revision,
        pendingSave: new Map(),
      });
      return this.response(request, { type: "initialized", notebook, revision: request.revision });
    }

    const session = this.sessions.get(request.sessionId);
    if (!session) throw new ProtocolError("missing-session", "Ink worker session is not initialized");
    if (session.generation !== request.generation) throw new ProtocolError("stale-generation", "Ink worker request belongs to a stale file generation");

    if (request.type === "apply-operation") {
      if (request.revision !== session.revision + 1) {
        throw new ProtocolError("revision-gap", `Expected revision ${session.revision + 1}, received ${request.revision}`);
      }
      applyNotebookOperation(session.notebook, request.operation);
      session.revision = request.revision;
      return this.response(request, { type: "operation-applied", revision: session.revision });
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
        reconcile: serializeNotebook(merged) !== serializeNotebook(local),
      });
      return this.response(request, { type: "save-prepared", token, content: serializeNotebook(merged), revision: session.revision });
    }
    if (request.type === "render-tile") {
      const rendered = renderTile(session.notebook, request.pageId, request.cell, request.density, request.revision, request.width, request.height);
      return this.response(request, { type: "tile-rendered", ...rendered });
    }
    if (request.type === "commit-save") {
      const candidate = session.pendingSave.get(request.token);
      if (!candidate) throw new ProtocolError("missing-session", "Prepared save is no longer available");
      session.pendingSave.delete(request.token);
      session.notebook = mergeNotebooks(candidate.notebook, session.notebook);
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
      const changed = serializeNotebook(merged) !== serializeNotebook(session.notebook);
      session.notebook = normalizeNotebook(merged);
      return this.response(request, { type: "external-merged", notebook: changed ? session.notebook : undefined, revision: session.revision });
    }
    this.sessions.delete(request.sessionId);
    return this.response(request, { type: "session-disposed" });
  }

  private response<T extends Omit<InkWorkerResponse, "requestId" | "sessionId" | "generation">>(
    request: InkWorkerRequest,
    response: T,
  ): InkWorkerResponse {
    return { ...response, requestId: request.requestId, sessionId: request.sessionId, generation: request.generation } as InkWorkerResponse;
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
  bitmap: ImageBitmap;
}

function renderTile(notebook: InkNotebook, pageId: string, cell: string, density: number, revision: number, pageWidth: number, pageHeight: number): RenderedTile {
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
  const rect = { x: x - 4, y: y - 4, width: width + 8, height: height + 8 };
  for (const stroke of page.strokes) {
    if (strokeTouchesRect(stroke, rect, pageWidth, pageHeight)) {
      drawInkStroke(ctx, stroke, pageWidth, pageHeight);
    }
  }
  return {
    pageId, cell, density: safeDensity, revision, x, y, width, height,
    canvasWidth, canvasHeight, bitmap: canvas.transferToImageBitmap(),
  };
}

function strokeTouchesRect(stroke: { points: Array<{ x: number; y: number }>; width: number }, rect: { x: number; y: number; width: number; height: number }, pageWidth: number, pageHeight: number): boolean {
  if (stroke.points.length === 0) return false;
  const padding = stroke.width * 0.7 + 4;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of stroke.points) {
    minX = Math.min(minX, point.x * pageWidth);
    minY = Math.min(minY, point.y * pageHeight);
    maxX = Math.max(maxX, point.x * pageWidth);
    maxY = Math.max(maxY, point.y * pageHeight);
  }
  return maxX + padding >= rect.x && minX - padding <= rect.x + rect.width
    && maxY + padding >= rect.y && minY - padding <= rect.y + rect.height;
}

function parseNotebook(raw: string): InkNotebook {
  try {
    return normalizeNotebook(JSON.parse(raw));
  } catch {
    throw new ProtocolError("invalid-format", "Existing ink notebook is not valid JSON");
  }
}

export function applyNotebookOperation(notebook: InkNotebook, operation: NotebookOperation): void {
  if (operation.type === "replace-notebook") {
    Object.assign(notebook, normalizeNotebook(operation.notebook));
    return;
  }
  const page = notebook.pages.find((candidate) => candidate.id === operation.pageId);
  if (!page) return;
  if (operation.type === "start-stroke") {
    const index = page.strokes.findIndex((stroke) => stroke.id === operation.stroke.id);
    const stroke = cloneStrokeValue(operation.stroke);
    if (index >= 0) page.strokes[index] = stroke;
    else page.strokes.push(stroke);
  } else if (operation.type === "append-stroke-points") {
    const stroke = page.strokes.find((candidate) => candidate.id === operation.strokeId);
    if (stroke) stroke.points.push(...operation.points.map((point) => ({ ...point })));
  } else if (operation.type === "complete-stroke") {
    const stroke = page.strokes.find((candidate) => candidate.id === operation.strokeId);
    if (stroke) stroke.updatedAt = operation.pageUpdatedAt;
  } else if (operation.type === "finalize-stroke") {
    const index = page.strokes.findIndex((stroke) => stroke.id === operation.stroke.id);
    const stroke = cloneStrokeValue(operation.stroke);
    if (index >= 0) page.strokes[index] = stroke;
    else page.strokes.push(stroke);
    page.strokes.sort((left, right) => left.createdAt - right.createdAt);
  } else if (operation.type === "patch-strokes") {
    const removed = new Set(operation.remove);
    const upsert = new Map(operation.upsert.map((stroke) => [stroke.id, cloneStrokeValue(stroke)]));
    page.strokes = page.strokes.filter((stroke) => !removed.has(stroke.id) && !upsert.has(stroke.id));
    page.strokes.push(...upsert.values());
    page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    page.deletedStrokeIds = [...new Set([...page.deletedStrokeIds, ...operation.deletedStrokeIds])];
  } else {
    if (operation.title !== undefined) page.title = operation.title;
    if (operation.paper !== undefined) page.paper = operation.paper;
  }
  page.updatedAt = operation.pageUpdatedAt;
  notebook.updatedAt = operation.notebookUpdatedAt;
}
