// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("obsidian", async () => import("../dev/obsidian"));
import { Platform, FileView, type WorkspaceLeaf } from "obsidian";
import { InkView } from "../src/view";
import { PdfInkView } from "../src/pdf-view";
import { createNotebook } from "../src/model";
import type { NotebookStore } from "../src/storage";

const views: (InkView | PdfInkView)[] = [];
const originalPlatform = { ...Platform };
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    new Proxy({}, { get: () => vi.fn(), set: () => true }) as CanvasRenderingContext2D);
});
afterEach(async () => {
  for (const view of views.splice(0)) {
    await view.onClose();
    (view as any).cleanups.forEach((cleanup: () => void) => cleanup());
  }
  vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren();
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  Object.assign(Platform, originalPlatform);
});

function device(desktop: boolean, shortEdge = 1024) {
  Object.assign(Platform, { isDesktopApp: desktop, isMobileApp: !desktop,
    isPhone: !desktop && shortEdge < 600, isTablet: !desktop && shortEdge >= 600 });
  vi.spyOn(window.screen, "width", "get").mockReturnValue(shortEdge);
  vi.spyOn(window.screen, "height", "get").mockReturnValue(1366);
}

async function open(mode: "ink" | "pdf", state?: Record<string, unknown>) {
  document.querySelector("#host")?.removeAttribute("id");
  const host = document.createElement("div"); host.id = "host";
  host.innerHTML = "<div></div><main></main>"; document.body.append(host);
  const view = mode === "ink"
    ? new InkView({} as WorkspaceLeaf, { read: async () => createNotebook("test") } as unknown as NotebookStore)
    : new PdfInkView({} as WorkspaceLeaf);
  views.push(view);
  if (state) await view.setState(state, { history: false });
  await view.onOpen();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Reading mode"]')!;
  return { view, host, toggle };
}

for (const mode of ["ink", "pdf"] as const) describe(`${mode} device mode lifecycle`, () => {
  it.each([[true, 1200, true], [false, 390, true], [false, 1024, false]] as const)(
    "starts with device default for desktop=%s / screen=%s", async (desktop, size, reading) => {
      device(desktop, size);
      const { view, host, toggle } = await open(mode);
      expect(toggle.getAttribute("aria-pressed")).toBe(String(reading));
      expect(host.querySelector("main")!.classList.contains("ink-reading")).toBe(reading);
      expect(view.getState().readingMode).toBe(reading);
      if (mode === "pdf") expect(host.querySelector("main")!.classList.contains("ink-pdf-editing")).toBe(!reading);
    });

  it("keeps iPad handwriting priority in narrow multiwindow UI", async () => {
    device(false, 320);
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Macintosh; Intel Mac OS X)");
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    const { toggle } = await open(mode);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("preserves a user's choice on resize, toolbar rebuild, and workspace restore", async () => {
    device(true);
    const { view, toggle } = await open(mode);
    toggle.click(); // Explicit editing on a reading-default computer.
    expect(view.getState().readingMode).toBe(false);
    device(false, 390);
    window.dispatchEvent(new Event("resize"));
    if (mode === "ink") (view as any).renderToolbar();
    else (view as any).renderToolbar((view as any).root);
    expect(view.getState().readingMode).toBe(false);
    const restored = await open(mode, view.getState());
    expect(restored.toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps split views independent and retains parent workspace state", async () => {
    device(false);
    const a = await open(mode), b = await open(mode);
    a.toggle.click();
    expect(a.view.getState().readingMode).toBe(true);
    expect(b.view.getState().readingMode).toBe(false);
    vi.spyOn(FileView.prototype, "getState").mockReturnValue({ file: "notes.ink", extra: "retained" });
    expect(a.view.getState()).toEqual({ file: "notes.ink", extra: "retained", readingMode: true });
    const parent = vi.spyOn(FileView.prototype, "setState");
    await b.view.setState({ file: "test.pdf", readingMode: true }, { history: false });
    expect(parent).toHaveBeenCalledWith({ file: "test.pdf", readingMode: true }, { history: false });
    expect(b.toggle.getAttribute("aria-pressed")).toBe("true");
  });
});
