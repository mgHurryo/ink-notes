import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { createNotebook } from "../src/model";
import { NotebookFormatError, NotebookStore } from "../src/storage";
import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";

describe("NotebookStore", () => {
  afterEach(() => vi.useRealTimers());
  it("reads compressed notebooks and merges peer strokes without reviving deletion tombstones", async () => {
    const remote=createNotebook(), page=remote.pages[0];
    const dense={...stroke("remote",page.id,1),points:Array.from({length:500},(_,i)=>({x:i/1000,y:.3,pressure:.7,t:i+1}))};
    page.strokes=[dense]; page.deletedStrokeIds=["erased"];
    let raw=serializeStoredJson(remote); expect(raw).toContain("INK-GZIP-1");
    const vault={ read:vi.fn(async()=>raw), process:vi.fn(async (_file:TFile,update:(raw:string)=>string)=>{raw=update(raw);}) };
    const store=new NotebookStore({vault} as unknown as App), file={path:"Ink Notes/Compressed.ink"} as TFile;
    expect((await store.read(file)).pages[0].strokes[0].points).toEqual(dense.points);
    const local=structuredClone(remote); local.pages[0].strokes=[stroke("local",page.id,2),stroke("erased",page.id,2)];
    const result=await store.save(file,local);
    expect(result.pages[0].strokes.map(s=>s.id)).toEqual(["remote","local"]);
    expect(parseStoredJson(raw).pages[0].strokes[0].points).toEqual(dense.points);
  });

  it("refuses corrupted compressed files and preserves their exact disk contents",async()=>{
    let raw="INK-GZIP-1\nAAAA\n";
    const vault={process:vi.fn(async (_file:TFile,update:(raw:string)=>string)=>{raw=update(raw);})};
    const store=new NotebookStore({vault} as unknown as App);
    await expect(store.save({path:"Ink Notes/Corrupt.ink"} as TFile,createNotebook())).rejects.toBeInstanceOf(NotebookFormatError);
    expect(raw).toBe("INK-GZIP-1\nAAAA\n");
  });
  it("returns and persists the merged notebook", async () => {
    const remote = createNotebook("Shared");
    const page = remote.pages[0];
    page.strokes.push(stroke("remote", page.id, 1));
    let raw = JSON.stringify(remote);
    const vault = {
      process: vi.fn(async (_file: TFile, update: (current: string) => string) => {
        raw = update(raw);
      }),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const local = createNotebook("Shared");
    local.pages = [{ ...page, strokes: [stroke("local", page.id, 2)], deletedStrokeIds: [] }];

    const merged = await store.save({} as TFile, local);

    expect(merged.pages[0].strokes.map((entry) => entry.id)).toEqual(["remote", "local"]);
    expect(parseStoredJson(raw).pages[0].strokes.map((entry: { id: string }) => entry.id)).toEqual(["remote", "local"]);
  });

  it("refuses to overwrite an existing notebook with invalid JSON", async () => {
    const original = "{ damaged";
    let raw = original;
    const vault = {
      process: vi.fn(async (_file: TFile, update: (current: string) => string) => {
        raw = update(raw);
      }),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    await expect(store.save({ path: "Ink Notes/Damaged.ink" } as TFile, createNotebook()))
      .rejects.toBeInstanceOf(NotebookFormatError);
    expect(raw).toBe(original);
  });

  it("writes only when the Vault text still matches", async () => {
    let raw = "before";
    const vault = {
      process: vi.fn(async (_file: TFile, update: (current: string) => string) => { raw = update(raw); }),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    expect(await store.writeIfUnchanged({ path: "Ink Notes/CAS.ink" } as TFile, "other", "after")).toBe(false);
    expect(raw).toBe("before");
    expect(await store.writeIfUnchanged({ path: "Ink Notes/CAS.ink" } as TFile, "before", "after")).toBe(true);
    expect(raw).toBe("after");
  });

  it("scans the whole vault for .ink notebooks instead of only the default folder", async () => {
    const inFolder = { path: "Ink Notes/Course.ink", extension: "ink" } as TFile;
    const outside = { path: "Courses/Math/Geometry.ink", extension: "ink" } as TFile;
    const markdown = { path: "Ink Notes/Readme.md", extension: "md" } as TFile;
    const sidecar = { path: "A_pdfinkwrittern/Paper--x.pdfink.json", extension: "json" } as TFile;
    const vault = { getFiles: vi.fn(() => [inFolder, outside, markdown, sidecar]) };
    const store = new NotebookStore({ vault } as unknown as App);
    expect(await store.list()).toEqual([inFolder, outside]);
  });

  it("also reloads open notebooks that live outside the default folder", async () => {
    vi.useFakeTimers();
    let modify: ((file: TFile) => void) | undefined;
    const vault = {
      on: vi.fn((_name: string, handler: (file: TFile) => void) => { modify = handler; return {}; }),
      offref: vi.fn(),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const changed = vi.fn();
    store.observe(changed);
    modify?.(Object.assign(new (await import("obsidian")).TFile(), { path: "Courses/Math/Geometry.ink", extension: "ink" }));
    await vi.advanceTimersByTimeAsync(75);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("creates in the default folder when no custom folder is given", async () => {
    const vault = {
      getAbstractFileByPath: vi.fn(() => undefined),
      createFolder: vi.fn(async () => undefined),
      create: vi.fn(async (path: string) => ({ path }) as TFile),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const file = await store.create("Algebra");
    expect(vault.createFolder).toHaveBeenCalledWith("Ink Notes");
    expect(file.path).toBe("Ink Notes/Algebra.ink");
  });

  it("creates through a custom nested folder and reuses folders that already exist", async () => {
    const vault = {
      getAbstractFileByPath: vi.fn((path: string) => path === "Courses" ? { path } : undefined),
      createFolder: vi.fn(async () => undefined),
      create: vi.fn(async (path: string) => ({ path }) as TFile),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const file = await store.create("Geometry", "Courses/Math");
    expect(vault.createFolder).toHaveBeenCalledExactlyOnceWith("Courses/Math");
    expect(file.path).toBe("Courses/Math/Geometry.ink");
  });

  it("cleans messy custom folders with the same rules as notebook titles", async () => {
    const vault = {
      getAbstractFileByPath: vi.fn(() => undefined),
      createFolder: vi.fn(async () => undefined),
      create: vi.fn(async (path: string) => ({ path }) as TFile),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const file = await store.create("My:Book", " Courses // Math\\Spring ");
    expect(file.path).toBe("Courses/Math/Spring/My-Book.ink");
  });

  it("keeps empty, dot and traversal folders on the default folder", async () => {
    const folders = new Set<string>();
    const vault = {
      getAbstractFileByPath: vi.fn((path: string) => folders.has(path) ? { path } : undefined),
      createFolder: vi.fn(async (path: string) => { folders.add(path); }),
      create: vi.fn(async (path: string) => ({ path }) as TFile),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    expect((await store.create("A", "  ")).path).toBe("Ink Notes/A.ink");
    expect((await store.create("B", ".././..")).path).toBe("Ink Notes/B.ink");
    expect(vault.createFolder).toHaveBeenCalledExactlyOnceWith("Ink Notes");
  });

  it("refuses a custom folder path occupied by a file", async () => {
    const occupant = Object.assign(new (await import("obsidian")).TFile(), { path: "Courses", extension: "md" });
    const vault = {
      getAbstractFileByPath: vi.fn((path: string) => path === "Courses" ? occupant : undefined),
      createFolder: vi.fn(async () => undefined),
      create: vi.fn(async (path: string) => ({ path }) as TFile),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    await expect(store.create("Algebra", "Courses/Math")).rejects.toThrow("a file already exists at Courses");
    expect(vault.createFolder).not.toHaveBeenCalled();
  });

  it("suppresses the matching modify event emitted by its own save", async () => {
    const notebook = createNotebook();
    let raw = JSON.stringify(notebook);
    let modify: ((file: TFile) => void) | undefined;
    const file = { path: "Ink Notes/Self.ink", extension: "ink" } as TFile;
    const vault = {
      process: vi.fn(async (_file: TFile, update: (current: string) => string) => { raw = update(raw); }),
      cachedRead: vi.fn(async () => raw),
      on: vi.fn((_name: string, handler: (file: TFile) => void) => { modify = handler; return {}; }),
      offref: vi.fn(),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const changed = vi.fn();
    store.observe(changed);
    await store.save(file, notebook);
    modify?.(file);
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not retain self-write suppression after the Vault write fails", async () => {
    vi.useFakeTimers();
    const notebook = createNotebook();
    let external = JSON.stringify(notebook);
    let modify: ((file: TFile) => void) | undefined;
    const file = Object.assign(new (await import("obsidian")).TFile(), { path: "Ink Notes/Failed.ink", extension: "ink" });
    const vault = {
      process: vi.fn(async (_file: TFile, update: (current: string) => string) => {
        external = update(external);
        throw new Error("disk full");
      }),
      cachedRead: vi.fn(async () => external),
      on: vi.fn((_name: string, handler: (changed: TFile) => void) => { modify = handler; return {}; }),
      offref: vi.fn(),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const changed = vi.fn();
    store.observe(changed);
    await expect(store.save(file, notebook)).rejects.toThrow("disk full");
    modify?.(file);
    await vi.advanceTimersByTimeAsync(75);
    expect(changed).toHaveBeenCalledOnce();
  });

  it("debounces external changes for one ink file and ignores unrelated files", async () => {
    vi.useFakeTimers();
    let modify: ((file: TFile) => void) | undefined;
    const vault = {
      on: vi.fn((_name: string, handler: (file: TFile) => void) => { modify = handler; return {}; }),
      offref: vi.fn(),
    };
    const store = new NotebookStore({ vault } as unknown as App);
    const changed = vi.fn();
    const dispose = store.observe(changed);
    const ink = Object.assign(new (await import("obsidian")).TFile(), { path: "Ink Notes/Shared.ink", extension: "ink" });
    const markdown = Object.assign(new (await import("obsidian")).TFile(), { path: "Ink Notes/Readme.md", extension: "md" });
    modify?.(ink); modify?.(ink); modify?.(markdown);
    await vi.advanceTimersByTimeAsync(74);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(ink);
    dispose();
    expect(vault.offref).toHaveBeenCalledOnce();
  });
});

function stroke(id: string, pageId: string, timestamp: number) {
  return {
    id,
    pageId,
    tool: "pen" as const,
    color: "#000",
    width: 3,
    opacity: 1,
    points: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
