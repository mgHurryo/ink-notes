import { TFile, type WorkspaceLeaf } from "obsidian";
import { PdfInkView, VIEW_TYPE_PDF_INK } from "../src/pdf-view";
import { createSidecar } from "../src/pdf-sidecar";
import { serializeSidecar, type PdfSidecarStore } from "../src/pdf-store";
import { PdfTabTakeover } from "../src/pdf-takeover";
import { InkWorkerService } from "../src/worker-service";

/** Blank PDF surface fixture using the real PDF layout/input/worker paths.
 * PDF decoding is independent of sticky chrome and touch navigation. */
export async function openPdfPreview(): Promise<PdfInkView> {
  const sidecar = createSidecar("Preview.pdf", { sha256: "a".repeat(64), byteLength: 2 },
    [{ width: 600, height: 800, rotation: 0 }]);
  let raw = serializeSidecar(sidecar);
  const store = {
    readRaw: async () => raw,
    writeIfUnchanged: async (_file: TFile, expected: string, next: string) => {
      if (expected !== raw) return false;
      raw = next; return true;
    },
  } as unknown as PdfSidecarStore;
  const view = new PdfInkView({} as WorkspaceLeaf);
  view.configure({ store, workers: new InkWorkerService(console.warn),
    takeover: new PdfTabTakeover(() => ({ enabled: false, enhancerActive: false, isPdfFile: () => true }), VIEW_TYPE_PDF_INK) });
  view.file = Object.assign(new TFile(), { path: "Preview.pdf", basename: "Preview" });
  await view.setState({ readingMode: false }, { history: false });
  await view.onOpen();
  const internal = view as any;
  internal.attachSidecar(sidecar, raw, Object.assign(new TFile(), { path: "Preview.pdfink.json" }));
  internal.layoutPage(); internal.renderAll(); await internal.renderPdfPage();
  return view;
}
