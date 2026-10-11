/**
 * Persisted tool settings shared by the notebook and PDF editors.
 *
 * The plugin owns one brush configuration in its data file: it loads and
 * sanitizes it once at startup, hands every editor the same BrushSettings
 * objects, and editors report changes back for a debounced save. Sanitizing
 * is field-level so one corrupted value falls back to its default without
 * discarding the rest of the saved settings.
 */

import { INK_COLORS, PRESET_PALETTE_MAX, PRESET_PALETTE_MIN } from "./brush-popover";
import type { BrushSettings } from "./brush-popover";
import type { EraserMode, ToolState } from "./ink-writing";
import type { InkClipboard } from "./lasso-clipboard";

/** The JSON shape persisted under `toolState` in the plugin data file. */
export type StoredToolState = Pick<ToolState, "pen" | "highlighter" | "eraserMode" | "eraserSize" | "palette" | "lasso" | "fingerAsPen">;

/** Single source of the pristine defaults both editors start from. */
export function defaultToolState(): ToolState {
  return {
    tool: "pen",
    fingerAsPen: false,
    pen: { color: "#1b1b1b", width: 3, opacity: 1, smooth: 0, taper: 0, pressureGain: 100, speedGain: 0, pressureCurve: undefined },
    highlighter: { color: "#f2c94c", width: 18, opacity: 0.4 },
    eraserMode: "stroke",
    eraserSize: 32,
    palette: INK_COLORS.map((color) => color.value),
    lasso: { mode: "freehand", crossFileClipboard: false },
  };
}

// Sanitized values must stay inside the ranges of the live controls, or the
// sliders would display one thing while the editor draws with another.
// Width mirrors brushToolConfigs() (pen max 24, highlighter max 48), opacity
// the brush panel slider, eraser size the eraser mini popover (8..160).
const PEN_WIDTH_RANGE = [1, 24] as const;
const HIGHLIGHTER_WIDTH_RANGE = [1, 48] as const;
const OPACITY_RANGE = [0.1, 1] as const;
const PERCENT_RANGE = [0, 100] as const;
const ERASER_SIZE_RANGE = [8, 160] as const;
const CSS_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Rebuilds a ToolState from untrusted saved data: missing or invalid fields
 * fall back to their default individually, numbers are clamped into their
 * control ranges, so a corrupted data file degrades to defaults instead of
 * breaking the editor.
 */
export function sanitizeToolState(raw: unknown): ToolState {
  const defaults = defaultToolState();
  const source = isRecord(raw) ? raw : {};
  const lasso = isRecord(source.lasso) ? source.lasso : {};
  return {
    tool: defaults.tool,
    fingerAsPen: source.fingerAsPen === true,
    pen: sanitizeBrush(source.pen, defaults.pen, PEN_WIDTH_RANGE, true),
    highlighter: sanitizeBrush(source.highlighter, defaults.highlighter, HIGHLIGHTER_WIDTH_RANGE, false),
    eraserMode: isEraserMode(source.eraserMode) ? source.eraserMode : defaults.eraserMode,
    eraserSize: sanitizeNumber(source.eraserSize, defaults.eraserSize, ERASER_SIZE_RANGE),
    palette: sanitizePalette(source.palette),
    lasso: { mode: lasso.mode === "rectangle" ? "rectangle" : "freehand", crossFileClipboard: lasso.crossFileClipboard === true },
  };
}

/** The plain-JSON snapshot to persist (the active tool stays per session). */
export function storedToolState(state: ToolState): StoredToolState {
  return {
    fingerAsPen: state.fingerAsPen,
    pen: storedBrush(state.pen),
    highlighter: storedBrush(state.highlighter),
    eraserMode: state.eraserMode,
    eraserSize: state.eraserSize,
    palette: [...state.palette],
    lasso: { ...state.lasso },
  };
}

/**
 * What the plugin hands each editor: the shared persisted settings plus the
 * debounced save trigger. Editors alias config.pen / config.highlighter into
 * their own ToolState (the active tool and the eraser values stay per
 * editor), so both editors and the saved data see one set of brush settings.
 */
export interface SharedToolState {
  config: ToolState;
  scheduleSave(state: ToolState): void;
  clipboard?: InkClipboard;
}

export const TOOL_STATE_SAVE_DEBOUNCE_MS = 500;

/** Trailing-edge debounce: saves once, TOOL_STATE_SAVE_DEBOUNCE_MS after the
 *  last change. Slider drags fire input events at frame rate; without the
 *  debounce every step would serialize the whole data file. */
export class ToolStateSaver {
  private timer: number | undefined;
  private latest: ToolState | null = null;

  constructor(private readonly save: (state: StoredToolState) => Promise<void>,
    private readonly delay: number = TOOL_STATE_SAVE_DEBOUNCE_MS) {}

  schedule(state: ToolState): void {
    this.latest = state;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.delay);
  }

  /** Saves the pending settings now (unload safety net); no-op when idle. */
  flush(): void {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const state = this.latest;
    if (!state) return;
    this.latest = null;
    void this.save(storedToolState(state));
  }
}

function sanitizeBrush(raw: unknown, fallback: BrushSettings, widthRange: readonly [number, number], withDynamics: boolean): BrushSettings {
  const source = isRecord(raw) ? raw : {};
  const settings: BrushSettings = {
    color: typeof source.color === "string" && CSS_HEX_COLOR.test(source.color) ? source.color : fallback.color,
    width: sanitizeNumber(source.width, fallback.width, widthRange),
    opacity: sanitizeNumber(source.opacity, fallback.opacity, OPACITY_RANGE),
  };
  if (!withDynamics) return settings;
  settings.smooth = sanitizeNumber(source.smooth, fallback.smooth ?? 0, PERCENT_RANGE);
  settings.taper = sanitizeNumber(source.taper, fallback.taper ?? 0, PERCENT_RANGE);
  settings.pressureGain = sanitizeNumber(source.pressureGain, fallback.pressureGain ?? 100, PERCENT_RANGE);
  settings.speedGain = sanitizeNumber(source.speedGain, fallback.speedGain ?? 0, PERCENT_RANGE);
  settings.pressureCurve = sanitizePressureCurve(source.pressureCurve);
  return settings;
}

/**
 * The curve editor keeps control points ordered so its sampling loop can
 * step forward; an out-of-order or non-numeric saved curve is discarded
 * (falling back to the identity mapping) rather than "repaired".
 */
function sanitizePressureCurve(raw: unknown): number[][] | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 32) return undefined;
  const points: number[][] = [];
  let previousX = -Infinity;
  for (const point of raw) {
    if (!Array.isArray(point) || point.length < 2) return undefined;
    const [x, y] = point;
    if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    const clampedX = Math.min(1, Math.max(0, x));
    if (clampedX < previousX) return undefined;
    previousX = clampedX;
    points.push([clampedX, Math.min(1, Math.max(0, y))]);
  }
  return points;
}

function sanitizeNumber(raw: unknown, fallback: number, [min, max]: readonly [number, number]): number {
  return typeof raw === "number" && Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : fallback;
}

function isEraserMode(value: unknown): value is EraserMode {
  return value === "stroke" || value === "circle" || value === "square";
}

/**
 * The preset swatch palette: hex colors only, case-insensitive dedupe,
 * clamped to the palette editor's range. Anything invalid shrinks the list;
 * fewer than the minimum (or nothing valid) restores the stock palette
 * instead of leaving the editor without a swatch.
 */
function sanitizePalette(raw: unknown): string[] {
  const stock = INK_COLORS.map((color) => color.value);
  if (!Array.isArray(raw)) return stock;
  const seen = new Set<string>();
  const palette: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || !CSS_HEX_COLOR.test(entry)) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    palette.push(entry);
    if (palette.length >= PRESET_PALETTE_MAX) break;
  }
  return palette.length >= PRESET_PALETTE_MIN ? palette : stock;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function storedBrush(settings: BrushSettings): BrushSettings {
  return {
    ...settings,
    // Deep-copy the curve: the editor mutates control-point arrays in place.
    ...(settings.pressureCurve ? { pressureCurve: settings.pressureCurve.map((point) => [...point]) } : {}),
  };
}
