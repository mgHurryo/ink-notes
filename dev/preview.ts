import { InkView } from "../src/view";
import { createNotebook } from "../src/model";
import type { NotebookStore } from "../src/storage";
import type { WorkspaceLeaf } from "obsidian";

const notebook = createNotebook("Ink Notebook");
const store = { read: async () => notebook, save: async (_file: unknown, value: unknown) => value };
const view = new InkView({} as WorkspaceLeaf, store as unknown as NotebookStore);
void view.onOpen();
