// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultToolState, sanitizeToolState, storedToolState, ToolStateSaver, TOOL_STATE_SAVE_DEBOUNCE_MS } from "../src/tool-state";
import type { StoredToolState } from "../src/tool-state";

describe("tool state persistence", () => {
  describe("sanitizeToolState", () => {
    it("falls back to the defaults for missing or non-object data", () => {
      for (const raw of [undefined, null, 42, "saved"]) {
        expect(sanitizeToolState(raw)).toEqual(defaultToolState());
      }
    });

    it("round-trips a stored snapshot unchanged", () => {
      const state = defaultToolState();
      state.pen.color = "#195bff";
      state.pen.width = 8;
      state.pen.smooth = 35;
      state.pen.pressureCurve = [[0, 0], [0.5, 0.4], [1, 1]];
      state.highlighter.color = "#f23c42";
      state.highlighter.width = 24;
      state.highlighter.opacity = 0.55;
      state.eraserMode = "square";
      state.eraserSize = 64;
      state.scribbleErase = false;
      state.lasso.crossFileClipboard = true;
      state.lasso.mode = "rectangle";
      state.fingerAsPen = true;
      expect(sanitizeToolState(storedToolState(state))).toEqual(state);
    });

    it("degrades only the invalid field, keeping valid siblings", () => {
      const state = sanitizeToolState({
        pen: { color: "nope", width: 12, opacity: 0.5 },
        highlighter: { color: "#123456" },
        eraserMode: "circle",
        eraserSize: 64,
      });
      expect(state.pen.color).toBe("#1b1b1b");
      expect(state.pen.width).toBe(12);
      expect(state.pen.opacity).toBe(0.5);
      expect(state.highlighter.color).toBe("#123456");
      expect(state.highlighter.width).toBe(18);
      expect(state.eraserMode).toBe("circle");
      expect(state.eraserSize).toBe(64);
    });

    it("keeps legacy touch navigation unless finger writing is explicitly enabled", () => {
      for (const value of [undefined, null, "true", 1, false]) expect(sanitizeToolState({ fingerAsPen: value }).fingerAsPen).toBe(false);
      expect(sanitizeToolState({ fingerAsPen: true }).fingerAsPen).toBe(true);
    });

    it("defaults scribble erasing on for old settings and accepts only an explicit false to disable it", () => {
      expect(sanitizeToolState({}).scribbleErase).toBe(true);
      expect(sanitizeToolState({ scribbleErase: false }).scribbleErase).toBe(false);
      expect(sanitizeToolState({ scribbleErase: "false" }).scribbleErase).toBe(true);
    });

    it("clamps numbers into their control ranges", () => {
      const state = sanitizeToolState({
        pen: { width: 999, opacity: 5, smooth: -3, taper: 42, pressureGain: 1000, speedGain: 1 },
        eraserSize: 999,
        eraserMode: "square",
      });
      expect(state.pen.width).toBe(24);
      expect(state.pen.opacity).toBe(1);
      expect(state.pen.smooth).toBe(0);
      expect(state.pen.taper).toBe(42);
      expect(state.pen.pressureGain).toBe(100);
      expect(state.pen.speedGain).toBe(1);
      expect(state.eraserSize).toBe(160);
      expect(sanitizeToolState({ highlighter: { width: 99 } }).highlighter.width).toBe(48);
    });

    it("drops dynamics fields the highlighter does not expose", () => {
      const state = sanitizeToolState({ highlighter: { smooth: 33, taper: 50 } });
      expect(state.highlighter.smooth).toBeUndefined();
      expect(state.highlighter.taper).toBeUndefined();
    });

    it("keeps an ordered pressure curve and discards a broken one", () => {
      expect(sanitizeToolState({ pen: { pressureCurve: [[0, 0], [0.5, 0.25], [1, 1]] } }).pen.pressureCurve)
        .toEqual([[0, 0], [0.5, 0.25], [1, 1]]);
      expect(sanitizeToolState({ pen: { pressureCurve: [[0, 0], [1, 2]] } }).pen.pressureCurve)
        .toEqual([[0, 0], [1, 1]]);
      for (const broken of [[[0.6, 0], [0.4, 1]], [[0, "x"]], "up", [[0, 0]]]) {
        expect(sanitizeToolState({ pen: { pressureCurve: broken } }).pen.pressureCurve).toBeUndefined();
      }
    });

    it("rejects non-finite numbers and unknown eraser modes", () => {
      const state = sanitizeToolState({ pen: { width: Number.NaN }, eraserSize: Number.POSITIVE_INFINITY, eraserMode: "magic" });
      expect(state.pen.width).toBe(3);
      expect(state.eraserSize).toBe(32);
      expect(state.eraserMode).toBe("stroke");
    });
  });

  describe("palette", () => {
    it("defaults to the stock palette", () => {
      const state = sanitizeToolState(undefined);
      expect(state.palette).toEqual(["#1b1b1b", "#195bff", "#f23c42", "#42c449", "#f2c94c"]);
    });

    it("drops invalid entries and duplicates, clamps to ten", () => {
      const palette = [
        "red", "#12", "#abc", "#ABC", "#195bff", "#f23c42",
        ...Array.from({ length: 12 }, (_, index) => `#aa${String(index).padStart(4, "0")}`),
      ];
      const state = sanitizeToolState({ palette });
      expect(state.palette).toEqual(["#abc", "#195bff", "#f23c42",
        "#aa0000", "#aa0001", "#aa0002", "#aa0003", "#aa0004", "#aa0005", "#aa0006"]);
    });

    it("falls back to the stock palette when nothing valid remains", () => {
      expect(sanitizeToolState({ palette: ["nope", "#123"] }).palette).toEqual(["#123"]);
      expect(sanitizeToolState({ palette: ["nope"] }).palette).toEqual(defaultToolState().palette);
      expect(sanitizeToolState({ palette: [] }).palette).toEqual(defaultToolState().palette);
    });

    it("survives a store roundtrip", () => {
      const state = defaultToolState();
      state.palette = ["#123456", "#fedcba"];
      expect(storedToolState(state).palette).toEqual(["#123456", "#fedcba"]);
      expect(sanitizeToolState(JSON.parse(JSON.stringify(storedToolState(state)))).palette).toEqual(["#123456", "#fedcba"]);
    });
  });

  describe("storedToolState", () => {
    it("keeps old or invalid lasso modes on freehand while preserving clipboard scope", () => {
      for (const mode of [undefined, "circle", 42, null]) {
        expect(sanitizeToolState({ lasso: { mode, crossFileClipboard: true } }).lasso)
          .toEqual({ mode: "freehand", crossFileClipboard: true });
      }
    });
    it("requires an explicit boolean to enable cross-file copying", () => {
      expect(sanitizeToolState({ lasso: { crossFileClipboard: "true" } }).lasso.crossFileClipboard).toBe(false);
      expect(sanitizeToolState({ lasso: { crossFileClipboard: true } }).lasso.crossFileClipboard).toBe(true);
    });
    it("strips the session tool and deep-copies the curve", () => {
      const source = defaultToolState();
      source.pen.pressureCurve = [[0, 0], [1, 1]];
      const stored = storedToolState(source);
      expect(stored).not.toHaveProperty("tool");
      expect(stored.pen.pressureCurve).toEqual([[0, 0], [1, 1]]);
      stored.pen.pressureCurve![0][0] = 9;
      expect(source.pen.pressureCurve![0][0]).toBe(0);
    });

    it("persists the scribble eraser preference", () => {
      const state = defaultToolState();
      state.scribbleErase = false;
      expect(storedToolState(state).scribbleErase).toBe(false);
      expect(sanitizeToolState(JSON.parse(JSON.stringify(storedToolState(state)))).scribbleErase).toBe(false);
    });
  });

  describe("ToolStateSaver", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("saves once, a full debounce after the last change", () => {
      const save = vi.fn(async (_state: StoredToolState) => undefined);
      const saver = new ToolStateSaver(save);
      const second = defaultToolState();
      second.pen.width = 8;
      saver.schedule(defaultToolState());
      vi.advanceTimersByTime(300);
      saver.schedule(second);
      vi.advanceTimersByTime(TOOL_STATE_SAVE_DEBOUNCE_MS - 1);
      expect(save).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(save).toHaveBeenCalledTimes(1);
      expect(save.mock.calls[0][0].pen.width).toBe(8);
    });

    it("flush() persists immediately, then stays idle", () => {
      const save = vi.fn(async (_state: StoredToolState) => undefined);
      const saver = new ToolStateSaver(save);
      saver.schedule(defaultToolState());
      saver.flush();
      expect(save).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(TOOL_STATE_SAVE_DEBOUNCE_MS * 2);
      saver.flush();
      expect(save).toHaveBeenCalledTimes(1);
    });
  });
});
