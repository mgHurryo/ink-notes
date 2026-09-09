import { InkWorkerCore } from "./worker-core";
import type { InkWorkerRequest } from "./worker-protocol";

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<InkWorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
const core = new InkWorkerCore({
  offscreenCanvas: typeof OffscreenCanvas !== "undefined",
  imageBitmap: typeof ImageBitmap !== "undefined",
});

scope.onmessage = (event: MessageEvent<InkWorkerRequest>) => {
  void core.handle(event.data).then(({ response, transfer }) => scope.postMessage(response, transfer ?? []));
};
scope.postMessage(core.ready());
