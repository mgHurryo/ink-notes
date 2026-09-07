import "obsidian";

declare module "obsidian" {
  interface Menu {
    onHistoryBack(): void;
  }

  interface Modal {
    onHistoryBack(): void;
  }

  interface PopoverSuggest<T> {
    onHistoryBack(): void;
  }
}
