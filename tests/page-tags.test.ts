import { describe, expect, it } from "vitest";
import { InkPage, createNotebook, mergeNotebooks, normalizeNotebook } from "../src/model";
import { parseStoredJson, serializeStoredJson } from "../src/storage-codec";
import {
  PAGE_FLAGS,
  pageHasInk,
  pageIsTagged,
  pageMatchesRailFilters,
  railFiltersActive,
} from "../src/page-tags";

function blankPage(overrides: Partial<InkPage> = {}): InkPage {
  const notebook = createNotebook();
  return { ...notebook.pages[0], ...overrides };
}

describe("page tag storage compatibility", () => {
  it("round-trips tags and flags through the disk codec", () => {
    const notebook = createNotebook();
    notebook.pages[0].tags = ["exam", "review"];
    notebook.pages[0].flag = "red";
    const parsed = normalizeNotebook(parseStoredJson(serializeStoredJson(notebook)));
    expect(parsed.pages[0].tags).toEqual(["exam", "review"]);
    expect(parsed.pages[0].flag).toBe("red");
  });

  it("normalizes legacy files without tag fields into untagged pages", () => {
    const legacy = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes: [] }] });
    expect(legacy.pages[0].tags).toBeUndefined();
    expect(legacy.pages[0].flag).toBeUndefined();
  });

  it("drops malformed tag values instead of storing them", () => {
    const parsed = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes: [], tags: ["real", 42, "  ", "", "real", " spaced "], flag: "purple" }] });
    expect(parsed.pages[0].tags).toEqual(["real", "spaced"]);
    expect(parsed.pages[0].flag).toBeUndefined();
  });

  it("accepts every supported flag value", () => {
    for (const flag of PAGE_FLAGS) {
      const parsed = normalizeNotebook({ pages: [{ id: "p1", title: "Page", strokes: [], flag }] });
      expect(parsed.pages[0].flag).toBe(flag);
    }
  });
});

describe("notebook tag merge semantics", () => {
  it("unions tags from both sides in base-first order", () => {
    const base = createNotebook();
    const incoming = normalizeNotebook(base);
    base.pages[0].tags = ["exam", "hard"];
    incoming.pages[0].tags = ["review", "exam"];
    expect(mergeNotebooks(base, incoming).pages[0].tags).toEqual(["exam", "hard", "review"]);
    expect(mergeNotebooks(incoming, base).pages[0].tags).toEqual(["review", "exam", "hard"]);
  });

  it("keeps tags when only one side carries them", () => {
    const base = createNotebook();
    const incoming = normalizeNotebook(base);
    base.pages[0].tags = ["solo"];
    expect(mergeNotebooks(base, incoming).pages[0].tags).toEqual(["solo"]);
    expect(mergeNotebooks(incoming, base).pages[0].tags).toEqual(["solo"]);
  });

  it("resolves flags last-writer-wins and lets a newer side clear one", () => {
    const base = createNotebook();
    const flagged = normalizeNotebook(base);
    flagged.pages[0].flag = "red";
    // A newer page whose flag edit cleared it carries no flag at all.
    const cleared = normalizeNotebook(base);
    cleared.pages[0].updatedAt = base.pages[0].updatedAt + 20;
    expect(cleared.pages[0].flag).toBeUndefined();
    expect(mergeNotebooks(flagged, cleared).pages[0].flag).toBeUndefined();
    expect(mergeNotebooks(cleared, flagged).pages[0].flag).toBeUndefined();
    // Two flags on the same page: the newer edit wins, in both merge orders.
    const green = normalizeNotebook(base);
    green.pages[0].flag = "green";
    green.pages[0].updatedAt = flagged.pages[0].updatedAt + 10;
    expect(mergeNotebooks(flagged, green).pages[0].flag).toBe("green");
    expect(mergeNotebooks(green, flagged).pages[0].flag).toBe("green");
  });
});

describe("rail filter predicates", () => {
  const inked = blankPage({ strokes: [{ id: "s", pageId: "p", tool: "pen", color: "#000", width: 3, opacity: 1, points: [], createdAt: 1, updatedAt: 1 }] });
  const tagged = blankPage({ tags: ["exam"] });
  const flagged = blankPage({ flag: "yellow" });

  it("mirrors the export gate's ink rule per page", () => {
    expect(pageHasInk(blankPage())).toBe(false);
    expect(pageHasInk(inked)).toBe(true);
    expect(pageHasInk(blankPage({ images: [{ id: "i", pageId: "p", assetPath: "Ink Notes/Images/assets/a.png", x: 0, y: 0, width: .2, height: .2, foreground: false, createdAt: 1, updatedAt: 1 }] }))).toBe(true);
    expect(pageHasInk(blankPage({ stickyNotes: [{ id: "n", pageId: "p", x: 0, y: 0, width: .2, height: .2, title: "", keywords: "", text: "", textUpdatedAt: 1, color: "#fff", collapsed: false, preview: true, scrollX: 0, scrollY: 0, boardPageWidth: 600, strokes: [], deletedStrokeIds: [], createdAt: 1, updatedAt: 1 }] }))).toBe(true);
  });

  it("treats any tag or flag as tagged", () => {
    expect(pageIsTagged(blankPage())).toBe(false);
    expect(pageIsTagged(tagged)).toBe(true);
    expect(pageIsTagged(flagged)).toBe(true);
    expect(pageIsTagged(blankPage({ tags: [] }))).toBe(false);
  });

  it("stacks both filters conjunctively", () => {
    const both = blankPage({ strokes: inked.strokes, tags: ["exam"] });
    const filters = { ink: true, tagged: true };
    expect(pageMatchesRailFilters(blankPage(), filters)).toBe(false);
    expect(pageMatchesRailFilters(inked, filters)).toBe(false);
    expect(pageMatchesRailFilters(tagged, filters)).toBe(false);
    expect(pageMatchesRailFilters(both, filters)).toBe(true);
    expect(pageMatchesRailFilters(flagged, { ink: false, tagged: true })).toBe(true);
    expect(pageMatchesRailFilters(flagged, { ink: true, tagged: false })).toBe(false);
  });

  it("reports whether any filter is on", () => {
    expect(railFiltersActive({ ink: false, tagged: false })).toBe(false);
    expect(railFiltersActive({ ink: true, tagged: false })).toBe(true);
    expect(railFiltersActive({ ink: false, tagged: true })).toBe(true);
  });
});
