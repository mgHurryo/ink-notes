import { describe, expect, it } from "vitest";
import { InkClipboard, pasteClipboardStrokes } from "../src/lasso-clipboard";
import type { InkStroke } from "../src/model";

const stroke: InkStroke = { id: "original", pageId: "source", tool: "pen", color: "#123456", width: 4, opacity: 0.8,
  createdAt: 1, updatedAt: 1, dynamics: { pressure: 75, pressureCurve: [[0, 0], [1, 1]] },
  points: [{ x: 0.1, y: 0.2, pressure: 0.4, t: 1 }, { x: 0.3, y: 0.4, pressure: 0.8, t: 2 }] };

describe("ink clipboard geometry", () => {
  it("copies independently and preserves proportions between different page shapes", () => {
    const clipboard = new InkClipboard();
    clipboard.copy({ filePath: "a.ink", width: 100, height: 200, strokes: [stroke] });
    const pasted = pasteClipboardStrokes(clipboard.content!, "target", 200, 100, { x: 0.5, y: 0.5 });
    const ink = pasted[0];
    expect(ink.id).not.toBe(stroke.id);
    expect(ink.pageId).toBe("target");
    // Widths are canonical page widths: they travel unchanged (fit shrink
    // only), whatever the source and target canvas sizes are.
    expect(ink.width).toBe(4);
    const originalRatio = (0.2 * 100) / (0.2 * 200);
    expect((ink.points[1].x - ink.points[0].x) * 200 / ((ink.points[1].y - ink.points[0].y) * 100)).toBeCloseTo(originalRatio);
    expect(ink.points.map((point) => point.pressure)).toEqual([0.4, 0.8]);
    ink.points[0].x = 99;
    ink.dynamics!.pressureCurve![0][0] = 99;
    expect(stroke.points[0].x).toBe(0.1);
    expect(clipboard.content!.strokes[0].dynamics!.pressureCurve![0][0]).toBe(0);
  });

  it("fits oversized content inside the destination and generates new IDs every time", () => {
    const content = { filePath: "a.pdf", width: 100, height: 1000, strokes: [stroke] };
    const first = pasteClipboardStrokes(content, "b", 1000, 100, { x: 1, y: 0 });
    const second = pasteClipboardStrokes(content, "b", 1000, 100, { x: 1, y: 0 });
    expect(first[0].id).not.toBe(second[0].id);
    for (const point of first[0].points) {
      expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(1);
      expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(1);
    }
    expect(first[0].width).toBeLessThan(40);
  });
});
