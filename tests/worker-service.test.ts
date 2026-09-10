import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNotebook } from "../src/model";
import type { InkWorkerRequest, InkWorkerResponse } from "../src/worker-protocol";
import { InkWorkerService } from "../src/worker-service";

class FakeWorker {
  static instances: FakeWorker[] = [];
  static transferable = true;
  static holdApplyResponses = false;
  onmessage: ((event: MessageEvent<InkWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  crashNextApply = false;
  requests: InkWorkerRequest[] = [];

  constructor(_url: string) {
    FakeWorker.instances.push(this);
    queueMicrotask(() => this.emit({ type: "ready", requestId: 0, sessionId: "", generation: 0, notebookRevision: 0,
      capabilities: { offscreenCanvas: true, imageBitmap: true, transferable: FakeWorker.transferable } }));
  }

  postMessage(value: InkWorkerRequest, transfer: Transferable[] = []): void {
    const request = transfer.length > 0 ? structuredClone(value, { transfer }) : structuredClone(value);
    this.requests.push(request);
    if (request.type === "apply-operation" && this.crashNextApply) {
      this.crashNextApply = false;
      queueMicrotask(() => this.onerror?.({} as ErrorEvent));
      return;
    }
    queueMicrotask(() => {
      if (request.type === "initialize-raw") this.emit({ type: "initialized", requestId: request.requestId,
        sessionId: request.sessionId, generation: request.generation, notebookRevision: request.notebookRevision,
        notebook: JSON.parse(request.raw), revision: request.revision });
      else if (request.type === "initialize-notebook") this.emit({ type: "initialized", requestId: request.requestId,
        sessionId: request.sessionId, generation: request.generation, notebookRevision: request.notebookRevision,
        notebook: request.notebook, revision: request.revision });
      else if (request.type === "apply-operation" && !FakeWorker.holdApplyResponses) this.emit({ type: "operation-applied", requestId: request.requestId,
        sessionId: request.sessionId, generation: request.generation, notebookRevision: request.notebookRevision,
        revision: request.revision });
      else if (request.type === "dispose-session") this.emit({ type: "session-disposed", requestId: request.requestId,
        sessionId: request.sessionId, generation: request.generation, notebookRevision: request.notebookRevision });
    });
  }

  terminate(): void { this.terminated = true; }

  emit(response: InkWorkerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<InkWorkerResponse>);
  }
}

describe("InkWorkerService recovery", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.transferable = true;
    FakeWorker.holdApplyResponses = false;
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:ink-worker"), revokeObjectURL: vi.fn() });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("recovers once from a crash without replaying a detached operation", async () => {
    const report = vi.fn();
    const notebook = createNotebook();
    let revision = 0;
    const service = new InkWorkerService(report);
    const session = service.createSession(() => ({ notebook, revision }));
    await session.initializeRaw(JSON.stringify(notebook), revision);

    const first = FakeWorker.instances[0];
    first.crashNextApply = true;
    revision = 1;
    const points = new Float64Array([0.2, 0.3, 0.5, 10, -5, 2]);
    await expect(session.apply(revision, {
      type: "append-stroke-points", pageId: notebook.pages[0].id, strokeId: "missing", points,
      pageUpdatedAt: 2, notebookUpdatedAt: 2,
    }, [points.buffer])).resolves.toMatchObject({ type: "operation-applied", revision: 1 });

    expect(points.byteLength).toBe(0);
    expect(FakeWorker.instances).toHaveLength(2);
    const recovered = FakeWorker.instances[1];
    expect(recovered.requests.filter((request) => request.type === "initialize-notebook"))
      .toHaveLength(1);
    expect(recovered.requests.filter((request) => request.type === "apply-operation" && request.revision === 1))
      .toHaveLength(0);

    revision = 2;
    await expect(session.apply(revision, { type: "set-page", pageId: notebook.pages[0].id, title: "After recovery",
      pageUpdatedAt: 3, notebookUpdatedAt: 3 })).resolves.toMatchObject({ type: "operation-applied", revision: 2 });
    expect(report).not.toHaveBeenCalled();
    service.dispose();
  });

  it("falls back once when the restarted worker crashes again", async () => {
    const report = vi.fn();
    const notebook = createNotebook();
    let revision = 0;
    const service = new InkWorkerService(report);
    const session = service.createSession(() => ({ notebook, revision }));
    await session.initializeRaw(JSON.stringify(notebook), revision);

    FakeWorker.instances[0].crashNextApply = true;
    revision = 1;
    await session.apply(revision, { type: "set-page", pageId: notebook.pages[0].id, title: "one",
      pageUpdatedAt: 2, notebookUpdatedAt: 2 });
    FakeWorker.instances[1].crashNextApply = true;
    revision = 2;
    await expect(session.apply(revision, { type: "set-page", pageId: notebook.pages[0].id, title: "two",
      pageUpdatedAt: 3, notebookUpdatedAt: 3 })).rejects.toThrow("stopped unexpectedly");
    await expect(session.apply(3, { type: "set-page", pageId: notebook.pages[0].id, title: "three",
      pageUpdatedAt: 4, notebookUpdatedAt: 4 })).rejects.toThrow("unavailable");
    expect(report).toHaveBeenCalledOnce();
  });

  it("copies packed points when transferable buffers are unavailable", async () => {
    FakeWorker.transferable = false;
    const notebook = createNotebook();
    const service = new InkWorkerService(vi.fn());
    const session = service.createSession(() => ({ notebook, revision: 1 }));
    await session.initializeRaw(JSON.stringify(notebook), 0);
    const points = new Float64Array([0.2, 0.3, 0.5, Number.NaN, Number.NaN, 2]);
    await session.apply(1, { type: "append-stroke-points", pageId: notebook.pages[0].id,
      strokeId: "missing", points, pageUpdatedAt: 2, notebookUpdatedAt: 2 }, [points.buffer]);
    expect(points.byteLength).toBe(6 * Float64Array.BYTES_PER_ELEMENT);
    expect(session.canRenderTiles()).toBe(false);
    service.dispose();
  });

  it("serializes operations even when callers enqueue later revisions immediately", async () => {
    FakeWorker.holdApplyResponses = true;
    const notebook = createNotebook();
    const service = new InkWorkerService(vi.fn());
    const session = service.createSession(() => ({ notebook, revision: 2 }));
    await session.initializeRaw(JSON.stringify(notebook), 0);
    const worker = FakeWorker.instances[0];
    const first = session.apply(1, { type: "set-page", pageId: notebook.pages[0].id, title: "one",
      pageUpdatedAt: 2, notebookUpdatedAt: 2 });
    const second = session.apply(2, { type: "set-page", pageId: notebook.pages[0].id, title: "two",
      pageUpdatedAt: 3, notebookUpdatedAt: 3 });
    await vi.waitFor(() => expect(worker.requests.filter((request) => request.type === "apply-operation")
      .map((request) => request.revision)).toEqual([1]));
    const requestOne = worker.requests.find((request) => request.type === "apply-operation")!;
    worker.emit({ type: "operation-applied", requestId: requestOne.requestId, sessionId: requestOne.sessionId,
      generation: requestOne.generation, notebookRevision: 1, revision: 1 });
    await first;
    await vi.waitFor(() => expect(worker.requests.filter((request) => request.type === "apply-operation")).toHaveLength(2));
    const requests = worker.requests.filter((request) => request.type === "apply-operation");
    expect(requests.map((request) => request.revision)).toEqual([1, 2]);
    const requestTwo = requests[1];
    worker.emit({ type: "operation-applied", requestId: requestTwo.requestId, sessionId: requestTwo.sessionId,
      generation: requestTwo.generation, notebookRevision: 2, revision: 2 });
    await second;
    service.dispose();
  });

  it("rejects a response from the wrong file generation", async () => {
    FakeWorker.holdApplyResponses = true;
    const notebook = createNotebook();
    const service = new InkWorkerService(vi.fn());
    const session = service.createSession(() => ({ notebook, revision: 1 }));
    await session.initializeRaw(JSON.stringify(notebook), 0);
    const worker = FakeWorker.instances[0];
    const applying = session.apply(1, { type: "set-page", pageId: notebook.pages[0].id, title: "stale",
      pageUpdatedAt: 2, notebookUpdatedAt: 2 });
    await vi.waitFor(() => expect(worker.requests.some((candidate) => candidate.type === "apply-operation")).toBe(true));
    const request = worker.requests.find((candidate) => candidate.type === "apply-operation")!;
    worker.emit({ type: "operation-applied", requestId: request.requestId, sessionId: request.sessionId,
      generation: request.generation + 1, notebookRevision: 1, revision: 1 });
    await expect(applying).rejects.toMatchObject({ code: "stale-response" });
    service.dispose();
  });
});
