// TypeScript port of the causal core of Google's ink-stroke-modeler
// (https://github.com/google/ink-stroke-modeler, Apache License 2.0,
// Copyright 2022 Google LLC): wobble smoothing, resampling, a spring-drag
// position model with stroke-end catch-up, and raw-input projection for
// stylus state.
//
// Like the original, the model is causal and incremental: every update()
// only appends results, so feeding more inputs never alters the results
// already produced. Strokes can therefore be streamed to storage while
// being captured without any later point rewrites.
//
// Deliberately omitted (unused by this plugin): input prediction, loop
// contraction mitigation (upstream default: disabled), stroke-normal
// projection (upstream default: disabled), and Save/Restore.
//
// The model is unit-agnostic. This plugin feeds positions in notebook page
// pixels and times in seconds; the tuning constants below follow the
// upstream reference values, whose distance unit matches that scale.

export interface StrokeModelPosition {
  x: number;
  y: number;
}

export type StrokeModelEventType = "down" | "move" | "up";

export interface StrokeModelInput {
  eventType: StrokeModelEventType;
  position: StrokeModelPosition;
  /** Seconds on any consistent clock; only deltas matter. */
  time: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
}

export interface StrokeModelResult {
  position: StrokeModelPosition;
  time: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
}

export interface WobbleSmootherParams {
  enabled: boolean;
  /** Length of the moving-average window, in seconds. */
  timeout: number;
  /** At this average speed (units/second) smoothing is strongest... */
  speedFloor: number;
  /** ...and at this one it is fully disabled. */
  speedCeiling: number;
}

export interface PositionModelerParams {
  /** Mass of the modeled pen-tip weight divided by the spring constant. */
  springMassConstant: number;
  /** Fraction of the tip velocity removed from its acceleration per second. */
  dragConstant: number;
}

export interface SamplingParams {
  /** Minimum modeled outputs per second; sparse inputs are upsampled to it. */
  minOutputRate: number;
  endOfStrokeStoppingDistance: number;
  endOfStrokeMaxIterations: number;
  /** Output cap per update, so a suspended client cannot stall the stroke. */
  maxOutputsPerCall: number;
}

export interface StrokeModelParams {
  wobbleSmoother: WobbleSmootherParams;
  positionModeler: PositionModelerParams;
  sampling: SamplingParams;
}

// Reference tuning from the upstream README. The wobble speed thresholds are
// intentionally left near zero in page-pixel units: smoothing must only apply
// to near-stationary input (pen-down tremor), never to moving strokes, whose
// sparse fast corners have to survive untouched.
export const DEFAULT_STROKE_MODEL_PARAMS: StrokeModelParams = {
  wobbleSmoother: { enabled: true, timeout: 0.04, speedFloor: 1.31, speedCeiling: 1.44 },
  positionModeler: { springMassConstant: 11 / 32400, dragConstant: 72 },
  sampling: {
    minOutputRate: 180,
    endOfStrokeStoppingDistance: 0.001,
    endOfStrokeMaxIterations: 20,
    maxOutputsPerCall: 100_000,
  },
};

interface TipState {
  position: StrokeModelPosition;
  velocity: StrokeModelPosition;
  acceleration: StrokeModelPosition;
  time: number;
}

function copyTip(state: TipState): TipState {
  return {
    position: { ...state.position },
    velocity: { ...state.velocity },
    acceleration: { ...state.acceleration },
    time: state.time,
  };
}

interface RawStylusSample {
  position: StrokeModelPosition;
  velocity: StrokeModelPosition;
  time: number;
  pressure?: number;
  tiltX?: number;
  tiltY?: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function interp(start: number, end: number, amount: number): number {
  return start + (end - start) * clamp01(amount);
}

function interpPosition(start: StrokeModelPosition, end: StrokeModelPosition, amount: number): StrokeModelPosition {
  return { x: interp(start.x, end.x, amount), y: interp(start.y, end.y, amount) };
}

function distance(a: StrokeModelPosition, b: StrokeModelPosition): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dotProduct(a: StrokeModelPosition, b: StrokeModelPosition): number {
  return a.x * b.x + a.y * b.y;
}

/** Upstream Normalize01: maps value into [0, 1] between start and end. */
function normalize01(start: number, end: number, value: number): number {
  if (start === end) return value > start ? 1 : 0;
  return clamp01((value - start) / (end - start));
}

/** Ratio of the closest point to `point` on segment [start, end], in [0, 1]. */
function nearestPointOnSegment(start: StrokeModelPosition, end: StrokeModelPosition, point: StrokeModelPosition): number {
  if (start.x === end.x && start.y === end.y) return 0;
  const segmentVector = { x: end.x - start.x, y: end.y - start.y };
  const projectionVector = { x: point.x - start.x, y: point.y - start.y };
  return clamp01(dotProduct(projectionVector, segmentVector) / dotProduct(segmentVector, segmentVector));
}

function springAcceleration(tip: TipState, anchor: StrokeModelPosition, params: PositionModelerParams): StrokeModelPosition {
  return {
    x: (anchor.x - tip.position.x) / params.springMassConstant - params.dragConstant * tip.velocity.x,
    y: (anchor.y - tip.position.y) / params.springMassConstant - params.dragConstant * tip.velocity.y,
  };
}

class WobbleSmoother {
  private params!: WobbleSmootherParams;
  private samples: { position: StrokeModelPosition; weightedPosition: StrokeModelPosition; distance: number; duration: number; time: number }[] = [];
  private weightedPositionSum: StrokeModelPosition = { x: 0, y: 0 };
  private distanceSum = 0;
  private durationSum = 0;

  reset(params: WobbleSmootherParams, position: StrokeModelPosition, time: number): void {
    this.params = params;
    this.samples = [{ position, weightedPosition: { x: 0, y: 0 }, distance: 0, duration: 0, time }];
    this.weightedPositionSum = { x: 0, y: 0 };
    this.distanceSum = 0;
    this.durationSum = 0;
  }

  update(position: StrokeModelPosition, time: number): StrokeModelPosition {
    if (!this.params.enabled) return position;
    // The moving average is a low-pass filter on digitizer noise; blending the
    // average back toward the raw position by speed keeps fast strokes intact.
    const back = this.samples[this.samples.length - 1];
    const deltaTime = time - back.time;
    const segmentDistance = distance(position, back.position);
    this.samples.push({
      position,
      weightedPosition: { x: position.x * deltaTime, y: position.y * deltaTime },
      distance: segmentDistance,
      duration: deltaTime,
      time,
    });
    this.weightedPositionSum.x += position.x * deltaTime;
    this.weightedPositionSum.y += position.y * deltaTime;
    this.distanceSum += segmentDistance;
    this.durationSum += deltaTime;
    while (this.samples.length > 1 && this.samples[0].time < time - this.params.timeout) {
      const front = this.samples.shift()!;
      this.weightedPositionSum.x -= front.weightedPosition.x;
      this.weightedPositionSum.y -= front.weightedPosition.y;
      this.distanceSum -= front.distance;
      this.durationSum -= front.duration;
    }
    if (this.durationSum === 0) return position;
    const averagePosition = {
      x: this.weightedPositionSum.x / this.durationSum,
      y: this.weightedPositionSum.y / this.durationSum,
    };
    const averageSpeed = this.distanceSum / this.durationSum;
    return interpPosition(averagePosition, position, normalize01(this.params.speedFloor, this.params.speedCeiling, averageSpeed));
  }
}

class PositionModeler {
  private params!: PositionModelerParams;
  private state!: TipState;

  reset(state: TipState, params: PositionModelerParams): void {
    this.state = state;
    this.params = params;
  }

  update(anchor: StrokeModelPosition, time: number): TipState {
    const state = this.state;
    const deltaTime = time - state.time;
    const acceleration = springAcceleration(state, anchor, this.params);
    state.acceleration = acceleration;
    state.velocity = {
      x: state.velocity.x + deltaTime * acceleration.x,
      y: state.velocity.y + deltaTime * acceleration.y,
    };
    state.position = {
      x: state.position.x + deltaTime * state.velocity.x,
      y: state.position.y + deltaTime * state.velocity.y,
    };
    state.time = time;
    return copyTip(state);
  }

  currentState(): TipState {
    return this.state;
  }

  /** Interpolates the anchor linearly from start to end over nSamples steps. */
  updateAlongLinearPath(startAnchor: StrokeModelPosition, startTime: number, endAnchor: StrokeModelPosition,
    endTime: number, nSamples: number, output: TipState[]): void {
    for (let index = 1; index <= nSamples; index++) {
      const amount = index / nSamples;
      output.push(this.update(interpPosition(startAnchor, endAnchor, amount), interp(startTime, endTime, amount)));
    }
  }

  /** Repeatedly updates toward the final anchor, halving the step on overshoot. */
  modelEndOfStroke(anchor: StrokeModelPosition, deltaTime: number, maxIterations: number, stopDistance: number, output: TipState[]): void {
    for (let index = 0; index < maxIterations; index++) {
      const previousState = copyTip(this.state);
      const candidate = this.update(anchor, previousState.time + deltaTime);
      if (distance(previousState.position, candidate.position) < stopDistance) return;
      if (nearestPointOnSegment(previousState.position, candidate.position, anchor) < 1) {
        deltaTime *= 0.5;
        this.state = previousState;
        continue;
      }
      output.push(candidate);
      if (distance(candidate.position, anchor) < stopDistance) return;
    }
  }
}

/**
 * Recovers the stylus state (pressure, tilt) a modeled tip position would have
 * seen, by projecting it onto the raw input polyline and interpolating.
 */
class StylusStateModeler {
  private samples: RawStylusSample[] = [];
  private segmentIndex = 0;
  private ratioAlongSegment = 0;
  private receivedUnknownPressure = false;
  private receivedUnknownTiltX = false;
  private receivedUnknownTiltY = false;

  reset(): void {
    this.samples = [];
    this.segmentIndex = 0;
    this.ratioAlongSegment = 0;
    this.receivedUnknownPressure = false;
    this.receivedUnknownTiltX = false;
    this.receivedUnknownTiltY = false;
  }

  update(position: StrokeModelPosition, time: number, pressure?: number, tiltX?: number, tiltY?: number): void {
    if (pressure === undefined || !Number.isFinite(pressure)) this.receivedUnknownPressure = true;
    if (tiltX === undefined || !Number.isFinite(tiltX)) this.receivedUnknownTiltX = true;
    if (tiltY === undefined || !Number.isFinite(tiltY)) this.receivedUnknownTiltY = true;
    const back = this.samples[this.samples.length - 1];
    let velocity = { x: 0, y: 0 };
    if (back && time !== back.time) {
      velocity = {
        x: (position.x - back.position.x) / (time - back.time),
        y: (position.y - back.position.y) / (time - back.time),
      };
    }
    // A pen resting in one spot streams samples for minutes; refreshing the
    // tail sample past this bound keeps the raw polyline (and the closest-
    // point scan over it) bounded without disturbing segment bookkeeping.
    if (this.samples.length > 4096 && back && distance(position, back.position) < 0.01) {
      this.samples[this.samples.length - 1] = { position, velocity, time, pressure, tiltX, tiltY };
      return;
    }
    this.samples.push({ position, velocity, time, pressure, tiltX, tiltY });
  }

  project(tip: TipState): { pressure?: number; tiltX?: number; tiltY?: number } {
    if (this.samples.length === 0) return {};
    this.projectToClosestPoint(tip.position);
    // The projection never backtracks, so consumed segments can be dropped.
    while (this.segmentIndex > 0) {
      this.segmentIndex--;
      this.samples.shift();
    }
    const start = this.samples[0];
    const end = this.samples[1] ?? start;
    const amount = this.samples.length > 1 ? this.ratioAlongSegment : 0;
    return {
      pressure: this.receivedUnknownPressure ? undefined : interp(start.pressure ?? 0, end.pressure ?? 0, amount),
      tiltX: this.receivedUnknownTiltX ? undefined : interp(start.tiltX ?? 0, end.tiltX ?? 0, amount),
      tiltY: this.receivedUnknownTiltY ? undefined : interp(start.tiltY ?? 0, end.tiltY ?? 0, amount),
    };
  }

  private projectToClosestPoint(position: StrokeModelPosition): void {
    let bestDistance = Infinity;
    for (let index = 0; index < this.samples.length - 1; index++) {
      const ratio = nearestPointOnSegment(this.samples[index].position, this.samples[index + 1].position, position);
      // Ignore a projection that would backtrack along the stroke.
      if (index === this.segmentIndex && ratio < this.ratioAlongSegment) continue;
      const projected = interpPosition(this.samples[index].position, this.samples[index + 1].position, ratio);
      const currentDistance = distance(position, projected);
      if (currentDistance <= bestDistance) {
        this.segmentIndex = index;
        this.ratioAlongSegment = ratio;
        bestDistance = currentDistance;
      }
    }
  }
}

export class StrokeModeler {
  private params: StrokeModelParams;
  private wobbleSmoother = new WobbleSmoother();
  private positionModeler = new PositionModeler();
  private stylusStateModeler = new StylusStateModeler();
  private lastInput: StrokeModelInput | null = null;
  private lastCorrectedPosition: StrokeModelPosition = { x: 0, y: 0 };

  constructor(params: StrokeModelParams = DEFAULT_STROKE_MODEL_PARAMS) {
    this.params = params;
  }

  reset(params: StrokeModelParams = DEFAULT_STROKE_MODEL_PARAMS): void {
    this.params = params;
    this.lastInput = null;
  }

  /** True while a stroke is in progress (after down, before up). */
  get strokeInProgress(): boolean {
    return this.lastInput !== null;
  }

  update(input: StrokeModelInput): StrokeModelResult[] {
    if (!Number.isFinite(input.time) || !Number.isFinite(input.position.x) || !Number.isFinite(input.position.y)) {
      throw new Error("Stroke modeler received a non-finite position or time");
    }
    if (this.lastInput) {
      if (input.time < this.lastInput.time) throw new Error("Stroke modeler inputs travel backwards in time");
      if (sameInput(this.lastInput, input)) return [];
    }
    switch (input.eventType) {
      case "down": return this.processDown(input);
      case "move": return this.processMove(input);
      case "up": return this.processUp(input);
      default: throw new Error(`Stroke modeler received an invalid event type: ${String((input as StrokeModelInput).eventType)}`);
    }
  }

  private processDown(input: StrokeModelInput): StrokeModelResult[] {
    if (this.lastInput) throw new Error("Stroke modeler received a down event while a stroke is in progress");
    this.wobbleSmoother.reset(this.params.wobbleSmoother, input.position, input.time);
    this.positionModeler.reset({
      position: { ...input.position },
      velocity: { x: 0, y: 0 },
      acceleration: { x: 0, y: 0 },
      time: input.time,
    }, this.params.positionModeler);
    this.stylusStateModeler.reset();
    this.stylusStateModeler.update(input.position, input.time, input.pressure, input.tiltX, input.tiltY);
    // The down event is never position-corrected: the first result is exactly
    // the first input, so stroke starts land precisely on the pen-down spot.
    this.lastInput = input;
    this.lastCorrectedPosition = { ...input.position };
    return [{ position: { ...input.position }, time: input.time, pressure: input.pressure, tiltX: input.tiltX, tiltY: input.tiltY }];
  }

  private processMove(input: StrokeModelInput): StrokeModelResult[] {
    if (!this.lastInput) throw new Error("Stroke modeler received a move event while no stroke is in progress");
    const corrected = this.wobbleSmoother.update(input.position, input.time);
    this.stylusStateModeler.update(corrected, input.time, input.pressure, input.tiltX, input.tiltY);
    const nSteps = this.numberOfStepsBetweenInputs(input);
    const tipStates: TipState[] = [];
    this.positionModeler.updateAlongLinearPath(
      this.lastCorrectedPosition, this.lastInput.time, corrected, input.time, nSteps, tipStates);
    this.lastInput = input;
    this.lastCorrectedPosition = corrected;
    return this.modelStylus(tipStates);
  }

  private processUp(input: StrokeModelInput): StrokeModelResult[] {
    if (!this.lastInput) throw new Error("Stroke modeler received an up event while no stroke is in progress");
    const nSteps = this.numberOfStepsBetweenInputs(input);
    const tipStates: TipState[] = [];
    this.positionModeler.updateAlongLinearPath(
      this.lastCorrectedPosition, this.lastInput.time, input.position, input.time, nSteps, tipStates);
    // Catch the tip up to the final input so stroke ends land on the lift spot.
    this.positionModeler.modelEndOfStroke(
      input.position,
      1 / this.params.sampling.minOutputRate,
      this.params.sampling.endOfStrokeMaxIterations,
      this.params.sampling.endOfStrokeStoppingDistance,
      tipStates);
    if (tipStates.length === 0) tipStates.push(copyTip(this.positionModeler.currentState()));
    this.stylusStateModeler.update(input.position, input.time, input.pressure, input.tiltX, input.tiltY);
    const results = this.modelStylus(tipStates);
    this.lastInput = null;
    return results;
  }

  private numberOfStepsBetweenInputs(input: StrokeModelInput): number {
    const tip = this.positionModeler.currentState();
    const deltaTime = input.time - this.lastInput!.time;
    let nSteps = Math.ceil(deltaTime * this.params.sampling.minOutputRate);
    if (this.params.sampling.maxOutputsPerCall > 0 && nSteps > this.params.sampling.maxOutputsPerCall) {
      throw new Error(`Stroke modeler input events are too far apart; requested ${nSteps} > ${this.params.sampling.maxOutputsPerCall} samples`);
    }
    return Math.max(0, nSteps);
  }

  private modelStylus(tipStates: TipState[]): StrokeModelResult[] {
    return tipStates.map((tip) => {
      const stylus = this.stylusStateModeler.project(tip);
      return { position: { ...tip.position }, time: tip.time, ...stylus };
    });
  }
}

function sameInput(left: StrokeModelInput, right: StrokeModelInput): boolean {
  return left.eventType === right.eventType && left.time === right.time
    && left.position.x === right.position.x && left.position.y === right.position.y
    && left.pressure === right.pressure && left.tiltX === right.tiltX && left.tiltY === right.tiltY;
}
