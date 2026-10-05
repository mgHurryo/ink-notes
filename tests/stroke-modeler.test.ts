import { describe, expect, it } from "vitest";
import { DEFAULT_STROKE_MODEL_PARAMS, StrokeModeler, StrokeModelInput, StrokeModelResult } from "../src/stroke-modeler";

function move(position: { x: number; y: number }, time: number, extra: Partial<StrokeModelInput> = {}): StrokeModelInput {
  return { eventType: "move", position, time, ...extra };
}

function down(position: { x: number; y: number }, time: number, extra: Partial<StrokeModelInput> = {}): StrokeModelInput {
  return { eventType: "down", position, time, ...extra };
}

function up(position: { x: number; y: number }, time: number, extra: Partial<StrokeModelInput> = {}): StrokeModelInput {
  return { eventType: "up", position, time, ...extra };
}

function collect(inputs: StrokeModelInput[]): StrokeModelResult[] {
  const modeler = new StrokeModeler();
  return inputs.flatMap((input) => modeler.update(input));
}

describe("stroke modeler", () => {
  it("returns the down input exactly as the only first result", () => {
    const modeler = new StrokeModeler();
    const results = modeler.update(down({ x: 12, y: -3 }, 1, { pressure: 0.42 }));
    expect(results).toHaveLength(1);
    expect(results[0].position).toEqual({ x: 12, y: -3 });
    expect(results[0].time).toBe(1);
    expect(results[0].pressure).toBe(0.42);
  });

  it("keeps a constant-speed straight line on its segment and lands on the lift point", () => {
    const inputs: StrokeModelInput[] = [down({ x: 0, y: 0 }, 0)];
    for (let index = 1; index <= 40; index++) {
      inputs.push(move({ x: index * 3, y: index }, index * 0.008, { pressure: 0.5 }));
    }
    inputs.push(up({ x: 123, y: 41 }, 40 * 0.008 + 0.004));
    const results = collect(inputs);
    expect(results.length).toBeGreaterThan(20);
    for (let index = 1; index < results.length; index++) {
      expect(results[index].time).toBeGreaterThanOrEqual(results[index - 1].time);
      // The modeled tip trails the anchor along the line but must stay on it.
      expect(Math.abs(results[index].position.y - results[index].position.x / 3)).toBeLessThan(1e-6);
    }
    const last = results[results.length - 1];
    expect(Math.hypot(last.position.x - 123, last.position.y - 41)).toBeLessThan(0.01);
  });

  it("produces at least minOutputRate results per second of sparse input", () => {
    const inputs: StrokeModelInput[] = [down({ x: 0, y: 0 }, 0)];
    for (let index = 1; index <= 5; index++) inputs.push(move({ x: index * 20, y: 0 }, index * 0.1));
    const modeler = new StrokeModeler();
    const moveResults = inputs.flatMap((input) => modeler.update(input));
    // Each 100 ms move must be upsampled to 180 Hz.
    expect(moveResults.length).toBeGreaterThanOrEqual(5 * 18);
  });

  it("never alters results that earlier inputs already produced", () => {
    const inputs: StrokeModelInput[] = [down({ x: 0, y: 0 }, 0)];
    for (let index = 1; index <= 30; index++) {
      inputs.push(move({ x: Math.cos(index / 5) * 40 + 40, y: index * 2 }, index * 0.008));
    }
    inputs.push(up({ x: 80, y: 62 }, 30 * 0.008 + 0.004));

    const partial = new StrokeModeler();
    const early = inputs.slice(0, 16).flatMap((input) => partial.update(input));
    const continued = [...early, ...inputs.slice(16).flatMap((input) => partial.update(input))];
    const complete = collect(inputs);
    expect(continued.length).toBe(complete.length);
    for (let index = 0; index < continued.length; index++) {
      expect(continued[index]).toEqual(complete[index]);
    }
  });

  it("converges to the final input when the stroke ends while the tip lags", () => {
    // A fast flick leaves the spring tip far behind; the up event must catch up.
    const results = collect([
      down({ x: 0, y: 0 }, 0),
      move({ x: 100, y: 0 }, 0.02),
      up({ x: 200, y: 0 }, 0.04),
    ]);
    const last = results[results.length - 1];
    expect(Math.hypot(last.position.x - 200, last.position.y)).toBeLessThan(0.01);
  });

  it("smooths high-frequency noise for near-stationary input", () => {
    const noisy: StrokeModelInput[] = [down({ x: 0, y: 0 }, 0)];
    for (let index = 1; index <= 60; index++) {
      noisy.push(move({ x: Math.sin(index * 2.4) * 0.4, y: Math.cos(index * 1.7) * 0.4 }, index * 0.02));
    }
    const results = collect(noisy);
    const lateral = (result: StrokeModelResult) => Math.hypot(result.position.x, result.position.y);
    const rawDeviation = noisy.slice(1).reduce((sum, input) => sum + Math.hypot(input.position.x, input.position.y), 0) / 60;
    const modeledDeviation = results.reduce((sum, result) => sum + lateral(result), 0) / results.length;
    expect(modeledDeviation).toBeLessThan(rawDeviation * 0.5);
  });

  it("interpolates pressure from the raw inputs the tip is projected onto", () => {
    const results = collect([
      down({ x: 0, y: 0 }, 0, { pressure: 0.2 }),
      move({ x: 10, y: 0 }, 0.05, { pressure: 0.2 }),
      move({ x: 20, y: 0 }, 0.1, { pressure: 0.8 }),
    ]);
    const middle = results.filter((result) => result.position.x > 12 && result.position.x < 18);
    expect(middle.length).toBeGreaterThan(0);
    for (const result of middle) {
      expect(result.pressure!).toBeGreaterThan(0.25);
      expect(result.pressure!).toBeLessThan(0.75);
    }
  });

  it("drops tilt for results produced after an input omits it", () => {
    const modeler = new StrokeModeler();
    const first = modeler.update(down({ x: 0, y: 0 }, 0, { tiltX: 30, tiltY: -20 }));
    const second = modeler.update(move({ x: 5, y: 0 }, 0.02, { tiltX: 31, tiltY: -20 }));
    const third = modeler.update(move({ x: 10, y: 0 }, 0.04));
    expect(first[0].tiltX).toBe(30);
    // Projections made before the unknown tilt keep interpolated values; once
    // unknown tilt is seen, every later projection drops the field.
    for (const result of second) expect(result.tiltX).toBeGreaterThan(30);
    for (const result of third) {
      expect(result.tiltX).toBeUndefined();
      expect(result.tiltY).toBeUndefined();
    }
  });

  it("ignores an exact duplicate input without producing results", () => {
    const modeler = new StrokeModeler();
    modeler.update(down({ x: 1, y: 2 }, 0.5, { pressure: 0.3 }));
    expect(modeler.update(down({ x: 1, y: 2 }, 0.5, { pressure: 0.3 }))).toHaveLength(0);
    modeler.update(move({ x: 2, y: 3 }, 0.6, { pressure: 0.3 }));
    expect(modeler.update(move({ x: 2, y: 3 }, 0.6, { pressure: 0.3 }))).toHaveLength(0);
  });

  it("rejects corrupted input streams", () => {
    const modeler = new StrokeModeler();
    expect(() => modeler.update(move({ x: 0, y: 0 }, 0))).toThrow(/no stroke is in progress/);
    modeler.update(down({ x: 0, y: 0 }, 1));
    expect(() => modeler.update(down({ x: 1, y: 0 }, 1.5))).toThrow(/stroke is in progress/);
    expect(() => modeler.update(move({ x: 1, y: 0 }, 0.5))).toThrow(/backwards in time/);
    expect(() => modeler.update(move({ x: Number.NaN, y: 0 }, 2))).toThrow(/non-finite/);
    modeler.update(up({ x: 1, y: 0 }, 2));
    expect(() => modeler.update(up({ x: 1, y: 0 }, 3))).toThrow(/no stroke is in progress/);
  });

  it("rejects a time gap that would exceed the per-update output budget", () => {
    const modeler = new StrokeModeler({ ...DEFAULT_STROKE_MODEL_PARAMS,
      sampling: { ...DEFAULT_STROKE_MODEL_PARAMS.sampling, maxOutputsPerCall: 10 } });
    modeler.update(down({ x: 0, y: 0 }, 0));
    expect(() => modeler.update(move({ x: 5, y: 0 }, 1))).toThrow(/too far apart/);
  });

  it("reports stroke progress for flush handling", () => {
    const modeler = new StrokeModeler();
    expect(modeler.strokeInProgress).toBe(false);
    modeler.update(down({ x: 0, y: 0 }, 0));
    expect(modeler.strokeInProgress).toBe(true);
    modeler.update(up({ x: 5, y: 0 }, 0.1));
    expect(modeler.strokeInProgress).toBe(false);
  });

  it("stays correct when a pen rests in one spot for thousands of samples", () => {
    const modeler = new StrokeModeler();
    modeler.update(down({ x: 0, y: 0 }, 0, { pressure: 0.5 }));
    // Ten minutes of 120 Hz resting-pen samples at one position.
    for (let index = 1; index <= 72_000; index++) {
      modeler.update(move({ x: 0, y: 0 }, index / 120, { pressure: 0.5 }));
    }
    const results = modeler.update(move({ x: 30, y: 0 }, 601, { pressure: 0.5 }));
    expect(results.length).toBeGreaterThan(0);
    const last = modeler.update(up({ x: 60, y: 0 }, 601.1, { pressure: 0.5 }));
    expect(last.length).toBeGreaterThan(0);
    expect(last[last.length - 1].position.x).toBeGreaterThan(55);
  });
});
