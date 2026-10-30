import { InkView } from "../src/view";
import { createInkEmbedProcessor } from "../src/embed";
import { createNotebook, normalizeNotebook } from "../src/model";
import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";
import type { InkStroke } from "../src/model";
import type { NotebookStore } from "../src/storage";
import { InkWorkerService } from "../src/worker-service";
import { drawInkStroke } from "../src/rendering";
import { TFile } from "obsidian";
import { NotebookSuggestModal } from "../src/notebook-modal";
import { discoverNotebooks } from "../src/storage";
import type { WorkspaceLeaf } from "obsidian";
import { ImageLibraryStore } from "../src/image-library";
import { imageVaultApp } from "./image-vault";
import { StickySearchModal } from "../src/sticky-index";
import { exportNotebookPdf, exportHandwrittenPdf } from "../src/pdf-export";
import { createSidecar } from "../src/pdf-sidecar";
import { PDFDocument, degrees } from "pdf-lib";
import { openPdfPreview } from "./pdf-preview";

type RendererComparisonMode = "pen" | "highlighter" | "stroke-eraser" | "circle-eraser" | "square-eraser" | "lasso";

const notebook = createNotebook("Ink Notebook");
const page = notebook.pages[0];
const previewStroke = {
  id: "preview-ink", pageId: page.id, tool: "pen", color: "#195bff", width: 4, opacity: 1,
  points: Array.from({ length: 36 }, (_, index) => ({
    x: 0.18 + index * 0.017, y: 0.35 + Math.sin(index / 4) * 0.045,
    pressure: 0.35 + index / 100, t: index + 1,
  })),
  createdAt: 1, updatedAt: 1,
} satisfies InkStroke;
if (new URLSearchParams(location.search).has("performance")) {
  page.strokes = Array.from({ length: 1001 }, (_, strokeIndex) => ({
    ...previewStroke,
    id: `performance-${strokeIndex}`,
    color: strokeIndex % 3 === 0 ? "#195bff" : "#171717",
    points: Array.from({ length: 80 }, (_, pointIndex) => ({
      x: 0.02 + (strokeIndex % 20) * 0.047 + pointIndex / 80 * 0.035,
      y: 0.02 + Math.floor(strokeIndex / 20) * 0.018 + Math.sin(pointIndex / 8) * 0.002,
      pressure: 0.35 + pointIndex / 200,
      t: pointIndex + 1,
    })),
  }));
} else {
  page.strokes.push(previewStroke);
}
let diskRaw = JSON.stringify(notebook);
const store = {
  read: async () => normalizeNotebook(parseStoredJson(diskRaw)),
  readRaw: async () => diskRaw,
  writeIfUnchanged: async (_file: unknown, expected: string, next: string) => {
    if (expected !== diskRaw) return false;
    diskRaw = next;
    return true;
  },
  save: async (_file: unknown, value: unknown) => value,
};
const workers = new InkWorkerService((message) => console.warn(message));
// Preview-only probes exercise the same disk codec used by both editors.
(window as any).__inkNotesStorage = { encode: serializeStoredJson, decode: parseStoredJson };
const view = new InkView({} as WorkspaceLeaf, store as unknown as NotebookStore, workers);
view.useImageLibrary(new ImageLibraryStore(imageVaultApp()));
void (async () => {
  await view.setState({ readingMode: false }, { history: false });
  await view.onOpen();
  view.file = Object.assign(new TFile(), { path: "Ink Notes/Preview.ink", basename: "Preview", extension: "ink" });
  await view.onLoadFile(view.file);
  const compareRenderer = async (mode: RendererComparisonMode = "pen") => {
    const internal = view as unknown as { workerSession: { renderTile(...args: unknown[]): Promise<any>;
      apply(revision: number, operation: unknown): Promise<unknown> } | null; workerRevision: number;
      notebook: typeof notebook; canvasLogicalWidth: number; canvasLogicalHeight: number };
    if (!internal.workerSession) throw new Error("Worker tile backend is unavailable");
    const width = internal.canvasLogicalWidth, height = internal.canvasLogicalHeight;
    const now = Date.now();
    const pageId = `renderer-${mode}-${internal.workerRevision}`;
    const target: InkStroke = {
      id: `${pageId}-target`, pageId, tool: mode === "highlighter" ? "highlighter" : "pen",
      color: mode === "highlighter" ? "#f5c400" : "#195bff", width: mode === "highlighter" ? 18 : 7,
      opacity: mode === "highlighter" ? 0.45 : 0.72,
      points: Array.from({ length: 42 }, (_, index) => ({
        x: 0.08 + index * 0.012, y: 0.12 + Math.sin(index / 5) * 0.025,
        pressure: index === 18 ? 0.18 : 0.35 + index / 100, t: now + index,
      })),
      createdAt: now, updatedAt: now,
    };
    const keeper: InkStroke = {
      ...target, id: `${pageId}-keeper`, color: "#ef4444", width: 4, opacity: 0.8,
      points: target.points.map((point) => ({ ...point, y: point.y + 0.11 })), createdAt: now + 1, updatedAt: now + 1,
    };
    const comparisonPage = {
      id: pageId, title: mode, paper: "blank" as const, strokes: [target, keeper], deletedStrokeIds: [],
      createdAt: now, updatedAt: now,
    };
    internal.notebook.pages.push(comparisonPage);
    internal.notebook.pageOrder.push(pageId);
    internal.notebook.pageOrderUpdatedAt = now;
    internal.notebook.updatedAt = now;
    await internal.workerSession.apply(++internal.workerRevision, {
      type: "page-operation", action: "add", page: comparisonPage,
      pageOrder: [...internal.notebook.pageOrder], pageOrderUpdatedAt: now, notebookUpdatedAt: now,
    });

    if (mode.endsWith("eraser")) {
      const remove = [target.id];
      let replacements: InkStroke[] = [];
      if (mode !== "stroke-eraser") {
        const cutStart = mode === "circle-eraser" ? 14 : 10;
        const cutEnd = mode === "circle-eraser" ? 27 : 31;
        replacements = [target.points.slice(0, cutStart), target.points.slice(cutEnd)].map((points, index) => ({
          ...target, id: `${target.id}-${mode}-${index}`, points: points.map((point) => ({ ...point })),
          createdAt: now + 2 + index, updatedAt: now + 2 + index,
        }));
      }
      comparisonPage.strokes = [keeper, ...replacements];
      comparisonPage.deletedStrokeIds.push(target.id);
      comparisonPage.updatedAt = now + 4;
      internal.notebook.updatedAt = now + 4;
      await internal.workerSession.apply(++internal.workerRevision, {
        type: "patch-strokes", pageId, upsert: replacements, remove,
        deletedStrokeIds: [...comparisonPage.deletedStrokeIds], pageUpdatedAt: comparisonPage.updatedAt,
        notebookUpdatedAt: internal.notebook.updatedAt,
      });
    } else if (mode === "lasso") {
      const dx = 0.09, dy = 0.07;
      target.points = target.points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
      target.updatedAt = now + 5;
      comparisonPage.updatedAt = now + 5;
      internal.notebook.updatedAt = now + 5;
      await internal.workerSession.apply(++internal.workerRevision, {
        type: "translate-strokes", pageId, strokeIds: [target.id], dx, dy,
        pageUpdatedAt: comparisonPage.updatedAt, notebookUpdatedAt: internal.notebook.updatedAt,
      });
    }

    let compared = 0, different = 0, inkPixels = 0, expectedInkPixels = 0;
    let totalPixels = 0;
    const columns = Math.min(5, Math.ceil(width / 128));
    const rows = Math.min(3, Math.ceil(height / 128));
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const cell = `${column}:${row}`;
      const result = await internal.workerSession.renderTile(pageId, cell, 3, 0, width, height, 10_000 + internal.workerRevision, "visible");
      const workerCanvas = document.createElement("canvas");
      workerCanvas.width = result.canvasWidth; workerCanvas.height = result.canvasHeight;
      workerCanvas.getContext("2d")!.drawImage(result.bitmap, 0, 0);
      result.bitmap.close();
      const expected = document.createElement("canvas");
      expected.width = result.canvasWidth; expected.height = result.canvasHeight;
      const expectedContext = expected.getContext("2d")!;
      const bleedPixels = Math.ceil(4 * result.density);
      expectedContext.setTransform(result.density, 0, 0, result.density,
        bleedPixels - result.x * result.density, bleedPixels - result.y * result.density);
      for (const stroke of comparisonPage.strokes) drawInkStroke(expectedContext, stroke, width, height);
      const actual = workerCanvas.getContext("2d")!.getImageData(0, 0, workerCanvas.width, workerCanvas.height).data;
      const baseline = expectedContext.getImageData(0, 0, expected.width, expected.height).data;
      totalPixels += actual.length / 4;
      for (let index = 0; index < actual.length; index += 4) {
        if (actual[index + 3] === 0 && baseline[index + 3] === 0) continue;
        inkPixels += actual[index + 3] > 0 ? 1 : 0;
        expectedInkPixels += baseline[index + 3] > 0 ? 1 : 0;
        compared++;
        if (Math.abs(actual[index] - baseline[index]) > 8 || Math.abs(actual[index + 1] - baseline[index + 1]) > 8
          || Math.abs(actual[index + 2] - baseline[index + 2]) > 8 || Math.abs(actual[index + 3] - baseline[index + 3]) > 8) different++;
      }
    }
    return { compared, different, inkPixels, expectedInkPixels, totalPixels };
  };
  (globalThis as typeof globalThis & { __inkNotesPreview?: { view: InkView; compareRenderer(mode?: RendererComparisonMode): Promise<{
    compared: number; different: number; inkPixels: number; expectedInkPixels: number; totalPixels: number }>;
    findStickies(): void; exportStickies(rotation?: 0 | 90 | 180 | 270): Promise<{ bytes: number; images: number }> } })
    .__inkNotesPreview = { view, compareRenderer, findStickies: () => new StickySearchModal((view as any).imageLibrary.app,
      (entry) => view.revealSticky(entry.pageId, entry.note.id), () => ({ files: ["Ink Notes/Preview.ink"], entries: view.stickyIndexEntries() })).open(),
      exportStickies: async (rotation) => {
        const active = (window as any).__inkNotesPreview.view;
        const book = active.currentNotebook();
        let bytes: Uint8Array;
        if (rotation !== undefined) {
          const source = await PDFDocument.create(); source.addPage([600, 800]).setRotation(degrees(rotation));
          const sidecar = createSidecar("Sample.pdf", { sha256: "a".repeat(64), byteLength: 2 }, [{ width: 600, height: 800, rotation }]);
          sidecar.notebook.pages[0].stickyNotes = structuredClone(book.pages[0].stickyNotes);
          bytes = await exportHandwrittenPdf((await source.save()).buffer as ArrayBuffer, sidecar, "Sample", undefined, undefined, { app: active.app, source: "Preview.ink" });
        } else bytes = await exportNotebookPdf(book, "Sticky export", undefined, undefined, { app: active.app, source: "Preview.ink" });
        const pdf = await PDFDocument.load(bytes), resources = pdf.getPage(0).node.Resources();
        const images = resources?.lookupMaybe((await import("pdf-lib")).PDFName.of("XObject"), (await import("pdf-lib")).PDFDict)?.keys().length ?? 0;
        return { bytes: bytes.length, images };
      } };
  document.documentElement.dataset.inkReady = "true";
  (window as any).__inkNotesPreview.openPdf = async () => {
    await view.onClose();
    for (const cleanup of (view as any).cleanups.splice(0)) cleanup();
    view.contentEl.className = "";
    const pdf = await openPdfPreview();
    (window as any).__inkNotesPreview.view = pdf;
  };
  if (new URLSearchParams(location.search).has("notebooks")) {
    const params = new URLSearchParams(location.search);
    const files = params.has("empty") ? [] : ["Class notes", "Sketchbook"].map((name) =>
      Object.assign(new TFile(), { path: `Ink Notes/${name}.ink`, basename: name, extension: "ink" }));
    const history = params.has("missing") ? [{ path: "Archive/Old notes.ink", title: "Old notes", lastOpened: 1 }] : [];
    const entries = discoverNotebooks(files, history);
    const openPicker = () => new NotebookSuggestModal({} as never, entries,
      (file) => { document.documentElement.dataset.openedNotebook = file.path; },
      async (title, folder) => {
        const created = Object.assign(new TFile(), { path: `${folder || "Ink Notes"}/${title}.ink`, basename: title, extension: "ink" });
        files.push(created);
        entries.push({ path: created.path, title, file: created });
        document.documentElement.dataset.openedNotebook = created.path;
      }, async (file, title) => {
        file.basename = title;
        file.path = `${file.path.slice(0, file.path.lastIndexOf("/") + 1)}${title}.ink`;
        const entry = entries.find((candidate) => candidate.file === file);
        if (entry) { entry.path = file.path; entry.title = title; }
      }, async (cleared) => {
        for (const entry of cleared) {
          const index = entries.indexOf(entry);
          if (index >= 0) entries.splice(index, 1);
        }
      }).open();
    (window as unknown as { openNotebookPicker(): void }).openNotebookPicker = openPicker;
    openPicker();
  }
})();

// Keep a real Markdown processor fixture in the browser preview. It is placed
// offscreen so editor screenshots stay focused on the writing surface, while
// browser tests can still verify the read-only embed rendering path.
const embedFile = Object.assign(new TFile(), { path: "Ink Notes/Preview.ink", extension: "ink" });
const embedHost = document.createElement("div");
embedHost.className = "preview-embed-fixture";
embedHost.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:320px";
document.body.append(embedHost);
const embedApp = {
  vault: {
    getAbstractFileByPath: () => embedFile,
    cachedRead: async () => serializeStoredJson(notebook),
    on: () => ({}),
  },
};
createInkEmbedProcessor(embedApp as never, async () => {})(
  `Ink Notes/Preview.ink\npage: ${page.id}`,
  embedHost,
  { addChild: (child: { onload(): void }) => child.onload() } as never,
);
