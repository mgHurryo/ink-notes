import { InkNotebook, mergeNotebooks, normalizeNotebook } from "./model";
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
      return { response: await this.dispatch(request) };
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
  if (operation.type === "finalize-stroke") {
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
