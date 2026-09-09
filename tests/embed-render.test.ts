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
});
