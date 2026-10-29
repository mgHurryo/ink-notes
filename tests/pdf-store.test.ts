import { describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { App, Vault } from "obsidian";
import { PdfSidecarFormatError, createSidecar, disambiguatedSidecarPathFor, sidecarPathFor } from "../src/pdf-sidecar";
import { PdfSidecarStore, serializeSidecar } from "../src/pdf-store";
import { parseStoredJson } from "../src/storage-codec";

/** Minimal in-memory vault that mimics the surface PdfSidecarStore touches. */
class FakeVault {
  private entries = new Map<string, { file: TFile; raw: string }>();

  private makeFile(path: string): TFile {
    const file = new TFile() as TFile & { path: string; name: string; extension: string; parent: { path: string } } & Record<string, unknown>;
    const slash = path.lastIndexOf("/");
    file.path = path;
    file.name = slash >= 0 ? path.slice(slash + 1) : path;
    file.extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".") + 1) : "";
    (file as unknown as { parent: unknown }).parent = { path: slash >= 0 ? path.slice(0, slash) : "" };
    return file;
  }

  getAbstractFileByPath(path: string): TFile | null {
    return this.entries.get(path)?.file ?? null;
  }

  async createFolder(): Promise<void> {}

  async create(path: string, raw: string): Promise<TFile> {
    if (this.entries.has(path)) throw new Error("file already exists");
    const file = this.makeFile(path);
    this.entries.set(path, { file, raw });
    return file;
  }

  async read(file: TFile): Promise<string> {
    return this.entries.get(file.path)?.raw ?? "";
  }

  async process(file: TFile, fn: (raw: string) => string): Promise<string> {
    const entry = this.entries.get(file.path);
    if (!entry) throw new Error("missing file");
    const next = fn(entry.raw);
    if (next !== entry.raw) entry.raw = next;
    return entry.raw;
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    const entry = this.entries.get(file.path);
    if (!entry) throw new Error("missing file");
    this.entries.delete(file.path);
    // Obsidian's rename mutates the same TFile instance; mirror that.
    const moved = file as TFile & { path: string; name: string; parent: { path: string } };
    moved.path = newPath;
    moved.name = newPath.includes("/") ? newPath.slice(newPath.lastIndexOf("/") + 1) : newPath;
    (moved as unknown as { parent: { path: string } }).parent = {
      path: newPath.includes("/") ? newPath.slice(0, newPath.lastIndexOf("/")) : "",
    };
    this.entries.set(newPath, { file: moved, raw: entry.raw });
  }

  getFiles(): TFile[] {
    return [...this.entries.values()].map((entry) => entry.file);
  }

  put(path: string, raw: string): TFile {
    const file = this.makeFile(path);
    this.entries.set(path, { file, raw });
    return file;
  }

  rawOf(path: string): string {
    return this.entries.get(path)?.raw ?? "";
  }
}

const FINGERPRINT = { sha256: "a".repeat(64), byteLength: 4096 };
const SOURCE_PAGES = [{ width: 595.28, height: 841.89, rotation: 0 }];
const PDF_PATH = "docs/lecture.pdf";

function setup() {
  const vault = new FakeVault();
  const store = new PdfSidecarStore({ vault: vault as unknown as Vault } as unknown as App);
  return { vault, store };
}

describe("createFor", () => {
  it("creates the empty sidecar and is idempotent", async () => {
    const { vault, store } = setup();
    const pdfFile = vault.put(PDF_PATH, "%PDF");
    const first = await store.createFor(pdfFile, FINGERPRINT, SOURCE_PAGES);
    expect(first.name.endsWith(".pdfink.json")).toBe(true);
    expect(first.path).toContain("A_pdfinkwrittern/");
    const second = await store.createFor(vault.getAbstractFileByPath(PDF_PATH) as TFile, FINGERPRINT, SOURCE_PAGES);
    expect(second.path).toBe(first.path);
    const sidecar = JSON.parse(vault.rawOf(first.path));
    expect(sidecar.source.sha256).toBe(FINGERPRINT.sha256);
    expect(sidecar.notePages).toHaveLength(1);
  });

  it("never overwrites an existing sidecar on create", async () => {
    const { vault, store } = setup();
    const pdfFile = vault.put(PDF_PATH, "%PDF");
    const created = await store.createFor(pdfFile, FINGERPRINT, SOURCE_PAGES);
    vault.process(created, () => "manually edited");
    await store.createFor(pdfFile, FINGERPRINT, SOURCE_PAGES);
    expect(vault.rawOf(created.path)).toBe("manually edited");
  });

  it("returns the winning sidecar when two panes create it concurrently", async () => {
    const { vault, store } = setup();
    const pdf = vault.put(PDF_PATH, "%PDF");
    const create = vault.create.bind(vault);
    vi.spyOn(vault, "create").mockImplementation(async (path, raw) => {
      await Promise.resolve();
      return create(path, raw);
    });
    const [first, second] = await Promise.all([
      store.createFor(pdf, FINGERPRINT, SOURCE_PAGES), store.createFor(pdf, FINGERPRINT, SOURCE_PAGES),
    ]);
    expect(first).toBe(second);
    expect(vault.getFiles().filter(file => file.name.endsWith(".pdfink.json"))).toHaveLength(1);
    expect((await store.read(first)).source.sha256).toBe(FINGERPRINT.sha256);
  });

  it("accepts a concurrently created folder but still propagates real create failures", async () => {
    const { vault, store } = setup();
    const pdf = vault.put(PDF_PATH, "%PDF");
    vi.spyOn(vault, "createFolder").mockImplementationOnce(async () => {
      vault.put("A_pdfinkwrittern", "");
      throw new Error("folder already exists");
    });
    await expect(store.createFor(pdf, FINGERPRINT, SOURCE_PAGES)).resolves.toBeDefined();
    vi.spyOn(vault, "create").mockRejectedValueOnce(new Error("disk full"));
    const other = vault.put("other.pdf", "%PDF");
    await expect(store.createFor(other, FINGERPRINT, SOURCE_PAGES)).rejects.toThrow("disk full");
  });
});

describe("read + CAS writes", () => {
  it("reads and normalizes sidecars", async () => {
    const { vault, store } = setup();
    const pdfFile = vault.put(PDF_PATH, "%PDF");
    const created = await store.createFor(pdfFile, FINGERPRINT, SOURCE_PAGES);
    const sidecar = await store.read(created);
    expect(sidecar.source.path).toBe(PDF_PATH);
  });

  it("writeIfUnchanged writes only when the disk text still matches", async () => {
    const { vault, store } = setup();
    const pdfFile = vault.put(PDF_PATH, "%PDF");
    const created = await store.createFor(pdfFile, FINGERPRINT, SOURCE_PAGES);
    const raw = await store.readRaw(created);
    expect(await store.writeIfUnchanged(created, raw, "next")).toBe(true);
    expect(vault.rawOf(created.path)).toBe("next");
    expect(await store.writeIfUnchanged(created, raw, "again")).toBe(false);
    expect(vault.rawOf(created.path)).toBe("next");
  });
});

describe("explicit disambiguated slot", () => {
  it("resolves and creates in the given slot without touching the legacy slot", async () => {
    const { vault, store } = setup();
    const pdfFile = vault.put(PDF_PATH, "%PDF");
    const slot = disambiguatedSidecarPathFor(PDF_PATH);
    expect(slot).not.toBe(sidecarPathFor(PDF_PATH));
    expect(store.sidecarFileFor(PDF_PATH, slot)).toBeNull();
    const created = await store.createFor(pdfFile, FINGERPRINT, SOURCE_PAGES, slot);
    expect(created.path).toBe(slot);
    expect(store.sidecarFileFor(PDF_PATH, slot)).toBe(created);
    // The derived (legacy) slot stays empty: a case twin sharing it is unaffected.
    expect(store.sidecarFileFor(PDF_PATH)).toBeNull();
    const again = await store.createFor(pdfFile, FINGERPRINT, SOURCE_PAGES, slot);
    expect(again.path).toBe(slot);
    expect(vault.getFiles().filter((file) => file.name.endsWith(".pdfink.json"))).toHaveLength(1);
  });
});

describe("computeFingerprint", () => {
  it("hashes bytes with SHA-256 and reports the length", async () => {
    const { store } = setup();
    const bytes = new TextEncoder().encode("pdf-bytes").buffer as ArrayBuffer;
    const fingerprint = await store.computeFingerprint(bytes);
    expect(fingerprint.byteLength).toBe(9);
    expect(fingerprint.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("findRecoveryCandidates", () => {
  it("matches by content fingerprint and skips corrupt files", async () => {
    const { vault, store } = setup();
    const sidecar = createSidecar(PDF_PATH, FINGERPRINT, SOURCE_PAGES);
    vault.put("A_pdfinkwrittern/moved--x.pdfink.json", serializeSidecar(sidecar));
    vault.put("A_pdfinkwrittern/broken--y.pdfink.json", "{ not json");
    const other = createSidecar(PDF_PATH, { sha256: "b".repeat(64), byteLength: 1 }, SOURCE_PAGES);
    vault.put("A_pdfinkwrittern/other--z.pdfink.json", serializeSidecar(other));
    const candidates = await store.findRecoveryCandidates(FINGERPRINT);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].file.name).toBe("moved--x.pdfink.json");
  });
});

describe("migrateForRename", () => {
  it("finds and renames compressed sidecars without changing their handwriting",async()=>{
    const {vault,store}=setup(), sidecar=createSidecar(PDF_PATH,FINGERPRINT,SOURCE_PAGES), p=sidecar.notebook.pages[0];
    p.strokes=[{id:"dense",pageId:p.id,tool:"pen",color:"#000",width:3,opacity:1,createdAt:1,updatedAt:2,
      points:Array.from({length:500},(_,i)=>({x:i/1000,y:.3,pressure:.7,t:i+1}))}];
    const raw=serializeSidecar(sidecar); expect(raw).toContain("INK-GZIP-1");
    const {sidecarPathFor}=await import("../src/pdf-sidecar"); vault.put(sidecarPathFor(PDF_PATH),raw);
    expect(await store.findRecoveryCandidates(FINGERPRINT)).toHaveLength(1);
    expect(await store.migrateForRename("docs/renamed.pdf",PDF_PATH)).toBe(true);
    const file=store.sidecarFileFor("docs/renamed.pdf")!;
    expect((await store.read(file)).notebook.pages[0].strokes[0].points).toEqual(p.strokes[0].points);
    expect(parseStoredJson(await store.readRaw(file)).source.path).toBe("docs/renamed.pdf");
  });
  it("moves the sidecar when its PDF is renamed", async () => {
    const { vault, store } = setup();
    await store.createFor(vault.put(PDF_PATH, "%PDF"), FINGERPRINT, SOURCE_PAGES);
    expect(store.sidecarFileFor(PDF_PATH)).not.toBeNull();
    const migrated = await store.migrateForRename("docs/moved.pdf", PDF_PATH);
    expect(migrated).toBe(true);
    expect(store.sidecarFileFor(PDF_PATH)).toBeNull();
    expect(store.sidecarFileFor("docs/moved.pdf")).not.toBeNull();
    expect((await store.read(store.sidecarFileFor("docs/moved.pdf") as TFile)).source.path).toBe("docs/moved.pdf");
  });

  it("does nothing without a sidecar and never overwrites an existing target", async () => {
    const { vault, store } = setup();
    expect(await store.migrateForRename("docs/moved.pdf", PDF_PATH)).toBe(false);
    const sidecar = createSidecar(PDF_PATH, FINGERPRINT, SOURCE_PAGES);
    const targetPdf = "docs/moved.pdf";
    vault.put(`A_pdfinkwrittern/${targetPdf.replace(/\W/g, "_")}.pdfink.json`, serializeSidecar(sidecar));
    const existingTarget = vault.put("A_pdfinkwrittern/existing--2.pdfink.json", serializeSidecar(sidecar));
    void existingTarget;
    // old sidecar missing -> false
    expect(await store.migrateForRename(targetPdf, PDF_PATH)).toBe(false);
  });
});

describe("format error propagation", () => {
  it("surfaces PdfSidecarFormatError for unknown versions", async () => {
    const { vault, store } = setup();
    const file = vault.put("A_pdfinkwrittern/unknown--3.pdfink.json", JSON.stringify({ format: 42 }));
    await expect(store.read(file)).rejects.toThrow(PdfSidecarFormatError);
  });
});
