// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { TFile } from "obsidian";
import type { ImageAsset } from "../src/image-library";
import { ImageLibraryStore, paintPageImages, parseImageLibrary, placedImage } from "../src/image-library";
import { createPage } from "../src/model";
import { imageVaultApp } from "../dev/image-vault";
import { constrainImage } from "../src/page-images";

const libraryPath = "Ink Notes/Images/library.json";
async function seedLibrary() {
  const app = imageVaultApp(), store = new ImageLibraryStore(app);
  await store.group("Photos", "photos");
  const assets: ImageAsset[] = ["a", "b", "c"].map((id) => ({ id, path: `Ink Notes/Images/assets/${id}.png`, name: `${id}.png`, width: 100, height: 50, groupId: "photos" }));
  for (const asset of assets) await app.vault.createBinary(asset.path, new Uint8Array([1, 2, 3]).buffer);
  await app.vault.process(app.vault.getAbstractFileByPath(libraryPath) as TFile, (text) => JSON.stringify({ ...parseImageLibrary(text), assets }));
  return { app, store, assets };
}

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
  it("removes only selected catalog entries and preserves placed-image bytes and peer edits", async () => {
    const { app, store, assets } = await seedLibrary(), peer = new ImageLibraryStore(app);
    const placed = placedImage(assets[0], "page", .5);
    vi.spyOn(app.vault, "getResourcePath").mockReturnValue("asset://image");
    const [removed] = await Promise.all([store.remove(["a", "a", "c", "missing"]), peer.move(["b"], "")]);
    expect(removed.map((asset) => asset.id)).toEqual(["a", "c"]);
    expect((await store.read()).assets).toEqual([{ ...assets[1], groupId: "" }]);
    expect((await store.read()).groups).toEqual([{ id: "photos", name: "Photos" }]);
    expect(new Uint8Array(await store.bytes(placed.assetPath))).toEqual(new Uint8Array([1, 2, 3]));
    expect(store.url(placed.assetPath)).toBe("asset://image");
    expect(await store.remove(["a", "missing"])).toEqual([]);
    expect(await store.remove([])).toEqual([]);
    expect((await store.read()).assets).toHaveLength(1);
  });
  it("undoes removal without overwriting restored peer entries or resurrecting deleted groups", async () => {
    const { app, store, assets } = await seedLibrary(), peer = new ImageLibraryStore(app);
    const removed = await store.remove(["a", "b"]);
    await peer.restore([removed[0]]); await peer.move(["a"], "");
    await app.vault.process(app.vault.getAbstractFileByPath(libraryPath) as TFile, (text) => {
      const library = parseImageLibrary(text); library.groups = [];
      library.assets.push({ ...assets[2], id: "peer-image" });
      return JSON.stringify(library);
    });
    await store.restore([...removed, removed[1]]); await store.restore(removed);
    const library = await store.read();
    expect(library.groups).toEqual([]);
    expect(library.assets).toHaveLength(4);
    expect(library.assets.find((asset) => asset.id === "a")?.groupId).toBe("");
    expect(library.assets.find((asset) => asset.id === "b")?.groupId).toBe("");
    expect(library.assets.find((asset) => asset.id === "peer-image")).toBeDefined();
    expect(removed[1].groupId).toBe("photos");
  });
  it("reports failed writes and can retry deletion and undo without losing catalog entries", async () => {
    const { app, store, assets } = await seedLibrary();
    const process = vi.spyOn(app.vault, "process");
    process.mockRejectedValueOnce(new Error("Disk full"));
    await expect(store.remove(["a", "b"])).rejects.toThrow("Disk full");
    expect((await store.read()).assets).toEqual(assets);
    const removed = await store.remove(["a", "b"]);
    process.mockRejectedValueOnce(new Error("Disk full"));
    await expect(store.restore(removed)).rejects.toThrow("Disk full");
    expect((await store.read()).assets).toEqual([assets[2]]);
    await store.restore(removed);
    expect((await store.read()).assets).toHaveLength(3);
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
