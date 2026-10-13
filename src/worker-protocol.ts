import type { InkImage, InkNotebook, InkPage, InkPoint, InkStroke, PaperStyle } from "./model";
import { cloneSticky } from "./sticky-model";
import type { StickyNote } from "./sticky-model";
import { serializeStoredJson } from "./storage-codec";

// Six doubles per sample keeps the hot path structured-clone free without
// dropping Pencil metadata. The layout is x, y, pressure, tiltX, tiltY,
// timestamp; NaN represents an unavailable optional tilt value.
export type PackedStrokePoints = Float64Array;

export type NotebookOperation =
  | { type: "patch-sticky-notes"; pageId: string; upsert: StickyNote[]; remove: string[]; deletedStickyNotes: Record<string, number>;
      pageUpdatedAt: number; notebookUpdatedAt: number }
  | { type: "patch-images"; pageId: string; upsert: InkImage[]; remove: string[]; deletedImageIds: string[];
      pageUpdatedAt: number; notebookUpdatedAt: number }
  | {
    type: "start-stroke";
    pageId: string;
    stroke: InkStroke;
    previewWidth?: number;
    previewHeight?: number;
    pageUpdatedAt: number;
    notebookUpdatedAt: number;
  }
  | {
    type: "append-stroke-points";
    pageId: string;
    strokeId: string;
    points: PackedStrokePoints;
    previewWidth?: number;
    previewHeight?: number;
    pageUpdatedAt: number;
    notebookUpdatedAt: number;
  }
  | {
    type: "complete-stroke";
    pageId: string;
    strokeId: string;
    pageUpdatedAt: number;
    notebookUpdatedAt: number;
  }
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
    type: "translate-strokes";
    pageId: string;
    strokeIds: string[];
    dx: number;
    dy: number;
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
  | {
    type: "page-operation";
    action: "add" | "duplicate" | "delete" | "reorder" | "restore";
    page?: InkPage;
    pageId?: string;
    deletedAt?: number;
    pageOrder: string[];
    pageOrderUpdatedAt: number;
    notebookUpdatedAt: number;
  }
  | { type: "history-restore"; notebook: InkNotebook }
  | { type: "replace-notebook"; notebook: InkNotebook };

interface RequestBase {
  requestId: number;
  sessionId: string;
  generation: number;
  // File-generation checks protect the session identity; notebookRevision
  // protects the state within that file for every request, including control
  // messages that do not otherwise carry an operation or tile revision.
  notebookRevision: number;
}

export type InkWorkerRequest =
  | RequestBase & { type: "initialize-raw"; raw: string; revision: number }
  | RequestBase & { type: "initialize-notebook"; notebook: InkNotebook; revision: number }
  | RequestBase & { type: "apply-operation"; operation: NotebookOperation; revision: number }
  | RequestBase & { type: "barrier"; minimumRevision: number }
  | RequestBase & { type: "prepare-save"; raw: string; minimumRevision: number }
  | RequestBase & { type: "serialize-storage"; value: unknown }
  | RequestBase & {
    type: "render-tile";
    pageId: string;
    cell: string;
    density: number;
    revision: number;
    renderGeneration: number;
    priority: "visible" | "prewarm";
    width: number;
    height: number;
  }
  | RequestBase & { type: "cancel-render-generation"; renderGeneration: number }
  | RequestBase & { type: "commit-save"; token: string }
  | RequestBase & { type: "abort-save"; token: string }
  | RequestBase & { type: "merge-external"; raw: string }
  | RequestBase & { type: "dispose-session" };

interface ResponseBase {
  requestId: number;
  sessionId: string;
  generation: number;
  notebookRevision: number;
}

export type InkWorkerResponse =
  | { type: "ready"; requestId: 0; sessionId: ""; generation: 0; notebookRevision: 0; capabilities: WorkerCapabilities }
  | ResponseBase & { type: "initialized"; notebook: InkNotebook; revision: number }
  | ResponseBase & {
    type: "operation-applied";
    revision: number;
    strokeId?: string;
    sampleCount?: number;
    outline?: Float32Array;
    outlineMode?: "pen" | "highlighter";
  }
  | ResponseBase & { type: "barrier-complete"; revision: number }
  | ResponseBase & { type: "save-prepared"; token: string; content: string; revision: number }
  | ResponseBase & { type: "storage-serialized"; content: string }
  | ResponseBase & {
    type: "tile-rendered";
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
    renderGeneration: number;
    bitmap: ImageBitmap;
  }
  | ResponseBase & { type: "save-committed"; revision: number; merged?: InkNotebook }
  | ResponseBase & { type: "save-aborted" }
  | ResponseBase & { type: "external-merged"; notebook?: InkNotebook; revision: number }
  | ResponseBase & { type: "session-disposed" }
  | ResponseBase & { type: "renders-cancelled"; renderGeneration: number }
  | ResponseBase & { type: "error"; code: WorkerErrorCode; message: string };

export interface WorkerCapabilities {
  offscreenCanvas: boolean;
  imageBitmap: boolean;
  transferable?: boolean;
}

export type WorkerErrorCode = "invalid-format" | "stale-generation" | "revision-gap" | "missing-session" | "internal";

export interface WorkerReply {
  response: InkWorkerResponse;
  transfer?: Transferable[];
}

export function serializeNotebook(notebook: InkNotebook): string {
  return serializeStoredJson(notebook);
}

export function cloneStrokeValue(stroke: InkStroke): InkStroke {
  return { ...stroke, points: stroke.points.map((point) => ({ ...point })) };
}

export function clonePageValue(page: InkPage): InkPage {
  return { ...page, stickyNotes: page.stickyNotes?.map(cloneSticky), deletedStickyNotes: { ...page.deletedStickyNotes }, images: page.images?.map((image) => ({ ...image })), deletedImageIds: [...(page.deletedImageIds ?? [])], strokes: page.strokes.map(cloneStrokeValue), deletedStrokeIds: [...page.deletedStrokeIds] };
}
