import { describe, expect, it, vi } from "vitest";
import { createNotebook, createPage } from "../src/model";
import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";
import { InkWorkerCore } from "../src/worker-core";
import type { InkWorkerRequest, InkWorkerResponse } from "../src/worker-protocol";
import { penOutlineRings } from "../src/rendering";

type RequestInput = InkWorkerRequest extends infer Request
  ? Request extends InkWorkerRequest ? Omit<Request, "requestId" | "sessionId" | "generation" | "notebookRevision"> : never
  : never;

function request<T extends RequestInput>(
  value: T,
  requestId = 1,
  notebookRevision = "revision" in value && typeof value.revision === "number"
    ? value.revision
    : "minimumRevision" in value && typeof value.minimumRevision === "number" ? value.minimumRevision : 0,
): InkWorkerRequest {
  return { ...value, requestId, sessionId: "test", generation: 1, notebookRevision } as InkWorkerRequest;
}

async function response(core: InkWorkerCore, value: InkWorkerRequest): Promise<InkWorkerResponse> {
  return (await core.handle(value)).response;
}

describe("InkWorkerCore persistence mirror", () => {
  it("loads compressed disk state, preserves samples and serializes a sidecar snapshot without changing the mirror",async()=>{
    const core=new InkWorkerCore({offscreenCanvas:false,imageBitmap:false}), book=createNotebook(), p=book.pages[0];
    p.strokes=[{id:"compressed",pageId:p.id,tool:"pen",color:"#000",width:3,opacity:1,createdAt:1,updatedAt:2,
      points:Array.from({length:500},(_,i)=>({x:i/1000,y:.3,pressure:.7,t:i+1,tiltX:12,tiltY:-6}))}];
    const raw=serializeStoredJson(book); expect(raw).toContain("INK-GZIP-1");
    const initialized=await response(core,request({type:"initialize-raw",raw,revision:0}));
    expect(initialized).toMatchObject({type:"initialized",notebook:{pages:[{strokes:[{points:p.strokes[0].points}]}]}});
    const serialized=await response(core,request({type:"serialize-storage",value:{notebook:book,format:1}},2));
    if(serialized.type!=="storage-serialized")throw new Error("snapshot not serialized");
    expect(parseStoredJson(serialized.content)).toEqual({notebook:book,format:1});
    expect(await response(core,{...request({type:"serialize-storage",value:book},3),generation:2}))
      .toMatchObject({type:"error",code:"stale-generation"});
    const saved=await response(core,request({type:"prepare-save",raw,minimumRevision:0},4));
    if(saved.type!=="save-prepared")throw new Error("save not prepared");
    expect(parseStoredJson(saved.content).pages[0].strokes[0].points).toEqual(p.strokes[0].points);
    expect(await response(core,request({type:"prepare-save",raw:"INK-GZIP-1\nAAAA",minimumRevision:0},5)))
      .toMatchObject({type:"error",code:"invalid-format"});
  });
  it("applies ordered operations and prepares a revision snapshot", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook("Worker");
    const page = notebook.pages[0];
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    const stroke = {
      id: "stroke-1", pageId: page.id, tool: "pen" as const, color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.2, y: 0.3, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    };
    const finalized = await response(core, request({ type: "apply-operation", revision: 1, operation: {
      type: "finalize-stroke", pageId: page.id, stroke, pageUpdatedAt: 2, notebookUpdatedAt: 2,
    } }, 2));
    expect(finalized).toMatchObject({ type: "operation-applied", revision: 1, strokeId: "stroke-1", sampleCount: 1 });
    expect(finalized.type === "operation-applied" && finalized.outline?.length).toBeGreaterThan(0);
    const prepared = await response(core, request({
      type: "prepare-save", raw: JSON.stringify(notebook), minimumRevision: 1,
    }, 3));
    expect(prepared).toMatchObject({ type: "save-prepared", revision: 1 });
    if (prepared.type !== "save-prepared") throw new Error("save was not prepared");
    expect(parseStoredJson(prepared.content).pages[0].strokes[0].id).toBe("stroke-1");
  });

  it("rejects damaged disk JSON without preparing a write", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    expect(await response(core, request({ type: "prepare-save", raw: "{ damaged", minimumRevision: 0 }, 2)))
      .toMatchObject({ type: "error", code: "invalid-format" });
  });

  it("omits equivalent self-save state but returns a real external merge", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    const prepared = await response(core, request({
      type: "prepare-save", raw: JSON.stringify(notebook), minimumRevision: 0,
    }, 2));
    if (prepared.type !== "save-prepared") throw new Error("save was not prepared");
    expect(await response(core, request({ type: "commit-save", token: prepared.token }, 3, 0)))
      .toMatchObject({ type: "save-committed", revision: 0, merged: undefined, notebookRevision: 0 });

    const external = structuredClone(notebook);
    external.pages[0].title = "External title";
    external.pages[0].updatedAt += 10;
    external.updatedAt += 10;
    expect(await response(core, request({ type: "merge-external", raw: JSON.stringify(external) }, 4, 0)))
      .toMatchObject({ type: "external-merged", notebook: { pages: [{ title: "External title" }] }, notebookRevision: 0 });
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
    expect(await response(core, request({ type: "apply-operation", revision: 1, operation: {
      type: "replace-notebook", notebook,
    } }, 4, 0))).toMatchObject({ type: "error", code: "revision-gap", notebookRevision: 0 });
  });

  it("acknowledges render-generation cancellation without changing the notebook revision", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false, transferable: true });
    const notebook = createNotebook();
    await response(core, request({ type: "initialize-notebook", notebook, revision: 4 }));
    expect(await response(core, request({ type: "cancel-render-generation", renderGeneration: 8 }, 2, 4)))
      .toMatchObject({ type: "renders-cancelled", renderGeneration: 8, generation: 1, notebookRevision: 4 });
    expect(await response(core, request({ type: "barrier", minimumRevision: 4 }, 3)))
      .toMatchObject({ type: "barrier-complete", revision: 4 });
  });

  it("keeps incremental stroke points in the worker mirror", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    const page = notebook.pages[0];
    const stroke = {
      id: "incremental", pageId: page.id, tool: "pen" as const, color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.1, y: 0.1, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    };
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    await response(core, request({ type: "apply-operation", revision: 1, operation: {
      type: "start-stroke", pageId: page.id, stroke, pageUpdatedAt: 1, notebookUpdatedAt: 1,
    } }, 2));
    const appended = await response(core, request({ type: "apply-operation", revision: 2, operation: {
      type: "append-stroke-points", pageId: page.id, strokeId: stroke.id,
      points: new Float64Array([0.2, 0.2, 0.6, 12, -8, 2]), pageUpdatedAt: 2, notebookUpdatedAt: 2,
    } }, 3));
    expect(appended).toMatchObject({ type: "operation-applied", strokeId: "incremental", sampleCount: 2 });
    const prepared = await response(core, request({ type: "prepare-save", raw: JSON.stringify(notebook), minimumRevision: 2 }, 4));
    expect(prepared).toMatchObject({ type: "save-prepared", revision: 2 });
    if (prepared.type !== "save-prepared") throw new Error("save was not prepared");
    const points = parseStoredJson(prepared.content).pages[0].strokes[0].points;
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({ tiltX: 12, tiltY: -8, t: 2 });
  });

  it("calculates normalized live outlines at the displayed canvas size", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    const page = notebook.pages[0];
    const stroke = {
      id: "display-sized", pageId: page.id, tool: "pen" as const, color: "#000", width: 6, opacity: 1,
      points: [
        { x: 0.2, y: 0.2, pressure: 0.5, t: 1 },
        { x: 0.7, y: 0.7, pressure: 0.5, t: 2 },
      ], createdAt: 1, updatedAt: 2,
    };
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    const applied = await response(core, request({ type: "apply-operation", revision: 1, operation: {
      type: "start-stroke", pageId: page.id, stroke, previewWidth: 400, previewHeight: 600,
      pageUpdatedAt: 2, notebookUpdatedAt: 2,
    } }, 2));
    if (applied.type !== "operation-applied" || !applied.outline) throw new Error("outline was not returned");
    const expected = penOutlineRings(stroke, 400, 600)
      .flatMap((ring, ringIndex) => (ringIndex ? [[Number.NaN, Number.NaN], ...ring] : ring))
      .flatMap(([x, y]) => [x / 400, y / 600]);
    expect(applied.outline).toHaveLength(expected.length);
    expected.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      expect(applied.outline![index]).toBeCloseTo(value, 6);
    });
  });

  it("applies translation as one operation and persists the moved geometry", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    const page = notebook.pages[0];
    page.strokes.push({
      id: "move", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
      points: [{ x: 0.1, y: 0.2, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1,
    });
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    expect(await response(core, request({ type: "apply-operation", revision: 1, operation: {
      type: "translate-strokes", pageId: page.id, strokeIds: ["move"], dx: 0.25, dy: -0.1,
      pageUpdatedAt: 3, notebookUpdatedAt: 3,
    } }, 2))).toMatchObject({ type: "operation-applied", revision: 1 });
    const prepared = await response(core, request({ type: "prepare-save", raw: JSON.stringify(createNotebook()), minimumRevision: 1 }, 3));
    if (prepared.type !== "save-prepared") throw new Error("save was not prepared");
    const moved = parseStoredJson(prepared.content).pages.find((candidate: { id: string }) => candidate.id === page.id).strokes[0];
    expect(moved.points[0]).toMatchObject({ x: 0.35, y: 0.1 });
  });

  it("keeps page order, deletion tombstones, and history restoration consistent", async () => {
    const core = new InkWorkerCore({ offscreenCanvas: false, imageBitmap: false });
    const notebook = createNotebook();
    const first = notebook.pages[0];
    const second = createPage("Second", "grid", first.createdAt + 1);
    await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
    await response(core, request({ type: "apply-operation", revision: 1, operation: {
      type: "page-operation", action: "add", page: second, pageOrder: [first.id, second.id],
      pageOrderUpdatedAt: 2, notebookUpdatedAt: 2,
    } }, 2));
    await response(core, request({ type: "apply-operation", revision: 2, operation: {
      type: "page-operation", action: "reorder", pageOrder: [second.id, first.id],
      pageOrderUpdatedAt: 3, notebookUpdatedAt: 3,
    } }, 3));
    await response(core, request({ type: "apply-operation", revision: 3, operation: {
      type: "page-operation", action: "delete", pageId: first.id, deletedAt: 4,
      pageOrder: [second.id], pageOrderUpdatedAt: 4, notebookUpdatedAt: 4,
    } }, 4));
    // A stale restore using the tombstoned ID must not revive the page.
    await response(core, request({ type: "apply-operation", revision: 4, operation: {
      type: "page-operation", action: "restore", page: first, pageOrder: [second.id, first.id],
      pageOrderUpdatedAt: 5, notebookUpdatedAt: 5,
    } }, 5));
    const restored = createPage("Restored", "ruled", 6);
    const history = { ...notebook, pages: [second, restored], pageOrder: [second.id, restored.id],
      deletedPages: { [first.id]: 4 }, pageOrderUpdatedAt: 6, updatedAt: 6 };
    await response(core, request({ type: "apply-operation", revision: 5, operation: {
      type: "history-restore", notebook: history,
    } }, 6));
    const prepared = await response(core, request({ type: "prepare-save", raw: JSON.stringify(notebook), minimumRevision: 5 }, 7));
    if (prepared.type !== "save-prepared") throw new Error("save was not prepared");
    const saved = parseStoredJson(prepared.content);
    expect(saved.pageOrder).toEqual([second.id, restored.id]);
    expect(saved.pages.map((page: { id: string }) => page.id)).toEqual([second.id, restored.id]);
    expect(saved.deletedPages[first.id]).toBe(4);
  });

  it("queries thick strokes across scaled tile boundaries", async () => {
    const stroke = vi.fn();
    class FakeOffscreenCanvas {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
          quadraticCurveTo: vi.fn(), lineTo: vi.fn(), stroke, fill: vi.fn(), arc: vi.fn(), closePath: vi.fn() };
      }
      transferToImageBitmap() { return { close: vi.fn() } as unknown as ImageBitmap; }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    try {
      const core = new InkWorkerCore({ offscreenCanvas: true, imageBitmap: true });
      const notebook = createNotebook();
      const page = notebook.pages[0];
      page.strokes.push({
        id: "wide", pageId: page.id, tool: "highlighter", color: "#ff0", width: 24, opacity: 0.5,
        points: [{ x: 0.43, y: 0.1, pressure: 0.5, t: 1 }, { x: 0.43, y: 0.2, pressure: 0.5, t: 2 }],
        createdAt: 1, updatedAt: 1,
      });
      await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
      expect(await response(core, request({ type: "render-tile", pageId: page.id, cell: "0:0", density: 2,
        revision: 1, renderGeneration: 1, priority: "visible", width: 320, height: 440 }, 2, 0)))
        .toMatchObject({ type: "tile-rendered", cell: "0:0" });
      expect(stroke).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("queries padded tile membership directly at the indexed page dimensions", async () => {
    const fill = vi.fn();
    class FakeOffscreenCanvas {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
          quadraticCurveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill, arc: vi.fn(), closePath: vi.fn() };
      }
      transferToImageBitmap() { return { close: vi.fn() } as unknown as ImageBitmap; }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    try {
      const core = new InkWorkerCore({ offscreenCanvas: true, imageBitmap: true });
      const notebook = createNotebook();
      const page = notebook.pages[0];
      const x = 128 / notebook.pageWidth;
      page.strokes.push({
        id: "boundary", pageId: page.id, tool: "pen", color: "#ff0", width: 24, opacity: 0.5,
        points: [{ x, y: 0.1, pressure: 0.5, t: 1 }, { x, y: 0.2, pressure: 0.5, t: 2 }],
        createdAt: 1, updatedAt: 1,
      });
      await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
      for (const cell of ["0:1", "1:1"]) {
        expect(await response(core, request({ type: "render-tile", pageId: page.id, cell, density: 2,
          revision: 1, renderGeneration: 1, priority: "visible", width: notebook.pageWidth, height: notebook.pageHeight }, 2, 0)))
          .toMatchObject({ type: "tile-rendered", cell });
      }
      expect(fill).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps main-thread-excluded pending strokes out of worker tiles", async () => {
    const stroke = vi.fn(), fill = vi.fn();
    class FakeOffscreenCanvas {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { setTransform: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
          quadraticCurveTo: vi.fn(), lineTo: vi.fn(), stroke, fill, arc: vi.fn(), closePath: vi.fn() };
      }
      transferToImageBitmap() { return { close: vi.fn() } as unknown as ImageBitmap; }
    }
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
    try {
      const core = new InkWorkerCore({ offscreenCanvas: true, imageBitmap: true });
      const notebook = createNotebook();
      const page = notebook.pages[0];
      page.strokes.push({
        id: "pending", pageId: page.id, tool: "pen", color: "#000", width: 3, opacity: 1,
        points: [{ x: 0.05, y: 0.05, pressure: 0.5, t: 1 }, { x: 0.06, y: 0.06, pressure: 0.5, t: 2 }],
        createdAt: 1, updatedAt: 1,
      });
      await response(core, request({ type: "initialize-notebook", notebook, revision: 0 }));
      // Pen-up: the main thread still renders the stroke from its preview
      // overlay while the worker mirror already received the complete stroke.
      await response(core, request({ type: "apply-operation", revision: 1, operation: {
        type: "complete-stroke", pageId: page.id, strokeId: "pending", pageUpdatedAt: 2, notebookUpdatedAt: 2 } }, 2));
      const tile = (renderGeneration: number, excludedStrokeIds?: readonly string[]) => request({
        type: "render-tile", pageId: page.id, cell: "0:0", density: 1, revision: 1, renderGeneration,
        priority: "visible", width: notebook.pageWidth, height: notebook.pageHeight, excludedStrokeIds,
      }, renderGeneration + 2, 1);
      expect(await response(core, tile(1))).toMatchObject({ type: "tile-rendered", cell: "0:0" });
      expect(stroke.mock.calls.length + fill.mock.calls.length).toBeGreaterThan(0);

      stroke.mockClear();
      fill.mockClear();
      expect(await response(core, tile(2, ["pending"]))).toMatchObject({ type: "tile-rendered", cell: "0:0" });
      expect(stroke).not.toHaveBeenCalled();
      expect(fill).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
