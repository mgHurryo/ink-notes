import { describe, expect, it } from "vitest";
import { parseInkEmbed } from "../src/embed-spec";

describe("ink markdown embeds", () => {
  it("parses a notebook path and optional page", () => {
    expect(parseInkEmbed("Ink Notes/My Notebook.ink\npage: page-1")).toEqual({
      path: "Ink Notes/My Notebook.ink", pageId: "page-1",
    });
    expect(parseInkEmbed("Ink Notes/My Notebook.ink")).toEqual({ path: "Ink Notes/My Notebook.ink", pageId: undefined });
  });

  it("rejects paths outside the managed folder", () => {
    expect(() => parseInkEmbed("Other/My Notebook.ink")).toThrow(/Ink Notes/);
    expect(() => parseInkEmbed("Ink Notes/../Other.ink")).toThrow(/Ink Notes/);
  });

  it("rejects malformed page selectors and extra lines", () => {
    expect(() => parseInkEmbed("Ink Notes/Book.ink\npage one")).toThrow(/page:/);
    expect(() => parseInkEmbed("Ink Notes/Book.ink\npage: one\nextra")).toThrow(/page:/);
  });
});
