import { Menu, Notice, setIcon } from "obsidian";
import { InkTool } from "./model";
import { penOutlineRings } from "./rendering";

export type BrushTool = "pen" | "highlighter";

export interface BrushSettings {
  color: string;
  width: number;
  opacity: number;
  /** 0 keeps ink direct (raw samples, no modeling); 1..100 is the
   *  user-selected stroke-modeler strength. */
  smooth?: number;
  /** End shape 0 (round caps) to 100 (tapered points). */
  taper?: number;
  /** Pressure response amplitude 0 (uniform width) to 100 (full). */
  pressureGain?: number;
  /** Speed-based thinning amplitude 0 (off) to 100. */
  speedGain?: number;
  /** Pressure mapping curve control points [in, out] in 0..1. */
  pressureCurve?: number[][];
}

export const INK_COLORS = [
  { value: "#1b1b1b", label: "Black" },
  { value: "#195bff", label: "Blue" },
  { value: "#f23c42", label: "Red" },
  { value: "#42c449", label: "Green" },
  { value: "#f2c94c", label: "Yellow" },
];

/** Bounds of the editable preset swatch palette (the stock five sit in the
 *  middle of the range). */
export const PRESET_PALETTE_MIN = 1;
export const PRESET_PALETTE_MAX = 10;
/** Hold opens options; destructive actions always require an explicit click. */
const LONG_PRESS_MS = 600;
/** How long the per-swatch picker input stays tappable after a tap on the
 *  swatch: the next tap lands on the input and opens the system picker
 *  natively - programmatic .click() never opens it on iPad. */
const PICKER_ARM_MS = 400;
/** Quiet period that settles the plus picker's picked color: the platform
 *  picker neither blurs its input nor reports close on dismissal, so the
 *  palette joins once the adjustments stop. */
const PICKER_SETTLE_MS = 800;

/** Open/close animation length; keep in sync with the .is-open/.is-closing
 *  CSS transitions on the popovers. */
export const POPOVER_TRANSITION_MS = 150;

/**
 * Places a fixed-position popover centered below (or above, when there is no
 * room below) its anchor and aims its open/close scale animation at that
 * anchor: the panel grows out of the button that opened it and shrinks back
 * into the same spot. Pairs with the .is-open/.is-closing classes.
 */
export function placePopover(pop: HTMLElement, anchor: HTMLElement, margin = 12): void {
  const anchorRect = anchor.getBoundingClientRect();
  const rect = pop.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const left = Math.max(margin, Math.min(window.innerWidth - rect.width - margin, anchorRect.left + anchorRect.width / 2 - rect.width / 2));
  const below = anchorRect.bottom + 10;
  const top = below + rect.height <= window.innerHeight - margin ? below : Math.max(margin, anchorRect.top - rect.height - 10);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  const originX = Math.max(12, Math.min(rect.width - 12, anchorRect.left + anchorRect.width / 2 - left));
  const originY = Math.max(0, Math.min(rect.height, top === below ? 0 : anchorRect.top - top));
  pop.style.setProperty("--ink-popover-origin-x", `${Math.round(originX)}px`);
  pop.style.setProperty("--ink-popover-origin-y", `${Math.round(originY)}px`);
}

/**
 * Anchor-true open/close: .is-open plays a short grow-from-the-anchor
 * animation; close() plays the reverse (shrink INTO the anchor) via
 * .is-closing and only then drops back to display:none. `hide` removes the
 * element for popovers that are destroyed on close instead of reused.
 */
export function closeAnchoredPopover(pop: HTMLElement, hide: () => void): void {
  if (pop.hasClass("is-closing")) return;
  pop.removeClass("is-open");
  pop.addClass("is-closing");
  pop.setAttribute("aria-hidden", "true");
  window.setTimeout(() => {
    pop.removeClass("is-closing");
    hide();
  }, POPOVER_TRANSITION_MS);
}

export function isBrushTool(tool: InkTool): tool is BrushTool {
  return tool === "pen" || tool === "highlighter";
}

export function formatControlValue(name: string, value: number): string {
  const normalized = name.toLowerCase();
  if (normalized === "smooth") return value === 0 ? "Direct" : String(value);
  if (normalized === "taper") return value === 0 ? "Round" : value === 100 ? "Sharp" : `${value}%`;
  if (normalized === "pressure") return value === 0 ? "Off" : value === 100 ? "Full" : `${value}%`;
  if (normalized === "speed width") return value === 0 ? "Off" : `${value}%`;
  return normalized.endsWith("opacity")
    ? `${Math.round(value * 100)}%`
    : `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} px`;
}

export interface BrushToolSpec {
  tool: BrushTool;
  label: string;
  presets: number[];
  maximum: number;
}

export interface BrushPopoverControllerOptions {
  /** Extra class appended to the popover root for host-specific styling. */
  extraClass?: string;
  tools: BrushToolSpec[];
  getSettings: (tool: BrushTool) => BrushSettings;
  /** The currently active tool: drives panel visibility and the header title. */
  activeTool: () => InkTool | null;
  /** Pen dynamics controls (smooth/taper/pressure/curve/speed) are shown when
   *  this returns true (the active tool is the pen). */
  showPenDynamics?: () => boolean;
  /** View-specific section appended after the tool panels (eraser controls).
   *  Receives the shared range-slider builder; runs during controller
   *  construction, so it must not touch the controller instance. */
  buildExtras?: (body: HTMLElement, api: { addRange: BrushPopoverController["addRange"] }) => void;
  /** The editable preset swatch colors (mutated in place by the palette
   *  editor; follow every mutation with the standard update() so the change
   *  reaches the view's persistence). Falls back to the stock palette. */
  palette?: () => string[];
  /** Fired after any control change so the view can refresh dependent UI. */
  onControlsChanged?: () => void;
  /** View teardown hook for document/window listeners. */
  registerCleanup?: (dispose: () => void) => void;
  /** Fixed-positioning anchor; falls back to the first tool spec's button. */
  anchor?: () => HTMLElement | null;
}

/**
 * The shared brush settings popover: a pinned header (title + live
 * sample-stroke preview on paper white) above a vertically scrolling body of
 * per-tool controls (size, presets, color, opacity and — for the pen — the
 * modeler strength, taper, pressure response, mapping curve and speed
 * compensation). Touches inside never propagate, so an open menu takes
 * priority over workspace swipe gestures.
 *
 * InkView and PdfInkView both mount this controller; the DOM contract
 * (.ink-size-popover, .ink-popover-title, input[aria-label="... size"],
 * .ink-width-preset, .ink-color-swatch, .ink-popover-title text) is shared
 * and covered by the visual and unit suites.
 */
export class BrushPopoverController {
  readonly root: HTMLElement;
  private readonly options: BrushPopoverControllerOptions;
  private readonly title: HTMLElement;
  private readonly preview: HTMLCanvasElement;
  private readonly body: HTMLElement;
  private readonly toolButtons = new Map<BrushTool, HTMLButtonElement>();
  /** Pending plus-picker settles; flushed when the panel closes in case the
   *  platform picker never blurs its input. */
  private readonly customPickers: (() => void)[] = [];
  private openState = false;
  private curveOpen = false;
  private dragIndex = -1;
  private presetPressTimer: number | undefined;
  private presetMenu: Menu | undefined;
  /** The tool whose panel was last shown; a switch resets the shared scroll
   *  container so the shorter panel is not left scrolled out of view. */
  private visiblePanel: InkTool | null = null;

  constructor(private readonly parent: HTMLElement, options: BrushPopoverControllerOptions) {
    this.options = options;
    this.root = parent.createDiv({
      cls: options.extraClass ? `ink-size-popover ${options.extraClass}` : "ink-size-popover",
      attr: { role: "dialog", "aria-label": "Tool settings", "aria-hidden": "true" },
    });
    const header = this.root.createDiv({ cls: "ink-popover-header" });
    this.title = header.createDiv({ cls: "ink-popover-title", text: "Brush settings" });
    this.preview = header.createEl("canvas", { cls: "ink-popover-preview", attr: { "aria-hidden": "true" } });
    // Menu priority over workspace gestures: touches inside the popover never
    // reach Obsidian's swipe handlers, so adjusting a slider cannot summon
    // the file switcher or other menus.
    for (const type of ["touchstart", "touchmove", "pointerdown"] as const) {
      options.registerCleanup
        ? options.registerCleanup(this.attachShield(this.root, type))
        : this.attachShield(this.root, type);
    }
    const body = this.root.createDiv({ cls: "ink-popover-body" });
    this.body = body;
    this.root.addEventListener("touchstart", (event) => { if (event.touches.length > 1) this.cancelPresetHold(); }, { capture: true });
    options.registerCleanup?.(() => { this.cancelPresetHold(); this.presetMenu?.hide(); });
    for (const spec of options.tools) this.buildToolPanel(body, spec);
    options.buildExtras?.(body, {
      addRange: (parent, name, min, max, step, value, onChange) => this.addRange(parent, name, min, max, step, value, onChange),
    });
    this.update();
  }

  private attachShield(target: HTMLElement, type: "touchstart" | "touchmove" | "pointerdown"): () => void {
    const handler = (event: Event): void => event.stopPropagation();
    const options: AddEventListenerOptions = { passive: type !== "touchmove" };
    target.addEventListener(type, handler, options);
    return () => target.removeEventListener(type, handler, options);
  }

  private buildToolPanel(body: HTMLElement, spec: BrushToolSpec): void {
    const settings = this.options.getSettings(spec.tool);
    const panel = body.createDiv({ cls: "ink-brush-settings", attr: { "data-brush-tool": spec.tool } });

    panel.createDiv({ cls: "ink-settings-label", text: "Size" });
    const input = panel.createEl("input", { attr: {
      type: "range", min: "1", max: String(spec.maximum), step: "0.5", value: String(settings.width),
      "aria-label": `${spec.label} size`, "data-control": "size",
    } });
    input.addEventListener("input", () => {
      settings.width = Number(input.value);
      this.update();
    });
    panel.createDiv({ cls: "ink-settings-label ink-settings-label-presets", text: "Presets" });
    const widths = this.buildSection(panel, `${spec.label}-widths`);
    for (const width of spec.presets) {
      const preset = widths.createEl("button", { cls: "ink-width-preset", attr: {
        type: "button", title: `${width} px`, "aria-label": `${spec.label} ${width} px`,
        "aria-pressed": String(settings.width === width), "data-width": String(width),
        "data-brush-tool": spec.tool,
      } });
      preset.createSpan({ cls: "ink-width-line" }).style.height = Math.min(width, 24) + "px";
      preset.addEventListener("click", () => { settings.width = width; this.update(); });
    }
    this.buildColorPicker(panel, spec);
    this.addRange(panel, `${spec.label} opacity`, 0.1, 1, 0.05, settings.opacity, (value) => {
      settings.opacity = value;
      this.update();
    });
    if (spec.tool !== "pen") return;
    // Pen-only dynamics live in one wrapper that the stylesheet hides unless
    // the pen panel is showing: they rendered under the highlighter too,
    // pushing the panel body full of low-frequency sliders.
    const dynamics = body.createDiv({ cls: "ink-pen-dynamics" });
    // 0 keeps ink direct (raw samples, no modeling); 1..100 is the stroke
    // modeler strength. Sparse low-rate devices also auto-engage at 0.
    // No update() here: smooth has no visual control state, but the change
    // must still reach the view (persisted settings).
    this.addRange(dynamics, "Smooth", 0, 100, 1, settings.smooth ?? 0, (value) => {
      settings.smooth = value;
      this.options.onControlsChanged?.();
    });
    // Dynamics sliders re-render the sample-stroke preview on change.
    this.addRange(dynamics, "Taper", 0, 100, 1, settings.taper ?? 0, (value) => {
      settings.taper = value;
      this.update();
    });
    this.addRange(dynamics, "Pressure", 0, 100, 1, settings.pressureGain ?? 100, (value) => {
      settings.pressureGain = value;
      this.update();
    });
    this.buildPressureCurveEditor(dynamics, settings);
    this.addRange(dynamics, "Speed width", 0, 100, 1, settings.speedGain ?? 0, (value: number) => {
      settings.speedGain = value;
      this.update();
    });
  }

  private buildSection(parent: HTMLElement, label: string): HTMLElement {
    const section = parent.createDiv({ cls: "ink-toolbar-section" });
    section.addClass(`ink-toolbar-section-${label.toLowerCase()}`);
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", label);
    return section.createDiv({ cls: "ink-toolbar-section-controls" });
  }

  private buildColorPicker(parent: HTMLElement, spec: BrushToolSpec): void {
    const settings = this.options.getSettings(spec.tool);
    parent.createDiv({ cls: "ink-settings-label", text: "Color" });
    const control = parent.createDiv({ cls: "ink-color-control", attr: { "data-brush-tool": spec.tool } });
    const swatches = control.createDiv({ cls: "ink-color-swatches" });
    this.buildSwatches(swatches, spec);
    // The plus keeps its place at the end of the row: it opens the color
    // picker and stores the picked color as a new preset while the palette
    // has room (full palette degrades to plain "use now").
    const custom = control.createEl("label", { cls: "ink-custom-color", attr: { title: "Add a preset color" } });
    setIcon(custom.createSpan({ cls: "ink-button-icon" }), "plus");
    const input = custom.createEl("input", { attr: {
      type: "color", value: settings.color, "aria-label": `${spec.label} custom color`, "data-brush-tool": spec.tool,
    } });
    // One pick = one preset. The platform picker streams input events while
    // adjusting and (on iOS) commits a change per swatch tapped inside it,
    // and it neither blurs its input nor reports a close event when it is
    // dismissed - so the palette settles on a QUIET PERIOD after the last
    // adjustment, with blur and panel close as immediate backstops. Exactly
    // one preset per settled pick.
    let dirty = false;
    let settleTimer: number | undefined;
    const flushPickedColor = (): void => {
      if (settleTimer !== undefined) { window.clearTimeout(settleTimer); settleTimer = undefined; }
      if (!dirty) return;
      dirty = false;
      const picked = input.value;
      settings.color = picked;
      const palette = this.options.palette?.();
      if (palette && !palette.some((entry) => entry.toLowerCase() === picked.toLowerCase()) && palette.length < PRESET_PALETTE_MAX) {
        palette.push(picked);
        this.buildSwatchesInto(spec);
        custom.title = palette.length >= PRESET_PALETTE_MAX ? "Custom color (palette is full)" : "Add a preset color";
      }
      this.updateColorSwatches(spec.tool, picked);
      this.update();
    };
    input.addEventListener("input", () => {
      dirty = true;
      settings.color = input.value;
      this.updateColorSwatches(spec.tool, input.value);
      this.update();
      if (settleTimer !== undefined) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(flushPickedColor, PICKER_SETTLE_MS);
    });
    input.addEventListener("change", () => { dirty = true; });
    input.addEventListener("blur", flushPickedColor);
    this.customPickers.push(flushPickedColor);
  }

  /** Rebuilds the swatch row from the live palette (after add/edit/remove). */
  private buildSwatchesInto(spec: BrushToolSpec): void {
    this.cancelPresetHold(); this.presetMenu?.hide();
    const swatches = this.root.querySelector<HTMLElement>(`.ink-color-control[data-brush-tool="${spec.tool}"] .ink-color-swatches`);
    if (!swatches) return;
    swatches.empty();
    this.buildSwatches(swatches, spec);
  }

  private buildSwatches(swatches: HTMLElement, spec: BrushToolSpec): void {
    const settings = this.options.getSettings(spec.tool);
    const palette = this.options.palette?.() ?? INK_COLORS.map((color) => color.value);
    for (const value of palette) {
      const label = INK_COLORS.find((color) => color.value.toLowerCase() === value.toLowerCase())?.label ?? "Custom";
      // Each swatch carries its OWN native color input, on top of it but
      // untappable until a tap on the swatch arms it: the next tap then
      // lands on a real input and opens the system picker natively
      // (programmatic .click() never opens it on iPad - the beta.30
      // regression). Double-tap edits; hold opens explicit color options.
      const slot = swatches.createDiv({ cls: "ink-swatch-slot" });
      const swatch = slot.createEl("button", { cls: "ink-color-swatch", attr: {
        type: "button", title: `${label} — double-tap to change, hold for options`, "aria-label": `${spec.label} ${label.toLowerCase()}`,
        "aria-pressed": String(settings.color.toLowerCase() === value.toLowerCase()), "data-color": value,
        "data-brush-tool": spec.tool,
      } });
      swatch.style.backgroundColor = value;
      const picker = slot.createEl("input", { cls: "ink-swatch-picker", attr: {
        type: "color", value, "aria-label": `${spec.label} ${label.toLowerCase()} preset picker`,
        "data-color": value, "data-brush-tool": spec.tool, tabindex: "-1",
      } });
      // This slot's live preset color: the closure must follow in-place edits
      // or the SECOND adjustment can no longer find its entry.
      let current = value;
      let suppressClick = false;
      let armTimer: number | undefined;
      swatch.addEventListener("click", () => {
        // A finished long-press must not also select the color.
        if (suppressClick) { suppressClick = false; return; }
        settings.color = current;
        this.updateColorSwatches(spec.tool, current);
        this.update();
        picker.addClass("is-armed");
        if (armTimer !== undefined) window.clearTimeout(armTimer);
        armTimer = window.setTimeout(() => {
          armTimer = undefined;
          picker.removeClass("is-armed");
        }, PICKER_ARM_MS);
      });
      // The pick replaces this preset LIVE on every input event (iOS fires
      // input per adjustment and its change/close behaviour is unreliable -
      // beta.31/32 missed edits because they keyed off change). STRICTLY
      // in-place: rebuilding the row destroys THIS input, and the platform
      // picker is anchored to it - it then snaps shut mid-adjust.
      const applyPick = (): void => {
        const palette = this.options.palette?.();
        if (!palette) return;
        const index = palette.findIndex((entry) => entry.toLowerCase() === current.toLowerCase());
        if (index < 0 || picker.value.toLowerCase() === current.toLowerCase()) return;
        if (settings.color.toLowerCase() === current.toLowerCase()) settings.color = picker.value;
        palette[index] = picker.value;
        const newLabel = INK_COLORS.find((color) => color.value.toLowerCase() === picker.value.toLowerCase())?.label ?? "Custom";
        swatch.style.backgroundColor = picker.value;
        swatch.dataset.color = picker.value;
        picker.dataset.color = picker.value;
        swatch.setAttribute("aria-label", `${spec.label} ${newLabel.toLowerCase()}`);
        swatch.title = `${newLabel} — double-tap to change, hold for options`;
        current = picker.value;
        this.update();
      };
      picker.addEventListener("input", applyPick);
      picker.addEventListener("change", applyPick);
      const options = (event: MouseEvent): void => {
        this.cancelPresetHold(); this.presetMenu?.hide();
        const menu = new Menu(); this.presetMenu = menu;
        menu.addItem((item) => item.setTitle("Remove preset color").setIcon("trash-2")
          .setDisabled((this.options.palette?.().length ?? 1) <= PRESET_PALETTE_MIN)
          .onClick(() => this.removePresetColor(spec, current)));
        menu.onHide(() => { if (this.presetMenu === menu) this.presetMenu = undefined; });
        menu.showAtMouseEvent(event);
      };
      let origin = { x: 0, y: 0 };
      swatch.addEventListener("pointerdown", (event) => {
        this.cancelPresetHold();
        if (event.button !== 0) return;
        suppressClick = false; origin = { x: event.clientX, y: event.clientY };
        this.presetPressTimer = window.setTimeout(() => {
          this.presetPressTimer = undefined;
          if (!this.isOpen || !swatch.isConnected) return;
          suppressClick = true;
          options(event);
        }, LONG_PRESS_MS);
      });
      swatch.addEventListener("pointermove", (event) => {
        if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 10) this.cancelPresetHold();
      });
      for (const type of ["pointerup", "pointercancel", "pointerleave"]) swatch.addEventListener(type, () => this.cancelPresetHold());
      swatch.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        if (!suppressClick || !this.presetMenu) options(event);
      });
      swatch.addEventListener("keydown", (event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault(); const rect = swatch.getBoundingClientRect();
          options(new MouseEvent("contextmenu", { clientX: rect.left, clientY: rect.bottom }));
        }
      });
    }
  }

  private cancelPresetHold(): void {
    if (this.presetPressTimer !== undefined) window.clearTimeout(this.presetPressTimer);
    this.presetPressTimer = undefined;
  }

  get optionsOpen(): boolean { return this.presetMenu !== undefined; }

  /** Deletes one palette entry outright (the one-swatch minimum holds). */
  private removePresetColor(spec: BrushToolSpec, value: string): void {
    const palette = this.options.palette?.();
    if (!palette || palette.length <= PRESET_PALETTE_MIN) return;
    const index = palette.findIndex((entry) => entry.toLowerCase() === value.toLowerCase());
    if (index < 0) return;
    const [removed] = palette.splice(index, 1);
    const settings = this.options.getSettings(spec.tool);
    if (settings.color.toLowerCase() === removed.toLowerCase()) settings.color = palette[0] ?? removed;
    this.buildSwatchesInto(spec);
    this.update();
    new Notice("Preset color removed");
  }

  private updateColorSwatches(tool: BrushTool, color: string): void {
    this.root.querySelectorAll<HTMLButtonElement>(`.ink-color-swatch[data-brush-tool="${tool}"]`).forEach((swatch) => {
      swatch.setAttribute("aria-pressed", String(color.toLowerCase() === swatch.dataset.color?.toLowerCase()));
      swatch.toggleClass("is-active", color.toLowerCase() === swatch.dataset.color?.toLowerCase());
    });
    const custom = this.root.querySelector<HTMLInputElement>(`input[type="color"][data-brush-tool="${tool}"]`);
    if (custom) custom.value = color;
  }
  addRange(parent: HTMLElement, name: string, min: number, max: number, step: number, value: number, onChange: (value: number) => void): void {
    const label = parent.createEl("label", { cls: "ink-range-control", attr: { title: name } });
    label.addClass(`ink-range-${name.toLowerCase().replace(/\s+/g, "-")}`);
    const header = label.createDiv({ cls: "ink-range-header" });
    header.createSpan({ text: name });
    const valueText = header.createSpan({ cls: "ink-control-value", text: formatControlValue(name, value) });
    const input = label.createEl("input", { attr: { type: "range", min: String(min), max: String(max), step: String(step), value: String(value), "aria-label": name } });
    input.addEventListener("input", () => {
      const next = Number(input.value);
      onChange(next);
      valueText.textContent = formatControlValue(name, next);
    });
  }

  private buildPressureCurveEditor(body: HTMLElement, settings: BrushSettings): void {
    // The curve editor stays collapsed until manually expanded.
    const curveHeader = body.createDiv({ cls: "ink-settings-label ink-curve-header" });
    curveHeader.createSpan({ text: "Pressure curve" });
    const curveToggle = curveHeader.createEl("button", {
      cls: "ink-curve-toggle", attr: {
        type: "button", "aria-expanded": String(this.curveOpen),
        "aria-label": this.curveOpen ? "Collapse pressure curve editor" : "Expand pressure curve editor",
      },
    });
    const curveIcon = curveToggle.createSpan({ cls: "ink-button-icon" });
    setIcon(curveIcon, this.curveOpen ? "chevron-up" : "chevron-down");
    // update() only re-syncs values - the curve body's visibility must be
    // flipped right here, or the toggle spins a field without ever showing
    // the editor.
    curveToggle.addEventListener("click", () => {
      this.curveOpen = !this.curveOpen;
      curveToggle.setAttribute("aria-expanded", String(this.curveOpen));
      setIcon(curveIcon, this.curveOpen ? "chevron-up" : "chevron-down");
      curveBody.toggleClass("is-collapsed", !this.curveOpen);
      if (this.curveOpen) requestAnimationFrame(() => this.drawPressureCurve(settings));
    });
    const curveBody = body.createDiv({ cls: "ink-curve-body" });
    curveBody.toggleClass("is-collapsed", !this.curveOpen);
    const resetRow = curveBody.createDiv({ cls: "ink-curve-actions" });
    const resetButton = resetRow.createEl("button", { text: "Reset", attr: { type: "button" } });
    resetButton.addEventListener("click", () => {
      settings.pressureCurve = undefined;
      selectedIndex = dragIndex = -1; removePoint.disabled = true;
      this.update();
    });
    const editor = curveBody.createDiv({ cls: "ink-curve-editor", attr: { "aria-label": "Pressure mapping curve" } });
    const canvas = editor.createEl("canvas", { cls: "ink-curve-editor-canvas" });
    canvas.setAttribute("aria-hidden", "true");
    const hit = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return { x: (clientX - rect.left) / rect.width, y: 1 - (clientY - rect.top) / rect.height };
    };
    const curve = (): number[][] => settings.pressureCurve ? settings.pressureCurve.map((point) => [...point]) : [[0, 0], [1, 1]];
    let dragIndex = -1;
    let selectedIndex = -1;
    const removePoint = resetRow.createEl("button", { text: "Remove point", attr: { type: "button" } });
    removePoint.disabled = true;
    removePoint.addEventListener("click", () => {
      const points = curve();
      if (selectedIndex <= 0 || selectedIndex >= points.length - 1) return;
      points.splice(selectedIndex, 1); settings.pressureCurve = points;
      selectedIndex = dragIndex = -1; removePoint.disabled = true; this.update();
    });
    canvas.addEventListener("pointerdown", (event) => {
      const position = hit(event.clientX, event.clientY);
      const points = curve();
      let nearest = -1;
      let nearestDistance = 0.06;
      for (let index = 0; index < points.length; index++) {
        const d = Math.hypot(points[index][0] - position.x, points[index][1] - position.y);
        if (d < nearestDistance) { nearest = index; nearestDistance = d; }
      }
      if (nearest >= 0) {
        dragIndex = nearest;
      } else if (points.length < 6) {
        const insertAt = points.findIndex((point) => point[0] > position.x);
        const index = insertAt === -1 ? points.length - 1 : insertAt;
        // Keep the mapping monotonic: a new point starts between its
        // neighbors' heights.
        const lowY = index > 0 ? points[index - 1][1] : 0;
        const highY = index < points.length - 1 ? points[index][1] : 1;
        points.splice(index, 0, [position.x, Math.max(lowY, Math.min(highY, position.y))]);
        settings.pressureCurve = points;
        dragIndex = index;
      }
      selectedIndex = dragIndex; removePoint.disabled = selectedIndex <= 0 || selectedIndex >= curve().length - 1;
      canvas.setPointerCapture(event.pointerId);
      this.update();
      event.preventDefault();
    });
    canvas.addEventListener("pointermove", (event) => {
      if (dragIndex < 0) return;
      const position = hit(event.clientX, event.clientY);
      const points = curve();
      const point = points[dragIndex];
      const isEnd = dragIndex === 0 || dragIndex === points.length - 1;
      // Non-decreasing heights: more pressure must never map to less width.
      const lowY = dragIndex > 0 ? points[dragIndex - 1][1] : 0;
      const highY = dragIndex < points.length - 1 ? points[dragIndex + 1][1] : 1;
      point[1] = Math.max(lowY, Math.min(highY, position.y));
      if (!isEnd) {
        const low = points[dragIndex - 1][0] + 0.02;
        const high = points[dragIndex + 1][0] - 0.02;
        point[0] = Math.max(low, Math.min(high, position.x));
      }
      settings.pressureCurve = points;
      this.update();
      event.preventDefault();
    });
    const endDrag = (event: PointerEvent): void => {
      if (dragIndex < 0) return;
      dragIndex = -1;
      try { canvas.releasePointerCapture(event.pointerId); } catch { /* pointer already released */ }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
  }

  get isOpen(): boolean {
    return this.openState;
  }

  open(): void {
    this.openState = true;
    // Cancel a close animation still in flight before replaying the open.
    this.root.removeClass("is-closing");
    this.root.addClass("is-open");
    this.root.setAttribute("aria-hidden", "false");
    // The popover is display:none while built, so canvas previews can only
    // be drawn once it becomes visible and has layout.
    window.requestAnimationFrame(() => {
      this.position();
      this.update();
      this.body.scrollTop = 0;
      this.focusSizeSlider();
    });
  }

  close(): void {
    this.cancelPresetHold(); this.presetMenu?.hide();
    if (!this.openState) return;
    this.openState = false;
    for (const flush of this.customPickers) flush();
    this.root.setAttribute("aria-hidden", "true");
    // Shrinks back into the anchor button; the base display:none returns
    // once the .is-closing transition window ends. Reopening mid-animation
    // cancels it via open()'s class swap.
    closeAnchoredPopover(this.root, () => undefined);
  }

  /**
   * Keyboard entry: opening hands focus to the active tool's size slider so
   * the dialog is immediately operable; the views hand focus back to the
   * tool button on Escape, closing the loop without stranding keyboard
   * users on the toolbar. Runs after the rAF so the slider exists with
   * layout even on the popover's first open.
   */
  private focusSizeSlider(): void {
    const active = this.options.activeTool();
    if (!active || !isBrushTool(active)) return;
    const panel = this.root.querySelector<HTMLElement>(`.ink-brush-settings[data-brush-tool="${active}"]`);
    panel?.querySelector<HTMLInputElement>('input[data-control="size"]')?.focus();
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open();
  }

  position(): void {
    if (!this.isOpen) return;
    const anchor = this.options.anchor?.() ?? null;
    if (!anchor) return;
    placePopover(this.root, anchor);
  }

  /** Re-syncs every control, the title and the canvases from settings. */
  update(): void {
    const active = this.options.activeTool();
    if (active !== this.visiblePanel) {
      this.visiblePanel = active;
      // Panels share one scroll container: without this, switching from the
      // long pen panel left the highlighter panel scrolled past its
      // high-frequency controls.
      this.body.scrollTop = 0;
    }
    for (const spec of this.options.tools) {
      const settings = this.options.getSettings(spec.tool);
      const panel = this.root.querySelector<HTMLElement>(`.ink-brush-settings[data-brush-tool="${spec.tool}"]`);
      const input = panel?.querySelector<HTMLInputElement>('input[data-control="size"]');
      if (input) input.value = String(settings.width);
      this.root.querySelectorAll<HTMLButtonElement>(`.ink-width-preset[data-brush-tool="${spec.tool}"]`).forEach((button) => {
        button.setAttribute("aria-pressed", String(Number(button.dataset.width) === settings.width));
      });
    }
    this.title.textContent = active && isBrushTool(active)
      ? `${this.options.tools.find((spec) => spec.tool === active)?.label ?? "Brush"} settings · ${formatControlValue("Size", this.options.getSettings(active).width)}`
      : "Brush settings";
    this.root.toggleClass("is-pen-tool", active === "pen");
    this.root.toggleClass("is-highlighter-tool", active === "highlighter");
    this.root.toggleClass("is-eraser-tool", active === "eraser");
    if (active && isBrushTool(active)) {
      this.updateColorSwatches(active as BrushTool, this.options.getSettings(active as BrushTool).color);
      if (active === "pen") {
        this.drawSampleStroke(this.options.getSettings("pen"));
        this.drawPressureCurve(this.options.getSettings("pen"));
      }
    }
    this.options.onControlsChanged?.();
  }

  /** Renders a sample stroke with the current pen dynamics into the pinned
   *  preview canvas, using the same outline geometry as committed ink. */
  private drawSampleStroke(settings: BrushSettings): void {
    const ctx = this.preview.getContext("2d");
    if (!ctx) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const cssWidth = this.preview.clientWidth || 200;
    const cssHeight = this.preview.clientHeight || 46;
    if (this.preview.width !== Math.round(cssWidth * ratio)) this.preview.width = Math.round(cssWidth * ratio);
    if (this.preview.height !== Math.round(cssHeight * ratio)) this.preview.height = Math.round(cssHeight * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    // A gentle S-curve with a mid-stroke pressure swell: exercises taper,
    // pressure response and speed compensation together.
    const samples = 36;
    const margin = Math.max(8, settings.width);
    const usableWidth = Math.max(10, cssWidth - margin * 2);
    const midY = cssHeight / 2;
    const amplitude = cssHeight / 2 - Math.max(3, settings.width);
    const points = Array.from({ length: samples }, (_, index) => {
      const k = index / (samples - 1);
      return {
        x: (margin + k * usableWidth) / cssWidth,
        y: (midY - Math.sin(k * Math.PI * 2) * amplitude * 0.8) / cssHeight,
        pressure: 0.35 + 0.45 * Math.sin(k * Math.PI),
        t: index * 8,
      };
    });
    const outline = penOutlineRings({
      id: "preview", pageId: "preview", tool: "pen", color: settings.color, width: settings.width,
      opacity: settings.opacity, points, createdAt: 0, updatedAt: 0,
      dynamics: {
        taper: settings.taper ?? 0, pressure: settings.pressureGain ?? 100, speed: settings.speedGain ?? 0,
        pressureCurve: settings.pressureCurve ? settings.pressureCurve.map((point) => [...point]) : undefined,
      },
    }, cssWidth, cssHeight,
    // The nib preview demonstrates the slider value at this canvas's own
    // scale (it must stay readable on a ~200px popover), NOT the canonical
    // page-space nib committed ink uses; pin the reference to the canvas so
    // the renderer's width conversion is a no-op here.
    cssWidth);
    if (outline.length < 2) return;
    ctx.globalAlpha = settings.opacity;
    ctx.fillStyle = settings.color;
    ctx.beginPath();
    for (const ring of outline) {
      ctx.moveTo(ring[0][0], ring[0][1]);
      for (let index = 1; index < ring.length; index++) ctx.lineTo(ring[index][0], ring[index][1]);
      ctx.closePath();
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /** Renders the pressure mapping editor: grid, identity guide, curve and
   *  control points. Skipped while the popover has no layout. */
  private drawPressureCurve(settings: BrushSettings): void {
    const canvas = this.root.querySelector<HTMLCanvasElement>(".ink-curve-editor-canvas");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (w < 10 || h < 10) return;
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(w * ratio)) canvas.width = Math.round(w * ratio);
    if (canvas.height !== Math.round(h * ratio)) canvas.height = Math.round(h * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = "#8a8f98";
    ctx.globalAlpha = 0.35;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
    ctx.beginPath();
    ctx.moveTo(0, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const points = settings.pressureCurve ? settings.pressureCurve.map((point) => [...point]) : [[0, 0], [1, 1]];
    const sampleY = (x: number): number => {
      if (x <= points[0][0]) return points[0][1];
      if (x >= points[points.length - 1][0]) return points[points.length - 1][1];
      let index = 1;
      while (points[index][0] < x) index++;
      const span = points[index][0] - points[index - 1][0];
      const amount = span > 0 ? (x - points[index - 1][0]) / span : 0;
      return points[index - 1][1] + (points[index][1] - points[index - 1][1]) * amount;
    };
    ctx.strokeStyle = settings.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let step = 0; step <= 48; step++) {
      const x = step / 48;
      const sx = x * w, sy = (1 - sampleY(x)) * h;
      if (step === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    for (const point of points) {
      ctx.fillStyle = settings.color;
      ctx.beginPath();
      ctx.arc(point[0] * w, (1 - point[1]) * h, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}
