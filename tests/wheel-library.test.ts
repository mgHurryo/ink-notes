import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { WheelGestures, type WheelEventData, type WheelEventState } from "wheel-gestures";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("wheel-gestures recorded-device evaluation", () => {
  it.each([["win-chrome-right-ptp", 1], ["win-chrome-fast-right-ptp", 1], ["double-swipe-right", 2], ["slow-drag-right", 1]] as const)(
    "replays %s", (name, expectedStarts) => {
      const recording = JSON.parse(readFileSync(new URL(`./fixtures/wheel-gestures/${name}.json`, import.meta.url), "utf8")) as { wheelEvents: WheelEventData[] };
      const engine = WheelGestures({ preventWheelAction: false, reverseSign: false });
      const states: WheelEventState[] = [];
      const off = engine.on("wheel", (state) => states.push(state));
      let previous = recording.wheelEvents[0].timeStamp;
      for (const event of recording.wheelEvents) {
        vi.advanceTimersByTime(Math.max(0, event.timeStamp - previous));
        engine.feedWheel(event);
        previous = event.timeStamp;
      }
      vi.advanceTimersByTime(1100);
      const starts = states.filter((state) => state.isStart).length;
      const momentum = states.filter((state) => state.isMomentum).length;
      expect(starts).toBe(expectedStarts);
      if (name === "slow-drag-right") expect(momentum).toBe(0);
      else expect(momentum).toBeGreaterThan(0);
      expect(states[states.length - 1]?.isEnding).toBe(true);
      off(); engine.disconnect();
    });
});
