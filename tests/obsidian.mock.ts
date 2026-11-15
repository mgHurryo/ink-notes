export class TFile {}
export class TFolder {}

export class FileView {
  app = { scope: {} };
  file: TFile | null = null;
}

export class Scope {
  register(): void {}
}

export class Notice {}

export class WorkspaceLeaf {}

export class Menu {}

export class SuggestModal<T> {
  constructor(_app?: unknown) {}
  open(): void {}
  onClose(): void {}
}

export function setIcon(): void {}

export function loadPdfJs(): Promise<unknown> {
  return Promise.resolve({});
}

export class Modal {}

export const Platform = { isDesktopApp: true, isMobileApp: false, isIosApp: false, isPhone: false, isTablet: false };
