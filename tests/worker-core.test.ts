import { describe, expect, it } from "vitest";
import { createNotebook } from "../src/model";
import { InkWorkerCore } from "../src/worker-core";
import type { InkWorkerRequest, InkWorkerResponse } from "../src/worker-protocol";

function request<T extends Omit<InkWorkerRequest, "requestId" | "sessionId" | "generation">>(
  value: T,
  requestId = 1,
): InkWorkerRequest {
  return { ...value, requestId, sessionId: "test", generation: 1 } as InkWorkerRequest;
}

async function response(core: InkWorkerCore, value: InkWorkerRequest): Promise<InkWorkerResponse> {
  return (await core.handle(value)).response;
}

describe("InkWorkerCore persistence mirror", () => {
  it("applies ordered operations and prepares a revision snapshot", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook("Worker");
    const page = notebook.pages[0];
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    const stroke = {
      id: "stroke-1", pageId: page.id, tool: "pen" as const, color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.2, y: 0.3, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    };
    expect(await response(core, request({ type: "apply-operation", revision: 1, operation: {
      type: "finalize-stroke", pageId: page.id, stroke, pageUpdatedAt: 2, notebookUpdatedAt: 2,
    } }, 2))).toMatchObject({ type: "operation-applied", revision: 1 });
    const prepared = await response(core, request({
      type: "prepare-save", raw: JSON.stringify(notebook), minimumRevision: 1,
    }, 3));
    expect(prepared).toMatchObject({ type: "save-prepared", revision: 1 });
    if (prepared.type !== "save-prepared") throw new Error("save was not prepared");
    expect(JSON.parse(prepared.content).pages[0].strokes[0].id).toBe("stroke-1");
  });

  it("rejects damaged disk JSON without preparing a write", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    expect(await response(core, request({ type: "prepare-save", raw: "{ damaged", minimumRevision: 0 }, 2)))
      .toMatchObject({ type: "error", code: "invalid-format" });
  });

  it("rejects revision gaps and stale generations", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    expect(await response(core, request({ type: "apply-operation", revision: 2, operation: {
      type: "replace-notebook", notebook,
    } }, 2))).toMatchObject({ type: "error", code: "revision-gap" });
    const stale = { ...request({ type: "barrier", minimumRevision: 0 }, 3), generation: 2 } as InkWorkerRequest;
    expect(await response(core, stale)).toMatchObject({ type: "error", code: "stale-generation" });
  });
});
