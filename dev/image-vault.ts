import { TFile } from "obsidian";
import type { App } from "obsidian";

/** Browser-only vault adapter exercises actual library persistence and imports. */
export function imageVaultApp(): App {
  const entries = new Map<string, TFile | object>();
  const content = new Map<string, string | ArrayBuffer>();
  const urls = new Map<string, string>();
  const file = (path: string) => Object.assign(new TFile(), { path, name: path.split("/").pop()!, basename: path.split("/").pop()!.replace(/\.[^.]+$/, ""), extension: path.split(".").pop()! });
  return { vault: {
    getAbstractFileByPath: (path: string) => entries.get(path) ?? null,
    getFiles: () => [...entries.values()].filter((entry): entry is TFile => entry instanceof TFile),
    createFolder: async (path: string) => { if (entries.has(path)) throw new Error("Path exists"); const folder = { path }; entries.set(path, folder); return folder; },
    create: async (path: string, text: string) => { if (entries.has(path)) throw new Error("Path exists"); const next = file(path); entries.set(path, next); content.set(path, text); return next; },
    createBinary: async (path: string, bytes: ArrayBuffer) => { if (entries.has(path)) throw new Error("Path exists"); const next = file(path); entries.set(path, next); content.set(path, bytes); return next; },
    read: async (f: TFile) => content.get(f.path) as string,
    readBinary: async (f: TFile) => content.get(f.path) as ArrayBuffer,
    process: async (f: TFile, fn: (text: string) => string) => { const next = fn(content.get(f.path) as string); content.set(f.path, next); return next; },
    getResourcePath: (f: TFile) => { if (!urls.has(f.path)) urls.set(f.path, URL.createObjectURL(new Blob([content.get(f.path) as ArrayBuffer], { type: "image/png" }))); return urls.get(f.path)!; },
  } } as unknown as App;
}
