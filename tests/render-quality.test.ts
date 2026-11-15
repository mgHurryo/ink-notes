import { describe, expect, it } from "vitest";
import { RENDER_BASE_FACTOR, RENDER_IDLE_MS, RENDER_MOTION_MS, RenderQualityPolicy, tierDensity } from "../src/render-quality";

describe("adaptive render quality tiers", () => {
  it("reads as motion immediately after a signal", () => {
    const policy = new RenderQualityPolicy();
    policy.note(1000);
    expect(policy.tier(1000 + RENDER_MOTION_MS - 1)).toBe("motion");
  });

  it("reads as base between the motion and idle windows", () => {
    const policy = new RenderQualityPolicy();
    policy.note(1000);
    expect(policy.tier(1000 + RENDER_MOTION_MS)).toBe("base");
    expect(policy.tier(1000 + RENDER_IDLE_MS - 1)).toBe("base");
  });

  it("reads as idle once the stationary window elapses", () => {
    const policy = new RenderQualityPolicy();
    policy.note(1000);
    expect(policy.tier(1000 + RENDER_IDLE_MS)).toBe("idle");
  });

  it("fresh activity restarts the windows from the latest signal", () => {
    const policy = new RenderQualityPolicy();
    policy.note(1000);
    expect(policy.tier(1000 + RENDER_IDLE_MS - 1)).toBe("base");
    policy.note(1400);
    expect(policy.tier(1400 + RENDER_MOTION_MS)).toBe("base");
    expect(policy.tier(1400 + RENDER_MOTION_MS - 1)).toBe("motion");
    expect(policy.tier(1400 + RENDER_IDLE_MS)).toBe("idle");
  });

  it("ignores nonfinite and out-of-order timestamps", () => {
    const policy = new RenderQualityPolicy();
    expect(policy.tier(5000)).toBe("idle");
    policy.note(Number.NaN);
    expect(policy.tier(5000)).toBe("idle");
    policy.note(1000);
    policy.note(500); // stale sample must not rewind the last activity
    expect(policy.tier(1000 + RENDER_MOTION_MS - 1)).toBe("motion");
  });

  it("mobile resolves to idle at every moment so density stays today's target", () => {
    const policy = new RenderQualityPolicy(false);
    policy.note(1000);
    expect(policy.tier(1000)).toBe("idle");
    expect(policy.tier(1000 + RENDER_IDLE_MS)).toBe("idle");
  });

  it("caps motion density at the 1:1 CSS-pixel legibility floor", () => {
    expect(tierDensity("motion", 2, 2)).toBe(1);
    expect(tierDensity("motion", 1, 0.5)).toBe(0.5);
  });

  it("scales base and keeps idle at the full dpr x zoom target", () => {
    expect(tierDensity("base", 1.25, 1)).toBeCloseTo(1.25 * RENDER_BASE_FACTOR);
    expect(tierDensity("idle", 1.25, 2)).toBeCloseTo(2.5);
    expect(tierDensity("idle", 1, 1)).toBe(1);
  });
});
