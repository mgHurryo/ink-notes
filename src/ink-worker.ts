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
          generation: queued.generation, code: "stale-generation", message: "Queued tile belongs to an obsolete render generation" });
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
  void core.handle(request).then(({ response, transfer }) => scope.postMessage(response, transfer ?? []))
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
