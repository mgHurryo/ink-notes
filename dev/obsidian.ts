import { createElement, icons } from "lucide";

// Minimal host adapter for exercising the real plugin view in a browser.
function createEl(this: HTMLElement, tag: string, options: any = {}) {
  const element = document.createElement(tag);
  if (options.cls) element.className = options.cls;
  if (options.text) element.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) element.setAttribute(key, String(value));
  this.append(element);
  return element;
}
Object.assign(HTMLElement.prototype, {
  createEl,
  createDiv(this: HTMLElement, options: any) { return createEl.call(this, "div", options); },
  createSpan(this: HTMLElement, options: any) { return createEl.call(this, "span", options); },
  empty(this: HTMLElement) { this.replaceChildren(); },
  addClass(this: HTMLElement, name: string) { this.classList.add(name); },
  hasClass(this: HTMLElement, name: string) { return this.classList.contains(name); },
  toggleClass(this: HTMLElement, name: string, value: boolean) { this.classList.toggle(name, value); },
});
export class FileView {
  app = { scope: {} };
  containerEl = document.querySelector<HTMLElement>("#host")!;
  file = null;
  scope: any;
  cleanups: (() => void)[] = [];
  constructor(_leaf: any) {}
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
  element = document.createElement("div");
  constructor() { this.element.className = "preview-menu"; }
  addItem(build: (item: any) => void) {
    const button = document.createElement("button");
    const item = {
      setTitle: (title: string) => { button.textContent = title; return item; },
      setChecked: (checked: boolean) => { button.setAttribute("aria-pressed", String(checked)); return item; },
      setDisabled: (disabled: boolean) => { button.disabled = disabled; return item; },
      onClick: (callback: () => void) => { button.onclick = () => { callback(); this.element.remove(); }; return item; },
    };
    build(item); this.element.append(button); return this;
  }
  addSeparator() { this.element.append(document.createElement("hr")); }
  showAtMouseEvent(event: MouseEvent) {
    document.querySelector(".preview-menu")?.remove();
    document.body.append(this.element);
    this.element.style.left = Math.min(event.clientX, innerWidth - 200) + "px";
    this.element.style.top = event.clientY + "px";
    const close = (e: PointerEvent) => { if (!this.element.contains(e.target as Node)) { this.element.remove(); document.removeEventListener("pointerdown", close); } };
    document.addEventListener("pointerdown", close);
  }
}
export class Notice { constructor(message: string) { console.warn(message); } }
export class TFile {}
export class WorkspaceLeaf {}
export class App {}
export class MarkdownRenderChild {
  constructor(public containerEl: HTMLElement) {}
  registerEvent(_event: unknown) {}
}
