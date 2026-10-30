import { describe, expect, it } from "vitest";
import type { TFile } from "obsidian";
import { NotebookHistoryIndex, discoverNotebooks } from "../src/storage";

function file(path: string, basename?: string): TFile {
  return { path, basename: basename ?? path.slice(path.lastIndexOf("/") + 1).replace(/\.ink$/, "") } as TFile;
}

describe("NotebookHistoryIndex", () => {
  it("records and refreshes opened notebooks by path with the latest title and time", () => {
    const index = new NotebookHistoryIndex();
    index.record("Ink Notes/Algebra.ink", "Algebra", 100);
    index.record("Ink Notes/Algebra.ink", "Algebra renamed", 200);
    expect(index.list()).toEqual([{ path: "Ink Notes/Algebra.ink", title: "Algebra renamed", lastOpened: 200 }]);
  });

  it("lists entries most recently opened first", () => {
    const index = new NotebookHistoryIndex();
    index.record("Ink Notes/Old.ink", "Old", 100);
    index.record("Ink Notes/New.ink", "New", 200);
    index.record("Ink Notes/Mid.ink", "Mid", 150);
    expect(index.list().map((entry) => entry.path)).toEqual(["Ink Notes/New.ink", "Ink Notes/Mid.ink", "Ink Notes/Old.ink"]);
  });

  it("removes single entries and every entry whose file is missing, only on request", () => {
    const index = new NotebookHistoryIndex();
    index.record("Ink Notes/Kept.ink", "Kept", 300);
    index.record("Archive/Gone.ink", "Gone", 200);
    index.record("Courses/Also gone.ink", "Also gone", 100);
    index.remove("Ink Notes/Kept.ink");
    expect(index.list().map((entry) => entry.path)).toEqual(["Archive/Gone.ink", "Courses/Also gone.ink"]);
    expect(index.removeMissing(new Set(["Ink Notes/Kept.ink", "Ink Notes/Other.ink"]))).toBe(2);
    expect(index.list()).toEqual([]);
  });

  it("restores persisted entries, skipping malformed ones without losing the rest", () => {
    const index = new NotebookHistoryIndex([
      { path: "Ink Notes/Good.ink", title: "Good", lastOpened: 100 },
      null,
      { path: "", title: "No path", lastOpened: 100 },
      { title: "No path field", lastOpened: 100 },
      { path: "Courses/Bad time.ink", title: "Bad time", lastOpened: "yesterday" },
      { path: "Ink Notes/Good.ink", title: "Good", lastOpened: 50 },
      "garbage",
    ]);
    expect(index.list()).toEqual([
      { path: "Ink Notes/Good.ink", title: "Good", lastOpened: 100 },
      { path: "Courses/Bad time.ink", title: "Bad time", lastOpened: 0 },
    ]);
    expect(new NotebookHistoryIndex("garbage").list()).toEqual([]);
    expect(new NotebookHistoryIndex().list()).toEqual([]);
  });

  it("derives a missing title from the path and caps the history by least recent open", () => {
    const index = new NotebookHistoryIndex(Array.from({ length: 210 }, (_, offset) => ({
      path: `Ink Notes/Book ${offset}.ink`, title: "", lastOpened: offset + 1,
    })));
    index.record("Ink Notes/Latest.ink", "Latest", 1000);
    const entries = index.list();
    expect(entries).toHaveLength(200);
    expect(entries[0]).toEqual({ path: "Ink Notes/Latest.ink", title: "Latest", lastOpened: 1000 });
    // Restored entries with an empty title fall back to the path basename.
    expect(entries.at(-1)).toEqual({ path: "Ink Notes/Book 11.ink", title: "Book 11.ink", lastOpened: 12 });
  });
});

describe("discoverNotebooks", () => {
  it("merges the vault scan with history by path, newest open first", () => {
    const scanned = [file("Ink Notes/Algebra.ink"), file("Courses/Math/Geometry.ink")];
    const history = [
      { path: "Courses/Math/Geometry.ink", title: "Geometry", lastOpened: 500 },
      { path: "Ink Notes/Algebra.ink", title: "Algebra", lastOpened: 900 },
    ];
    expect(discoverNotebooks(scanned, history)).toEqual([
      { path: "Ink Notes/Algebra.ink", title: "Algebra", lastOpened: 900, file: scanned[0] },
      { path: "Courses/Math/Geometry.ink", title: "Geometry", lastOpened: 500, file: scanned[1] },
    ]);
  });

  it("keeps history entries whose file is missing behind the existing ones", () => {
    const scanned = [file("Ink Notes/Algebra.ink")];
    const history = [
      { path: "Archive/Moved away.ink", title: "Moved away", lastOpened: 900 },
      { path: "Ink Notes/Algebra.ink", title: "Algebra", lastOpened: 100 },
    ];
    expect(discoverNotebooks(scanned, history)).toEqual([
      { path: "Ink Notes/Algebra.ink", title: "Algebra", lastOpened: 100, file: scanned[0] },
      { path: "Archive/Moved away.ink", title: "Moved away", lastOpened: 900, file: null },
    ]);
  });

  it("deduplicates repeated scan and history paths and sorts deterministically", () => {
    const scanned = [file("B.ink", "B"), file("a.ink", "a"), file("B.ink", "B")];
    const history = [
      { path: "B.ink", title: "B", lastOpened: 10 },
      { path: "B.ink", title: "B", lastOpened: 20 },
    ];
    const merged = discoverNotebooks(scanned, history);
    expect(merged).toHaveLength(2);
    expect(merged.map((entry) => entry.path)).toEqual(["B.ink", "a.ink"]);
    expect(merged[0].lastOpened).toBe(20);
    expect(discoverNotebooks([], [])).toEqual([]);
  });
});
