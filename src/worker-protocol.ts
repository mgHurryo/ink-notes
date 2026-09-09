import type { InkNotebook, InkPage, InkStroke, PaperStyle } from "./model";

export type NotebookOperation =
  | {
    type: "finalize-stroke";
    pageId: string;
    stroke: InkStroke;
    pageUpdatedAt: number;
    notebookUpdatedAt: number;
  }
  | {
    type: "patch-strokes";
    pageId: string;
    upsert: InkStroke[];
    remove: string[];
    deletedStrokeIds: string[];
    pageUpdatedAt: number;
    notebookUpdatedAt: number;
  }
  | {
    type: "set-page";
    pageId: string;
    title?: string;
    paper?: PaperStyle;
    pageUpdatedAt: number;
    notebookUpdatedAt: number;
  }
  | { type: "replace-notebook"; notebook: InkNotebook };

interface RequestBase {
  requestId: number;
  sessionId: string;
  generation: number;
}

export type InkWorkerRequest =
  | RequestBase & { type: "initialize-raw"; raw: string; revision: number }
  | RequestBase & { type: "initialize-notebook"; notebook: InkNotebook; revision: number }
  | RequestBase & { type: "apply-operation"; operation: NotebookOperation; revision: number }
  | RequestBase & { type: "barrier"; minimumRevision: number }
  | RequestBase & { type: "prepare-save"; raw: string; minimumRevision: number }
  | RequestBase & { type: "commit-save"; token: string }
  | RequestBase & { type: "abort-save"; token: string }
  | RequestBase & { type: "merge-external"; raw: string }
  | RequestBase & { type: "dispose-session" };

interface ResponseBase {
  requestId: number;
  sessionId: string;
  generation: number;
}

export type InkWorkerResponse =
  | { type: "ready"; requestId: 0; sessionId: ""; generation: 0; capabilities: WorkerCapabilities }
  | ResponseBase & { type: "initialized"; notebook: InkNotebook; revision: number }
  | ResponseBase & { type: "operation-applied"; revision: number }
  | ResponseBase & { type: "barrier-complete"; revision: number }
  | ResponseBase & { type: "save-prepared"; token: string; content: string; revision: number }
  | ResponseBase & { type: "save-committed"; revision: number; merged?: InkNotebook }
  | ResponseBase & { type: "save-aborted" }
  | ResponseBase & { type: "external-merged"; notebook?: InkNotebook; revision: number }
  | ResponseBase & { type: "session-disposed" }
  | ResponseBase & { type: "error"; code: WorkerErrorCode; message: string };

export interface WorkerCapabilities {
  offscreenCanvas: boolean;
  imageBitmap: boolean;
}

export type WorkerErrorCode = "invalid-format" | "stale-generation" | "revision-gap" | "missing-session" | "internal";

export interface WorkerReply {
  response: InkWorkerResponse;
  transfer?: Transferable[];
}

export function serializeNotebook(notebook: InkNotebook): string {
  return `${JSON.stringify(notebook, null, 2)}\n`;
}

export function cloneStrokeValue(stroke: InkStroke): InkStroke {
  return { ...stroke, points: stroke.points.map((point) => ({ ...point })) };
}

export function clonePageValue(page: InkPage): InkPage {
  return { ...page, strokes: page.strokes.map(cloneStrokeValue), deletedStrokeIds: [...page.deletedStrokeIds] };
}
