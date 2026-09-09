import { afterEach, describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { createNotebook } from "../src/model";
import { NotebookFormatError, NotebookStore } from "../src/storage";

describe("NotebookStore", () => {
  afterEach(() => vi.useRealTimers());
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
    expect(JSON.parse(raw).pages[0].strokes.map((entry: { id: string }) => entry.id)).toEqual(["remote", "local"]);
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
