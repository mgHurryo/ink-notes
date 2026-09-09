// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("obsidian", async () => import("../dev/obsidian"));
vi.mock("../src/rendering", () => ({ drawInkStroke: vi.fn() }));

import { TFile } from "obsidian";
import { createInkEmbedProcessor } from "../src/embed";
import { createNotebook } from "../src/model";

function file(path: string): TFile {
  return Object.assign(new TFile(), { path, extension: "ink" });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("ink embed rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  });

  it("renders the requested page and refreshes only for its target file", async () => {
    const target = file("Ink Notes/Book.ink");
    const notebook = createNotebook("Book");
    notebook.pages[0].id = "requested";
    notebook.pageOrder = ["requested"];
    let modify: ((changed: TFile) => void) | undefined;
    const vault = {
      getAbstractFileByPath: vi.fn(() => target),
      cachedRead: vi.fn(async () => JSON.stringify(notebook)),
      on: vi.fn((_name: string, handler: (changed: TFile) => void) => { modify = handler; return {}; }),
    };
    const el = document.body.createDiv();
    const processor = createInkEmbedProcessor({ vault } as never, vi.fn());
    processor("Ink Notes/Book.ink\npage: requested", el, { addChild: (child: { onload(): void }) => child.onload() } as never);
    await vi.waitFor(() => expect(el.querySelector('canvas[aria-label="Ink preview: Page 1"]')).not.toBeNull());
    expect(vault.cachedRead).toHaveBeenCalledOnce();
    modify?.(file("Ink Notes/Other.ink"));
    await Promise.resolve();
    expect(vault.cachedRead).toHaveBeenCalledOnce();
    modify?.(target);
    await vi.waitFor(() => expect(vault.cachedRead).toHaveBeenCalledTimes(2));
  });

  it("shows inline errors for a missing page and damaged JSON", async () => {
    const target = file("Ink Notes/Book.ink");
    const notebook = createNotebook("Book");
    const vault = {
      getAbstractFileByPath: vi.fn(() => target),
      cachedRead: vi.fn(async () => JSON.stringify(notebook)),
      on: vi.fn(() => ({})),
    };
    const render = async (source: string) => {
      const el = document.body.createDiv();
      createInkEmbedProcessor({ vault } as never, vi.fn())(source, el, { addChild: (child: { onload(): void }) => child.onload() } as never);
      await vi.waitFor(() => expect(el.querySelector(".ink-embed-error")).not.toBeNull());
      return el.textContent;
    };
    expect(await render("Ink Notes/Book.ink\npage: missing")).toContain("Ink page not found");
    vault.cachedRead.mockResolvedValueOnce("{ damaged");
    expect(await render("Ink Notes/Book.ink")).toContain("Ink notebook is damaged");
  });

  it("uses the first page when page is omitted and reports invalid paths inline", async () => {
    const target = file("Ink Notes/Book.ink");
    const notebook = createNotebook("Book");
    const vault = {
      getAbstractFileByPath: vi.fn(() => target),
      cachedRead: vi.fn(async () => JSON.stringify(notebook)),
      on: vi.fn(() => ({})),
    };
    const processor = createInkEmbedProcessor({ vault } as never, vi.fn());
    const preview = document.body.createDiv();
    processor("Ink Notes/Book.ink", preview, { addChild: (child: { onload(): void }) => child.onload() } as never);
    await vi.waitFor(() => expect(preview.querySelector('canvas[aria-label="Ink preview: Page 1"]')).not.toBeNull());
    const invalid = document.body.createDiv();
    processor("Other/Book.ink", invalid, { addChild: vi.fn() } as never);
    expect(invalid.querySelector(".ink-embed-error")?.textContent).toContain("inside Ink Notes/");
  });

  it("ignores a stale failed refresh after a newer preview succeeds", async () => {
    const target = file("Ink Notes/Book.ink");
    const first = deferred<string>();
    const second = deferred<string>();
    let modify: ((changed: TFile) => void) | undefined;
    const vault = {
      getAbstractFileByPath: vi.fn(() => target),
      cachedRead: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      on: vi.fn((_name: string, handler: (changed: TFile) => void) => { modify = handler; return {}; }),
    };
    const el = document.body.createDiv();
    createInkEmbedProcessor({ vault } as never, vi.fn())("Ink Notes/Book.ink", el, { addChild: (child: { onload(): void }) => child.onload() } as never);
    modify?.(target);
    const notebook = createNotebook("Newest");
    notebook.pages[0].title = "Newest page";
    second.resolve(JSON.stringify(notebook));
    await vi.waitFor(() => expect(el.querySelector('canvas[aria-label="Ink preview: Newest page"]')).not.toBeNull());
    first.reject(new Error("stale read failed"));
    await Promise.resolve();
    expect(el.querySelector(".ink-embed-error")).toBeNull();
    expect(el.querySelector('canvas[aria-label="Ink preview: Newest page"]')).not.toBeNull();
  });

  it("does not update the container after the preview component unloads", async () => {
    const target = file("Ink Notes/Book.ink");
    const read = deferred<string>();
    const vault = {
      getAbstractFileByPath: vi.fn(() => target),
      cachedRead: vi.fn(() => read.promise),
      on: vi.fn(() => ({})),
    };
    let child: { onload(): void; onunload(): void } | undefined;
    const el = document.body.createDiv();
    createInkEmbedProcessor({ vault } as never, vi.fn())("Ink Notes/Book.ink", el, { addChild: (next: typeof child) => { child = next; next?.onload(); } } as never);
    child?.onunload();
    read.resolve(JSON.stringify(createNotebook("Late")));
    await Promise.resolve();
    await Promise.resolve();
    expect(el.querySelector("canvas")).toBeNull();
    expect(el.querySelector(".ink-embed-error")).toBeNull();
  });
});
