import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { createNotebook } from "../src/model";
import { NotebookStore } from "../src/storage";

describe("NotebookStore", () => {
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
