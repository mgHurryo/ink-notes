import { App, TFile, Vault } from "obsidian";
import {
  PdfSidecar,
  PdfSidecarFormatError,
  PdfSourcePageGeometry,
  PDF_INK_FOLDER,
  PDF_SIDECAR_EXTENSION,
  createSidecar,
  normalizeSidecar,
  sidecarPathFor,
} from "./pdf-sidecar";

/**
 * Vault I/O for PDF handwriting sidecars. Sidecars live in a normal vault
 * folder so Obsidian (and sync) treat them like any other file; paths are
 * derived from the PDF path, so no global index is kept.
 */
export class PdfSidecarStore {
  private readonly vault: Vault;

  constructor(app: App) {
    this.vault = app.vault;
  }

  sidecarFileFor(pdfPath: string): TFile | null {
    const file = this.vault.getAbstractFileByPath(sidecarPathFor(pdfPath));
    // TFile.extension is "json" for "*.pdfink.json"; check the full suffix.
    return file instanceof TFile && file.name.endsWith(`.${PDF_SIDECAR_EXTENSION}`) ? file : null;
  }

  /**
   * Create the empty sidecar for a PDF if it does not exist yet. Opening a
   * PDF must never overwrite an existing sidecar — if one is already present
   * (for instance restored by the recovery scan) it is returned as-is.
   */
  async createFor(pdf: TFile, fingerprint: { sha256: string; byteLength: number }, sourcePages: PdfSourcePageGeometry[]): Promise<TFile> {
    await this.ensureFolder();
    const existing = this.sidecarFileFor(pdf.path);
    if (existing) return existing;
    const sidecar = createSidecar(pdf.path, fingerprint, sourcePages);
    try {
      return await this.vault.create(sidecarPathFor(pdf.path), serializeSidecar(sidecar));
    } catch (error) {
      // A split pane may finish creating the same sidecar first.
      const created = this.sidecarFileFor(pdf.path);
      if (created) return created;
      throw error;
    }
  }

  async readRaw(file: TFile): Promise<string> {
    return this.vault.read(file);
  }

  /** Parse + repair; throws PdfSidecarFormatError for corrupt/unknown files. */
  async read(file: TFile): Promise<PdfSidecar> {
    return normalizeSidecar(JSON.parse(await this.readRaw(file)));
  }

  /**
   * Compare-and-sidestep write: only writes when the on-disk raw text is
   * still what the caller last saw. Returns false on mismatch, in which case
   * callers must re-read, merge, and retry — never blind-overwrite.
   */
  async writeIfUnchanged(file: TFile, expectedRaw: string, nextRaw: string): Promise<boolean> {
    let matched = false;
    await this.vault.process(file, (raw) => {
      if (raw !== expectedRaw) return raw;
      matched = true;
      return nextRaw;
    });
    return matched;
  }

  /** SHA-256 + size of the PDF bytes; the fingerprint that gates all writes. */
  async computeFingerprint(bytes: ArrayBuffer): Promise<{ sha256: string; byteLength: number }> {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      byteLength: bytes.byteLength,
    };
  }

  /**
   * Sidecars whose recorded fingerprint matches this PDF's content — the
   * candidates for restoring a sidecar whose PDF was moved while the plugin
   * was not running. Corrupt or unknown-version files are skipped.
   */
  async findRecoveryCandidates(fingerprint: { sha256: string; byteLength: number }): Promise<Array<{ file: TFile; sidecar: PdfSidecar }>> {
    const candidates: Array<{ file: TFile; sidecar: PdfSidecar }> = [];
    for (const file of this.vault.getFiles()) {
      if (!file.name.endsWith(`.${PDF_SIDECAR_EXTENSION}`) || file.parent?.path !== PDF_INK_FOLDER) continue;
      try {
        const sidecar = await this.read(file);
        if (sidecar.source.sha256 === fingerprint.sha256 && sidecar.source.byteLength === fingerprint.byteLength) {
          candidates.push({ file, sidecar });
        }
      } catch (error) {
        if (!(error instanceof PdfSidecarFormatError) && !(error instanceof SyntaxError)) throw error;
      }
    }
    return candidates;
  }

  /**
   * Migrate the sidecar when its PDF is renamed while the plugin runs. Never
   * overwrites an existing sidecar at the destination; when the destination
   * already exists both files are kept and the recovery scan resolves it.
   */
  async migrateForRename(pdfPath: string, oldPdfPath: string): Promise<boolean> {
    const source = this.sidecarFileFor(oldPdfPath);
    const destinationPath = sidecarPathFor(pdfPath);
    const destination = this.vault.getAbstractFileByPath(destinationPath);
    if (!source) return false;
    if (destination) return false;
    await this.ensureFolder();
    await this.vault.rename(source, destinationPath);
    await this.recordSourcePath(source, pdfPath);
    return true;
  }

  /** Best-effort metadata refresh so the sidecar records its PDF's path. */
  private async recordSourcePath(file: TFile, pdfPath: string): Promise<void> {
    try {
      await this.vault.process(file, (raw) => {
        const sidecar = normalizeSidecar(JSON.parse(raw));
        if (sidecar.source.path === pdfPath) return raw;
        sidecar.source.path = pdfPath;
        return serializeSidecar(sidecar);
      });
    } catch {
      // A stale source path is safe: recovery matches on content fingerprint.
    }
  }

  private async ensureFolder(): Promise<void> {
    if (this.vault.getAbstractFileByPath(PDF_INK_FOLDER)) return;
    try {
      await this.vault.createFolder(PDF_INK_FOLDER);
    } catch (error) {
      if (!this.vault.getAbstractFileByPath(PDF_INK_FOLDER)) throw error;
    }
  }
}

export function serializeSidecar(sidecar: PdfSidecar): string {
  return `${JSON.stringify(sidecar, null, 2)}\n`;
}
