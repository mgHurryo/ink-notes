export class TFile {}

export class FileView {
  app = { scope: {} };
  file: TFile | null = null;
}

export class Scope {
  register(): void {}
}

export class Notice {}
