import { createElement, icons } from "lucide";

// The editing preview/test host emulates a tablet. Device-default tests set
// these facts explicitly; production reads Obsidian's real Platform object.
export const Platform = { isDesktopApp: false, isMobileApp: true, isPhone: false, isTablet: true };

// Minimal host adapter for exercising the real plugin view in a browser.
function createEl(this: HTMLElement, tag: string, options: any = {}) {
  const element = document.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text) element.textContent = options.text;
  for (const key of ["type", "value", "placeholder"]) if (options[key] !== undefined) (element as any)[key] = options[key];
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  this.append(element);
  return element;
}
Object.assign(HTMLElement.prototype, {
  createEl,
  createDiv(this: HTMLElement, options: any) { return createEl.call(this, "div", options); },
  createSpan(this: HTMLElement, options: any) { return createEl.call(this, "span", options); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  addClass(this: HTMLElement, ...names: string[]) { this.classList.add(...names); },
  removeClass(this: HTMLElement, ...names: string[]) { this.classList.remove(...names); },
  hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
  toggleClass(this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); },
  toggle(this: HTMLElement, value: boolean) { this.style.display = value ? "" : "none"; },
  setText(this: HTMLElement, text: string) { this.textContent = text; return this; },
  setCssStyles(this: HTMLElement, styles: Record<string, string>) { Object.assign(this.style, styles); },
});
export class FileView {
  app = { scope: {}, workspace: { requestSaveLayout() {} } };
  containerEl = document.querySelector<HTMLElement>("#host")!;
  /** Obsidian's ItemView exposes the .view-content pane as contentEl; the
   *  preview shell provides it as containerEl.children[1], mirroring the
   *  [header, content] children of a real view container. Views mount
   *  popovers on contentEl so they inherit the view's --ink-* token scope
   *  (mounted on containerEl they fall outside it and render transparent).
   *  Null-safe: some tests construct views without a host in the DOM. */
  contentEl = (this.containerEl?.children[1] ?? this.containerEl) as HTMLElement;
  file = null;
  scope: any;
  cleanups: (() => void)[] = [];
  constructor(_leaf: any) {}
  getState(): Record<string, unknown> { return {}; }
  async setState(_state: unknown, _result: unknown): Promise<void> {}
  register(callback: () => void) { this.cleanups.push(callback); }
  registerDomEvent(target: EventTarget, name: string, callback: any, options?: any) {
    target.addEventListener(name, callback, options);
    this.register(() => target.removeEventListener(name, callback, options));
  }
}
export class Scope {
  constructor(_parent: any) {}
  register(modifiers: string[], key: string, callback: () => void) {
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === key && event.shiftKey === modifiers.includes("Shift")) {
        event.preventDefault(); callback();
      }
    });
  }
}
export function setIcon(element: HTMLElement, name: string) {
  const key = name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("");
  const icon = icons[key as keyof typeof icons];
  if (icon) element.append(createElement(icon));
}
export class Menu {
  private static visible: Menu | null = null;
  private hideCallbacks: (() => void)[] = [];
  private dismissCleanup: (() => void) | null = null;
  element = document.createElement("div");
  constructor() { this.element.className = "preview-menu menu"; }
  addItem(build: (item: any) => void) {
    const button = document.createElement("button");
    const item = {
      setTitle: (title: string) => { button.textContent = title; return item; },
      setChecked: (checked: boolean) => { button.setAttribute("aria-pressed", String(checked)); return item; },
      setDisabled: (disabled: boolean) => { button.disabled = disabled; return item; },
      setIcon: (icon: string) => { button.dataset.icon = icon; return item; },
      onClick: (callback: () => void) => { button.onclick = () => { this.hide(); callback(); }; return item; },
    };
    build(item); this.element.append(button); return this;
  }
  addSeparator() { this.element.append(document.createElement("hr")); }
  onHide(callback: () => void) { this.hideCallbacks.push(callback); }
  hide() {
    const wasOpen = this.element.isConnected || Menu.visible === this;
    this.element.remove();
    this.dismissCleanup?.();
    this.dismissCleanup = null;
    if (Menu.visible === this) Menu.visible = null;
    if (wasOpen) this.hideCallbacks.forEach((callback) => callback());
    return this;
  }
  showAtMouseEvent(event: MouseEvent) {
    Menu.visible?.hide();
    Menu.visible = this;
    document.body.append(this.element);
    this.element.style.left = Math.min(event.clientX, innerWidth - 200) + "px";
    this.element.style.top = event.clientY + "px";
    const close = (e: PointerEvent) => { if (!this.element.contains(e.target as Node)) this.hide(); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") this.hide(); };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape);
    this.dismissCleanup = () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape);
    };
    return this;
  }
}
export class Notice { constructor(message: string) { console.warn(message); } }
export class TFile {}
export function normalizePath(path: string): string { return path.replace(/\\/g, "/").replace(/\/+/g, "/"); }
export class WorkspaceLeaf {}
export class App {}
export async function loadPdfJs(): Promise<never> { throw new Error("PDF decoding is unavailable in the browser preview fixture"); }
/** pdf-view's RecoveryChoiceModal extends this at module load; the preview
 *  never opens one, the jsdom unit tests only need the class to exist. */
export class Modal {
  containerEl = document.createElement("div");
  modalEl = document.createElement("div");
  titleEl = document.createElement("h2");
  contentEl = document.createElement("div");
  private previousFocus: HTMLElement | null = null;
  private escape = (event: KeyboardEvent) => { if (event.key === "Escape") this.close(); };
  constructor(public app?: unknown) {
    this.containerEl.className = "preview-modal-container";
    this.modalEl.className = "preview-modal modal";
    this.contentEl.className = "modal-content";
    this.modalEl.setAttribute("role", "dialog");
    this.modalEl.setAttribute("aria-modal", "true");
    this.modalEl.append(this.titleEl, this.contentEl);
    this.containerEl.append(this.modalEl);
  }
  setTitle(title: string) { this.titleEl.textContent = title; this.modalEl.setAttribute("aria-label", title); return this; }
  open(): void {
    this.previousFocus = document.activeElement as HTMLElement | null;
    document.body.append(this.containerEl);
    document.addEventListener("keydown", this.escape);
    this.onOpen();
  }
  close(): void {
    this.containerEl.remove();
    document.removeEventListener("keydown", this.escape);
    this.onClose();
    this.previousFocus?.focus();
  }
  onOpen(): void {}
  onClose(): void {}
}
export class SuggestModal<T> extends Modal {
  inputEl = document.createElement("input");
  resultContainerEl = document.createElement("div");
  emptyStateText = "No results";
  constructor(app?: unknown) {
    super(app);
    this.contentEl.append(this.inputEl, this.resultContainerEl);
    this.inputEl.addEventListener("input", () => this.refresh());
    this.inputEl.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const first = this.getSuggestions(this.inputEl.value)[0];
      if (first !== undefined) { event.preventDefault(); this.close(); this.onChooseSuggestion(first, event); }
    });
  }
  setPlaceholder(value: string) { this.inputEl.placeholder = value; this.inputEl.setAttribute("aria-label", value); }
  onOpen(): void { this.refresh(); this.inputEl.focus(); }
  getSuggestions(_query: string): T[] { return []; }
  renderSuggestion(_value: T, _el: HTMLElement): void {}
  onChooseSuggestion(_value: T, _event: MouseEvent | KeyboardEvent): void {}
  private refresh(): void {
    this.resultContainerEl.replaceChildren();
    const results = this.getSuggestions(this.inputEl.value);
    if (!results.length) this.resultContainerEl.textContent = this.emptyStateText;
    for (const result of results) {
      const row = document.createElement("div");
      row.className = "suggestion-item";
      this.renderSuggestion(result, row);
      row.addEventListener("click", (event) => { this.close(); this.onChooseSuggestion(result, event); });
      this.resultContainerEl.append(row);
    }
  }
}
export class MarkdownRenderChild {
  constructor(public containerEl: HTMLElement) {}
  registerEvent(_event: unknown) {}
}

export class Component { load() {} unload() {} }
// Preview adapter uses safe text nodes; production uses Obsidian's renderer.
export class MarkdownRenderer {
  static async render(_app: unknown, markdown: string, el: HTMLElement, _source: string, _component: Component) {
    for (const line of markdown.split("\n")) {
      const match = /^(#{1,6}) (.*)$/.exec(line);
      const p = el.createEl((match ? `h${match[1].length}` : "p") as keyof HTMLElementTagNameMap);
      const text = match ? match[2] : line;
      const parts = text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^ )]+\))/g);
      for (const part of parts) {
        if (part.startsWith("**") && part.endsWith("**")) p.createEl("strong", { text: part.slice(2, -2) });
        else { const link = /^\[([^\]]+)\]\(([^ )]+)\)$/.exec(part);
          if (link && /^(https?:|obsidian:|#)/.test(link[2])) p.createEl("a", { text: link[1], attr: { href: link[2] } });
          else p.append(document.createTextNode(part)); }
      }
    }
  }
}
