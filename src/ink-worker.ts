import { InkWorkerCore } from "./worker-core";
import type { InkWorkerRequest } from "./worker-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<InkWorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
const core = new InkWorkerCore({
  offscreenCanvas: typeof OffscreenCanvas !== "undefined",
  imageBitmap: typeof ImageBitmap !== "undefined",
  transferable: supportsTransferableBuffers(),
});

const queue: InkWorkerRequest[] = [];
let running = false;

scope.onmessage = (event: MessageEvent<InkWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel-render-generation") {
    for (let index = queue.length - 1; index >= 0; index--) {
      const queued = queue[index];
      if (queued.type === "render-tile" && queued.sessionId === request.sessionId
        && queued.generation === request.generation && queued.renderGeneration < request.renderGeneration) {
        queue.splice(index, 1);
        scope.postMessage({ type: "error", requestId: queued.requestId, sessionId: queued.sessionId,
          generation: queued.generation, notebookRevision: queued.notebookRevision,
          code: "stale-generation", message: "Queued tile belongs to an obsolete render generation" });
      }
    }
  }
  queue.push(request);
  drain();
};

function drain(): void {
  if (running || queue.length === 0) return;
  queue.sort((left, right) => workerPriority(left) - workerPriority(right));
  const request = queue.shift()!;
  running = true;
  // Receipt ack: the main thread's hang guards measure from this moment,
  // not from dispatch - this request may have waited in the serial queue
  // behind multi-second tile renders.
  scope.postMessage({ type: "processing", requestId: request.requestId, sessionId: request.sessionId,
    generation: request.generation, notebookRevision: request.notebookRevision });
  void core.handle(request)
    .then(({ response, transfer }) => scope.postMessage(response, transfer ?? []))
    .catch((error) => {
      // A failed response postMessage (bad transfer, detached buffer) must
      // still answer the caller: a silently lost response hangs the main
      // thread until its hang guard kills a perfectly healthy worker.
      try {
        scope.postMessage({ type: "error", requestId: request.requestId, sessionId: request.sessionId,
          generation: request.generation, notebookRevision: request.notebookRevision,
          code: "internal", message: error instanceof Error ? error.message : String(error) });
      } catch { /* the channel itself is gone; the main-thread guard owns it */ }
    })
    .finally(() => { running = false; drain(); });
}

function workerPriority(request: InkWorkerRequest): number {
  if (request.type === "cancel-render-generation" || request.type === "initialize-raw" || request.type === "initialize-notebook") return 0;
  if (request.type === "apply-operation") return 1;
  if (request.type === "render-tile") return request.priority === "visible" ? 2 : 3;
  return 4;
}

scope.postMessage(core.ready());

function supportsTransferableBuffers(): boolean {
  if (typeof MessageChannel === "undefined") return false;
  try {
    const channel = new MessageChannel();
    const buffer = new ArrayBuffer(1);
    channel.port1.postMessage(buffer, [buffer]);
    channel.port1.close();
    channel.port2.close();
    return buffer.byteLength === 0;
  } catch {
    return false;
  }
}
