// Read-only diagnostics for the developer panel: pure statistics over the
// capture pipeline's own bookkeeping. Nothing here mutates ink state; the
// view feeds records in, the panel renders and exports them.

export type ModelerEngageReason = "smooth" | "sparse" | "direct";

export interface StrokeDiagnosticsRecord {
  /** 1-based counter across the view's lifetime. */
  index: number;
  startedAt: number;
  /** null while the stroke is still active. */
  durationMs: number | null;
  tool: string;
  smooth: number;
  engaged: boolean;
  reason: ModelerEngageReason;
  /** The stroke degraded to raw capture mid-stream. */
  fallback: boolean;
  /** Delivered input samples consumed for this stroke. */
  rawSamples: number;
  pointsStored: number;
  intervals: IntervalStats;
  /** Page-pixel distance from the last stored point to the lift input. */
  liftDistancePx: number | null;
  /**
   * Raw delivered samples as [x, y, pressure, t] in normalized page space.
   * Recorded only while the developer panel is open, capped per stroke.
   */
  rawPointSamples?: number[][];
  rawTruncated?: boolean;
}

export interface IntervalStats {
  count: number;
  min: number | null;
  median: number | null;
  mean: number | null;
  max: number | null;
}

export function intervalStats(intervals: readonly number[]): IntervalStats {
  if (intervals.length === 0) return { count: 0, min: null, median: null, mean: null, max: null };
  const sorted = [...intervals].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    median,
    mean: total / sorted.length,
    max: sorted[sorted.length - 1],
  };
}

export interface DiagnosticsEnvironment {
  version: string;
  lastPointerType: string | null;
  coalescedApi: boolean;
  rawUpdateApi: boolean;
  predictedApi: boolean;
  maxTouchPoints: number;
  devicePixelRatio: number;
  zoom: number;
}

export interface DiagnosticsCounters {
  pointerEvents: number;
  rawUpdates: number;
  coalescedSamples: number;
  samplesFed: number;
}

export interface DiagnosticsReport {
  format: "ink-notes-diagnostics";
  version: string;
  generatedAt: string;
  environment: DiagnosticsEnvironment;
  counters: DiagnosticsCounters;
  sampleIntervals: IntervalStats;
  sparse: { thresholdMs: number; flagged: boolean };
  mode: { tool: string; smooth: number };
  strokes: StrokeDiagnosticsRecord[];
}

export const MAX_RECORDED_STROKES = 8;
export const MAX_RAW_POINT_SAMPLES = 8192;

/** Trims the stroke record ring buffer to the kept length, in place. */
export function pushStrokeRecord(records: StrokeDiagnosticsRecord[], record: StrokeDiagnosticsRecord): void {
  records.push(record);
  if (records.length > MAX_RECORDED_STROKES) records.splice(0, records.length - MAX_RECORDED_STROKES);
}
