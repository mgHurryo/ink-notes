// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { ImageLibraryStore, paintPageImages, parseImageLibrary, placedImage } from "../src/image-library";
import { createPage } from "../src/model";
import { imageVaultApp } from "../dev/image-vault";
import { constrainImage } from "../src/page-images";

describe("managed image library", () => {
  it("does not repaint a deleted image when an older asynchronous thumbnail load finishes", async () => {
    const drawImage = vi.fn(); const ctx = { save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), drawImage };
    const canvas = { width: 100, height: 200, getContext: () => ctx } as unknown as HTMLCanvasElement;
    let finish!: (image: HTMLImageElement) => void;
    const store = { image: () => new Promise<HTMLImageElement>((resolve) => finish = resolve) } as unknown as ImageLibraryStore;
    const page = createPage("Images");
    page.images = [placedImage({ id: "a", path: "Ink Notes/Images/assets/a.png", name: "a", width: 100, height: 100, groupId: "" }, page.id, .5)];
    paintPageImages(store, canvas, page, () => undefined, () => undefined);
    page.images = [];
    paintPageImages(store, canvas, page, () => undefined, () => undefined);
    finish(document.createElement("img")); await new Promise((resolve) => setTimeout(resolve, 0));
    expect(drawImage).not.toHaveBeenCalled();
  });
  it("preserves separate clients' groups with vault process updates", async () => {
    const app = imageVaultApp(); const a = new ImageLibraryStore(app), b = new ImageLibraryStore(app);
    await Promise.all([a.group("Photos", "photos"), b.group("Diagrams", "diagrams")]);
    await b.group("Course photos", "photos");
    expect((await a.read()).groups).toEqual(expect.arrayContaining([{ id: "photos", name: "Course photos" }, { id: "diagrams", name: "Diagrams" }]));
    await expect(a.group(" ")).rejects.toThrow("group name");
    await expect(a.move([], "unknown")).rejects.toThrow("no longer exists");
  });
  it("refuses invalid metadata and paths instead of reading unrelated files", () => {
    expect(() => parseImageLibrary('{"schema":2,"groups":[],"assets":[]}')).toThrow("format");
    expect(() => parseImageLibrary(JSON.stringify({ schema: 1, groups: [], assets: [{ id: "i", path: "Secret.png", name: "x", width: 1, height: 1, groupId: "" }] }))).toThrow("entry");
    const store = new ImageLibraryStore(imageVaultApp());
    expect(() => store.url("../../secret.png")).toThrow("Invalid managed");
    expect(() => store.url("Ink Notes/Images/assets/missing.png")).toThrow("missing");
  });
  it("creates independent aspect-correct instances and keeps edits within the page", () => {
    const asset = { id: "a", path: "Ink Notes/Images/assets/image-a.png", name: "a", width: 1600, height: 900, groupId: "" };
    const a = placedImage(asset, "page-a", 1600 / 2200), b = placedImage(asset, "page-b", 1600 / 2200);
    expect(a.id).not.toBe(b.id); expect(a.foreground).toBe(false);
    expect(a.width * 1600 / (a.height * 2200)).toBeCloseTo(1600 / 900);
    const changed = constrainImage({ ...a, x: -1, y: 2 });
    expect(changed.x).toBe(0); expect(changed.y + changed.height).toBe(1); expect(b.x).toBe(.25);
  });
});
