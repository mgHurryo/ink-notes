import { App, Modal, SuggestModal, TFile, setIcon } from "obsidian";

/** Keep creation outside the filtered results so it never disappears. */
export class NotebookSuggestModal extends SuggestModal<TFile> {
  private actions: HTMLElement | null = null;

  constructor(app: App, private readonly files: TFile[], private readonly select: (file: TFile) => void,
    private readonly create: (title: string) => Promise<void>, private readonly rename: (file: TFile, title: string) => Promise<void>) {
    super(app);
    this.setPlaceholder("Search Ink notebooks");
    this.emptyStateText = "No notebooks found";
  }

  onOpen(): void {
    super.onOpen();
    this.modalEl.addClass("ink-notebook-picker");
    this.actions = this.modalEl.createDiv({ cls: "ink-notebook-picker-actions" });
    this.modalEl.prepend(this.actions);
    this.actions.createEl("span", { text: "Ink notebooks" });
    const button = this.actions.createEl("button", { cls: "ink-notebook-create", attr: {
      type: "button", title: "Create Ink notebook", "aria-label": "Create Ink notebook",
    } });
    setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), "plus");
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    button.addEventListener("click", () => {
      this.close();
      new NotebookNameModal(this.app, "Create Ink notebook", "Ink Notebook", "Create", this.create).open();
    });
  }

  onClose(): void {
    this.actions?.remove();
    this.actions = null;
    super.onClose();
  }

  getSuggestions(query: string): TFile[] {
    const search = query.trim().toLowerCase();
    return this.files.filter((file) => !search || file.path.toLowerCase().includes(search));
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.addClass("ink-notebook-result");
    const name = el.createDiv({ cls: "ink-notebook-result-name" });
    name.createDiv({ text: file.basename });
    name.createDiv({ text: file.path, cls: "ink-notebook-result-path" });
    const rename = el.createEl("button", { cls: "ink-notebook-rename", attr: {
      type: "button", title: "Rename notebook", "aria-label": `Rename ${file.basename}`,
    } });
    setIcon(rename.createSpan({ attr: { "aria-hidden": "true" } }), "pencil");
    rename.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") event.stopPropagation();
    });
    rename.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      new NotebookNameModal(this.app, "Rename Ink notebook", file.basename, "Rename",
        (title) => this.rename(file, title)).open();
    });
  }

  onChooseSuggestion(file: TFile, event: MouseEvent | KeyboardEvent): void {
    if ((event.target as HTMLElement | null)?.closest?.("button")) return;
    this.select(file);
  }
}

export class NotebookNameModal extends Modal {
  constructor(app: App, private readonly heading: string, private readonly initialName: string,
    private readonly action: string, private readonly submitName: (title: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.heading);
    this.modalEl.addClass("ink-notebook-name-modal");
    const form = this.contentEl.createEl("form", { cls: "ink-notebook-name-form" });
    const label = form.createEl("label", { text: "Notebook name" });
    const input = label.createEl("input", { attr: { type: "text", required: "", maxlength: "80" } });
    input.value = this.initialName;
    const error = form.createDiv({ cls: "ink-notebook-name-error", attr: { role: "alert" } });
    const actions = form.createDiv({ cls: "ink-notebook-name-actions" });
    const cancel = actions.createEl("button", { text: "Cancel", attr: { type: "button" } });
    const submit = actions.createEl("button", { text: this.action, cls: "mod-cta", attr: { type: "submit" } });
    cancel.addEventListener("click", () => this.close());
    let pending = false;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (pending) return;
      const title = input.value.trim();
      if (!title || title.length > 80 || /[\\/:*?"<>|#^\[\]]/.test(title) || /\.$/.test(title)) {
        error.setText("Enter a valid notebook name without path or reserved characters.");
        input.focus();
        return;
      }
      pending = true;
      input.disabled = cancel.disabled = submit.disabled = true;
      error.setText("");
      void this.submitName(title).then(() => this.close()).catch((reason: unknown) => {
        error.setText(`Could not ${this.action.toLowerCase()} notebook: ${reason instanceof Error ? reason.message : String(reason)}`);
      }).finally(() => {
        pending = false;
        input.disabled = cancel.disabled = submit.disabled = false;
      });
    });
    input.focus();
    input.select();
  }

  onClose(): void { this.contentEl.empty(); }
}
