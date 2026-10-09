/**
 * Shared writing layer for both ink editors (notebook and PDF).
 *
 * Everything from pointer capture through stroke modeling, preview commits,
 * eraser/lasso behavior, history stack mechanics and save scheduling lives
 * here exactly once; the notebook and PDF views only supply their seams:
 * geometry (which page, which rect), model access, render targets and the
 * storage path. Every fix landed here applies to both editors — the previous
 * per-view forks are where iPad bugs survived fixes made in the other fork.
 *
 * Method bodies are the notebook editor's proven implementations. Where the
 * PDF fork had drifted (sparser guard set, dead sparse-input path, unclamped
 * lift pressure, no raw-update pipeline), this layer re-unifies it on the
 * notebook semantics.
 */

import { FileView, Menu, Notice, setIcon } from "obsidian";
import {
  MAX_RAW_POINT_SAMPLES,
  ModelerEngageReason,
  StrokeDiagnosticsRecord,
  intervalStats,
  pushStrokeRecord,
} from "./diagnostics";
import {
  InkNotebook,
  InkPage,
  InkPoint,
  InkStroke,
  InkTool,
  newId,
} from "./model";
import { BrushPopoverController, BrushSettings, BrushTool, closeAnchoredPopover, isBrushTool, placePopover } from "./brush-popover";
import { Rect, TileRenderer } from "./tiles";
import { StrokeModeler, StrokeModelInput, StrokeModelResult, StrokeModelParams, DEFAULT_STROKE_MODEL_PARAMS, strokeModelParamsForSmoothStrength } from "./stroke-modeler";
import type { InkWorkerResponse, NotebookOperation } from "./worker-protocol";
import { InkWorkerService, InkWorkerSession } from "./worker-service";
import { canvasResolution, clampPercent, drawInkStroke, normalizePressureCurve, samplePressureCurve } from "./rendering";
import { defaultToolState, type SharedToolState } from "./tool-state";

export interface ToolState {
  tool: InkTool;
  pen: BrushSettings;
  highlighter: BrushSettings;
  eraserMode: EraserMode;
  eraserSize: number;
  /** Editable preset swatch colors, shared by both editors and persisted
   *  with the rest of the tool settings (1..10 entries). */
  palette: string[];
}

export type EraserMode = "stroke" | "circle" | "square";

export interface EditCommand {
  undo: () => void;
  redo: () => void;
  rebuild?: boolean;
}

export interface InteractionContext {
  generation: number;
  pointerId: number;
  pointerType: string;
  source: "pointer" | "stylus-touch";
  pageId: string;
  tool: InkTool;
  eraserMode?: EraserMode;
  eraserSize?: number;
}

export interface InkPointerSample {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  pressure: number;
  tiltX?: number;
  tiltY?: number;
  /** Monotonic event time in ms; coalesced samples carry distinct values. */
  timeStamp?: number;
  getCoalescedEvents?: () => InkPointerSample[];
  getPredictedEvents?: () => InkPointerSample[];
  button?: number;
  buttons?: number;
  preventDefault?: () => void;
}

interface StylusTouch extends Touch {
  altitudeAngle?: number;
  azimuthAngle?: number;
}

export interface ConfirmedStrokeOutline {
  points: Float32Array;
  sampleCount: number;
  mode: "pen" | "highlighter";
}

/** Capture-time state for modeling one active pen stroke. */
export interface PenCapture {
  modeler: StrokeModeler;
  pageWidth: number;
  pageHeight: number;
  /** Last fed input; null once the stroke's up event has been modeled. */
  lastInput: StrokeModelInput | null;
  /** Most recent raw-sample pressure, for inheriting lift pressure. */
  lastRawPressure: number;
  lastStored: { x: number; y: number };
  /** Set when the input stream breaks; the stroke then continues raw. */
  fallback: boolean;
}

const STROKE_ERASER_HIT_RADIUS = 10;
const OVERLAY_PIXEL_BUDGET = 12_000_000;
const SAVE_IDLE_DELAY = 1_500;
const SAVE_MAX_DELAY = 10_000;
export const INK_COMMIT_IDLE_DELAY = 180;
const LIVE_TAIL_SAMPLE_LIMIT = 32;
const COMPLETED_PREVIEW_SAMPLE_LIMIT = 256;
// Modeled pen samples are deduplicated against this page-pixel radius. The
// radius must exceed the modeler's end-of-stroke catch-up step sizes: those
// converging (and overshoot-reversing) micro-segments otherwise reach the
// outline renderer whole, whose (size*smoothing)^2 outline-point gate then
// misconnects the end-cap arc into a visible dot past the tail. 0.35 page px
// stays far below one nib width while collapsing that cluster.
const PEN_CAPTURE_MIN_DISTANCE = 0.35;
// A median inter-sample interval above this (ms) marks a sparse input stream
// whose raw polyline looks segmented; the stroke modeler then intervenes even
// with smooth disabled. ~24 ms ≈ devices delivering fewer than ~40 Hz.
export const SPARSE_SAMPLE_INTERVAL_MS = 24;
const PEN_SAMPLE_INTERVAL_WINDOW = 32;
const PEN_SPARSE_MIN_INTERVALS = 8;
/** Undo entries retained per editor. Full-notebook snapshots are heavy; the
 *  cap keeps worst-case memory bounded without being reachable in practice. */
const UNDO_STACK_LIMIT = 200;

// ---------------------------------------------------------------------------
// Pure geometry / model helpers
// ---------------------------------------------------------------------------

export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointInsideRect(point: { clientX: number; clientY: number }, rect: DOMRect): boolean {
  return point.clientX >= rect.left && point.clientX <= rect.right
    && point.clientY >= rect.top && point.clientY <= rect.bottom;
}

function stylusTouchSample(touch: StylusTouch, timeStamp?: number): InkPointerSample {
  const altitude = touch.altitudeAngle;
  const azimuth = touch.azimuthAngle;
  let tiltX = 0;
  let tiltY = 0;
  if (typeof altitude === "number" && altitude >= 0 && altitude <= Math.PI / 2
    && typeof azimuth === "number" && azimuth >= 0 && azimuth <= Math.PI * 2) {
    if (altitude === 0) {
      tiltX = azimuth === Math.PI / 2 || azimuth === Math.PI * 1.5 ? 0 : Math.sign(Math.cos(azimuth)) * 90;
      tiltY = azimuth === 0 || azimuth === Math.PI || azimuth === Math.PI * 2 ? 0 : Math.sign(Math.sin(azimuth)) * 90;
    } else {
      const slope = 1 / Math.tan(altitude);
      tiltX = Math.atan(Math.cos(azimuth) * slope) * 180 / Math.PI;
      tiltY = Math.atan(Math.sin(azimuth) * slope) * 180 / Math.PI;
    }
  }
  return {
    pointerId: touch.identifier,
    pointerType: "pen",
    clientX: touch.clientX,
    clientY: touch.clientY,
    pressure: touch.force,
    tiltX,
    tiltY,
    // Touch objects carry no per-sample timestamp; the owning TouchEvent's is
    // per-event, which is exactly the per-sample time for stylus input.
    timeStamp: typeof timeStamp === "number" && Number.isFinite(timeStamp) ? timeStamp : undefined,
  };
}

/**
 * iPadOS re-reports a fresh, frequently higher pressure on the lift sample at
 * the frozen tail position (measured in device diagnostics: the fading tail
 * reads 0.01-0.33, the lift jumps back to 0.36-0.76). Contact force can only
 * fall while the pen is leaving the surface, so a rising lift reading is that
 * artifact; clamping to the previous point keeps the rendered tail from
 * fattening into a round dot past the stroke.
 */
export function clampLiftPressure(point: InkPoint, previous: InkPoint | null): void {
  if (!previous || point.pressure <= previous.pressure) return;
  point.pressure = previous.pressure;
}

export function penSampleTimeMillis(sample: InkPointerSample): number {
  // Pointer events carry a monotonic per-sample timestamp; falling back to
  // Date.now() would give every coalesced sample of one event the same time
  // and defeat the modeler's resampling.
  return typeof sample.timeStamp === "number" && Number.isFinite(sample.timeStamp) ? sample.timeStamp : Date.now();
}

export function strokeIntersectsEraser(stroke: InkStroke, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  if (stroke.points.some((point) => pointInsideEraser(point, center, radius, mode, width, height))) return true;
  for (let index = 1; index < stroke.points.length; index++) {
    if (segmentIntersectsEraser(stroke.points[index - 1], stroke.points[index], center, radius, mode, width, height)) return true;
  }
  return false;
}

export function eraseStrokeSegments(stroke: InkStroke, center: InkPoint, radius: number, mode: Exclude<EraserMode, "stroke">, width: number, height: number): InkPoint[][] {
  const segments: InkPoint[][] = [];
  let segment: InkPoint[] = [];
  const flush = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };
  for (const point of sampleStrokeForEraser(stroke.points, radius, width, height)) {
    if (pointInsideEraser(point, center, radius, mode, width, height)) flush();
    else segment.push({ ...point });
  }
  flush();
  return segments;
}

function pointInsideEraser(point: InkPoint, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  const dx = (point.x - center.x) * width;
  const dy = (point.y - center.y) * height;
  return mode === "square" ? Math.abs(dx) <= radius && Math.abs(dy) <= radius : Math.hypot(dx, dy) <= radius;
}

function segmentIntersectsEraser(start: InkPoint, end: InkPoint, center: InkPoint, radius: number, mode: EraserMode, width: number, height: number): boolean {
  const ax = (start.x - center.x) * width;
  const ay = (start.y - center.y) * height;
  const bx = (end.x - center.x) * width;
  const by = (end.y - center.y) * height;
  if (mode === "square") return segmentIntersectsBox(ax, ay, bx, by, radius);
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return Math.hypot(ax + dx * t, ay + dy * t) <= radius;
}

function segmentIntersectsBox(ax: number, ay: number, bx: number, by: number, radius: number): boolean {
  let minimum = 0, maximum = 1;
  const dx = bx - ax, dy = by - ay;
  for (const [origin, delta] of [[ax, dx], [ay, dy]] as const) {
    if (delta === 0) { if (origin < -radius || origin > radius) return false; continue; }
    const near = (-radius - origin) / delta;
    const far = (radius - origin) / delta;
    minimum = Math.max(minimum, Math.min(near, far));
    maximum = Math.min(maximum, Math.max(near, far));
    if (minimum > maximum) return false;
  }
  return true;
}

function sampleStrokeForEraser(points: InkPoint[], radius: number, width: number, height: number): InkPoint[] {
  if (points.length < 2) return points.map((point) => ({ ...point }));
  const sampled: InkPoint[] = [{ ...points[0] }];
  const step = Math.max(1, radius / 3);
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1], end = points[index];
    const pixels = Math.hypot((end.x - start.x) * width, (end.y - start.y) * height);
    const count = Math.max(1, Math.ceil(pixels / step));
    for (let sample = 1; sample <= count; sample++) sampled.push(interpolateInkPoint(start, end, sample / count));
  }
  return sampled;
}

function interpolateInkPoint(start: InkPoint, end: InkPoint, amount: number): InkPoint {
  return {
    x: start.x + (end.x - start.x) * amount,
    y: start.y + (end.y - start.y) * amount,
    pressure: start.pressure + (end.pressure - start.pressure) * amount,
    tiltX: start.tiltX === undefined || end.tiltX === undefined ? end.tiltX : start.tiltX + (end.tiltX - start.tiltX) * amount,
    tiltY: start.tiltY === undefined || end.tiltY === undefined ? end.tiltY : start.tiltY + (end.tiltY - start.tiltY) * amount,
    t: start.t + (end.t - start.t) * amount,
  };
}

export function cloneStroke(stroke: InkStroke): InkStroke {
  return { ...stroke, points: clonePoints(stroke.points), dynamics: stroke.dynamics ? { ...stroke.dynamics } : undefined };
}

export function clonePoints(points: InkPoint[]): InkPoint[] {
  return points.map((point) => ({ ...point }));
}

export function packStrokePoints(points: readonly InkPoint[], start: number): Float64Array {
  const packed = new Float64Array((points.length - start) * 6);
  let offset = 0;
  for (let index = start; index < points.length; index++) {
    const point = points[index];
    packed[offset++] = point.x;
    packed[offset++] = point.y;
    packed[offset++] = point.pressure;
    packed[offset++] = point.tiltX ?? Number.NaN;
    packed[offset++] = point.tiltY ?? Number.NaN;
    packed[offset++] = point.t;
  }
  return packed;
}

function drawImmediateStrokeTail(ctx: CanvasRenderingContext2D, stroke: InkStroke, width: number, height: number, confirmedSamples: number): void {
  // Keep lightweight test doubles and legacy snapshots readable. Real strokes
  // always carry a point array and use the incremental pressure-line path.
  if (!Array.isArray(stroke.points)) {
    drawInkStroke(ctx, stroke, width, height);
    return;
  }
  if (stroke.points.length === 0 || confirmedSamples >= stroke.points.length) return;
  // The canvas is cleared each frame, so every sample not covered by the
  // Worker outline must be redrawn. Truncating this tail erases live ink when
  // fast input outruns the Worker or the host has no Worker support.
  // Retain one confirmed sample as seam context for the uncovered geometry.
  const start = Math.max(0, confirmedSamples - 1);
  drawInkStroke(ctx, { ...stroke, points: stroke.points.slice(start) }, width, height);
}

function boundedPreviewStroke(stroke: InkStroke): InkStroke {
  if (!Array.isArray(stroke.points) || stroke.points.length <= COMPLETED_PREVIEW_SAMPLE_LIMIT) return stroke;
  const last = stroke.points.length - 1;
  const points = Array.from({ length: COMPLETED_PREVIEW_SAMPLE_LIMIT }, (_, index) =>
    stroke.points[Math.round(index * last / (COMPLETED_PREVIEW_SAMPLE_LIMIT - 1))]);
  return { ...stroke, points };
}

function restoredStroke(stroke: InkStroke): InkStroke {
  const now = Date.now();
  return { ...cloneStroke(stroke), id: newId("stroke"), createdAt: now, updatedAt: now };
}

export function translatePoints(points: InkPoint[], dx: number, dy: number): InkPoint[] {
  return points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy, t: Date.now() }));
}

export function selectionBounds(strokes: InkStroke[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  return boundsForPointSets(strokes.map((stroke) => stroke.points));
}

export function boundsForPointSets(pointSets: InkPoint[][]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const points of pointSets) for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

export function pointInPolygon(point: InkPoint, polygon: InkPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function constrainDelta(delta: number, minimum: number, maximum: number): number {
  return Math.max(-minimum, Math.min(1 - maximum, delta));
}

function isPointerCaptureError(error: unknown): boolean {
  // instanceof misses DOMExceptions originating in another Obsidian window.
  if (Object.prototype.toString.call(error) !== "[object DOMException]") return false;
  const name = (error as DOMException).name;
  return name === "NotFoundError" || name === "InvalidStateError";
}

// ---------------------------------------------------------------------------
// Shared writing layer
// ---------------------------------------------------------------------------

/**
 * Base class carrying the complete writing pipeline. Subclasses implement the
 * small seam surface declared abstract below; everything else behaves
 * identically in both editors.
 */
export abstract class InkWritingView extends FileView {
  /** Defaults come from the persistence module so saved settings restore
   *  against the exact same shape the editors start from. */
  protected state: ToolState = defaultToolState();

  // --- view-provided geometry / render state
  protected tiles: TileRenderer | null = null;
  protected viewport: Rect = { x: 0, y: 0, width: 1, height: 1 };
  protected zoom = 1;
  protected zoomLocked = false;
  private zoomHud: HTMLElement | null = null;
  private zoomHudValue: HTMLElement | null = null;
  private zoomLockButton: HTMLButtonElement | null = null;
  private zoomHudTimer: number | undefined;
  protected canvasLogicalWidth = 1;
  protected canvasLogicalHeight = 1;
  protected viewReady = false;
  /** Selection/interaction overlay: lasso path, selection bounds, eraser and
   *  lasso interaction frames. Assigned by the view's canvas build. */
  protected canvas!: HTMLCanvasElement;
  protected ctx!: CanvasRenderingContext2D;
  protected lassoCanvas: HTMLCanvasElement | null = null;
  protected lassoCtx: CanvasRenderingContext2D | null = null;
  protected previewCanvas: HTMLCanvasElement | null = null;
  protected previewCtx: CanvasRenderingContext2D | null = null;
  protected confirmedPreviewCanvas: HTMLCanvasElement | null = null;
  protected confirmedPreviewCtx: CanvasRenderingContext2D | null = null;
  protected eraserCursor!: HTMLElement;
  protected eraserHoverPoint: InkPoint | null = null;
  protected eraserPointerInside = false;
  protected renderFrame: number | null = null;
  protected resizeRequested = false;

  // --- shared brush settings popover + toolbar
  protected brushPopover!: BrushPopoverController;
  /** Popover root; reflects the eraser mode state (is-stroke-eraser). */
  protected settingsPanel: HTMLElement | null = null;
  /** The eraser's own mini popover (mode + size only). */
  protected eraserPopover: HTMLElement | null = null;
  private eraserPopoverClose: (() => void) | null = null;

  // --- shared persisted tool settings (wired by the plugin assembly)
  private sharedToolSettings: SharedToolState | null = null;

  // --- worker pipeline
  protected workers: InkWorkerService | undefined;
  protected workerSession: InkWorkerSession | null = null;
  protected workerRevision = 0;
  protected workerFallbackReported = false;

  // --- active interaction
  protected interaction: InteractionContext | null = null;
  protected interactionGeneration = 0;
  protected activePointerId: number | null = null;
  protected activeStroke: InkStroke | null = null;
  protected workerStrokePointIndex = 0;
  protected lastPoint: InkPoint | null = null;
  protected touchGesture: {
    ids: number[];
    distance: number;
    currentDistance: number;
    zoom: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    /** Locked drag axis; "x" on a horizontally-dominant drag that cannot
     *  scroll past its edge (the page-flip gesture), "y" for panning. */
    axis: "x" | "y" | null;
    /** Page-flip drag telemetry: last sample and smoothed velocity (px/ms). */
    lastX: number;
    lastT: number;
    velocity: number;
    dragX: number;
    /** Gesture-start midpoint, normalized page space (pinch anchor). */
    pageX: number;
    pageY: number;
  } | null = null;
  /** Last input the active pointer produced; drives stale-interaction
   *  healing when the platform loses the final pointerup. */
  protected lastPointerActivityAt = 0;

  // --- pen modeling
  protected penModeler: PenCapture | null = null;
  /** Active while pointerrawupdate delivers pen samples; tracks the newest
   *  consumed timestamp so pointermove batches cannot replay eaten samples. */
  protected rawUpdateCapture: { pointerId: number; lastTime: number } | null = null;
  /** Recent inter-sample intervals (ms), the device-rate history that drives
   *  the sparse-input auto-intervention. */
  protected penSampleIntervals: number[] = [];
  protected lastPenSampleTime: number | null = null;
  /** Predicted (speculative) tip points for the active stroke, page space.
   *  Render-only: they never enter stroke.points and are dropped at lift. */
  protected predictedTip: InkPoint[] | null = null;
  protected devPredictedSamples = 0;

  // --- ink preview / commit
  protected confirmedStrokeOutlines = new Map<string, ConfirmedStrokeOutline>();
  protected pendingInkStrokes: InkStroke[] = [];
  protected committingInkStrokes: InkStroke[] | null = null;
  protected pendingInkPageId: string | null = null;
  protected inkCommitTimer: number | undefined;

  // --- eraser bookkeeping
  protected erasedStrokeIds = new Set<string>();
  protected erasedCandidateIds = new Set<string>();
  protected erasedStrokes: InkStroke[] = [];
  protected eraserReplacementIds = new Set<string>();
  protected eraserReplacements: InkStroke[] = [];
  protected eraserPreviewCells = new Set<string>();

  // --- lasso / selection
  protected lassoPath: InkPoint[] = [];
  protected selectedStrokeIds = new Set<string>();
  protected lassoDrag: {
    start: InkPoint;
    pageId: string;
    bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
    strokes: InkStroke[];
    before: Map<string, InkPoint[]>;
    dx: number;
    dy: number;
  } | null = null;
  protected pendingLassoPoint: InkPoint | null = null;

  // --- history
  protected undoStack: EditCommand[] = [];
  protected redoStack: EditCommand[] = [];

  // --- save scheduling (the write path itself stays per view)
  protected saveTimer: number | undefined;
  protected maxSaveTimer: number | undefined;
  protected maxSaveDue = false;

  // --- diagnostics (records shared; the dev panel UI stays in the notebook view)
  protected strokeRecords: StrokeDiagnosticsRecord[] = [];
  protected currentStrokeRecord: StrokeDiagnosticsRecord | null = null;
  protected strokeRecordCounter = 0;
  protected pendingLiftPagePx: { x: number; y: number } | null = null;
  protected devPointerEvents = 0;
  protected devRawUpdates = 0;
  protected devCoalescedSamples = 0;
  protected devSamplesFed = 0;
  protected devLastPointerType: string | null = null;

  // ------------------------------------------------------------------ seams

  protected readingMode = false;

  /** The notebook model this editor writes into (drives op metadata). */
  protected abstract currentNotebook(): InkNotebook;
  /** The page new input lands on. */
  protected abstract currentPage(): InkPage;
  /** Screen rect input coordinates are normalized against. */
  protected abstract inputRect(): DOMRect;
  /** True while gestures must not start new input (reading mode, locks). */
  protected inputLocked(): boolean { return false; }
  /** Page pixel extent used for diagnostics distances and modeler space. */
  protected abstract pagePixelSize(): { width: number; height: number };
  /** Called after the model was mutated; tracks dirtiness per storage. */
  protected abstract onModelMutated(): void;
  /** Resize pass before a render frame that was requested with resize. */
  protected abstract onRenderResize(): void;
  protected abstract resizeOverlay(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, maxPixels: number): boolean;
  /** Element the toolbar buttons/sections are queried against. */
  protected abstract toolbarRoot(): HTMLElement;
  /** Scrollable container the touch pan gesture moves. */
  protected abstract inputScroller(): HTMLElement;
  /** Zoom applied for a two-finger pinch (value already computed). */
  protected abstract applyGestureZoom(value: number, focus: { x: number; y: number }, anchor: { x: number; y: number }): void;

  protected zoomLevel(): number { return this.zoom; }
  protected onZoomLockChanged(): void {}

  protected buildZoomHud(parent: HTMLElement): void {
    this.disposeZoomHud();
    const hud = parent.createDiv({ cls: "ink-zoom-hud", attr: { "aria-label": "Zoom", "aria-hidden": "true" } });
    this.zoomHud = hud;
    this.zoomHudValue = hud.createSpan({ cls: "ink-zoom-hud-value" });
    this.zoomLockButton = hud.createEl("button", { cls: "ink-zoom-lock", attr: { type: "button", tabindex: "-1" } });
    this.zoomLockButton.addEventListener("click", () => this.toggleZoomLock());
    // The floating control must never start ink or join the page's gesture.
    for (const type of ["pointerdown", "pointerup", "touchstart", "touchmove", "touchend", "touchcancel"]) {
      hud.addEventListener(type, (event) => event.stopPropagation());
    }
    this.updateZoomHud();
  }

  protected updateZoomHud(): void {
    const value = `${Math.round(this.zoomLevel() * 100)}%`;
    if (this.zoomHudValue && this.zoomHudValue.textContent !== value) this.zoomHudValue.textContent = value;
    const button = this.zoomLockButton;
    if (!button) return;
    const label = this.zoomLocked ? "Unlock zoom" : "Lock zoom";
    if (button.getAttribute("aria-label") !== label) {
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(this.zoomLocked));
      button.replaceChildren();
      setIcon(button, this.zoomLocked ? "lock-keyhole" : "lock-keyhole-open");
    }
  }

  private showZoomHud(): void {
    if (!this.zoomHud) return;
    if (this.zoomHudTimer !== undefined) window.clearTimeout(this.zoomHudTimer);
    this.zoomHudTimer = undefined;
    this.updateZoomHud();
    if (this.zoomHud.classList.contains("is-visible")) return;
    this.zoomHud.classList.add("is-visible");
    this.zoomHud.setAttribute("aria-hidden", "false");
    this.zoomLockButton?.removeAttribute("tabindex");
  }

  protected scheduleZoomHudHide(): void {
    if (!this.zoomHud) return;
    if (this.zoomHudTimer !== undefined) window.clearTimeout(this.zoomHudTimer);
    // Exit takes 120ms, so the complete popup disappears within one second.
    this.zoomHudTimer = window.setTimeout(() => {
      this.zoomHudTimer = undefined;
      if (this.touchGesture?.ids.length === 2) return;
      if (document.activeElement === this.zoomLockButton) this.zoomLockButton?.blur();
      this.zoomHud?.classList.remove("is-visible");
      this.zoomHud?.setAttribute("aria-hidden", "true");
      this.zoomLockButton?.setAttribute("tabindex", "-1");
    }, 850);
  }

  private toggleZoomLock(): void {
    this.zoomLocked = !this.zoomLocked;
    this.onZoomLockChanged();
    const gesture = this.touchGesture;
    if (gesture?.ids.length === 2) {
      // Rebase against the latest contacts so unlocking cannot jump to the
      // distance accumulated while zoom was frozen.
      const rect = this.inputRect();
      gesture.zoom = this.zoom;
      gesture.distance = gesture.currentDistance;
      gesture.pageX = (gesture.x - rect.left) / rect.width;
      gesture.pageY = (gesture.y - rect.top) / rect.height;
    }
    this.showZoomHud();
    if (gesture?.ids.length !== 2) this.scheduleZoomHudHide();
  }

  protected disposeZoomHud(): void {
    if (this.zoomHudTimer !== undefined) window.clearTimeout(this.zoomHudTimer);
    this.zoomHudTimer = undefined;
    this.zoomHud?.remove();
    this.zoomHud = this.zoomHudValue = this.zoomLockButton = null;
  }

  // ------------------------------------------------------- tool switching

  /** View hook before a tool button selects a tool (PDF: enter editing). */
  protected onToolSelected(_tool: InkTool): void {}
  /** View hook: the page-flip drag moved by `offset` px — the page and the
   *  neighbouring page slide along with the finger. */
  protected swipeDrag(_offset: number): void {}
  /** View hook: the drag ended. delta is -1/+1 to flip (animated slide to
   *  the neighbouring page) or 0 to spring back. */
  protected swipeSettle(_delta: number, _travel = 0): void {}

  protected pageInsertThreshold(): number {
    return Math.max(120, Math.min(240, this.inputScroller().clientWidth * 0.35));
  }

  protected showPageInsertPreview(stage: HTMLElement, side: number): void {
    stage.dataset.insert = "true";
    const hint = stage.createDiv({ cls: "ink-page-insert-hint", attr: { "aria-hidden": "true" } });
    hint.style[side < 0 ? "right" : "left"] = "24px";
    setIcon(hint, "plus");
  }

  protected updatePageInsertPreview(stage: HTMLElement | null, offset: number): void {
    if (stage?.dataset.insert) stage.toggleClass("is-ready", Math.abs(offset) >= this.pageInsertThreshold());
  }

  protected openPageInsertMenu(event: MouseEvent, index: number, count: number, insert: (index: number) => void): void {
    if (this.readingMode) return;
    const menu = this.beginPageOptionsMenu(event);
    if (!menu) return;
    for (const [title, position] of [
      ["Add page before current", index], ["Add page after current", index + 1],
      ["Add page before first", 0], ["Add page after last", count],
    ] as const) {
      menu.addItem((item) => item.setTitle(title).setIcon("plus").onClick(() => insert(position)));
    }
    menu.showAtMouseEvent(event);
  }

  protected flipSettling = false;
  private pageSwipeAnimations: Animation[] = [];
  private pageSwipeRequest: { target: number; count: number } | null = null;

  /** Track the requested destination, including swipes made while saving/rendering. */
  protected beginPageSwipe(target: number, count: number): () => boolean {
    const request = { target, count };
    this.pageSwipeRequest = request;
    return () => this.flipSettling && this.pageSwipeRequest === request;
  }

  protected clearPageSwipeTarget(): void { this.pageSwipeRequest = null; }

  /** Coalesce rapid swipes instead of replaying a backlog of animations/renders. */
  protected async navigatePageSwipe(navigate: (index: number) => Promise<void>,
    index: () => number, isCurrent: () => boolean): Promise<void> {
    while (isCurrent() && this.pageSwipeRequest !== null) {
      const target = this.pageSwipeRequest.target;
      if (target === index()) return;
      await navigate(target);
      // A failed or superseded navigation must not retry indefinitely.
      if (index() !== target) return;
    }
  }

  protected resumePageSwipeDrag(): void {
    if (this.touchGesture?.axis === "x") this.swipeDrag(this.touchGesture.dragX);
  }

  private finishPageSwipeAnimations(): void {
    for (const animation of this.pageSwipeAnimations) {
      if (animation.playState === "running" || animation.playState === "paused") animation.finish();
    }
  }

  /** Both pages share a distance, clock and easing, so the gutter stays fixed. */
  protected animatePageSwipe(elements: HTMLElement[], from: number, to: number, done: () => void): void {
    this.cancelPageSwipeAnimations();
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const duration = Math.min(260, Math.max(140, Math.abs(to - from) * 0.35));
    const startTime = document.timeline?.currentTime;
    let remaining = elements.length;
    const finish = () => { if (--remaining === 0) done(); };
    for (const element of elements) {
      element.style.transition = "none";
      element.style.transform = `translateX(${to}px)`;
      if (reduced || from === to || typeof element.animate !== "function") {
        finish();
        continue;
      }
      const animation = element.animate(
        [{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }],
        { duration, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "forwards" });
      this.pageSwipeAnimations.push(animation);
      if (typeof startTime === "number") animation.startTime = startTime;
      animation.onfinish = finish;
      // Cancellation is not a successful flip. Settle back to the current page.
      animation.oncancel = () => {
        this.cancelPageSwipeAnimations();
        this.flipSettling = false;
        this.swipeSettle(0);
      };
    }
  }

  protected cancelPageSwipeAnimations(): void {
    for (const animation of this.pageSwipeAnimations) {
      animation.onfinish = animation.oncancel = null;
      animation.cancel();
    }
    this.pageSwipeAnimations = [];
  }

  private settlePageFlip(event: TouchEvent): void {
    const gesture = this.touchGesture;
    if (!gesture || gesture.axis !== "x") return;
    if (Array.from(event.touches).some((touch) => touch.identifier === gesture.ids[0])) return;
    const width = this.inputScroller().clientWidth;
    const travel = gesture.dragX;
    const releaseTime = typeof event.timeStamp === "number" ? event.timeStamp : gesture.lastT;
    const fling = releaseTime - gesture.lastT < 100 && gesture.velocity * travel > 0
      && Math.abs(gesture.velocity) > 0.35 && Math.abs(travel) > 24;
    const crossed = Math.abs(travel) > width * 0.35;
    const delta = fling || crossed ? (travel > 0 ? -1 : 1) : 0;
    if (this.flipSettling) {
      const request = this.pageSwipeRequest;
      if (request) request.target = Math.max(0, Math.min(request.count - 1, request.target + delta));
    } else {
      this.swipeSettle(delta, travel);
    }
  }

  /** Cancels an in-flight page-flip drag (spring back, no flip). */
  protected cancelPageFlip(): void {
    if (this.touchGesture?.axis === "x") this.swipeSettle(0);
  }
  protected settingsOpen(): boolean { return false; }
  protected toggleToolSettings(_anchor: HTMLElement): void {}
  /** Re-open the settings popover at the (new) active tool's anchor. */
  protected reopenToolSettings(): void {}
  /**
   * The toolbar control the settings popover anchors to: the ACTIVE TOOL's
   * button, so the panel grows out of the control that was actually tapped
   * and collapses back into it. Falls back to the toolbar when no tool
   * button exists (tests, unusual hosts).
   */
  protected activeSettingsAnchor(): HTMLElement | null {
    const root = this.toolbarRoot();
    return root.querySelector<HTMLElement>(`.ink-tool-button[data-tool="${this.state.tool}"]`)
      ?? root.querySelector<HTMLElement>(".ink-toolbar");
  }

  /** Host-specific popover class (the PDF view scopes its surface rules). */
  protected brushPopoverExtraClass(): string | undefined { return undefined; }

  /**
   * ONE popover entry for both editors: same controller, same tools, same
   * anchor rule (the active tool button) - the views only differ in an
   * optional extra class. Opens through re-tapping a tool; there is no
   * separate settings button on the toolbar.
   */
  protected ensureBrushSettingsPopover(): void {
    if (this.brushPopover) return;
    // Mount inside the view root: the popover is a sibling of the themed
    // view when hung on the container, and every --ink-* token would be
    // out of scope (transparent background, lost border, broken layout).
    const parent = (this.contentEl ?? this.containerEl) as HTMLElement | undefined;
    if (!parent?.createDiv) return;
    const extraClass = this.brushPopoverExtraClass();
    this.brushPopover = new BrushPopoverController(parent, {
      ...(extraClass ? { extraClass } : {}),
      tools: this.brushToolConfigs(),
      getSettings: (tool) => this.brushSettings(tool),
      activeTool: () => this.state.tool,
      showPenDynamics: () => this.state.tool === "pen",
      palette: () => this.state.palette,
      onControlsChanged: () => {
        this.updateEraserControls();
        this.scheduleToolStateSave();
      },
      anchor: () => this.activeSettingsAnchor(),
    });
    this.settingsPanel = this.brushPopover.root;
    this.registerPopoverDismiss();
  }

  /**
   * ONE dismiss/position wiring for the settings popover in both editors:
   * tap-outside closes (the popover's own controls and every tool button are
   * exempt - a tool's tap toggles its own panel), Escape closes and hands
   * focus back to the trigger, and window resizes and captures reposition
   * the panel. The per-view copies this replaces had drifted: the PDF fork
   * never repositioned on resize.
   */
  private registerPopoverDismiss(): void {
    const popover = this.brushPopover;
    this.registerDomEvent(document, "pointerdown", (event) => {
      if (!popover.isOpen) return;
      const target = event.target as HTMLElement | null;
      // Tool buttons decide their own open/close on click; a tap on another
      // tool must not close the popover first (it rebuilds for that tool).
      if (target && target.closest?.(".ink-tool-button")) return;
      if (target && popover.root.contains(target)) return;
      popover.close();
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && popover.isOpen) {
        popover.close();
        this.activeSettingsAnchor()?.focus();
      }
    });
    this.registerDomEvent(window, "resize", () => popover.position());
    this.registerDomEvent(window, "scroll", (event) => {
      // The panel's own scrolling must not reposition it: while a touch
      // scroll runs, platforms report jittering rects for fixed elements and
      // every reposition visibly nudged the panel sideways mid-scroll.
      if (event.target && popover.root.contains(event.target as Node)) return;
      popover.position();
    }, true);
  }

  /**
   * Adopts the plugin's shared persisted settings: pen and highlighter brush
   * settings are aliased (both editors and the saved data then see one
   * source of truth) while the active tool and the eraser values stay per
   * editor - sharing the active tool would desync the other editor's
   * toolbar from what its strokes actually use.
   */
  protected useSharedToolState(shared: SharedToolState): void {
    this.sharedToolSettings = shared;
    this.state = {
      tool: this.state.tool,
      pen: shared.config.pen,
      highlighter: shared.config.highlighter,
      eraserMode: shared.config.eraserMode,
      eraserSize: shared.config.eraserSize,
      palette: shared.config.palette,
    };
  }

  /** Persists tool settings (debounced); safe to call on every input event. */
  protected scheduleToolStateSave(): void {
    this.sharedToolSettings?.scheduleSave(this.state);
  }

  /** Shared drawing tools in the centre, with history next to page navigation. */
  protected buildWritingSections(toolbar: HTMLElement, historyParent: HTMLElement): void {
    const history = this.addToolbarSection(historyParent, "History");
    this.addIconButton(history, "undo-2", "Undo", () => this.undo(), this.undoStack.length === 0);
    this.addIconButton(history, "redo-2", "Redo", () => this.redo(), this.redoStack.length === 0);
    const draw = this.addToolbarSection(toolbar, "Draw");
    this.addToolButton(draw, "pen-line", "Pen", "pen");
    this.addToolButton(draw, "highlighter", "Highlight", "highlighter");
    this.addToolButton(draw, "eraser", "Erase", "eraser");
    this.addToolButton(draw, "lasso-select", "Select", "lasso");
  }

  protected buildReadingModeButton(parent: HTMLElement): void {
    const button = this.addIconButton(parent, "book-open", "Reading mode", () => this.setReadingMode(!this.readingMode));
    button.classList.add("ink-reading-toggle");
    this.updateReadingModeButton();
  }

  protected setReadingMode(reading: boolean): void {
    if (reading === this.readingMode) return;
    this.finishPointerInput(false);
    this.endDesktopPan();
    this.closePageOptionsMenu();
    this.brushPopover?.close();
    this.closeEraserPopover();
    this.clearSelection();
    this.readingMode = reading;
    this.toolbarRoot().toggleClass("ink-reading", reading);
    this.onReadingModeChanged();
    this.updateReadingModeButton();
    this.updateHistoryButtons();
    this.refreshEraserCursor();
  }

  protected onReadingModeChanged(): void {}

  private updateReadingModeButton(): void {
    const button = this.toolbarRoot().querySelector<HTMLButtonElement>(".ink-reading-toggle");
    if (!button) return;
    button.setAttribute("aria-pressed", String(this.readingMode));
    button.title = this.readingMode ? "Switch to editing mode" : "Switch to reading mode";
  }
  /** Whether the diagnostics panel wants raw point samples retained. */
  protected diagnosticsCaptureRawPoints(): boolean { return false; }
  /** Called at the top of a new pointerdown, after the input locks. */
  protected onInputStarting(): void {}
  /** Called once pending ink fully committed and no pointer is active. */
  protected applyPendingMergedNotebook(): void {}
  /** Called at the very end of finishPointerInput. */
  protected afterInputFullySettled(): void {}

  // ------------------------------------------------------------------ input

  private pageOptionsMenu: { menu: Menu; trigger: HTMLElement | null } | null = null;
  private pageOptionsTriggerPressed = false;
  private pageOptionsDismissRegistered = false;
  private desktopPan: { pointerId: number; x: number; y: number } | null = null;
  private desktopSpaceDown = false;
  private desktopWheelTravel = 0;
  private desktopWheelTimer: number | undefined;
  private desktopWheelFlipped = false;

  /** Snapshot the trigger press before the host dismisses its menu on pointerdown. */
  protected beginPageOptionsMenu(event: MouseEvent): Menu | null {
    if (!this.pageOptionsDismissRegistered) {
      this.pageOptionsDismissRegistered = true;
      const doc = this.containerEl.ownerDocument;
      const capturePress = (press: PointerEvent) => {
        this.pageOptionsTriggerPressed = !!this.pageOptionsMenu?.trigger?.contains(press.target as Node);
      };
      // Window capture precedes even a host document listener installed at startup.
      if (doc.defaultView) this.registerDomEvent(doc.defaultView, "pointerdown", capturePress, true);
      else this.registerDomEvent(doc, "pointerdown", capturePress, true);
      this.registerDomEvent(doc, "pointercancel", () => { this.pageOptionsTriggerPressed = false; }, true);
      this.registerDomEvent(doc, "keydown", () => { this.pageOptionsTriggerPressed = false; }, true);
      this.register(() => this.closePageOptionsMenu());
    }
    const trigger = event.currentTarget as HTMLElement | null;
    if (this.pageOptionsTriggerPressed || this.pageOptionsMenu?.trigger === trigger) {
      this.closePageOptionsMenu();
      return null;
    }
    this.closePageOptionsMenu();
    const menu = new Menu();
    const opened = { menu, trigger };
    this.pageOptionsMenu = opened;
    trigger?.setAttribute("aria-haspopup", "menu");
    trigger?.setAttribute("aria-expanded", "true");
    menu.onHide(() => {
      if (this.pageOptionsMenu !== opened) return;
      this.pageOptionsMenu = null;
      trigger?.setAttribute("aria-expanded", "false");
    });
    return menu;
  }

  protected closePageOptionsMenu(): void {
    this.pageOptionsTriggerPressed = false;
    const opened = this.pageOptionsMenu;
    this.pageOptionsMenu = null;
    opened?.trigger?.setAttribute("aria-expanded", "false");
    opened?.menu.hide();
  }

  /** An Obsidian native menu (page options) is open. While it is, surface
   *  input must not swallow the outside tap that dismisses it, and must not
   *  start ink underneath it. Resolved through the view's own document so
   *  DOM-less harnesses (gesture unit tests) simply read as "no menu". */
  protected nativeMenuOpen(): boolean {
    return !!this.containerEl?.ownerDocument?.querySelector?.(".menu");
  }

  protected desktopNavigate(_destination: "previous" | "next" | "first" | "last"): void {}
  protected desktopZoom(_factor: number, _target?: { x: number; y: number }): void {}
  protected desktopResetZoom(): void {}

  protected registerDesktopInput(): void {
    const scroller = this.inputScroller();
    const doc = this.containerEl.ownerDocument;
    scroller.tabIndex = 0;
    this.registerDomEvent(scroller, "pointerdown", (event) => {
      if (event.pointerType !== "mouse" || this.nativeMenuOpen()) return;
      scroller.focus({ preventScroll: true });
      if (this.beginDesktopPan(event)) event.stopPropagation();
    }, true);
    this.registerDomEvent(this.containerEl, "keydown", (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.isComposing || this.nativeMenuOpen()
        || target?.closest?.('input, textarea, select, [contenteditable], [role="dialog"]')) return;
      if (event.code === "Space" || event.key === " ") {
        if (target?.closest?.("button") || event.ctrlKey || event.metaKey || event.altKey) return;
        this.desktopSpaceDown = true;
        scroller.classList.add("ink-pan-ready");
        event.preventDefault();
        return;
      }
      if (this.onDesktopKeyDown(event)) { event.preventDefault(); event.stopPropagation(); }
    });
    this.registerDomEvent(doc, "keyup", (event: KeyboardEvent) => {
      if (event.code === "Space" || event.key === " ") {
        this.desktopSpaceDown = false;
        scroller.classList.remove("ink-pan-ready");
      }
    });
    this.registerDomEvent(doc, "pointermove", (event) => {
      if (this.desktopPan?.pointerId === event.pointerId) { this.onPointerMove(event); event.stopPropagation(); }
    }, true);
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      this.registerDomEvent(doc, type, (event) => {
        if (this.desktopPan?.pointerId === event.pointerId) this.endDesktopPan();
      }, true);
    }
    const reset = () => {
      this.desktopSpaceDown = false;
      scroller.classList.remove("ink-pan-ready");
      this.endDesktopPan();
      if (this.desktopWheelTimer !== undefined) window.clearTimeout(this.desktopWheelTimer);
      this.desktopWheelTravel = 0; this.desktopWheelFlipped = false;
    };
    if (doc.defaultView) this.registerDomEvent(doc.defaultView, "blur", reset);
    this.register(reset);
    this.registerDomEvent(scroller, "wheel", (event) => this.onWheel(event), { passive: false });
  }

  private onDesktopKeyDown(event: KeyboardEvent): boolean {
    if (this.activePointerId !== null || this.desktopPan || this.flipSettling) return false;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      if (key === "+" || key === "=") { this.desktopZoom(1.1); return true; }
      if (key === "-") { this.desktopZoom(1 / 1.1); return true; }
      if (key === "0") { this.desktopResetZoom(); return true; }
      if (this.inputLocked()) return false;
      if (key === "z") { if (event.shiftKey) this.redo(); else this.undo(); return true; }
      if (key === "y" && !event.shiftKey) { this.redo(); return true; }
      return false;
    }
    if (event.altKey) {
      if (key === "arrowleft") { this.desktopNavigate("previous"); return true; }
      if (key === "arrowright") { this.desktopNavigate("next"); return true; }
      return false;
    }
    const destinations: Record<string, "previous" | "next" | "first" | "last"> = {
      pageup: "previous", pagedown: "next", home: "first", end: "last",
    };
    const destination = destinations[key];
    if (destination) { this.desktopNavigate(destination); return true; }
    if (key === "+" || key === "=") { this.desktopZoom(1.1); return true; }
    if (key === "-") { this.desktopZoom(1 / 1.1); return true; }
    if (key === "0") { this.desktopResetZoom(); return true; }
    if (event.shiftKey || this.inputLocked()) return false;
    const tools: Record<string, InkTool> = { b: "pen", h: "highlighter", e: "eraser", v: "lasso" };
    const tool = tools[key];
    if (tool) { this.selectWritingTool(tool); return true; }
    if (key === "escape") { this.clearSelection(); return true; }
    return false;
  }

  private beginDesktopPan(event: InkPointerSample): boolean {
    if (event.pointerType !== "mouse" || this.flipSettling || this.activePointerId !== null || this.nativeMenuOpen()) return false;
    const button = event.button ?? 0;
    if (button !== 1 && !(button === 0 && (this.desktopSpaceDown || this.readingMode))) return false;
    this.desktopPan = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.inputScroller().classList.add("ink-panning");
    this.capturePointer(event.pointerId);
    event.preventDefault?.();
    return true;
  }

  private endDesktopPan(): void {
    const pan = this.desktopPan;
    this.desktopPan = null;
    this.inputScroller()?.classList.remove("ink-panning");
    if (pan) this.releasePointer(pan.pointerId);
  }

  protected onWheel(event: WheelEvent): void {
    if (this.nativeMenuOpen() || this.activePointerId !== null || this.desktopPan || this.flipSettling) return;
    const scroller = this.inputScroller();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
    const x = event.deltaX * unit, y = event.deltaY * unit;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      this.desktopZoom(Math.exp(-Math.max(-100, Math.min(100, y)) * 0.004), { x: event.clientX, y: event.clientY });
      this.showZoomHud(); this.scheduleZoomHudHide();
      return;
    }
    if (event.shiftKey && !x && y) {
      event.preventDefault();
      scroller.scrollLeft += y;
      return;
    }
    if (event.deltaMode !== 0 || Math.abs(x) < Math.abs(y) * 1.5 || !x) return;
    // One page per wheel burst: residual trackpad inertia cannot flip again.
    if (this.desktopWheelTimer !== undefined) window.clearTimeout(this.desktopWheelTimer);
    this.desktopWheelTimer = window.setTimeout(() => {
      this.desktopWheelTimer = undefined; this.desktopWheelTravel = 0; this.desktopWheelFlipped = false;
    }, 180);
    event.preventDefault();
    const before = scroller.scrollLeft;
    scroller.scrollLeft += x;
    // Compare actual movement: stable/overlay scrollbar gutters can make
    // scrollWidth - clientWidth disagree with the browser's clamped limit.
    if (Math.abs(scroller.scrollLeft - before) > 0.5) { this.desktopWheelTravel = 0; return; }
    if (this.desktopWheelFlipped) return;
    if (Math.sign(this.desktopWheelTravel) !== Math.sign(x)) this.desktopWheelTravel = 0;
    this.desktopWheelTravel += x;
    if (Math.abs(this.desktopWheelTravel) >= 100) {
      this.desktopWheelFlipped = true;
      this.desktopNavigate(x > 0 ? "next" : "previous");
    }
  }

  protected onPointerDown(event: InkPointerSample, source: InteractionContext["source"] = "pointer"): void {
    this.devPointerEvents += 1;
    this.devLastPointerType = event.pointerType || this.devLastPointerType;
    if (this.beginDesktopPan(event)) return;
    if (event.pointerType === "mouse" && ((event.button ?? 0) !== 0 || this.desktopPan)) return;
    if (this.inputLocked()) return;
    if (this.nativeMenuOpen()) return;
    if (event.pointerType === "touch") return;
    // Deduplicate only the contact currently owned by native stylus Touch.
    // The next contact may have Pointer events without a classified Touch,
    // so observing one Touch stream must not disable pen input for the view.
    if (source === "pointer" && event.pointerType === "pen" && this.interaction?.source === "stylus-touch") return;
    this.onInputStarting();
    this.interactionGeneration += 1;
    if (this.activePointerId !== null) this.finishPointerInput(false);
    // Direct-manipulation pens normally have implicit capture. Explicit
    // capture is only a best-effort fallback because WebKit can transiently
    // reject a reused Pencil pointer id while the previous capture unwinds.
    if (source === "pointer") this.capturePointer(event.pointerId);
    const page = this.currentPage();
    const tool = this.state.tool;
    const brush = isBrushTool(tool) ? this.brushSettings(tool) : null;
    const rect = this.inputRect();
    this.tiles?.beginInput?.();
    this.cancelPendingInkCommitTimer();
    if (tool === "pen" || tool === "highlighter") this.tiles?.pauseInkCommit();
    else if (this.pendingInkStrokes.length > 0 || this.committingInkStrokes) this.materializePendingInkPreview(page);
    if (this.saveTimer !== undefined) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    this.activePointerId = event.pointerId;
    this.lastPointerActivityAt = Date.now();
    this.interaction = {
      generation: ++this.interactionGeneration,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      source,
      pageId: page.id,
      tool,
      eraserMode: tool === "eraser" ? this.state.eraserMode : undefined,
      eraserSize: tool === "eraser" ? this.state.eraserSize : undefined,
    };
    const point = this.toPoint(event, rect);
    this.erasedStrokeIds.clear();
    this.erasedCandidateIds.clear();
    this.erasedStrokes = [];
    this.eraserReplacementIds.clear();
    this.eraserReplacements = [];
    this.eraserPreviewCells.clear();
    if (tool === "eraser") {
      this.updateEraserHover(point, true);
      if (this.eraseAt(point, page)) this.requestRender();
      return;
    }
    if (tool === "lasso") {
      if (this.isPointInSelection(point)) {
        const strokes = this.selectedStrokes();
        const before = new Map(strokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
        this.lassoDrag = {
          start: point,
          pageId: page.id,
          strokes,
          before,
          bounds: boundsForPointSets([...before.values()]),
          dx: 0,
          dy: 0,
        };
        this.beginLassoPreview(page);
      } else {
        this.selectedStrokeIds.clear();
        this.lassoPath = [point];
        this.drawStrokes(page.strokes);
      }
      return;
    }
    this.activeStroke = {
      id: newId("stroke"),
      pageId: page.id,
      tool,
      color: brush!.color,
      width: brush!.width,
      opacity: brush!.opacity,
      points: [point],
      dynamics: tool === "pen" ? {
        taper: this.state.pen.taper ?? 0,
        pressure: this.state.pen.pressureGain ?? 100,
        speed: this.state.pen.speedGain ?? 0,
        pressureCurve: this.state.pen.pressureCurve ? this.state.pen.pressureCurve.map((point) => [...point]) : undefined,
      } : undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.workerStrokePointIndex = 1;
    if (tool === "pen") {
      const decision = this.penModelerDecision();
      if (decision.engaged) this.startPenModeler(event, point, this.penModelerParams());
      this.beginStrokeRecord(decision);
    }
    this.queueWorkerOperation({
      type: "start-stroke",
      pageId: page.id,
      stroke: { ...this.activeStroke, points: [{ ...point }] },
      previewWidth: this.canvasLogicalWidth,
      previewHeight: this.canvasLogicalHeight,
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.currentNotebook().updatedAt,
    });
    this.lastPoint = point;
    page.strokes.push(this.activeStroke);
    this.resizePreview();
    this.drawPreview();
  }

  protected onPointerEnter(event: InkPointerSample): void {
    if (event.pointerType === "touch") return;
    const rect = this.inputRect();
    this.updateEraserHover(this.toPoint(event, rect), pointInsideRect(event, rect));
  }

  protected onPointerMove(event: InkPointerSample, source: InteractionContext["source"] = "pointer"): void {
    this.devPointerEvents += 1;
    if (event.pointerType === "touch") return;
    if (this.desktopPan?.pointerId === event.pointerId) {
      const scroller = this.inputScroller();
      scroller.scrollLeft -= event.clientX - this.desktopPan.x;
      scroller.scrollTop -= event.clientY - this.desktopPan.y;
      this.desktopPan.x = event.clientX;
      this.desktopPan.y = event.clientY;
      event.preventDefault?.();
      return;
    }
    if (this.interaction && (this.interaction.source ?? "pointer") !== source) return;
    const rect = this.inputRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    if (this.activePointerId === null) {
      // Hover samples are device-rate history too; skip them while raw
      // updates own the pointer, or the coalesced replay double-counts.
      if (this.rawUpdateCapture?.pointerId !== event.pointerId) this.recordPenSampleIntervals(this.pointerSamples(event));
      this.updateEraserHover(point, inside);
      return;
    }
    if (this.activePointerId !== event.pointerId) return;
    if (this.interaction?.tool === "eraser") this.updateEraserHover(point, inside);
    // While pointerrawupdate owns this pointer, its samples already reached the
    // stroke; replaying the frame-aligned batch would duplicate them.
    if (this.rawUpdateCapture?.pointerId === event.pointerId) return;
    this.applyPointerSamples(event, rect, "move");
  }

  /** Consumes Chromium raw hardware samples so ink forms at full pen rate
   *  instead of waiting for the next frame-aligned pointermove batch. */
  protected onPointerRawUpdate(event: InkPointerSample): void {
    this.devPointerEvents += 1;
    this.devRawUpdates += 1;
    this.devLastPointerType = event.pointerType || this.devLastPointerType;
    if (this.activePointerId === null || event.pointerId !== this.activePointerId) return;
    const interaction = this.interaction;
    if (!interaction || (interaction.source ?? "pointer") !== "pointer") return;
    if (interaction.tool !== "pen" && interaction.tool !== "highlighter") return;
    // Timestamps drive the pointermove dedup; without one the coalesced replay
    // could feed the modeler an out-of-order sample and force raw capture.
    if (typeof event.timeStamp !== "number" || !Number.isFinite(event.timeStamp)) {
      this.rawUpdateCapture = null;
      return;
    }
    if (this.rawUpdateCapture && this.rawUpdateCapture.pointerId !== event.pointerId) return;
    if (!this.rawUpdateCapture) this.rawUpdateCapture = { pointerId: event.pointerId, lastTime: event.timeStamp - 1 };
    this.applyPointerSamples(event, this.inputRect(), "move");
  }

  protected onPointerUp(event: InkPointerSample, source: InteractionContext["source"] = "pointer"): void {
    this.devPointerEvents += 1;
    if (this.desktopPan?.pointerId === event.pointerId) {
      this.endDesktopPan();
      return;
    }
    if (this.activePointerId !== event.pointerId || (this.interaction?.source ?? "pointer") !== source) return;
    const rect = this.inputRect();
    const point = this.toPoint(event, rect);
    const inside = pointInsideRect(event, rect);
    this.pendingLiftPagePx = { x: point.x * this.pagePixelSize().width, y: point.y * this.pagePixelSize().height };
    this.applyPointerSamples(event, rect, "up");
    try {
      if (source === "pointer") this.releasePointer(event.pointerId);
    } finally {
      this.finishPointerInput(true);
    }
    this.updateEraserHover(point, inside);
  }

  protected onPointerCancel(event: InkPointerSample, source: InteractionContext["source"] = "pointer"): void {
    this.devPointerEvents += 1;
    if (this.desktopPan?.pointerId === event.pointerId) {
      this.endDesktopPan();
      return;
    }
    if (this.activePointerId !== event.pointerId || (this.interaction?.source ?? "pointer") !== source) return;
    this.eraserPointerInside = false;
    this.finishPointerInput(false);
  }

  private applyPointerSamples(event: InkPointerSample, rect: DOMRect, phase: "move" | "up" = "move"): void {
    const interaction = this.interaction;
    if (!interaction || interaction.pointerId !== event.pointerId) return;
    const page = this.pageById(interaction.pageId);
    if (!page) return;
    const samples = this.pointerSamples(event);
    if (interaction.tool === "lasso") {
      this.pendingLassoPoint = this.toPoint(samples[samples.length - 1], rect);
      this.requestRender();
      return;
    }
    let feed = samples;
    const raw = this.rawUpdateCapture;
    if (raw && raw.pointerId === event.pointerId && (interaction.tool === "pen" || interaction.tool === "highlighter")) {
      // Raw updates already consumed the leading samples of every coalesced
      // batch; replaying them would send the modeler backwards in time and
      // degrade the whole stroke to raw capture.
      let newest = raw.lastTime;
      feed = [];
      for (const sample of samples) {
        const time = sample.timeStamp;
        if (typeof time === "number" && time <= raw.lastTime) continue;
        feed.push(sample);
        if (typeof time === "number" && time > newest) newest = time;
      }
      raw.lastTime = newest;
      if (feed.length === 0) return;
    }
    this.recordPenSampleIntervals(feed);
    this.devSamplesFed += feed.length;
    const record = this.currentStrokeRecord;
    if (record) {
      record.rawSamples += feed.length;
      if (this.diagnosticsCaptureRawPoints() && record.rawPointSamples) {
        for (const sample of feed) {
          if (record.rawPointSamples.length >= MAX_RAW_POINT_SAMPLES) { record.rawTruncated = true; break; }
          const samplePoint = this.toPoint(sample, rect);
          record.rawPointSamples.push([samplePoint.x, samplePoint.y, samplePoint.pressure, samplePoint.t]);
        }
      }
    }
    let changed = false;
    if (interaction.tool === "pen" && this.penModeler && !this.penModeler.fallback) {
      changed = this.appendModeledPenPoints(feed, rect, phase);
    } else {
      for (let index = 0; index < feed.length; index++) {
        const sample = feed[index];
        const point = this.toPoint(sample, rect);
        if (interaction.tool === "eraser") {
          changed = this.eraseAt(point, page, interaction.eraserMode, interaction.eraserSize) || changed;
        } else if (this.activeStroke && this.lastPoint) {
          clampLiftPressure(point, phase === "up" && index === feed.length - 1 ? this.lastPoint : null);
          // Raw capture: every sample is stored exactly as delivered. Repeated
          // positions from duplicate input events still must not enter the stroke.
          if (distance(point, this.lastPoint) <= 0) continue;
          this.activeStroke.points.push(point);
          this.lastPoint = point;
          changed = true;
        }
      }
    }
    this.updatePredictedTip(event, rect, phase);
    this.lastPointerActivityAt = Date.now();
    if (changed) {
      if (this.activeStroke) this.activeStroke.updatedAt = Date.now();
      this.requestRender();
    }
  }

  /**
   * Keeps the newest predicted-events batch (WebKit / partial Chromium) for
   * the live ghost tip. Predicted points are speculative: they render only on
   * the preview layer, never enter stroke.points, and are dropped at lift so
   * the real tail takes over.
   */
  private updatePredictedTip(event: InkPointerSample, rect: DOMRect, phase: "move" | "up"): void {
    if (phase === "up") { this.predictedTip = null; return; }
    const predicted = typeof event.getPredictedEvents === "function" ? event.getPredictedEvents() : [];
    this.devPredictedSamples += predicted.length;
    const record = this.currentStrokeRecord;
    if (record) record.predictedSamples = (record.predictedSamples ?? 0) + predicted.length;
    if (predicted.length === 0) { this.predictedTip = null; return; }
    this.predictedTip = predicted.map((sample) => this.toPoint(sample, rect));
  }

  /** Draws the predicted tip as a tapering ghost extension of the live ink:
   *  continuous with the stroke at the junction, fading toward the predicted
   *  position. Anchored at the live stroke tail — anchoring anywhere else
   *  sweeps faint segments from the stroke's start to the pen on every frame.
   *  Preview-layer only. */
  protected drawPredictedTip(ctx: CanvasRenderingContext2D, stroke: InkStroke): void {
    if (!this.predictedTip || this.predictedTip.length === 0) return;
    const tail = stroke.points[stroke.points.length - 1];
    if (!tail) return;
    const gain = clampPercent(stroke.dynamics?.pressure, 100) / 100;
    const mapped = samplePressureCurve(tail.pressure, normalizePressureCurve(stroke.dynamics?.pressureCurve));
    const baseHalf = Math.max(0.6, (stroke.width * (0.55 + 0.75 * (0.5 + (mapped - 0.5) * gain))) / 2);
    let previous = { x: tail.x * this.canvasLogicalWidth, y: tail.y * this.canvasLogicalHeight };
    const segments = this.predictedTip.length;
    for (let index = 0; index < segments; index++) {
      const point = { x: this.predictedTip[index].x * this.canvasLogicalWidth, y: this.predictedTip[index].y * this.canvasLogicalHeight };
      const progress = (index + 1) / segments;
      // Deep at the junction (continuous ink) fading to faint at the tip.
      ctx.globalAlpha = stroke.opacity * (0.6 - 0.45 * progress);
      ctx.lineWidth = Math.max(0.5, baseHalf * 2 * (1 - 0.45 * progress));
      ctx.strokeStyle = stroke.color;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
      previous = point;
    }
    ctx.globalAlpha = 1;
  }

  /** Feeds raw pointer samples through the stroke modeler and stores its results. */
  private appendModeledPenPoints(samples: InkPointerSample[], rect: DOMRect, phase: "move" | "up"): boolean {
    const capture = this.penModeler!;
    const stroke = this.activeStroke;
    if (!stroke) return false;
    let changed = false;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const point = this.toPoint(sample, rect);
      if (capture.fallback) {
        if (this.appendRawPenPoint(stroke, point)) changed = true;
        continue;
      }
      const isLift = phase === "up" && index === samples.length - 1;
      // Lift events (and some coalesced samples) report pressure 0. Inherit
      // the most recent raw pressure, not the modeled tip's projected
      // pressure: the modeled tip lags the pen and would drag a stale value
      // into the tail. iPadOS additionally re-reports a fresh, often higher
      // pressure on the lift sample at the frozen tail position; a rising
      // reading while the pen is leaving the surface is that artifact, and
      // clamping to the previous sample keeps the tail from fattening into
      // a dot.
      const reportedPressure = sample.pressure > 0 ? sample.pressure : capture.lastRawPressure;
      const rawPressure = isLift && reportedPressure > (capture.lastRawPressure ?? reportedPressure)
        ? capture.lastRawPressure ?? reportedPressure
        : reportedPressure;
      capture.lastRawPressure = rawPressure;
      const input: StrokeModelInput = {
        eventType: isLift ? "up" : "move",
        position: { x: point.x * capture.pageWidth, y: point.y * capture.pageHeight },
        time: penSampleTimeMillis(sample) / 1000,
        pressure: rawPressure,
        tiltX: sample.tiltX,
        tiltY: sample.tiltY,
      };
      this.updatePenModeler(input, isLift);
      if (capture.fallback) {
        // The broken sample contributed nothing modeled; keep its raw position.
        this.appendRawPenPoint(stroke, point);
        changed = true;
        continue;
      }
      changed = true;
    }
    return changed;
  }

  /** Runs one modeler input and appends its results, guarding stroke bloat. */
  private updatePenModeler(input: StrokeModelInput, _isLift: boolean): boolean {
    const capture = this.penModeler!;
    const stroke = this.activeStroke!;
    let results: StrokeModelResult[];
    try {
      results = capture.modeler.update(input);
    } catch {
      // A corrupted stream (clock jump, oversized gap) must never lose ink;
      // the rest of the stroke falls back to raw capture.
      capture.fallback = true;
      return false;
    }
    capture.lastInput = _isLift ? null : input;
    let changed = false;
    for (const result of results) {
      // One radius for every modeled result, the final lift point included:
      // exempting the landing is what used to append the catch-up cluster's
      // degenerate tail. The stroke then ends within 0.35 page px of the
      // lift, which is far below one nib width.
      if (Math.hypot(result.position.x - capture.lastStored.x, result.position.y - capture.lastStored.y) < PEN_CAPTURE_MIN_DISTANCE) continue;
      capture.lastStored = { x: result.position.x, y: result.position.y };
      const point: InkPoint = {
        x: result.position.x / capture.pageWidth,
        y: result.position.y / capture.pageHeight,
        pressure: result.pressure ?? 0.5,
        tiltX: result.tiltX,
        tiltY: result.tiltY,
        t: result.time * 1000,
      };
      stroke.points.push(point);
      this.lastPoint = point;
      changed = true;
    }
    return changed;
  }

  private appendRawPenPoint(stroke: InkStroke, point: InkPoint): boolean {
    if (!this.lastPoint || distance(point, this.lastPoint) <= 0) return false;
    stroke.points.push(point);
    this.lastPoint = point;
    return true;
  }

  /** Completes a stroke whose pointer vanished without an up event. */
  private flushPenModeler(): void {
    const capture = this.penModeler;
    if (!capture || capture.fallback || !capture.lastInput) return;
    // Synthesize the missing up event from the last input so the modeled tail
    // still converges onto the pen's final position.
    this.updatePenModeler({ ...capture.lastInput, eventType: "up" }, true);
  }

  /** Ink stays direct (raw samples, probe-style) unless the user picked a
   *  smooth strength or the device itself samples too sparsely. */
  protected shouldModelPenStroke(): boolean {
    return this.penModelerDecision().engaged;
  }

  protected penModelerDecision(): { engaged: boolean; reason: ModelerEngageReason } {
    const smooth = this.state.pen.smooth ?? 0;
    if (smooth > 0) return { engaged: true, reason: "smooth" };
    if (this.penInputSparse()) return { engaged: true, reason: "sparse" };
    return { engaged: false, reason: "direct" };
  }

  private beginStrokeRecord(decision: { engaged: boolean; reason: ModelerEngageReason }): void {
    if (this.currentStrokeRecord) this.finalizeStrokeRecord();
    this.currentStrokeRecord = {
      index: ++this.strokeRecordCounter,
      startedAt: Date.now(),
      durationMs: null,
      tool: "pen",
      smooth: this.state.pen.smooth ?? 0,
      engaged: decision.engaged,
      reason: decision.reason,
      fallback: false,
      rawSamples: 0,
      pointsStored: 0,
      intervals: intervalStats(this.penSampleIntervals),
      liftDistancePx: null,
      // Delivered samples are retained only while the panel can show or
      // export them; normal writing keeps no second copy of the input.
      ...(this.diagnosticsCaptureRawPoints() ? { rawPointSamples: [] as number[][] } : {}),
    };
  }

  protected finalizeStrokeRecord(): void {
    const record = this.currentStrokeRecord;
    this.currentStrokeRecord = null;
    if (!record) return;
    record.durationMs = Date.now() - record.startedAt;
    record.pointsStored = this.activeStroke?.points.length ?? record.pointsStored;
    record.fallback = this.penModeler?.fallback ?? false;
    record.intervals = intervalStats(this.penSampleIntervals);
    const lift = this.pendingLiftPagePx;
    this.pendingLiftPagePx = null;
    const lastPoint = this.activeStroke && this.activeStroke.points.length > 0
      ? this.activeStroke.points[this.activeStroke.points.length - 1]
      : null;
    if (lift && lastPoint) {
      record.liftDistancePx = Math.hypot(
        lastPoint.x * this.pagePixelSize().width - lift.x,
        lastPoint.y * this.pagePixelSize().height - lift.y,
      );
    }
    pushStrokeRecord(this.strokeRecords, record);
  }

  /** Sparse devices get the proven default tuning; an explicit strength maps
   *  through the slider curve. */
  private penModelerParams(): StrokeModelParams {
    const smooth = this.state.pen.smooth ?? 0;
    return smooth > 0 ? strokeModelParamsForSmoothStrength(smooth) : DEFAULT_STROKE_MODEL_PARAMS;
  }

  protected penInputSparse(): boolean {
    if (this.penSampleIntervals.length < PEN_SPARSE_MIN_INTERVALS) return false;
    const sorted = [...this.penSampleIntervals].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] > SPARSE_SAMPLE_INTERVAL_MS;
  }

  /** Feeds the device-rate history from one batch of consumed samples. */
  private recordPenSampleIntervals(samples: InkPointerSample[]): void {
    for (const sample of samples) {
      const time = sample.timeStamp;
      if (typeof time !== "number" || !Number.isFinite(time)) continue;
      if (this.lastPenSampleTime !== null) {
        const interval = time - this.lastPenSampleTime;
        // Above ~120 ms is a human pause (between strokes or hover bursts),
        // not device rate; counting it would flag every normal writing
        // session as sparse and silently re-engage the modeler.
        if (interval > 0 && interval < 120) {
          this.penSampleIntervals.push(interval);
          if (this.penSampleIntervals.length > PEN_SAMPLE_INTERVAL_WINDOW) this.penSampleIntervals.shift();
        }
      }
      this.lastPenSampleTime = time;
    }
  }

  private startPenModeler(event: InkPointerSample, point: InkPoint, params: StrokeModelParams): void {
    const pageWidth = this.pagePixelSize().width;
    const pageHeight = this.pagePixelSize().height;
    const modeler = new StrokeModeler(params);
    const input: StrokeModelInput = {
      eventType: "down",
      position: { x: point.x * pageWidth, y: point.y * pageHeight },
      time: penSampleTimeMillis(event) / 1000,
      pressure: point.pressure,
      tiltX: event.tiltX,
      tiltY: event.tiltY,
    };
    try {
      modeler.update(input);
    } catch {
      // Without capture state the stroke is captured raw instead.
      return;
    }
    // Keep the whole stroke on one time base: the stored down point carries
    // the event time the modeler consumed.
    point.t = input.time * 1000;
    this.penModeler = {
      modeler,
      pageWidth,
      pageHeight,
      lastInput: input,
      lastRawPressure: point.pressure,
      lastStored: { ...input.position },
      fallback: false,
    };
  }

  private pointerSamples(event: InkPointerSample): InkPointerSample[] {
    const coalesced = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    this.devCoalescedSamples += coalesced.length;
    this.devLastPointerType = event.pointerType || this.devLastPointerType;
    return coalesced.length > 0 ? [...coalesced, event] : [event];
  }

  protected toPoint(event: InkPointerSample, rect: DOMRect): InkPoint {
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
      // Lift events (and some coalesced samples) report pressure 0. Inherit
      // the previous sample's pressure instead of a 0.5 default: a pressure
      // jump at the tail makes the outline end in a thin line with a
      // full-width round cap dot.
      pressure: event.pressure > 0 ? event.pressure : (this.lastPoint?.pressure ?? 0.5),
      tiltX: event.tiltX,
      tiltY: event.tiltY,
      t: Date.now(),
    };
  }

  protected onLostPointerCapture(event: PointerEvent): void {
    if (this.desktopPan?.pointerId === event.pointerId) { this.endDesktopPan(); return; }
    if (this.activePointerId !== event.pointerId) return;
    // Capture loss is not contact loss. In particular, WebKit may deliver the
    // previous stroke's event after a reused Pencil pointer has already begun.
    // pointerup/pointercancel own finalization; the next pointerdown also
    // finalizes any genuinely abandoned interaction before starting its own.
  }

  protected onDocumentPointerEnd(event: PointerEvent): void {
    if (this.desktopPan?.pointerId === event.pointerId) { this.endDesktopPan(); return; }
    // The input host handles ordinary endings first. This catches an
    // uncaptured Pencil released elsewhere in the document after capture was
    // unavailable.
    if (this.interaction?.source !== "stylus-touch" && this.activePointerId === event.pointerId) this.finishPointerInput(false);
  }

  protected capturePointer(pointerId: number): void {
    const host = this.inputHost();
    if (!host || host.hasPointerCapture(pointerId)) return;
    try {
      host.setPointerCapture(pointerId);
    } catch (error) {
      if (!isPointerCaptureError(error)) throw error;
    }
  }

  protected releasePointer(pointerId: number): void {
    const host = this.inputHost();
    if (!host) return;
    try {
      if (host.hasPointerCapture(pointerId)) host.releasePointerCapture(pointerId);
    } catch (error) {
      if (!isPointerCaptureError(error)) throw error;
    }
  }

  protected onStylusTouch(event: TouchEvent): boolean {
    const host = this.inputHost();
    if (!host) return false;
    const touch = Array.from(event.changedTouches ?? []).find((candidate) =>
      candidate.touchType === "stylus" && host.contains(candidate.target as Node));
    if (!touch) return false;
    if (event.cancelable) event.preventDefault();
    this.touchGesture = null;
    const sample = stylusTouchSample(touch, event.timeStamp);
    const interaction = this.interaction;
    if (event.type === "touchstart") {
      // Scribble can suppress Pointer events. Native stylus Touch owns this
      // contact, including a Pointer stream that has already started it.
      if (interaction?.source === "pointer" && interaction.pointerType === "pen") {
        const pointerId = interaction.pointerId;
        interaction.source = "stylus-touch";
        interaction.pointerId = touch.identifier;
        this.activePointerId = touch.identifier;
        this.releasePointer(pointerId);
      } else {
        this.onPointerDown(sample, "stylus-touch");
      }
    } else if (interaction?.source === "stylus-touch" && interaction.pointerId === touch.identifier) {
      if (event.type === "touchmove") this.onPointerMove(sample, "stylus-touch");
      else if (event.type === "touchend") {
        this.onPointerUp(sample, "stylus-touch");
        return false;
      }
      else if (event.type === "touchcancel") this.onPointerCancel(sample, "stylus-touch");
    }
    return true;
  }

  /** The element pointer capture is taken on (the writing surface). */
  protected abstract inputHost(): HTMLElement | undefined;

  // ---------------------------------------------------------------- touch

  protected onTouchStart(event: TouchEvent): void {
    if (this.touchGesture?.ids.length === 2) this.scheduleZoomHudHide();
    // A native menu owns the surface until dismissed: let its outside-tap
    // dismissal see this event instead of swallowing it (the menu otherwise
    // stayed open until one of its own items was picked).
    if (this.nativeMenuOpen()) { this.touchGesture = null; return; }
    // Handwriting owns the whole surface: stop the touch from reaching the
    // app chrome entirely, so Obsidian's sidebar edge-swipe can never fire
    // mid-write, whatever the entry point. Navigation gestures (pan,
    // pinch-zoom, page flip) deliberately stay available while editing is
    // locked (reading mode, PDF writer arbitration) - only ink input is
    // gated, and that happens in onPointerDown.
    event.stopPropagation?.();
    if (this.onStylusTouch(event)) return;
    // Cancel native tap recognition before the guards, including Pencil
    // contact and final touchend events with no remaining contacts.
    if (event.cancelable && event.touches.length < 2) event.preventDefault();
    // Lifting the dragging finger decides the flip once: by travel distance
    // or by fling velocity; anything less springs back with the animation.
    if (this.touchGesture?.axis === "x" && event.touches.length > 1) {
      this.cancelPageFlip();
      this.touchGesture = null;
      return;
    }
    this.settlePageFlip(event);
    this.touchGesture = null;
    this.healStaleInteraction(Array.from(event.touches));
    const touches = Array.from(event.touches).filter((touch) => touch.touchType !== "stylus"
      && !this.zoomHud?.contains(touch.target as Node));
    if (touches.length < 1 || touches.length > 2) return;
    if (this.flipSettling && touches.length === 2) return;
    if (this.activePointerId !== null) return;
    const [a, b] = touches;
    if (!a) return;
    const x = b ? (a.clientX + b.clientX) / 2 : a.clientX;
    const y = b ? (a.clientY + b.clientY) / 2 : a.clientY;
    const rect = this.inputRect();
    this.touchGesture = {
      ids: b ? [a.identifier, b.identifier] : [a.identifier],
      distance: b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0,
      currentDistance: b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0,
      zoom: this.zoom, x, y, startX: x, startY: y,
      axis: null,
      lastX: x, lastT: typeof event.timeStamp === "number" ? event.timeStamp : 0,
      velocity: 0, dragX: 0,
      pageX: (x - rect.left) / rect.width,
      pageY: (y - rect.top) / rect.height,
    };
    if (b) this.showZoomHud();
  }

  /**
   * Finalizes interactions whose pointer the platform lost. iPadOS split-view
   * transitions can swallow the final pointerup/touchend of an in-flight
   * stroke; the interaction then stays "active" forever, which blocks every
   * two-finger gesture (and, for stylus-touch sources, the document-level
   * pointerup fallback deliberately does not fire). Two heal signals: a
   * stylus-touch interaction whose identifier is no longer on screen, and a
   * pointer interaction with no input for >2.5 s (an active stroke emits
   * samples at frame rate, so silence means the pointer is gone).
   */
  private healStaleInteraction(touches: Touch[]): void {
    const interaction = this.interaction;
    if (!interaction || this.activePointerId === null) return;
    if (interaction.source === "stylus-touch") {
      const alive = touches.some((touch) => touch.identifier === interaction.pointerId);
      if (!alive) this.finishPointerInput(false);
      return;
    }
    if (Date.now() - this.lastPointerActivityAt > 2500) this.finishPointerInput(false);
  }

  protected onTouchMove(event: TouchEvent): void {
    if (this.nativeMenuOpen()) { this.touchGesture = null; return; }
    event.stopPropagation?.();
    if (this.onStylusTouch(event)) return;
    if (this.activePointerId !== null) {
      this.touchGesture = null;
      return;
    }
    const gesture = this.touchGesture;
    if (!gesture) return;
    const touches = Array.from(event.touches).filter((touch) => touch.touchType !== "stylus"
      && !this.zoomHud?.contains(touch.target as Node));
    const a = touches.find((touch) => touch.identifier === gesture.ids[0]);
    const b = touches.find((touch) => touch.identifier === gesture.ids[1]);
    if (touches.length !== gesture.ids.length || !a || (gesture.ids.length === 2 && !b)) {
      this.onTouchStart(event);
      return;
    }
    event.preventDefault();
    if (!b) {
      const scroller = this.inputScroller();
      const totalX = a.clientX - gesture.startX;
      const totalY = a.clientY - gesture.startY;
      if (gesture.axis === null && Math.max(Math.abs(totalX), Math.abs(totalY)) > 10) {
        // A horizontal drag flips pages when the document cannot scroll
        // sideways at all, or when it is zoomed but already scrolled to the
        // edge the drag is heading for (gallery behaviour while zoomed).
        const scrollableX = scroller.scrollWidth > scroller.clientWidth + 4;
        let flipAllowed = !scrollableX;
        if (scrollableX) {
          const atLeft = scroller.scrollLeft <= 2;
          const atRight = scroller.scrollLeft >= scroller.scrollWidth - scroller.clientWidth - 2;
          flipAllowed = (totalX > 0 && atLeft) || (totalX < 0 && atRight);
        }
        gesture.axis = Math.abs(totalX) > Math.abs(totalY) * 1.5 && flipAllowed ? "x" : "y";
      }
      if (gesture.axis === "x") {
        // Gallery drag: the page follows the finger one-to-one (the view
        // slides the neighbouring page in alongside); the flip itself is
        // decided once, on release, by distance or fling velocity.
        const now = typeof event.timeStamp === "number" ? event.timeStamp : gesture.lastT + 16;
        const dt = Math.max(1, now - gesture.lastT);
        gesture.velocity = 0.8 * gesture.velocity + 0.2 * ((a.clientX - gesture.lastX) / dt);
        gesture.lastX = a.clientX;
        gesture.lastT = now;
        gesture.dragX = totalX;
        // A new horizontal gesture takes priority over the previous animation.
        // The storage/render barrier still runs before changing the live page.
        if (this.flipSettling) this.finishPageSwipeAnimations();
        this.swipeDrag(totalX);
        return;
      }
      if (this.flipSettling) {
        gesture.x = a.clientX;
        gesture.y = a.clientY;
        return;
      }
      scroller.scrollLeft += gesture.x - a.clientX;
      scroller.scrollTop += gesture.y - a.clientY;
      gesture.x = a.clientX;
      gesture.y = a.clientY;
      return;
    }
    if (this.flipSettling) return;
    if (gesture.distance < 1) {
      this.onTouchStart(event);
      return;
    }
    const distanceNow = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const x = (a.clientX + b.clientX) / 2, y = (a.clientY + b.clientY) / 2;
    if (this.zoomLocked) {
      const scroller = this.inputScroller();
      scroller.scrollLeft += gesture.x - x;
      scroller.scrollTop += gesture.y - y;
    } else {
      this.applyGestureZoom(gesture.zoom * distanceNow / gesture.distance,
        { x, y }, { x: gesture.pageX, y: gesture.pageY });
    }
    gesture.x = x;
    gesture.y = y;
    gesture.currentDistance = distanceNow;
    this.showZoomHud();
  }

  // --------------------------------------------------------------- eraser

  protected eraseAt(point: InkPoint, page: InkPage, mode: EraserMode = this.state.eraserMode, size = this.state.eraserSize): boolean {
    const radius = mode === "stroke" ? STROKE_ERASER_HIT_RADIUS : size / 2;
    const indexed = this.tiles?.queryNear ? this.tiles.queryNear(point, radius) : page.strokes;
    const candidates = [...new Map([...indexed, ...this.eraserReplacements].map((stroke) => [stroke.id, stroke])).values()]
      .filter((stroke) => !this.erasedCandidateIds.has(stroke.id));
    const removed = candidates.filter((stroke) => strokeIntersectsEraser(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight));
    if (removed.length === 0) return false;
    for (const stroke of removed) {
      this.erasedCandidateIds.add(stroke.id);
      if (!this.eraserReplacementIds.has(stroke.id) && !this.erasedStrokeIds.has(stroke.id)) {
        this.erasedStrokeIds.add(stroke.id);
        this.erasedStrokes.push(cloneStroke(stroke));
      }
      if (this.eraserReplacementIds.delete(stroke.id)) this.eraserReplacements = this.eraserReplacements.filter((candidate) => candidate.id !== stroke.id);
    }
    this.deleteStrokes(page, removed.map((stroke) => stroke.id));
    const replacements: InkStroke[] = [];
    if (mode !== "stroke") {
      const now = Date.now();
      for (const stroke of removed) {
        const segments = eraseStrokeSegments(stroke, point, radius, mode, this.canvasLogicalWidth, this.canvasLogicalHeight);
        for (const points of segments) {
          const replacement = { ...cloneStroke(stroke), id: newId("stroke"), points, createdAt: now, updatedAt: now };
          page.strokes.push(replacement);
          replacements.push(replacement);
          this.eraserReplacementIds.add(replacement.id);
          this.eraserReplacements.push(cloneStroke(replacement));
        }
      }
      page.strokes.sort((left, right) => left.createdAt - right.createdAt);
    }
    if (page === this.currentPage()) {
      for (const cell of this.tiles?.patchStrokes(replacements, removed.map((stroke) => stroke.id), page.strokes) ?? []) {
        this.eraserPreviewCells.add(cell);
      }
    }
    return true;
  }

  protected deleteStrokes(page: InkPage, ids: string[]): void {
    const deleted = new Set(ids);
    page.strokes = page.strokes.filter((stroke) => !deleted.has(stroke.id));
    page.deletedStrokeIds = [...new Set([...page.deletedStrokeIds, ...ids])];
  }

  protected markChanged(page: InkPage): void {
    const now = Date.now();
    page.updatedAt = now;
    this.currentNotebook().updatedAt = now;
    this.onModelMutated();
  }

  protected updateEraserHover(point: InkPoint, inside: boolean): void {
    this.eraserHoverPoint = point;
    this.eraserPointerInside = inside;
    this.refreshEraserCursor();
  }

  protected refreshEraserCursor(): void {
    if (!this.eraserCursor) return;
    const mode = this.interaction?.tool === "eraser" ? this.interaction.eraserMode ?? this.state.eraserMode : this.state.eraserMode;
    const eraserSize = this.interaction?.tool === "eraser" ? this.interaction.eraserSize ?? this.state.eraserSize : this.state.eraserSize;
    this.eraserCursor.toggleClass("is-visible", this.state.tool === "eraser" && !this.inputLocked() && this.eraserPointerInside && this.eraserHoverPoint !== null);
    this.eraserCursor.toggleClass("is-square", mode === "square");
    this.eraserCursor.toggleClass("is-stroke", mode === "stroke");
    const size = mode === "stroke" ? STROKE_ERASER_HIT_RADIUS * 2 : eraserSize;
    this.eraserCursor.style.width = `${size * this.zoom}px`;
    this.eraserCursor.style.height = `${size * this.zoom}px`;
    if (!this.eraserHoverPoint) return;
    this.eraserCursor.style.left = `${this.eraserHoverPoint.x * this.canvasLogicalWidth * this.zoom}px`;
    this.eraserCursor.style.top = `${this.eraserHoverPoint.y * this.canvasLogicalHeight * this.zoom}px`;
  }

  // ---------------------------------------------------------------- lasso

  protected applyLassoPoint(point: InkPoint): boolean {
    if (this.lassoDrag) {
      const bounds = this.lassoDrag.bounds;
      const dx = constrainDelta(point.x - this.lassoDrag.start.x, bounds?.minX ?? 0, bounds?.maxX ?? 1);
      const dy = constrainDelta(point.y - this.lassoDrag.start.y, bounds?.minY ?? 0, bounds?.maxY ?? 1);
      if (dx === this.lassoDrag.dx && dy === this.lassoDrag.dy) return false;
      this.lassoDrag.dx = dx;
      this.lassoDrag.dy = dy;
      this.onLassoDragMoved(dx, dy);
      return true;
    }
    const previous = this.lassoPath[this.lassoPath.length - 1];
    if (!previous || distance(point, previous) < 0.001) return false;
    this.lassoPath.push(point);
    return true;
  }

  protected flushPendingLassoPoint(): void {
    const point = this.pendingLassoPoint;
    this.pendingLassoPoint = null;
    if (point) this.applyLassoPoint(point);
  }

  protected selectedStrokes(): InkStroke[] {
    return this.currentPage().strokes.filter((stroke) => this.selectedStrokeIds.has(stroke.id));
  }

  protected isPointInSelection(point: InkPoint): boolean {
    const bounds = selectionBounds(this.selectedStrokes());
    const padding = 0.008;
    return bounds !== null && point.x >= bounds.minX - padding && point.x <= bounds.maxX + padding
      && point.y >= bounds.minY - padding && point.y <= bounds.maxY + padding;
  }

  protected clearSelection(): void {
    this.selectedStrokeIds.clear();
    this.lassoPath = [];
    this.lassoDrag = null;
    this.hideLassoPreview();
  }

  private finishLasso(page: InkPage): void {
    if (this.lassoDrag) {
      const drag = this.lassoDrag;
      const before = drag.before;
      const movedStrokes = drag.strokes;
      const moved = drag.dx !== 0 || drag.dy !== 0;
      if (moved) for (const stroke of movedStrokes) {
        const points = before.get(stroke.id);
        if (points) stroke.points = translatePoints(points, drag.dx, drag.dy);
      }
      const after = new Map(movedStrokes.map((stroke) => [stroke.id, clonePoints(stroke.points)]));
      if (moved) {
        const now = Date.now();
        for (const stroke of movedStrokes) stroke.updatedAt = now;
        const pageId = drag.pageId;
        this.pushCommand({
          undo: () => this.applyStrokePoints(pageId, before),
          redo: () => this.applyStrokePoints(pageId, after),
        });
        this.markChanged(page);
        this.queueWorkerOperation({
          type: "translate-strokes",
          pageId: page.id,
          strokeIds: movedStrokes.map((stroke) => stroke.id),
          dx: drag.dx,
          dy: drag.dy,
          pageUpdatedAt: page.updatedAt,
          notebookUpdatedAt: this.currentNotebook().updatedAt,
        });
        this.scheduleSave();
      }
      this.lassoDrag = null;
      this.commitLassoPreview(page);
      return;
    }
    if (this.lassoPath.length >= 3) {
      this.selectedStrokeIds = new Set(page.strokes.filter((stroke) => stroke.points.some((point) => pointInPolygon(point, this.lassoPath))).map((stroke) => stroke.id));
    }
    this.lassoPath = [];
    this.drawStrokes(page.strokes);
  }

  private applyStrokePoints(pageId: string, pointsById: Map<string, InkPoint[]>): void {
    const page = this.pageById(pageId);
    if (!page) return;
    for (const stroke of page.strokes) {
      const points = pointsById.get(stroke.id);
      if (points) {
        stroke.points = clonePoints(points);
        stroke.updatedAt = Date.now();
      }
    }
    this.markChanged(page);
    this.queueStrokePatch(page, page.strokes.filter((stroke) => pointsById.has(stroke.id)), []);
  }

  // ------------------------------------------------------- ink commit flow

  protected commitPreview(page: InkPage = this.currentPage()): void {
    if (!this.activeStroke || this.activeStroke.tool !== "pen" && this.activeStroke.tool !== "highlighter") return;
    if (this.pendingInkPageId && this.pendingInkPageId !== page.id) this.discardPendingInkPreview();
    this.pendingInkPageId = page.id;
    if (!this.pendingInkStrokes.includes(this.activeStroke)) this.pendingInkStrokes.push(this.activeStroke);
  }

  protected hasInkPreview(): boolean { return this.activeStroke !== null || this.pendingInkStrokes.length > 0; }

  protected tileExclusion(): ReadonlySet<string> | undefined {
    const committing = new Set(this.committingInkStrokes?.map(stroke => stroke.id) ?? []);
    const excluded = new Set<string>();
    if (this.activeStroke) excluded.add(this.activeStroke.id);
    for (const stroke of this.pendingInkStrokes) if (!committing.has(stroke.id)) excluded.add(stroke.id);
    return excluded.size > 0 ? excluded : undefined;
  }

  protected startPendingInkCommit(page: InkPage): void {
    if (this.activePointerId !== null || this.committingInkStrokes || this.pendingInkStrokes.length === 0
      || this.pendingInkPageId !== page.id || page !== this.currentPage() || !this.tiles) return;
    const batch = [...this.pendingInkStrokes];
    this.committingInkStrokes = batch;
    this.tiles.patchStrokes(batch, [], page.strokes);
    this.tiles.commitInk(batch, this.viewport, (window.devicePixelRatio || 1) * this.zoom, (committed) => {
      if (this.committingInkStrokes !== batch) return;
      this.committingInkStrokes = null;
      if (!committed) {
        // A new pointerdown intentionally cancels unfinished tile work. Keep
        // the completed strokes on the sharp overlay and retry them with the
        // next idle batch instead of synchronously replaying the whole page.
        this.tiles?.removeStrokes(batch.map((stroke) => stroke.id));
        if (this.viewReady && page === this.currentPage()) this.drawPreview();
        if (this.activePointerId === null) this.schedulePendingInkCommit(page);
        return;
      }
      const ids = new Set(batch.map(stroke => stroke.id));
      this.pendingInkStrokes = this.pendingInkStrokes.filter(stroke => !ids.has(stroke.id));
      if (this.pendingInkStrokes.length === 0) this.pendingInkPageId = null;
      const outlines = this.confirmedStrokeOutlines ?? (this.confirmedStrokeOutlines = new Map());
      for (const stroke of batch) outlines.delete(stroke.id);
      if (this.viewReady && page === this.currentPage()) {
        this.redrawConfirmedPreview();
        this.drawPreview();
      }
      if (this.pendingInkStrokes.length > 0) this.schedulePendingInkCommit(page);
      else if (this.activePointerId === null) {
        this.applyPendingMergedNotebook();
        this.afterInputFullySettled();
      }
    });
  }

  protected schedulePendingInkCommit(page: InkPage): void {
    if (this.pendingInkStrokes.length === 0 || this.pendingInkPageId !== page.id) return;
    this.cancelPendingInkCommitTimer();
    this.inkCommitTimer = window.setTimeout(() => {
      this.inkCommitTimer = undefined;
      this.startPendingInkCommit(page);
    }, INK_COMMIT_IDLE_DELAY);
  }

  protected cancelPendingInkCommitTimer(): void {
    if (this.inkCommitTimer === undefined) return;
    window.clearTimeout(this.inkCommitTimer);
    this.inkCommitTimer = undefined;
  }

  protected discardPendingInkPreview(): void {
    this.cancelPendingInkCommitTimer();
    this.committingInkStrokes = null;
    this.pendingInkStrokes = [];
    this.pendingInkPageId = null;
    this.confirmedStrokeOutlines.clear();
    this.tiles?.cancelInkCommit();
    if (this.confirmedPreviewCanvas) {
      this.confirmedPreviewCanvas.width = this.confirmedPreviewCanvas.height = 1;
      this.confirmedPreviewCanvas.classList.remove("is-highlighter-preview");
    }
    if (this.previewCanvas) {
      this.previewCanvas.width = this.previewCanvas.height = 1;
      this.previewCanvas.classList.remove("is-highlighter-preview");
    }
  }

  protected materializePendingInkPreview(page: InkPage): void {
    if (this.pendingInkPageId !== page.id) {
      this.discardPendingInkPreview();
      return;
    }
    const pending = [...new Map([
      ...this.pendingInkStrokes,
      ...(this.committingInkStrokes ?? []),
    ].map((stroke) => [stroke.id, stroke])).values()];
    this.discardPendingInkPreview();
    if (pending.length === 0) return;
    const cells = this.tiles?.patchStrokes(pending, [], page.strokes) ?? [];
    // A tool switch must not make recently completed ink disappear or become
    // impossible for the eraser to hit while its background commit is pending.
    this.tiles?.previewInteractiveCells(cells, this.viewport, (window.devicePixelRatio || 1) * this.zoom);
  }

  /** Live preview layer for the active stroke; view-owned canvases. */
  protected resizePreview(): void {
    if (this.previewCanvas && this.previewCtx) this.resizeOverlay(this.previewCanvas, this.previewCtx, OVERLAY_PIXEL_BUDGET);
    if (this.confirmedPreviewCanvas && this.confirmedPreviewCtx) {
      if (this.resizeOverlay(this.confirmedPreviewCanvas, this.confirmedPreviewCtx, OVERLAY_PIXEL_BUDGET)) {
        this.redrawConfirmedPreview();
      }
    }
  }

  protected drawPreview(): void {
    const ctx = this.previewCtx;
    if (!ctx) return;
    const outlines = this.confirmedStrokeOutlines ?? (this.confirmedStrokeOutlines = new Map());
    const strokes = this.activeStroke && (this.activeStroke.tool === "pen" || this.activeStroke.tool === "highlighter")
      ? [this.activeStroke]
      : [];
    ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    if (strokes.length === 0) {
      this.previewCanvas?.classList.remove("is-highlighter-preview");
      return;
    }
    this.previewCanvas?.classList.toggle("is-highlighter-preview", strokes.every(stroke => stroke.tool === "highlighter"));
    for (const stroke of strokes) {
      const confirmed = outlines.get(stroke.id);
      if (confirmed) {
        this.drawConfirmedOutline(ctx, confirmed.points, stroke.color, stroke.opacity, stroke.width, confirmed.mode);
      }
      drawImmediateStrokeTail(ctx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight, confirmed?.sampleCount ?? 0);
      if (stroke.tool === "pen") this.drawPredictedTip(ctx, stroke);
    }
  }

  protected redrawConfirmedPreview(): void {
    if (!this.confirmedPreviewCtx || !this.confirmedPreviewCanvas) return;
    const strokes = [...this.pendingInkStrokes];
    this.confirmedPreviewCtx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.confirmedPreviewCanvas.classList.toggle("is-highlighter-preview",
      strokes.length > 0 && strokes.every((stroke) => stroke.tool === "highlighter"));
    for (const stroke of strokes) this.drawCompletedPreviewStroke(this.confirmedPreviewCtx, stroke);
  }

  protected retainActivePreview(): void {
    if (!this.activeStroke || !this.confirmedPreviewCanvas || !this.confirmedPreviewCtx) return;
    this.drawCompletedPreviewStroke(this.confirmedPreviewCtx, this.activeStroke);
    this.confirmedPreviewCanvas.classList.toggle("is-highlighter-preview",
      this.pendingInkStrokes.length > 0 && this.pendingInkStrokes.every((stroke) => stroke.tool === "highlighter"));
  }

  protected drawCompletedPreviewStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke): void {
    const outlines = this.confirmedStrokeOutlines ?? (this.confirmedStrokeOutlines = new Map());
    const confirmed = outlines.get(stroke.id);
    const firstBoundedTailSample = Math.max(0, stroke.points.length - LIVE_TAIL_SAMPLE_LIMIT);
    if (!confirmed || confirmed.sampleCount <= firstBoundedTailSample) {
      // Worker-less and delayed-Worker strokes need a complete synchronous
      // representation. Bound the temporary geometry so pointerup stays fast.
      drawInkStroke(ctx, boundedPreviewStroke(stroke), this.canvasLogicalWidth, this.canvasLogicalHeight);
      return;
    }
    // Unbounded: the outline already exists, so rendering every vertex costs
    // one fill and matches the committed tiles exactly.
    this.drawConfirmedOutline(ctx, confirmed.points, stroke.color, stroke.opacity, stroke.width, confirmed.mode);
    drawImmediateStrokeTail(ctx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight, confirmed.sampleCount);
  }

  protected drawConfirmedOutline(ctx: CanvasRenderingContext2D, points: Float32Array, color: string, opacity: number, width: number,
    mode: "pen" | "highlighter"): void {
    if (points.length < 4) return;
    ctx.save();
    ctx.globalAlpha = opacity;
    const scaleX = this.canvasLogicalWidth;
    const scaleY = this.canvasLogicalHeight;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (mode === "highlighter") {
      ctx.globalCompositeOperation = "multiply";
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(points[0] * scaleX, points[1] * scaleY);
      for (let index = 2; index < points.length; index += 2) {
        const previousX = points[index - 2] * scaleX;
        const previousY = points[index - 1] * scaleY;
        const pointX = points[index] * scaleX;
        const pointY = points[index + 1] * scaleY;
        const last = index === points.length - 2;
        ctx.quadraticCurveTo(previousX, previousY,
          last ? pointX : (previousX + pointX) / 2,
          last ? pointY : (previousY + pointY) / 2);
      }
      ctx.lineTo(points[points.length - 2] * scaleX, points[points.length - 1] * scaleY);
      ctx.stroke();
    } else {
      ctx.globalCompositeOperation = "source-over";
      // The outline is the final ink shape; render it as plain polygons so
      // live ink, retained previews and committed tiles all keep sparse
      // fast-written corners exactly where the pen turned. NaN separators
      // split retraced runs, which fill separately so a retraced band keeps
      // its ink instead of cancelling its neighbour's winding to holes.
      ctx.beginPath();
      let tracing = false;
      for (let index = 0; index < points.length; index += 2) {
        const x = points[index] * scaleX;
        const y = points[index + 1] * scaleY;
        if (!Number.isFinite(x) || !Number.isFinite(y)) { tracing = false; continue; }
        if (!tracing) { tracing = true; ctx.moveTo(x, y); continue; }
        ctx.lineTo(x, y);
      }
      if (tracing) ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /** Per-frame content render (interaction previews, selection). */
  protected renderInteractionFrame(): void {
    if (this.lassoDrag) this.drawLassoInteraction();
    else if (this.interaction?.tool === "eraser") this.drawEraserInteraction();
    else if (this.hasInkPreview()) this.drawPreview();
    else this.drawStrokes(this.currentPage().strokes);
  }

  protected drawStrokes(strokes: InkStroke[]): void {
    if (!this.ctx) return;
    this.tiles?.sync(strokes, this.tileExclusion());
    this.tiles?.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.drawPreview();
  }

  protected drawInteractiveStrokes(strokes: InkStroke[], refine = false): void {
    if (!this.ctx) return;
    this.tiles?.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, refine);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
  }

  protected drawEraserInteraction(): void {
    if (!this.ctx) return;
    const cells = [...this.eraserPreviewCells];
    this.eraserPreviewCells.clear();
    this.tiles?.previewInteractiveCells(cells, this.viewport, (window.devicePixelRatio || 1) * this.zoom);
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
  }

  protected drawSelection(width: number, height: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.strokeStyle = "#2f80ed";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 4]);
    if (this.lassoPath.length > 1) {
      ctx.beginPath();
      ctx.moveTo(this.lassoPath[0].x * width, this.lassoPath[0].y * height);
      for (const point of this.lassoPath.slice(1)) ctx.lineTo(point.x * width, point.y * height);
      ctx.closePath();
      ctx.stroke();
    }
    const bounds = selectionBounds(this.selectedStrokes());
    if (bounds) ctx.strokeRect(bounds.minX * width, bounds.minY * height, (bounds.maxX - bounds.minX) * width, (bounds.maxY - bounds.minY) * height);
    ctx.restore();
  }

  private beginLassoPreview(page: InkPage): void {
    const drag = this.lassoDrag;
    if (!drag || !this.lassoCanvas || !this.lassoCtx) return;
    const selected = new Set(drag.strokes.map((stroke) => stroke.id));
    this.tiles?.patchStrokes([], [...selected], page.strokes);
    this.tiles?.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, false);
    const resolution = canvasResolution(this.canvasLogicalWidth, this.canvasLogicalHeight,
      window.devicePixelRatio || 1, this.zoom, 4_000_000);
    this.lassoCanvas.width = resolution.width;
    this.lassoCanvas.height = resolution.height;
    this.lassoCanvas.style.left = "0";
    this.lassoCanvas.style.top = "0";
    this.lassoCanvas.style.width = `${this.canvasLogicalWidth * this.zoom}px`;
    this.lassoCanvas.style.height = `${this.canvasLogicalHeight * this.zoom}px`;
    this.lassoCtx.setTransform(resolution.width / this.canvasLogicalWidth, 0, 0,
      resolution.height / this.canvasLogicalHeight, 0, 0);
    this.lassoCtx.clearRect(0, 0, this.canvasLogicalWidth, this.canvasLogicalHeight);
    for (const stroke of drag.strokes) drawInkStroke(this.lassoCtx, stroke, this.canvasLogicalWidth, this.canvasLogicalHeight);
    this.lassoCanvas.style.transform = "translate(0px, 0px)";
    this.lassoCanvas.style.display = "block";
  }

  protected onLassoDragMoved(dx: number, dy: number): void {
    if (!this.lassoCanvas) return;
    this.lassoCanvas.style.transform = `translate(${dx * this.canvasLogicalWidth * this.zoom}px, ${dy * this.canvasLogicalHeight * this.zoom}px)`;
  }

  private drawLassoInteraction(): void {
    const drag = this.lassoDrag;
    if (!drag || !this.ctx) return;
    this.ctx.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
    const bounds = drag.bounds;
    if (!bounds) return;
    this.ctx.save();
    this.ctx.strokeStyle = "#2f80ed";
    this.ctx.lineWidth = 1.5;
    this.ctx.setLineDash([6, 4]);
    this.ctx.strokeRect(
      (bounds.minX + drag.dx) * this.canvasLogicalWidth,
      (bounds.minY + drag.dy) * this.canvasLogicalHeight,
      (bounds.maxX - bounds.minX) * this.canvasLogicalWidth,
      (bounds.maxY - bounds.minY) * this.canvasLogicalHeight,
    );
    this.ctx.restore();
  }

  private commitLassoPreview(page: InkPage): void {
    this.tiles?.patchStrokes(this.selectedStrokes(), [], page.strokes);
    // Keep the transformed vector preview visible until the replacement tiles
    // are complete, then swap the affected frame atomically.
    this.tiles?.commitInteractive(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true, () => {
      this.hideLassoPreview();
      if (this.viewReady && page === this.currentPage()) {
        this.ctx?.clearRect(this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height);
        this.drawSelection(this.canvasLogicalWidth, this.canvasLogicalHeight);
        this.drawPreview();
      }
    });
  }

  private hideLassoPreview(): void {
    if (!this.lassoCanvas) return;
    this.lassoCanvas.style.display = "none";
    this.lassoCanvas.style.transform = "none";
    this.lassoCanvas.width = this.lassoCanvas.height = 1;
  }

  protected flushWorkerStrokePoints(): void {
    const stroke = this.activeStroke;
    const interaction = this.interaction;
    if (!stroke || !interaction || (interaction.tool !== "pen" && interaction.tool !== "highlighter")) return;
    if (this.workerStrokePointIndex >= stroke.points.length) return;
    const points = packStrokePoints(stroke.points, this.workerStrokePointIndex);
    this.workerStrokePointIndex = stroke.points.length;
    this.queueWorkerOperation({
      type: "append-stroke-points", pageId: stroke.pageId, strokeId: stroke.id, points,
      previewWidth: this.canvasLogicalWidth, previewHeight: this.canvasLogicalHeight,
      pageUpdatedAt: stroke.updatedAt, notebookUpdatedAt: this.currentNotebook().updatedAt,
    }, [points.buffer], (response) => {
      if (response.type !== "operation-applied" || !response.outline || response.strokeId !== stroke.id
        || (this.activeStroke?.id !== stroke.id && !this.pendingInkStrokes.some((candidate) => candidate.id === stroke.id))) return;
      const outlines = this.confirmedStrokeOutlines ?? (this.confirmedStrokeOutlines = new Map());
      const previous = outlines.get(stroke.id);
      const sampleCount = response.sampleCount ?? stroke.points.length;
      if (previous && previous.sampleCount >= sampleCount) return;
      outlines.set(stroke.id, {
        points: response.outline,
        sampleCount,
        mode: response.outlineMode ?? "pen",
      });
      this.requestRender();
    });
  }

  // -------------------------------------------------------- input finalize

  protected requestRender(resize = false): void {
    this.resizeRequested ||= resize;
    if (this.renderFrame !== null) return;
    this.renderFrame = window.requestAnimationFrame(() => {
      this.renderFrame = null;
      this.flushPendingLassoPoint();
      this.flushWorkerStrokePoints();
      const shouldResize = this.resizeRequested;
      this.resizeRequested = false;
      if (shouldResize) this.onRenderResize();
      else this.renderInteractionFrame();
    });
  }

  protected finishPointerInput(_includeFinalSample = false): void {
    this.flushPenModeler();
    this.finalizeStrokeRecord();
    const interaction = this.interaction;
    if (!interaction) return;
    const page = this.pageById(interaction.pageId);
    if (!page) {
      this.interaction = null;
      this.refreshEraserCursor();
      this.activePointerId = null;
      this.penModeler = null;
      this.rawUpdateCapture = null;
      this.predictedTip = null;
      this.tiles?.resumeInkCommit();
      return;
    }
    this.flushPendingLassoPoint();
    this.flushWorkerStrokePoints();
    this.commitPreview(page);
    this.interaction = null;
    this.refreshEraserCursor();
    if (this.activeStroke && this.renderFrame !== null && !this.resizeRequested) {
      window.cancelAnimationFrame(this.renderFrame);
      this.renderFrame = null;
    }
    if (interaction.tool === "lasso") {
      this.finishLasso(page);
      this.activePointerId = null;
      this.tiles?.resumeInkCommit();
      this.applyPendingMergedNotebook();
      return;
    }
    if (interaction.tool === "eraser" && this.erasedStrokes.length > 0) {
      this.markChanged(page);
      const replacementIds = new Set(this.eraserReplacements.map((stroke) => stroke.id));
      this.queueWorkerOperation({
        type: "patch-strokes",
        pageId: page.id,
        upsert: page.strokes.filter((stroke) => replacementIds.has(stroke.id)).map(cloneStroke),
        remove: [...new Set([...this.erasedStrokes.map((stroke) => stroke.id), ...replacementIds])],
        deletedStrokeIds: [...page.deletedStrokeIds],
        pageUpdatedAt: page.updatedAt,
        notebookUpdatedAt: this.currentNotebook().updatedAt,
      });
      this.pushCommand(this.erasedStrokesCommand(page.id, this.erasedStrokes, this.eraserReplacements));
      this.drawInteractiveStrokes(page.strokes, true);
    } else if (this.activeStroke) {
      this.markChanged(page);
      // Retain a complete vector preview without copying the full high-density
      // overlay. Late Worker responses update only the live stroke layer.
      this.retainActivePreview();
      this.queueWorkerOperation({ type: "complete-stroke", pageId: page.id, strokeId: this.activeStroke.id,
        pageUpdatedAt: page.updatedAt, notebookUpdatedAt: this.currentNotebook().updatedAt });
      this.pushCommand(this.addedStrokeCommand(page.id, this.activeStroke));
    }
    this.activePointerId = null;
    this.activeStroke = null;
    this.workerStrokePointIndex = 0;
    this.lastPoint = null;
    this.penModeler = null;
    this.rawUpdateCapture = null;
    this.predictedTip = null;
    this.pendingLassoPoint = null;
    this.eraserPreviewCells.clear();
    if (interaction.tool === "pen" || interaction.tool === "highlighter") {
      this.resizePreview();
      this.drawPreview();
      this.schedulePendingInkCommit(page);
    }
    this.tiles?.resumeInkCommit();
    this.applyPendingMergedNotebook();
    this.scheduleSave();
    this.afterInputFullySettled();
  }

  // -------------------------------------------------------- history stack

  protected undo(): void {
    if (this.readingMode) return;
    const command = this.undoStack.pop();
    if (!command) return;
    command.undo();
    this.redoStack.push(command);
    this.afterCommand(command);
  }

  protected redo(): void {
    if (this.readingMode) return;
    const command = this.redoStack.pop();
    if (!command) return;
    command.redo();
    this.undoStack.push(command);
    this.afterCommand(command);
  }

  protected pushCommand(command: EditCommand): void {
    this.undoStack.push(command);
    if (this.undoStack.length > UNDO_STACK_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  protected afterCommand(command: EditCommand): void {
    this.discardPendingInkPreview();
    this.clearSelection();
    this.updateHistoryButtons();
    if (command.rebuild) this.renderAll();
    else this.drawInteractiveStrokes(this.currentPage().strokes, true);
    this.scheduleSave();
  }

  protected updateHistoryButtons(): void {
    const undo = this.toolbarRoot().querySelector<HTMLButtonElement>("[aria-label='Undo']");
    const redo = this.toolbarRoot().querySelector<HTMLButtonElement>("[aria-label='Redo']");
    if (undo) undo.disabled = this.readingMode || this.undoStack.length === 0;
    if (redo) redo.disabled = this.readingMode || this.redoStack.length === 0;
  }

  protected abstract renderAll(): void;

  private addedStrokeCommand(pageId: string, original: InkStroke): EditCommand {
    let currentId = original.id;
    // Keep the immutable finalized stroke by reference. Cloning every point at
    // pointerup makes the next Pencil down wait behind an O(stroke length)
    // copy; redo can clone later, outside the input hot path.
    let template = original;
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        template = page.strokes.find((stroke) => stroke.id === currentId) ?? template;
        this.deleteStrokes(page, [currentId]);
        this.markChanged(page);
        this.queueStrokePatch(page, [], [currentId]);
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        const restored = restoredStroke(template);
        currentId = restored.id;
        page.strokes.push(restored);
        this.markChanged(page);
        this.queueStrokePatch(page, [restored], []);
      },
    };
  }

  private erasedStrokesCommand(pageId: string, originals: InkStroke[], replacements: InkStroke[]): EditCommand {
    let currentOriginals = originals.map(cloneStroke);
    let currentReplacements = replacements.map(cloneStroke);
    return {
      undo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, currentReplacements.map((stroke) => stroke.id));
        currentOriginals = originals.map(restoredStroke);
        page.strokes.push(...currentOriginals.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        this.markChanged(page);
        this.queueStrokePatch(page, currentOriginals, currentReplacements.map((stroke) => stroke.id));
      },
      redo: () => {
        const page = this.pageById(pageId);
        if (!page) return;
        this.deleteStrokes(page, currentOriginals.map((stroke) => stroke.id));
        currentReplacements = replacements.map(restoredStroke);
        page.strokes.push(...currentReplacements.map(cloneStroke));
        page.strokes.sort((left, right) => left.createdAt - right.createdAt);
        this.markChanged(page);
        this.queueStrokePatch(page, currentReplacements, currentOriginals.map((stroke) => stroke.id));
      },
    };
  }

  protected queueStrokePatch(page: InkPage, upsert: readonly InkStroke[], remove: readonly string[]): void {
    if (page === this.currentPage()) this.tiles?.patchStrokes(upsert, remove, page.strokes);
    this.queueWorkerOperation({
      type: "patch-strokes",
      pageId: page.id,
      upsert: upsert.map(cloneStroke),
      remove: [...remove],
      deletedStrokeIds: [...page.deletedStrokeIds],
      pageUpdatedAt: page.updatedAt,
      notebookUpdatedAt: this.currentNotebook().updatedAt,
    });
  }

  protected pageById(id: string): InkPage | undefined {
    return this.currentNotebook().pages.find((page) => page.id === id);
  }

  // -------------------------------------------------------- save scheduling

  /**
   * Idle-plus-deadline scheduling: save shortly after the last change, but at
   * the latest after SAVE_MAX_DELAY. An active stroke defers the deadline —
   * the save then runs on the next scheduleSave() after pointerup — because
   * writing mid-stroke would persist incomplete geometry and compete with the
   * input hot path.
   */
  protected scheduleSave(): void {
    if (this.maxSaveDue && this.activePointerId === null) {
      this.maxSaveDue = false;
      this.performScheduledSave();
      return;
    }
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      this.performScheduledSave();
    }, SAVE_IDLE_DELAY);
    if (this.maxSaveTimer === undefined) {
      this.maxSaveTimer = window.setTimeout(() => {
        this.maxSaveTimer = undefined;
        if (this.activePointerId !== null) {
          this.maxSaveDue = true;
          return;
        }
        this.performScheduledSave();
      }, SAVE_MAX_DELAY);
    }
  }

  protected clearSaveTimers(): void {
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    if (this.maxSaveTimer !== undefined) window.clearTimeout(this.maxSaveTimer);
    this.saveTimer = undefined;
    this.maxSaveTimer = undefined;
  }

  protected abstract performScheduledSave(): void;

  // -------------------------------------------------------- worker session

  protected queueWorkerOperation(operation: NotebookOperation, transfer?: Transferable[], onApplied?: (response: InkWorkerResponse) => void): void {
    const session = this.workerSession;
    if (!session) return;
    const revision = ++this.workerRevision;
    void session.apply(revision, operation, transfer).then((response) => {
      if (this.workerSession === session) onApplied?.(response);
    }).catch((error) => {
      if (this.workerSession === session) this.disableWorkerSession(error);
    });
  }

  protected disableWorkerSession(error: unknown): void {
    this.tiles?.setBackend?.(null);
    if (this.viewReady && this.tiles && this.currentNotebook().pages.length > 0) {
      this.tiles.sync(this.currentPage().strokes, this.tileExclusion());
      this.tiles.update(this.viewport, (window.devicePixelRatio || 1) * this.zoom, true);
    }
    this.workerSession?.dispose();
    this.workerSession = null;
    if (this.workerFallbackReported || this.workers?.isDisabled()) return;
    this.workerFallbackReported = true;
    new Notice(`Ink Notes background processing is unavailable; using reduced-performance mode: ${error instanceof Error ? error.message : String(error)}`);
  }

  // --------------------------------------------------------------- brushes

  protected brushSettings(tool: BrushTool): BrushSettings {
    return this.state[tool];
  }

  /**
   * The eraser needs exactly two controls - mode and size - so it gets its
   * own mini popover anchored to its tool button instead of the full brush
   * panel. It grows out of the eraser button and closes back into it;
   * outside taps (tool buttons run their own toggle), Escape and a second
   * tap close it.
   */
  protected toggleEraserPopover(anchor: HTMLElement | null): void {
    if (this.eraserPopover) { this.closeEraserPopover(); return; }
    const host = (this.contentEl ?? this.containerEl) as HTMLElement | undefined;
    if (!host?.createDiv) return;
    // Mount inside the view root: the popover is styled with --ink-* tokens,
    // which only resolve inside the themed view. Hung on the container it
    // rendered with a fully transparent background and unthemed borders.
    const pop = host.createDiv({ cls: "ink-eraser-popover", attr: { role: "dialog", "aria-label": "Eraser settings" } });
    // Menu priority over workspace gestures, exactly like the brush panel:
    // without the shield, a slider drag reached the app chrome and dragged
    // the sidebars out.
    for (const type of ["touchstart", "touchmove", "pointerdown"] as const) {
      pop.addEventListener(type, (event) => event.stopPropagation());
    }
    pop.createDiv({ cls: "ink-size-popover-title", text: "Eraser" });
    const modes = pop.createDiv({ cls: "ink-eraser-modes", attr: { role: "radiogroup", "aria-label": "Eraser mode" } });
    for (const [mode, label, shortLabel, iconName] of [["stroke", "Stroke eraser", "Stroke", "eraser"], ["circle", "Circle eraser", "Circle", "circle"], ["square", "Square eraser", "Square", "square"]] as const) {
      const modeButton = modes.createEl("button", { cls: "ink-eraser-mode", attr: { type: "button", role: "radio", title: label, "aria-label": label, "aria-checked": String(this.state.eraserMode === mode), "data-eraser-mode": mode } });
      setIcon(modeButton.createSpan({ cls: "ink-button-icon" }), iconName);
      modeButton.createSpan({ cls: "ink-eraser-mode-label", text: shortLabel });
      modeButton.addEventListener("click", () => {
        this.state.eraserMode = mode;
        modes.querySelectorAll<HTMLElement>(".ink-eraser-mode").forEach((candidate) => {
          candidate.setAttribute("aria-checked", String(candidate.dataset.eraserMode === mode));
        });
        syncSizeVisibility();
        this.refreshEraserCursor();
        this.scheduleToolStateSave();
      });
    }
    const sizeRow = pop.createDiv({ cls: "ink-eraser-size-row" });
    sizeRow.createDiv({ cls: "ink-settings-label", text: "Size" });
    const range = sizeRow.createEl("input", { attr: { type: "range", "aria-label": "Eraser size" } });
    range.min = "8";
    range.max = "160";
    range.step = "2";
    range.value = String(this.state.eraserSize);
    range.addEventListener("input", () => {
      this.state.eraserSize = Number(range.value);
      this.refreshEraserCursor();
      this.scheduleToolStateSave();
    });
    // The stroke eraser ignores the size (fixed hit radius) - offer the
    // slider only for the shapes that use it.
    const syncSizeVisibility = (): void => {
      sizeRow.style.display = this.state.eraserMode === "stroke" ? "none" : "";
    };
    syncSizeVisibility();
    this.eraserPopover = pop;
    const place = (): void => {
      const target = anchor ?? this.activeSettingsAnchor();
      if (target) placePopover(pop, target, 8);
    };
    // Hidden until placed: a fixed-position element without coordinates
    // would flash at its static position for a frame.
    pop.style.visibility = "hidden";
    window.requestAnimationFrame(() => {
      if (this.eraserPopover !== pop) return;
      place();
      pop.style.visibility = "";
      pop.addClass("is-open");
    });
    const onOutside = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && pop.contains(target)) return;
      // Tool buttons toggle their own popover on click. Closing on the
      // pointerdown made the following click event reopen it, which read as
      // a popover that flashes and can never be re-tapped closed.
      if (target && (target as HTMLElement).closest?.(".ink-tool-button")) return;
      this.closeEraserPopover();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") this.closeEraserPopover();
    };
    const onRelayout = (event?: Event): void => {
      if (this.eraserPopover !== pop) return;
      // Ignore the popover's own scrolling - same jitter rule as the brush
      // panel; repositioning during it nudged the popover sideways.
      if (event?.target && pop.contains(event.target as Node)) return;
      place();
    };
    document.addEventListener("pointerdown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onRelayout);
    window.addEventListener("scroll", onRelayout, true);
    this.eraserPopoverClose = () => {
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onRelayout);
      window.removeEventListener("scroll", onRelayout, true);
    };
    this.register(() => this.closeEraserPopover());
  }

  protected closeEraserPopover(): void {
    const pop = this.eraserPopover;
    if (!pop) return;
    this.eraserPopover = null;
    this.eraserPopoverClose?.();
    this.eraserPopoverClose = null;
    closeAnchoredPopover(pop, () => pop.remove());
  }

  // -------------------------------------------------------------- toolbar

  protected addToolbarSection(parent: HTMLElement, label: string): HTMLElement {
    const section = parent.createDiv({ cls: "ink-toolbar-section" });
    section.addClass(`ink-toolbar-section-${label.toLowerCase()}`);
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", label);
    return section.createDiv({ cls: "ink-toolbar-section-controls" });
  }

  protected addIconButton(parent: HTMLElement, icon: string, label: string, callback: (event: MouseEvent) => void, disabled = false): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "ink-icon-button", attr: { type: "button", title: label, "aria-label": label } });
    button.disabled = disabled;
    if (label === "Undo") button.title = "Undo (Ctrl/Command+Z)";
    if (label === "Redo") button.title = "Redo (Ctrl/Command+Shift+Z, Ctrl/Command+Y)";
    // Icon inside a .ink-button-icon span: iPadOS sizes a bare svg inside the
    // button unreliably (icons collapsed to dots), while this wrapped
    // structure renders correctly.
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    setIcon(iconHolder, icon);
    button.addEventListener("click", callback);
    return button;
  }

  protected addToolButton(parent: HTMLElement, icon: string, label: string, tool: InkTool): void {
    const hasSettings = tool === "pen" || tool === "highlighter" || tool === "eraser";
    const button = parent.createEl("button", { cls: "ink-tool-button", attr: {
      type: "button", title: label, "aria-label": label, "aria-pressed": String(this.state.tool === tool), "data-tool": tool,
      ...(hasSettings ? { "aria-haspopup": "dialog", "aria-expanded": "false" } : {}),
    } });
    const shortcut: Record<InkTool, string> = { pen: "B", highlighter: "H", eraser: "E", lasso: "V" };
    button.title = `${label} (${shortcut[tool]})`;
    const iconHolder = button.createSpan({ cls: "ink-button-icon" });
    setIcon(iconHolder, icon);
    button.addEventListener("click", () => {
      if (this.readingMode) return;
      this.finishPointerInput(false);
      if (this.state.tool === tool && hasSettings) {
        this.toggleToolSettings(button);
        return;
      }
      this.selectWritingTool(tool);
    });
  }

  private selectWritingTool(tool: InkTool): void {
    this.finishPointerInput(false);
    this.onToolSelected(tool);
    this.state.tool = tool;
    if (tool !== "lasso") this.clearSelection();
    if (tool === "eraser") this.brushPopover?.close();
    this.closeEraserPopover();
    this.brushPopover?.update();
    this.updateToolButtons();
    this.refreshEraserCursor();
    if (this.settingsOpen()) this.reopenToolSettings();
  }

  protected updateToolButtons(): void {
    this.toolbarRoot().querySelectorAll<HTMLElement>(".ink-tool-button").forEach((el) => {
      const active = el.getAttribute("data-tool") === this.state.tool;
      el.toggleClass("is-active", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }

  /** Per-tool brush presets; the ink standard applies to both editors. */
  protected brushToolConfigs(): { tool: "pen" | "highlighter"; label: string; presets: number[]; maximum: number }[] {
    return [
      { tool: "pen", label: "Pen", presets: [2, 4, 8], maximum: 24 },
      { tool: "highlighter", label: "Highlighter", presets: [8, 16, 24], maximum: 48 },
    ];
  }

  protected updateEraserControls(): void {
    this.refreshEraserCursor();
    if (this.eraserPopover) {
      this.eraserPopover.querySelectorAll<HTMLElement>(".ink-eraser-mode").forEach((button) => {
        button.setAttribute("aria-checked", String(button.dataset.eraserMode === this.state.eraserMode));
      });
    }
  }
}
