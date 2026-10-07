import { setIcon } from "obsidian";
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
  private openState = false;
  private curveOpen = false;
  private dragIndex = -1;

  constructor(parent: HTMLElement, options: BrushPopoverControllerOptions) {
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
    // 0 keeps ink direct (raw samples, no modeling); 1..100 is the stroke
    // modeler strength. Sparse low-rate devices also auto-engage at 0.
    this.addRange(body, "Smooth", 0, 100, 1, settings.smooth ?? 0, (value) => {
      settings.smooth = value;
    });
    // Dynamics sliders re-render the sample-stroke preview on change.
    this.addRange(body, "Taper", 0, 100, 1, settings.taper ?? 0, (value) => {
      settings.taper = value;
      this.update();
    });
    this.addRange(body, "Pressure", 0, 100, 1, settings.pressureGain ?? 100, (value) => {
      settings.pressureGain = value;
      this.update();
    });
    this.buildPressureCurveEditor(body, settings);
    this.addRange(body, "Speed width", 0, 100, 1, settings.speedGain ?? 0, (value: number) => {
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
    for (const color of INK_COLORS) {
      const swatch = swatches.createEl("button", { cls: "ink-color-swatch", attr: {
        type: "button", title: color.label, "aria-label": `${spec.label} ${color.label.toLowerCase()}`,
        "aria-pressed": String(settings.color.toLowerCase() === color.value), "data-color": color.value,
        "data-brush-tool": spec.tool,
      } });
      swatch.style.backgroundColor = color.value;
      if (settings.color.toLowerCase() === color.value) swatch.addClass("is-active");
      swatch.addEventListener("click", () => {
        settings.color = color.value;
        this.updateColorSwatches(spec.tool, settings.color);
        this.update();
      });
    }
    const custom = control.createEl("label", { cls: "ink-custom-color", attr: { title: "Custom color" } });
    setIcon(custom.createSpan({ cls: "ink-button-icon" }), "plus");
    const input = custom.createEl("input", { attr: {
      type: "color", value: settings.color, "aria-label": `${spec.label} custom color`, "data-brush-tool": spec.tool,
    } });
    input.addEventListener("input", () => {
      settings.color = input.value;
      this.updateColorSwatches(spec.tool, settings.color);
      this.update();
    });
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
      curveBody.style.display = this.curveOpen ? "" : "none";
      if (this.curveOpen) requestAnimationFrame(() => this.drawPressureCurve(settings));
    });
    const curveBody = body.createDiv({ cls: "ink-curve-body" });
    if (!this.curveOpen) curveBody.style.display = "none";
    const resetRow = curveBody.createDiv({ cls: "ink-curve-actions" });
    const resetButton = resetRow.createEl("button", { text: "Reset", attr: { type: "button" } });
    resetButton.addEventListener("click", () => {
      settings.pressureCurve = undefined;
      this.update();
    });
    const editor = curveBody.createDiv({ cls: "ink-curve-editor", attr: { "aria-label": "Pressure mapping curve" } });
    const canvas = editor.createEl("canvas", { cls: "ink-curve-editor-canvas" });
    canvas.style.width = "100%";
    canvas.style.height = "110px";
    canvas.setAttribute("aria-hidden", "true");
    const hit = (clientX: number, clientY: number): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return { x: (clientX - rect.left) / rect.width, y: 1 - (clientY - rect.top) / rect.height };
    };
    const curve = (): number[][] => settings.pressureCurve ? settings.pressureCurve.map((point) => [...point]) : [[0, 0], [1, 1]];
    let dragIndex = -1;
    canvas.addEventListener("pointerdown", (event) => {
      const position = hit(event.clientX, event.clientY);
      const points = curve();
      let nearest = -1;
      let nearestDistance = 0.06;
      for (let index = 0; index < points.length; index++) {
        const d = Math.hypot(points[index][0] - position.x, points[index][1] - position.y);
        if (d < nearestDistance) { nearest = index; nearestDistance = d; }
      }
      if (event.detail >= 2 && nearest > 0 && nearest < points.length - 1 && points.length > 2) {
        points.splice(nearest, 1);
        settings.pressureCurve = points;
        dragIndex = -1;
      } else if (nearest >= 0) {
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
      // Flinging an interior point onto the bottom edge removes it.
      if (!isEnd && dragIndex > 0 && dragIndex < points.length - 1 && point[1] <= 0.02) {
        points.splice(dragIndex, 1);
        dragIndex = -1;
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
    this.root.toggleClass("is-open", true);
    this.root.setAttribute("aria-hidden", "false");
    // The popover is display:none while built, so canvas previews can only
    // be drawn once it becomes visible and has layout.
    window.requestAnimationFrame(() => {
      this.position();
      this.update();
    });
  }

  close(): void {
    this.openState = false;
    this.root.toggleClass("is-open", false);
    this.root.setAttribute("aria-hidden", "true");
  }

  toggle(): void {
    this.isOpen ? this.close() : this.open();
  }

  position(): void {
    if (!this.isOpen) return;
    const anchor = this.options.anchor?.() ?? null;
    if (!anchor) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = this.root.getBoundingClientRect();
    const margin = 12;
    const left = Math.max(margin, Math.min(window.innerWidth - popoverRect.width - margin, anchorRect.left + anchorRect.width / 2 - popoverRect.width / 2));
    const below = anchorRect.bottom + 10;
    const top = below + popoverRect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, anchorRect.top - popoverRect.height - 10);
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  /** Re-syncs every control, the title and the canvases from settings. */
  update(): void {
    const active = this.options.activeTool();
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
    }, cssWidth, cssHeight);
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
