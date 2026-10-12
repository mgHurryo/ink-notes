import { describe, expect, it } from "vitest";
import { defaultReadingMode } from "../src/device-mode";

const mobile = { isDesktopApp: false, isMobileApp: true, isPhone: false, isTablet: true };
const tablet = { width: 1024, height: 1366, userAgent: "Android", maxTouchPoints: 5 };

describe("device default mode", () => {
  it("starts phones and small touch devices reading, in either orientation", () => {
    for (const [width, height] of [[390, 844], [844, 390], [540, 720]]) {
      expect(defaultReadingMode(mobile, { ...tablet, width, height })).toBe(true);
    }
  });

  it("starts large mobile tablets writing regardless of available phone UI space", () => {
    expect(defaultReadingMode(mobile, tablet)).toBe(false);
    expect(defaultReadingMode({ ...mobile, isPhone: true, isTablet: false }, tablet)).toBe(false);
  });

  it.each(["iPad", "Mozilla/5.0 (Macintosh; Intel Mac OS X)"])("keeps %s multiwindow handwriting-first", (userAgent) => {
    expect(defaultReadingMode({ ...mobile, isPhone: true, isTablet: false }, {
      ...tablet, width: 320, height: 800, userAgent,
    })).toBe(false);
  });

  it("starts desktop and unknown devices reading, including touch-enabled computers", () => {
    expect(defaultReadingMode({ ...mobile, isDesktopApp: true, isMobileApp: false }, tablet)).toBe(true);
    expect(defaultReadingMode({ ...mobile, isMobileApp: false }, tablet)).toBe(true);
    expect(defaultReadingMode({ ...mobile, isTablet: false }, { ...tablet, width: 0, height: 0 })).toBe(true);
  });
});
