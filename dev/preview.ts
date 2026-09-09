import { InkView } from "../src/view";
import { createInkEmbedProcessor } from "../src/embed";
import { createNotebook } from "../src/model";
import type { NotebookStore } from "../src/storage";
import { InkWorkerService } from "../src/worker-service";
import { TFile } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";

const notebook = createNotebook("Ink Notebook");
const page = notebook.pages[0];
page.strokes.push({
  id: "preview-ink", pageId: page.id, tool: "pen", color: "#195bff", width: 4, opacity: 1,
  points: Array.from({ length: 36 }, (_, index) => ({
    x: 0.18 + index * 0.017, y: 0.35 + Math.sin(index / 4) * 0.045,
    pressure: 0.35 + index / 100, t: index + 1,
  })),
  createdAt: 1, updatedAt: 1,
});
const rawNotebook = () => JSON.stringify(notebook);
const store = {
  read: async () => notebook,
  readRaw: async () => rawNotebook(),
  writeIfUnchanged: async (_file: unknown, expected: string, next: string) => expected === rawNotebook() && (Object.assign(notebook, JSON.parse(next)), true),
  save: async (_file: unknown, value: unknown) => value,
};
const workers = new InkWorkerService((message) => console.warn(message));
const view = new InkView({} as WorkspaceLeaf, store as unknown as NotebookStore, workers);
void (async () => {
  await view.onOpen();
  await view.onLoadFile({ path: "Ink Notes/Preview.ink", basename: "Preview" } as TFile);
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
