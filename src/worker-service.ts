import workerSource from "ink-worker-source";
import type { InkNotebook } from "./model";
import type {
  InkWorkerRequest,
  InkWorkerResponse,
  NotebookOperation,
  WorkerCapabilities,
} from "./worker-protocol";
import type { RenderTileResult } from "./tiles";

type WorkerRequestInput = InkWorkerRequest extends infer Request
  ? Request extends InkWorkerRequest ? Omit<Request, "requestId"> : never
  : never;

const WORKER_READY_TIMEOUT = 2_000;

export class InkWorkerRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "InkWorkerRequestError";
  }
}

interface RecoverySnapshot {
  notebook: InkNotebook;
  revision: number;
}

interface PendingRequest {
  resolve: (response: InkWorkerResponse) => void;
  reject: (error: Error) => void;
  sessionId: string;
  generation: number;
  notebookRevision: number;
}

export class InkWorkerService {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private readyPromise: Promise<WorkerCapabilities> | null = null;
  private resolveReady: ((capabilities: WorkerCapabilities) => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private readyTimer: number | undefined;
  private nextRequestId = 1;
  private nextSessionId = 1;
  private restartCount = 0;
  private disabled = false;
  private capabilities: WorkerCapabilities | null = null;
  private recoveryPromise: Promise<void> | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sessions = new Map<string, InkWorkerSession>();

  constructor(private readonly reportFallback: (message: string) => void) {}

  createSession(snapshot: () => RecoverySnapshot): InkWorkerSession {
    const session = new InkWorkerSession(this, `view-${this.nextSessionId++}`, snapshot);
    this.sessions.set(session.id, session);
    return session;
  }

  async send(message: WorkerRequestInput, retry = true, skipRecovery = false, transfer: Transferable[] = []): Promise<InkWorkerResponse> {
    if (this.disabled) throw new InkWorkerRequestError("unavailable", "Ink background worker is unavailable");
    if (this.recoveryPromise && !skipRecovery) await this.recoveryPromise;
    await this.ensureWorker();
    try {
      return await this.dispatch(message, transfer);
    } catch (error) {
      if (retry && this.recoveryPromise) {
        await this.recoveryPromise;
        return this.send(message, false, false, transfer);
      }
      throw error;
    }
  }

  removeSession(id: string): void { this.sessions.delete(id); }

  canRenderTiles(): boolean {
    return this.capabilities?.offscreenCanvas === true && this.capabilities.imageBitmap === true
      && this.capabilities.transferable !== false;
  }

  canTransfer(): boolean { return this.capabilities?.transferable === true; }

  isDisabled(): boolean { return this.disabled; }

  async waitForRecovery(): Promise<boolean> {
    const recovery = this.recoveryPromise;
    if (!recovery) return false;
    try {
      await recovery;
      return !this.disabled;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.disabled = true;
    this.stopWorker(new InkWorkerRequestError("disposed", "Ink background worker was disposed"));
    this.sessions.clear();
  }

  private async ensureWorker(): Promise<WorkerCapabilities> {
    if (this.readyPromise) return this.readyPromise;
    if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
      this.disable("This device does not support the Ink Notes background worker; reduced-performance mode is active.");
      throw new InkWorkerRequestError("unsupported", "Web Worker is not supported");
    }
    const blob = new Blob([workerSource], { type: "text/javascript" });
    this.workerUrl = URL.createObjectURL(blob);
    this.worker = new Worker(this.workerUrl);
    this.readyPromise = new Promise<WorkerCapabilities>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
      this.readyTimer = globalThis.setTimeout(() => reject(new InkWorkerRequestError("timeout", "Ink background worker did not start")), WORKER_READY_TIMEOUT) as unknown as number;
    });
    this.worker.onmessage = (event: MessageEvent<InkWorkerResponse>) => this.onMessage(event.data);
    this.worker.onerror = () => this.onWorkerFailure(new InkWorkerRequestError("crashed", "Ink background worker stopped unexpectedly"));
    try {
      return await this.readyPromise;
    } catch (error) {
      this.onWorkerFailure(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private dispatch(message: WorkerRequestInput, transfer: Transferable[] = []): Promise<InkWorkerResponse> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        resolve,
        reject,
        sessionId: message.sessionId,
        generation: message.generation,
        notebookRevision: message.notebookRevision,
      });
      try { this.worker!.postMessage({ ...message, requestId }, transfer); }
      catch (error) {
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(response: InkWorkerResponse): void {
    if (response.type === "ready") {
      if (this.readyTimer !== undefined) globalThis.clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      this.resolveReady?.(response.capabilities);
      this.capabilities = response.capabilities;
      this.resolveReady = null;
      this.rejectReady = null;
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
      this.workerUrl = null;
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);
    if (response.sessionId !== pending.sessionId || response.generation !== pending.generation
      || response.notebookRevision < pending.notebookRevision) {
      pending.reject(new InkWorkerRequestError("stale-response", "Ink background worker returned a stale or mismatched response"));
      return;
    }
    if (response.type === "error") pending.reject(new InkWorkerRequestError(response.code, response.message));
    else pending.resolve(response);
  }

  private onWorkerFailure(error: Error): void {
    if (this.disabled || this.recoveryPromise) return;
    this.stopWorker(error);
    if (this.restartCount >= 1) {
      this.disable("Ink Notes could not restart its background worker; reduced-performance mode is active.");
      return;
    }
    this.restartCount += 1;
    this.recoveryPromise = this.recover().finally(() => { this.recoveryPromise = null; });
  }

  private async recover(): Promise<void> {
    try {
      await this.ensureWorker();
      for (const session of this.sessions.values()) await session.recover();
    } catch {
      this.disable("Ink Notes could not restart its background worker; reduced-performance mode is active.");
    }
  }

  private stopWorker(error: Error): void {
    if (this.readyTimer !== undefined) globalThis.clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.rejectReady?.(error);
    this.resolveReady = null;
    this.rejectReady = null;
    this.readyPromise = null;
    this.capabilities = null;
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private disable(message: string): void {
    if (this.disabled) return;
    this.disabled = true;
    this.stopWorker(new InkWorkerRequestError("unavailable", message));
    this.reportFallback(message);
  }
}

export class InkWorkerSession {
  private generation = 0;
  private mirroredRevision = 0;
  private initialized = false;
  private operationTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly service: InkWorkerService,
    readonly id: string,
    private readonly snapshot: () => RecoverySnapshot,
  ) {}

  canRenderTiles(): boolean {
    return this.service.canRenderTiles();
  }

  async initializeRaw(raw: string, revision: number): Promise<InkNotebook> {
    this.generation += 1;
    this.initialized = false;
    const response = await this.service.send({
      type: "initialize-raw", sessionId: this.id, generation: this.generation,
      notebookRevision: revision, raw, revision,
    });
    if (response.type !== "initialized") throw unexpected(response);
    this.mirroredRevision = response.revision;
    this.initialized = true;
    return response.notebook;
  }

  async apply(revision: number, operation: NotebookOperation, transfer?: Transferable[]): Promise<InkWorkerResponse> {
    const apply = this.operationTail.then(async () => {
      if (revision <= this.mirroredRevision) return this.applied(revision);
      // A transferred point buffer cannot be retried after detachment. The
      // session snapshot is also the recovery source for ordinary operations:
      // it may already contain several operations queued after the crash.
      let response: InkWorkerResponse;
      try {
        response = await this.service.send({
          type: "apply-operation", sessionId: this.id, generation: this.generation,
          notebookRevision: revision, revision, operation,
        },
          false, false, transfer && this.service.canTransfer() ? transfer : []);
      } catch (error) {
        // Recovery reinitializes this session from the authoritative UI model.
        // Never post the operation twice after that snapshot has advanced.
        if (!await this.service.waitForRecovery() || revision > this.mirroredRevision) throw error;
        return this.applied(revision);
      }
      if (response.type !== "operation-applied") throw unexpected(response);
      this.mirroredRevision = response.revision;
      return response;
    });
    this.operationTail = apply.then(() => undefined, () => undefined);
    return apply;
  }

  async barrier(minimumRevision: number): Promise<number> {
    await this.operationTail;
    const response = await this.service.send({
      type: "barrier", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision, minimumRevision,
    });
    if (response.type !== "barrier-complete") throw unexpected(response);
    return response.revision;
  }

  /** Caller supplies a detached snapshot; compression runs in the existing worker. */
  async serializeStorage(value: unknown): Promise<string> {
    await this.operationTail;
    const response = await this.service.send({
      type: "serialize-storage", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision, value,
    });
    if (response.type !== "storage-serialized") throw unexpected(response);
    return response.content;
  }

  async prepareSave(raw: string, minimumRevision: number): Promise<{ token: string; content: string; revision: number }> {
    await this.operationTail;
    const response = await this.service.send({
      type: "prepare-save", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision, raw, minimumRevision,
    });
    if (response.type !== "save-prepared") throw unexpected(response);
    return response;
  }

  async renderTile(pageId: string, cell: string, density: number, revision: number, width: number, height: number,
    renderGeneration = 0, priority: "visible" | "prewarm" = "visible",
    excludedStrokeIds?: readonly string[]): Promise<RenderTileResult> {
    await this.operationTail;
    const response = await this.service.send({
      type: "render-tile", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision,
      pageId,
      cell, density, revision, renderGeneration, priority, width, height, excludedStrokeIds,
    });
    if (response.type !== "tile-rendered") throw unexpected(response);
    return response;
  }

  cancelGeneration(renderGeneration: number): void {
    void this.service.send({
      type: "cancel-render-generation", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision, renderGeneration,
    }).then(() => undefined, () => undefined);
  }

  async commitSave(token: string): Promise<{ revision: number; merged?: InkNotebook }> {
    const response = await this.service.send({
      type: "commit-save", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision, token,
    });
    if (response.type !== "save-committed") throw unexpected(response);
    return response;
  }

  async abortSave(token: string): Promise<void> {
    const response = await this.service.send({
      type: "abort-save", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision, token,
    });
    if (response.type !== "save-aborted") throw unexpected(response);
  }

  async mergeExternal(raw: string): Promise<InkNotebook | undefined> {
    await this.operationTail;
    const response = await this.service.send({
      type: "merge-external", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision, raw,
    });
    if (response.type !== "external-merged") throw unexpected(response);
    return response.notebook;
  }

  async recover(): Promise<void> {
    if (!this.initialized) return;
    const { notebook, revision } = this.snapshot();
    const response = await this.service.send({
      type: "initialize-notebook",
      sessionId: this.id,
      generation: this.generation,
      notebookRevision: revision,
      notebook,
      revision,
    }, false, true);
    if (response.type !== "initialized") throw unexpected(response);
    this.mirroredRevision = response.revision;
  }

  dispose(): void {
    void this.service.send({
      type: "dispose-session", sessionId: this.id, generation: this.generation,
      notebookRevision: this.mirroredRevision,
    }, false).catch(() => undefined);
    this.service.removeSession(this.id);
  }

  private applied(revision: number): InkWorkerResponse {
    return { type: "operation-applied", requestId: -1, sessionId: this.id,
      generation: this.generation, notebookRevision: revision, revision };
  }
}

function unexpected(response: InkWorkerResponse): InkWorkerRequestError {
  return new InkWorkerRequestError("protocol", `Unexpected worker response: ${response.type}`);
}
