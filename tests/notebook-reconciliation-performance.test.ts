import { describe, expect, it, vi } from "vitest";
import { createNotebook } from "../src/model";
import type { StickyNote } from "../src/sticky-model";
import { reconcileNotebook } from "../src/notebook-reconciliation";

function sticky(id: string, pageId: string): StickyNote {
  return {
    id, pageId, x: 0.1, y: 0.1, width: 0.3, height: 0.25,
    title: "", keywords: "", text: "note", textUpdatedAt: 1,
    color: "yellow", collapsed: false, preview: false, scrollX: 0, scrollY: 0, boardPageWidth: 1600,
    strokes: [{ id: `${id}-stroke`, pageId: id, tool: "pen", color: "#111111", width: 3, opacity: 1,
      points: [{ x: 0.2, y: 0.3, pressure: 0.5, t: 1 }], createdAt: 1, updatedAt: 1 }],
    deletedStrokeIds: [], createdAt: 1, updatedAt: 1,
  };
}

describe("sticky note reconciliation cost", () => {
  it("reuses unchanged notes and strokes without serializing their content", () => {
    const book = createNotebook();
    const page = book.pages[0]!;
    const note = sticky("note-1", page.id);
    page.stickyNotes = [note];
    const incoming = structuredClone(book);
    const stringify = vi.spyOn(JSON, "stringify");

    try {
      const result = reconcileNotebook(book, incoming, page.id, 0);
      expect(result.currentInkChanged).toBe(false);
      expect(page.stickyNotes?.[0]).toBe(note);
      expect(page.stickyNotes?.[0]?.strokes[0]).toBe(note.strokes[0]);
      expect(stringify.mock.calls.some(([value]) => Array.isArray(value) && value[0]?.id === note.id)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it("clones only a changed note and preserves unaffected note identity", () => {
    const book = createNotebook();
    const page = book.pages[0]!;
    const first = sticky("note-1", page.id), second = sticky("note-2", page.id);
    page.stickyNotes = [first, second];
    const incoming = structuredClone(book);
    incoming.pages[0]!.stickyNotes![0]!.text = "updated";
    incoming.pages[0]!.stickyNotes![0]!.textUpdatedAt = 2;
    incoming.pages[0]!.stickyNotes![0]!.updatedAt = 2;

    const result = reconcileNotebook(book, incoming, page.id, 0);

    expect(result.currentInkChanged).toBe(true);
    expect(page.stickyNotes?.[0]).not.toBe(first);
    expect(page.stickyNotes?.[0]?.text).toBe("updated");
    expect(page.stickyNotes?.[1]).toBe(second);
    expect(page.stickyNotes?.[1]?.strokes[0]).toBe(second.strokes[0]);
  });

  it("detects content changes even when concurrent edits share timestamps", () => {
    const book = createNotebook();
    const page = book.pages[0]!;
    const note = sticky("note-1", page.id);
    page.stickyNotes = [note];
    const incoming = structuredClone(book);
    incoming.pages[0]!.stickyNotes![0]!.text = "same-millisecond edit";

    const result = reconcileNotebook(book, incoming, page.id, 0);

    expect(result.currentInkChanged).toBe(true);
    expect(page.stickyNotes?.[0]).not.toBe(note);
    expect(page.stickyNotes?.[0]?.text).toBe("same-millisecond edit");
  });
});
