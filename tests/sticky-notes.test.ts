// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { createNotebook, mergeNotebooks, normalizeNotebook } from "../src/model";
import { cloneSticky, normalizeSticky, StickyNote, stickyLink, stickyPosition, stickyTextBoxes, stickyText, patchStickyTextBox, mergeSticky, stickyFont, resizeStickyTextBox } from "../src/sticky-model";
import { applyNotebookOperation } from "../src/worker-core";
import { clonePageValue } from "../src/worker-protocol";
import { collectStickyEntries, filterStickyEntries, StickySearchModal } from "../src/sticky-index";
import { paintStickyBoard } from "../src/sticky-rendering";
import { imageVaultApp } from "../dev/image-vault";
import { createSidecar, PDF_INK_FOLDER } from "../src/pdf-sidecar";
import { notebookHasInk } from "../src/pdf-export";
import { serializeStoredJson } from "../src/storage-codec";

export function note(pageId: string): StickyNote {
  return { id: "sticky-a", pageId, x: .2, y: .2, width: .5, height: .3, title: "Physics", keywords: "force diagrams", text: "你好\nNewton",
    textUpdatedAt: 1, color: "#fff1a8", collapsed: false, preview: true, scrollX: 4000, scrollY: 8000, boardPageWidth: 600,
    strokes: [{ id: "s", pageId: "sticky-a", tool: "pen", width: 4, color: "#000000", opacity: 1,
      points: [{ x: 4, y: 8, pressure: .5, t: 1 }, { x: 4.2, y: 8.1, pressure: .6, t: 2 }], createdAt: 1, updatedAt: 1 }],
    deletedStrokeIds: [], createdAt: 1, updatedAt: 1 };
}

describe("sticky note persistence and search", () => {
  it("preserves styles through primary/extra merges and serialization while repairing unsafe fonts", () => {
    const legacy = note("p"); expect(stickyFont(stickyTextBoxes(legacy)[0], true)).toBe("20px/1.4 sans-serif");
    const a = patchStickyTextBox(legacy, "primary", { fontSize: 36, fontFamily: "kai", bold: true, italic: true, scaleText: true });
    a.textUpdatedAt = 3; a.updatedAt = 3;
    const b = { ...legacy, updatedAt: 4, textBoxes: [{ id: "extra", text: "Peer", x: 20, y: 20, width: 120, fontSize: 40, fontFamily: "serif" as const, createdAt: 1, updatedAt: 4 }] };
    const loaded = normalizeSticky(JSON.parse(JSON.stringify(mergeSticky(a, b))), "p")!;
    expect(stickyTextBoxes(loaded)[0]).toMatchObject({ fontSize: 36, fontFamily: "kai", bold: true, italic: true, scaleText: true });
    expect(loaded.textBoxes![0]).toMatchObject({ fontSize: 40, fontFamily: "serif" });
    expect(mergeSticky(b, a)).toEqual(mergeSticky(a, b));
    const unsafe = normalizeSticky({ ...loaded, textFontSize: Infinity, textFontFamily: "constructor",
      textBoxes: [{ ...b.textBoxes[0], fontSize: -200, fontFamily: "url(https://bad.test/font)" }] }, "p")!;
    expect(stickyFont(stickyTextBoxes(unsafe)[0])).toBe("italic bold 20px sans-serif");
    expect(stickyFont(unsafe.textBoxes![0])).toBe("8px sans-serif");
  });
  it("resizes text uniformly only when bound, including height-only drags and size limits", () => {
    const box = { ...stickyTextBoxes(note("p"))[0], width: 200, height: 100, fontSize: 20 };
    expect(resizeStickyTextBox(box, 400, 100)).toEqual({ width: 400, height: 100 });
    expect(resizeStickyTextBox({ ...box, scaleText: true }, 400, 100)).toEqual({ width: 400, height: 100, fontSize: 40 });
    expect(resizeStickyTextBox({ ...box, scaleText: true }, 200, 200).fontSize).toBe(40);
    expect(resizeStickyTextBox({ ...box, scaleText: true }, 100, 60).fontSize).toBe(10);
    expect(resizeStickyTextBox({ ...box, scaleText: true }, 10000, 100).fontSize).toBe(144);
    expect(box.fontSize).toBe(20);
  });
  it("uses saved fonts and line height for canvas previews without changing the text", () => {
    const sticky = { ...note("p"), text: "A\nB", textFontSize: 30, textFontFamily: "serif" as const, textBold: true, textItalic: true, scrollX: 0, scrollY: 0, strokes: [] };
    const fonts: string[] = [];
    const ctx = { save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), scale: vi.fn(), translate: vi.fn(), fillText: vi.fn(), measureText: vi.fn(() => ({ width: 10 })), restore: vi.fn(), set font(value: string) { fonts.push(value); } };
    paintStickyBoard(ctx as unknown as CanvasRenderingContext2D, sticky, 400, 300);
    expect(fonts).toContain("italic bold 30px serif"); expect(ctx.fillText.mock.calls).toEqual([["A", 16, 16], ["B", 16, 58]]);
  });
  it("loads legacy text as one box and keeps multiple boxes through worker serialization", () => {
    const book = createNotebook(), page = book.pages[0], legacy = note(page.id);
    expect(stickyTextBoxes(legacy)).toEqual([{ id: "primary", text: legacy.text, x: 16, y: 16, width: 268, height: undefined,
      fontSize: undefined, fontFamily: undefined, bold: undefined, italic: undefined, scaleText: undefined, createdAt: 1, updatedAt: 1 }]);
    const extra = { id: "box", text: "Additional searchable text", x: 200, y: 100, width: 180, height: 120, createdAt: 2, updatedAt: 2 };
    const sticky = { ...legacy, textBoxes: [extra], deletedTextBoxes: { gone: 3 } };
    applyNotebookOperation(book, { type: "patch-sticky-notes", pageId: page.id, upsert: [sticky], remove: [], deletedStickyNotes: {}, pageUpdatedAt: 3, notebookUpdatedAt: 3 });
    extra.text = "mutated input";
    const loaded = normalizeNotebook(JSON.parse(JSON.stringify(book))).pages[0].stickyNotes![0];
    expect(stickyText(loaded)).toBe(`${legacy.text}\n\nAdditional searchable text`);
    const copy = clonePageValue(page); copy.stickyNotes![0].textBoxes![0].x = 900;
    copy.stickyNotes![0].deletedTextBoxes!.gone = 10;
    expect(page.stickyNotes![0].textBoxes![0].x).toBe(200);
    expect(page.stickyNotes![0].deletedTextBoxes!.gone).toBe(3);
    expect(filterStickyEntries([{ file: "Notes.ink", pageId: page.id, pageTitle: "Page", note: loaded }], "additional searchable")).toHaveLength(1);
  });
  it("merges edits to independent boxes and suppresses deleted boxes from stale peers", () => {
    const base = { ...note("p"), textBoxes: [
      { id: "a", text: "A", x: 16, y: 16, width: 100, createdAt: 1, updatedAt: 1 },
      { id: "b", text: "B", x: 160, y: 16, width: 100, createdAt: 1, updatedAt: 1 },
    ] };
    const a = patchStickyTextBox(base, "a", { text: "Edited A", updatedAt: 3 }); a.updatedAt = 3;
    const b = patchStickyTextBox(base, "b", { x: 300, updatedAt: 4 }); b.updatedAt = 4;
    const merged = mergeSticky(a, b);
    expect(merged.textBoxes).toMatchObject([{ id: "a", text: "Edited A" }, { id: "b", x: 300 }]);
    expect(mergeSticky(b, a)).toEqual(merged);
    const removed = { ...merged, textBoxes: merged.textBoxes!.filter((box) => box.id !== "a"), deletedTextBoxes: { a: 5 }, updatedAt: 5 };
    expect(mergeSticky(removed, a).textBoxes!.map((box) => box.id)).toEqual(["b"]);
    expect(mergeSticky(a, removed)).toEqual(mergeSticky(removed, a));
    // A delayed peer save cannot reuse an erased identity, even if its clock
    // advances past deletion. Explicit undo restores content with a new id.
    const delayed = patchStickyTextBox(a, "a", { text: "Late peer edit", updatedAt: 10 }); delayed.updatedAt = 10;
    expect(mergeSticky(removed, delayed).textBoxes!.map((box) => box.id)).toEqual(["b"]);
    expect(normalizeSticky({ ...delayed, deletedTextBoxes: { a: 5 } }, "p")!.textBoxes!.map((box) => box.id)).toEqual(["b"]);
    const primary = patchStickyTextBox(base, "primary", { x: 400, y: 200, width: 160 }); primary.textUpdatedAt = 6;
    expect(mergeSticky(primary, b)).toMatchObject({ text: base.text, textX: 400, textY: 200, textWidth: 160 });
  });
  it("normalizes box geometry without losing offscreen text or sharing mutable box objects", () => {
    const base = { ...note("p"), textBoxes: [
      { id: "a", text: "Beyond the frame", x: 4000, y: 8000, width: 200, height: 100, createdAt: 1, updatedAt: 2 },
      { id: "bad", text: "Repair bounds", x: NaN, y: -1, width: Infinity, height: 0, createdAt: 1, updatedAt: 1 },
      { id: "gone", text: "Deleted", x: 0, y: 0, width: 100, createdAt: 1, updatedAt: 1 },
    ], deletedTextBoxes: { gone: 2 } };
    const loaded = normalizeSticky(base, "p")!;
    expect(loaded.textBoxes).toHaveLength(2);
    expect(loaded.textBoxes![0]).toMatchObject({ x: 4000, y: 8000, text: "Beyond the frame" });
    expect(loaded.textBoxes![1]).toMatchObject({ x: 16, y: 0, width: 240, height: 120 });
    const copy = cloneSticky(loaded); copy.textBoxes![0].text = "Different";
    expect(loaded.textBoxes![0].text).toBe("Beyond the frame");
    const moved = patchStickyTextBox(loaded, "a", { x: 9000, width: 60 });
    expect(moved.strokes).toEqual(base.strokes); expect(moved.text).toBe(base.text);
    expect(loaded.textBoxes![0].x).toBe(4000);
  });
  it("renders each box at its board origin and clips only its viewport", () => {
    const sticky = { ...note("p"), text: "", strokes: [], scrollX: 100, scrollY: 50,
      textBoxes: [{ id: "box", text: "ABCD", x: 120, y: 70, width: 60, height: 60, createdAt: 1, updatedAt: 1 }] };
    const ctx = { save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), scale: vi.fn(), translate: vi.fn(), fillText: vi.fn(), measureText: vi.fn((text: string) => ({ width: text.length * 25 })), restore: vi.fn() };
    paintStickyBoard(ctx as unknown as CanvasRenderingContext2D, sticky, 400, 300, 2);
    expect(ctx.rect.mock.calls).toContainEqual([120, 70, 60, 60]);
    expect(ctx.fillText.mock.calls).toEqual([["AB", 120, 70], ["CD", 120, 98]]);
    expect(ctx.translate).toHaveBeenCalledWith(-100, -50);
    expect(sticky.textBoxes[0].text).toBe("ABCD");
  });
  it("preserves folded edge positions through loading and worker saves", () => {
    const book = createNotebook(), page = book.pages[0];
    const folded = { ...note(page.id), x: .78, y: .88, collapsed: true };
    page.stickyNotes = [folded];
    let loaded = normalizeNotebook(JSON.parse(JSON.stringify(book)));
    expect(loaded.pages[0].stickyNotes![0]).toMatchObject({ x: .78, y: .88, width: .5, height: .3 });
    applyNotebookOperation(loaded, { type: "patch-sticky-notes", pageId: page.id, remove: [folded.id],
      upsert: [{ ...folded, title: "At the edge", updatedAt: 2 }], deletedStickyNotes: {}, pageUpdatedAt: 2, notebookUpdatedAt: 2 });
    loaded = normalizeNotebook(JSON.parse(JSON.stringify(loaded)));
    expect(loaded.pages[0].stickyNotes![0]).toMatchObject({ x: .78, y: .88, title: "At the edge", strokes: folded.strokes });
    const expanded = normalizeSticky({ ...folded, collapsed: false }, page.id)!;
    expect(expanded).toMatchObject({ x: .78, y: .88 });
    expect(stickyPosition(expanded)).toEqual({ x: .5, y: .7 });
    expect(stickyPosition({ ...expanded, collapsed: true })).toEqual({ x: .78, y: .88 });
  });
  it("keeps overlapping notes in creation order through edits, worker saves and merges", () => {
    const book = createNotebook(), page = book.pages[0];
    const back = { ...note(page.id), id: "back", createdAt: 1 }, front = { ...note(page.id), id: "front", createdAt: 2 };
    page.stickyNotes = [back, front];
    const edited = { ...back, title: "Updated behind the front note", updatedAt: 9 };
    applyNotebookOperation(book, { type: "patch-sticky-notes", pageId: page.id, remove: [back.id], upsert: [edited],
      deletedStickyNotes: {}, pageUpdatedAt: 9, notebookUpdatedAt: 9 });
    expect(page.stickyNotes.map((n) => n.id)).toEqual(["back", "front"]);
    expect(page.stickyNotes[0].title).toBe(edited.title);
    const loaded = normalizeNotebook(JSON.parse(JSON.stringify(book)));
    expect(loaded.pages[0].stickyNotes!.map((n) => n.id)).toEqual(["back", "front"]);
    const peer = structuredClone(loaded); peer.pages[0].stickyNotes!.reverse();
    expect(mergeNotebooks(loaded, peer).pages[0].stickyNotes!.map((n) => n.id)).toEqual(["back", "front"]);
    expect(normalizeNotebook(peer).pages[0].stickyNotes!.map((n) => n.id)).toEqual(["back", "front"]);
  });
  it("renders a fixed content coordinate space when the visible frame changes", () => {
    const sticky = note("p"); sticky.strokes[0].points = [sticky.strokes[0].points[0]];
    const ctx = { save: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(), fillRect: vi.fn(), scale: vi.fn(), translate: vi.fn(), fillText: vi.fn(), measureText: vi.fn((text: string) => ({ width: text.length * 10 })), arc: vi.fn(), fill: vi.fn(), restore: vi.fn() };
    paintStickyBoard(ctx as unknown as CanvasRenderingContext2D, sticky, 400, 300);
    paintStickyBoard(ctx as unknown as CanvasRenderingContext2D, { ...sticky, width: .1, height: .1 }, 100, 80);
    expect(ctx.arc.mock.calls[0]).toEqual(ctx.arc.mock.calls[1]);
    expect(ctx.arc.mock.calls[0].slice(0, 2)).toEqual([4000, 8000]);
    expect(ctx.translate.mock.calls).toEqual([[-4000, -8000], [-4000, -8000]]);
  });
  it("preserves content beyond the frame and unit square through resize and normalization", () => {
    const book = createNotebook(), sticky = note("wrong"); book.pages[0].stickyNotes = [sticky];
    sticky.width = .1; sticky.height = .05;
    const result = normalizeNotebook(JSON.parse(JSON.stringify(book))).pages[0].stickyNotes![0];
    expect(result.pageId).toBe(book.pages[0].id); expect(result.strokes[0].points).toEqual(sticky.strokes[0].points);
    expect(result.text).toBe(sticky.text); expect(result.scrollX).toBe(4000); expect(result.boardPageWidth).toBe(600);
    expect(normalizeSticky({ ...sticky, color: "url(secret)", x: NaN }, "p")).toBeNull();
    expect(normalizeSticky({ ...sticky, color: "url(secret)" }, "p")!.color).toBe("#fff1a8");
    expect(normalizeNotebook(createNotebook()).pages[0].stickyNotes).toBeUndefined();
    expect(notebookHasInk(book)).toBe(true);
  });
  it("merges independent handwriting and text without stale geometry resurrecting deleted notes", () => {
    const a = createNotebook(); a.pages[0].stickyNotes = [note(a.pages[0].id)]; const b = structuredClone(a);
    a.pages[0].stickyNotes![0].text = "Peer text"; a.pages[0].stickyNotes![0].textUpdatedAt = 3;
    a.pages[0].stickyNotes![0].updatedAt = 3;
    b.pages[0].stickyNotes![0].width = .2; b.pages[0].stickyNotes![0].updatedAt = 4;
    b.pages[0].stickyNotes![0].strokes.push({ ...b.pages[0].stickyNotes![0].strokes[0], id: "peer-ink", updatedAt: 4 });
    const merged = mergeNotebooks(a, b).pages[0].stickyNotes![0];
    expect(merged.text).toBe("Peer text"); expect(merged.width).toBe(.2); expect(merged.strokes).toHaveLength(2);
    expect(mergeNotebooks(b, a).pages[0].stickyNotes).toEqual(mergeNotebooks(a, b).pages[0].stickyNotes);
    b.pages[0].deletedStickyNotes = { "sticky-a": 5 };
    expect(mergeNotebooks(a, b).pages[0].stickyNotes).toEqual([]);
    b.pages[0].stickyNotes![0].updatedAt = 6;
    expect(mergeNotebooks(a, b).pages[0].stickyNotes).toHaveLength(1);
  });
  it("isolates worker patches and snapshots, and rejects stale removed notes", () => {
    const book = createNotebook(), page = book.pages[0], sticky = note(page.id);
    const patch = (upsert: StickyNote[], remove: string[], deletedStickyNotes: Record<string, number>) => applyNotebookOperation(book,
      { type: "patch-sticky-notes", pageId: page.id, upsert, remove, deletedStickyNotes, pageUpdatedAt: 2, notebookUpdatedAt: 2 });
    patch([sticky], [], {}); sticky.strokes[0].points[0].x = 90;
    expect(page.stickyNotes![0].strokes[0].points[0].x).toBe(4);
    const copy = clonePageValue(page); copy.stickyNotes![0].strokes[0].points[0].x = 100;
    expect(page.stickyNotes![0].strokes[0].points[0].x).toBe(4);
    patch([], [sticky.id], { [sticky.id]: 5 }); patch([sticky], [], {}); expect(page.stickyNotes).toEqual([]);
    sticky.updatedAt = 6; patch([sticky], [], {}); expect(page.stickyNotes).toHaveLength(1);
  });
  it("derives index from ink/PDF files, searches title/text/keywords and optional recognized terms", async () => {
    const app = imageVaultApp(), book = createNotebook(); book.pages[0].stickyNotes = [note(book.pages[0].id)];
    book.pages[0].stickyNotes![0].strokes[0].points = Array.from({length:100},(_,i)=>({x:4+i/100,y:8,pressure:.5,t:i+1}));
    const compressed = serializeStoredJson(book); expect(compressed).toContain("INK-GZIP-1");
    await app.vault.create("Course.ink", compressed);
    await app.vault.create("Broken.ink", "invalid");
    await app.vault.createBinary("Paper.pdf", new ArrayBuffer(2));
    const sidecar = createSidecar("Paper.pdf", { sha256: "a".repeat(64), byteLength: 2 }, [{ width: 600, height: 800, rotation: 0 }]);
    sidecar.notebook.pages[0].stickyNotes = [{ ...note(sidecar.notePages[0].id), title: "PDF note", text: "exam review" }];
    await app.vault.create(`${PDF_INK_FOLDER}/Paper.pdfink.json`, serializeStoredJson(sidecar));
    // The preview vault supplies no parent; use the host's parent metadata as Obsidian does.
    const pdf = app.vault.getAbstractFileByPath(`${PDF_INK_FOLDER}/Paper.pdfink.json`)!;
    Object.assign(pdf, { parent: { path: PDF_INK_FOLDER } });
    const result = await collectStickyEntries(app, new AbortController().signal);
    expect(result.entries).toHaveLength(2); expect(result.errors).toHaveLength(1);
    expect(filterStickyEntries(result.entries, "physics 你好")).toHaveLength(1);
    expect(filterStickyEntries(result.entries, "diagrams")).toHaveLength(2);
    expect(filterStickyEntries(result.entries, "exam")[0].file).toBe("Paper.pdf");
    result.entries[0].handwritingTerms = ["recognized formula"];
    expect(filterStickyEntries(result.entries, "formula")).toHaveLength(1);
    const controller = new AbortController(); controller.abort();
    expect((await collectStickyEntries(app, controller.signal)).entries).toEqual([]);
  });
  it("indexes each PDF note once when a conflict copy mirrors the same sidecar", async () => {
    const app = imageVaultApp();
    await app.vault.createBinary("Paper.pdf", new ArrayBuffer(2));
    const sidecar = createSidecar("Paper.pdf", { sha256: "a".repeat(64), byteLength: 2 }, [{ width: 600, height: 800, rotation: 0 }]);
    const shared = { ...note(sidecar.notePages[0].id), title: "PDF note", text: "exam review" };
    sidecar.notebook.pages[0].stickyNotes = [{ ...shared, updatedAt: 2 }];
    await app.vault.create(`${PDF_INK_FOLDER}/Paper.pdfink.json`, serializeStoredJson(sidecar));
    const conflict = structuredClone(sidecar);
    conflict.notebook.pages[0].stickyNotes = [{ ...shared, updatedAt: 1 }];
    await app.vault.create(`${PDF_INK_FOLDER}/Paper.conflict-1700000000000.pdfink.json`, serializeStoredJson(conflict));
    // The preview vault supplies no parent; use the host's parent metadata as Obsidian does.
    for (const path of [`${PDF_INK_FOLDER}/Paper.pdfink.json`, `${PDF_INK_FOLDER}/Paper.conflict-1700000000000.pdfink.json`])
      Object.assign(app.vault.getAbstractFileByPath(path)!, { parent: { path: PDF_INK_FOLDER } });
    const result = await collectStickyEntries(app, new AbortController().signal);
    const paper = result.entries.filter((entry) => entry.file === "Paper.pdf");
    expect(paper).toHaveLength(1);
    expect(paper[0].note.updatedAt).toBe(2);
    expect(result.errors).toEqual([]);
  });
  it("encodes stable vault/file/page/note IDs in external links and deep-clones recognizer inputs", () => {
    const url = new URL(stickyLink("笔记/#?.ink", "p #?", "n#?", "My vault"));
    expect(url.searchParams.get("file")).toBe("笔记/#?.ink"); expect(url.searchParams.get("page")).toBe("p #?");
    expect(url.searchParams.get("vault")).toBe("My vault");
    const sticky = note("p"); sticky.strokes[0].dynamics = { pressureCurve: [[0, 0], [1, 1]] };
    const copy = cloneSticky(sticky); copy.strokes[0].dynamics!.pressureCurve![0][1] = 1;
    expect(sticky.strokes[0].dynamics!.pressureCurve![0][1]).toBe(0);
  });
  it("adds optional handwriting terms without modifying note data and cancels work when closed", async () => {
    const app = imageVaultApp(), sticky = note("p"), entry = { file: "Course.ink", pageId: "p", pageTitle: "Page 1", note: sticky };
    const open = vi.fn(async () => undefined), indexer = vi.fn(async (copy: Readonly<StickyNote>) => { copy.strokes[0].points[0].x = 50; return ["recognized formula"]; });
    const modal = new StickySearchModal(app, open, () => ({ files: [entry.file], entries: [entry] }), indexer); modal.open();
    await vi.waitFor(() => expect(indexer).toHaveBeenCalledOnce());
    const search = modal.contentEl.querySelector("input")!; search.value = "formula"; search.dispatchEvent(new Event("input"));
    await vi.waitFor(() => expect(modal.contentEl.querySelector("button")).not.toBeNull());
    expect(sticky.strokes[0].points[0].x).toBe(4); modal.close();
    let signal!: AbortSignal;
    const slow = new StickySearchModal(app, open, () => ({ files: [], entries: [entry] }), (_copy, abort) => { signal = abort; return new Promise(() => undefined); });
    slow.open(); await vi.waitFor(() => expect(signal).toBeDefined()); slow.close(); expect(signal.aborted).toBe(true);
  });
  it("uses live empty pages instead of showing deleted notes from disk", async () => {
    const app = imageVaultApp(), book = createNotebook(); book.pages[0].stickyNotes = [note(book.pages[0].id)];
    await app.vault.create("Course.ink", JSON.stringify(book));
    const modal = new StickySearchModal(app, vi.fn(async () => undefined), () => ({ files: ["Course.ink"], entries: [] })); modal.open();
    await vi.waitFor(() => expect(modal.contentEl.querySelector('[role="status"]')?.textContent).toBe("0 sticky notes"));
    expect(modal.contentEl.querySelector("button")).toBeNull(); modal.close();
  });
});
