import { InkView } from "../src/view";
import { createInkEmbedProcessor } from "../src/embed";
import { createNotebook } from "../src/model";
import type { InkStroke } from "../src/model";
import type { NotebookStore } from "../src/storage";
import { InkWorkerService } from "../src/worker-service";
import { drawInkStroke } from "../src/rendering";
import { TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

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
  read: async () => notebook,
  readRaw: async () => diskRaw,
  writeIfUnchanged: async (_file: unknown, expected: string, next: string) => {
    if (expected !== diskRaw) return false;
    diskRaw = next;
    return true;
  },
  save: async (_file: unknown, value: unknown) => value,
};
const workers = new InkWorkerService((message) => console.warn(message));
const view = new InkView({} as WorkspaceLeaf, store as unknown as NotebookStore, workers);
void (async () => {
  await view.onOpen();
  await view.onLoadFile({ path: "Ink Notes/Preview.ink", basename: "Preview" } as TFile);
  const compareRenderer = async (mode: "pen" | "highlighter" = "pen") => {
    const internal = view as unknown as { workerSession: { renderTile(...args: unknown[]): Promise<any>;
      apply(revision: number, operation: unknown): Promise<unknown> } | null; workerRevision: number;
      notebook: typeof notebook; canvasLogicalWidth: number; canvasLogicalHeight: number };
    if (!internal.workerSession) throw new Error("Worker tile backend is unavailable");
    const comparisonPage = internal.notebook.pages[0];
    let comparisonStroke = comparisonPage.strokes[0];
    if (mode === "highlighter") {
      comparisonStroke = { ...comparisonStroke, id: "comparison-highlighter", tool: "highlighter", color: "#f5c400",
        width: 18, opacity: 0.45, points: comparisonStroke.points.map((point) => ({ ...point, y: point.y + 0.08 })) };
      comparisonPage.strokes.push(comparisonStroke);
      comparisonPage.updatedAt += 1;
      internal.notebook.updatedAt += 1;
      await internal.workerSession.apply(++internal.workerRevision, { type: "finalize-stroke", pageId: comparisonPage.id,
        stroke: comparisonStroke, pageUpdatedAt: comparisonPage.updatedAt, notebookUpdatedAt: internal.notebook.updatedAt });
    }
    const width = internal.canvasLogicalWidth, height = internal.canvasLogicalHeight;
    const cell = `${Math.floor(comparisonStroke.points[0].x * width / 128)}:${Math.floor(comparisonStroke.points[0].y * height / 128)}`;
    const result = await internal.workerSession.renderTile(comparisonPage.id, cell, 2, 0, width, height, 10_000, "visible");
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
    let compared = 0, different = 0, inkPixels = 0, expectedInkPixels = 0;
    for (let index = 0; index < actual.length; index += 4) {
      if (actual[index + 3] === 0 && baseline[index + 3] === 0) continue;
      inkPixels += actual[index + 3] > 0 ? 1 : 0;
      expectedInkPixels += baseline[index + 3] > 0 ? 1 : 0;
      compared++;
      if (Math.abs(actual[index] - baseline[index]) > 8 || Math.abs(actual[index + 1] - baseline[index + 1]) > 8
        || Math.abs(actual[index + 2] - baseline[index + 2]) > 8 || Math.abs(actual[index + 3] - baseline[index + 3]) > 8) different++;
    }
    return { compared, different, inkPixels, expectedInkPixels, totalPixels: actual.length / 4 };
  };
  (globalThis as typeof globalThis & { __inkNotesPreview?: { view: InkView; compareRenderer(mode?: "pen" | "highlighter"): Promise<{
    compared: number; different: number; inkPixels: number; expectedInkPixels: number; totalPixels: number }> } })
    .__inkNotesPreview = { view, compareRenderer };
  document.documentElement.dataset.inkReady = "true";
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
    cachedRead: async () => JSON.stringify(notebook),
    on: () => ({}),
  },
};
createInkEmbedProcessor(embedApp as never, async () => {})(
  `Ink Notes/Preview.ink\npage: ${page.id}`,
  embedHost,
  { addChild: (child: { onload(): void }) => child.onload() } as never,
);
