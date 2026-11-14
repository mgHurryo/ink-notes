import { setIcon } from "obsidian";
import { InkPage, PageFlag } from "./model";

/**
 * Shared page-tag surface for both editors' page rails (notebook + PDF).
 *
 * Data lives on the standard InkPage (`tags`, `flag`) in both stores, so this
 * module only carries the per-page predicates, the rail thumbnail badge
 * markup and the tagging popover. The two views keep their own rail DOM
 * (one rebuilds it per render, one keeps persistent buttons) but mount the
 * same badges and popover, mirroring the #327 rail-parity direction without
 * forcing a shared rail component.
 */

export const PAGE_FLAGS: readonly PageFlag[] = ["red", "yellow", "green"];

export interface RailTagFilters {
  /** Only pages that carry ink (strokes, images or sticky notes). */
  ink: boolean;
  /** Only pages that carry any tag or flag. */
  tagged: boolean;
}

/**
 * Per-page ink presence: the same rule as the export gate notebookHasInk
 * (pdf-export.ts), so the rail's "with ink" filter never hides a page that
 * export would include.
 */
export function pageHasInk(page: InkPage): boolean {
  return page.strokes.length > 0 || (page.images?.length ?? 0) > 0 || (page.stickyNotes?.length ?? 0) > 0;
}

export function pageIsTagged(page: InkPage): boolean {
  return (page.tags?.length ?? 0) > 0 || page.flag !== undefined;
}

/** Both toggles stack: a page must satisfy every active filter. */
export function pageMatchesRailFilters(page: InkPage, filters: RailTagFilters): boolean {
  if (filters.ink && !pageHasInk(page)) return false;
  if (filters.tagged && !pageIsTagged(page)) return false;
  return true;
}

/** Any active filter, for count displays. */
export function railFiltersActive(filters: RailTagFilters): boolean {
  return filters.ink || filters.tagged;
}

/**
 * Syncs a thumbnail's flag/tag badge with the page. Created lazily and
 * removed when empty so untagged pages render exactly as before. Safe to
 * call repeatedly: both rails re-query it on every refresh.
 */
export function paintThumbBadges(button: HTMLElement, page: InkPage): void {
  let flag = button.querySelector<HTMLElement>(":scope > .ink-thumb-flag");
  let tags = button.querySelector<HTMLElement>(":scope > .ink-thumb-tags");
  if (page.flag) {
    flag ??= button.createSpan({ cls: "ink-thumb-flag", attr: { "aria-hidden": "true" } });
    flag.className = `ink-thumb-flag is-${page.flag}`;
  } else {
    flag?.remove();
  }
  const names = page.tags ?? [];
  if (names.length > 0) {
    tags ??= button.createSpan({ cls: "ink-thumb-tags", attr: { "aria-hidden": "true" } });
    tags.setText(String(names.length));
    tags.setAttribute("title", names.join(", "));
  } else {
    tags?.remove();
  }
}

export interface TagPopoverHost {
  /** The live page for the popover's state; null closes the popover. */
  getPage(): InkPage | null;
  /** Apply a full replacement tag list to the page. */
  onTagsChange(page: InkPage, tags: string[]): void;
  /** Apply a flag; null clears it. */
  onFlagChange(page: InkPage, flag: PageFlag | null): void;
  /** While true the flag/tag controls are disabled (read-only surface). */
  isLocked(): boolean;
  /** Why the controls are read-only, shown inside a locked popover. */
  lockReason?(): string | null;
}

/**
 * Opens the shared tagging popover (flag presets + free-text tags) beside a
 * rail thumbnail. Mounts on the caller's view root so the --ink-* tokens
 * resolve. State is re-read through `getPage()` on every interaction, so a
 * rail rebuild or peer merge that replaces page objects mid-edit cannot
 * write into a stale model. Returns a close function; the popover also
 * closes on outside pointerdown and Escape.
 */
export function openTagPopover(host: HTMLElement, anchor: HTMLElement, controller: TagPopoverHost): () => void {
  const popover = host.createDiv({ cls: "ink-tag-popover", attr: { role: "dialog", "aria-label": "Page tags" } });
  const sourceThumb = anchor.closest<HTMLElement>(".ink-page-thumb") ?? anchor;
  const pageId = sourceThumb.dataset.pageId;
  function position(): void {
    if (closed) return;
    // Notebook tag edits rebuild the rail. Resolve the same page again so
    // positioning never follows a detached thumbnail or another page.
    const thumb = pageId ? Array.from(host.querySelectorAll<HTMLElement>(".ink-page-thumb"))
      .find((candidate) => candidate.dataset.pageId === pageId) : sourceThumb;
    if (!thumb?.isConnected) { close(); return; }
    const rect = thumb.getBoundingClientRect();
    const list = thumb.closest(".ink-rail-thumbs")?.getBoundingClientRect();
    if (list && list.height > 0 && (rect.bottom <= list.top || rect.top >= list.bottom)) { close(); return; }
    const rail = thumb.closest(".ink-page-rail")?.getBoundingClientRect() ?? rect;
    const root = host.getBoundingClientRect();
    // The editor's CSS containment establishes a containing block for fixed
    // descendants. Use root-local absolute coordinates instead of mixing
    // viewport coordinates with that containing block in offset/split panes.
    const visibleWidth = Math.min(host.clientWidth, window.innerWidth - root.left);
    // Keep the four flag choices usable, but shrink beside the rail on phone
    // layouts before falling back to viewport clamping in very narrow panes.
    popover.style.maxWidth = `${Math.max(0, Math.min(visibleWidth - 16,
      Math.max(160, visibleWidth - (rail.right - root.left) - 16)))}px`;
    const minLeft = Math.max(0, -root.left) + 8;
    const minTop = Math.max(0, -root.top) + 8;
    const maxLeft = Math.max(minLeft, Math.min(host.clientWidth, window.innerWidth - root.left) - popover.offsetWidth - 8);
    const maxTop = Math.max(minTop, Math.min(host.clientHeight, window.innerHeight - root.top) - popover.offsetHeight - 8);
    const left = Math.max(minLeft, Math.min(rail.right - root.left + 8, maxLeft));
    const top = Math.max(minTop, Math.min(rect.top - root.top, maxTop));
    popover.setCssStyles({ left: `${Math.round(left)}px`, top: `${Math.round(top)}px` });
  }

  const reason = popover.createDiv({ cls: "ink-tag-lock-reason", attr: { role: "status" } });
  const flagsRow = popover.createDiv({ cls: "ink-tag-flags", attr: { role: "group", "aria-label": "Flag color" } });
  const choices = new Map<PageFlag | null, HTMLButtonElement>();
  for (const flag of [...PAGE_FLAGS, null]) {
    const label = flag === null ? "No flag" : `${flag[0].toUpperCase()}${flag.slice(1)} flag`;
    const button = flagsRow.createEl("button", {
      cls: flag === null ? "ink-flag-choice ink-flag-none" : `ink-flag-choice ink-flag-${flag}`,
      attr: { type: "button", "aria-label": label, title: label },
    });
    setIcon(button, flag === null ? "flag-off" : "flag");
    button.addEventListener("click", () => {
      const page = controller.getPage();
      if (!page || controller.isLocked()) return;
      controller.onFlagChange(page, flag);
      sync();
    });
    choices.set(flag, button);
  }

  const tagList = popover.createDiv({ cls: "ink-tag-list" });
  const inputRow = popover.createDiv({ cls: "ink-tag-input-row" });
  const input = inputRow.createEl("input", {
    cls: "ink-tag-input",
    attr: { type: "text", "aria-label": "Add tag", placeholder: "Add tag" },
  });
  const commitInput = () => {
    const page = controller.getPage();
    const tag = input.value.trim();
    if (!page || controller.isLocked() || !tag) return;
    const tags = page.tags ?? [];
    if (!tags.includes(tag)) controller.onTagsChange(page, [...tags, tag]);
    input.value = "";
    sync();
    input.focus();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); commitInput(); }
  });
  const addButton = inputRow.createEl("button", { cls: "ink-icon-button", attr: { type: "button", "aria-label": "Add page tag" } });
  setIcon(addButton, "plus");
  addButton.addEventListener("click", commitInput);

  function sync(): void {
    const page = controller.getPage();
    if (!page) { close(); return; }
    const locked = controller.isLocked();
    // A locked popover still opens: the tags stay readable, and the reason
    // line tells the user WHY editing is off instead of leaving a dead
    // button that swallows both left and right clicks without feedback.
    const lockText = locked ? controller.lockReason?.() ?? null : null;
    reason.setText(lockText ?? "");
    reason.toggleClass("is-locked", locked);
    for (const [flag, button] of choices) {
      button.setAttribute("aria-pressed", String(page.flag === flag));
      button.disabled = locked;
    }
    input.disabled = locked;
    addButton.disabled = locked;
    tagList.empty();
    for (const tag of page.tags ?? []) {
      const chip = tagList.createDiv({ cls: "ink-tag-chip" });
      chip.createSpan({ text: tag, cls: "ink-tag-chip-name" });
      const remove = chip.createEl("button", { cls: "ink-icon-button", attr: { type: "button", "aria-label": `Remove tag ${tag}`, title: "Remove" } });
      setIcon(remove, "x");
      remove.disabled = locked;
      remove.addEventListener("click", () => {
        const current = controller.getPage();
        if (!current || controller.isLocked()) return;
        controller.onTagsChange(current, (current.tags ?? []).filter((candidate) => candidate !== tag));
        sync();
      });
    }
    if ((page.tags?.length ?? 0) === 0) tagList.addClass("is-empty");
    else tagList.removeClass("is-empty");
    position();
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", escape, true);
    host.removeEventListener("scroll", position, true);
    window.removeEventListener("resize", position);
    resizeObserver?.disconnect();
    popover.remove();
  };
  const outside = (event: PointerEvent) => {
    if (!popover.contains(event.target as Node)) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); close(); }
  };
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
  resizeObserver?.observe(host);
  resizeObserver?.observe(sourceThumb.closest(".ink-page-rail") ?? sourceThumb);
  resizeObserver?.observe(popover);
  host.addEventListener("scroll", position, true);
  window.addEventListener("resize", position);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape, true);
  sync();
  return close;
}
