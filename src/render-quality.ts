export type RenderTier = "motion" | "base" | "idle";

/** Window after the last input/navigation signal that still reads as motion. */
export const RENDER_MOTION_MS = 150;
/** Window of total quiet after which the view counts as stationary and the
 *  full-resolution refine pass runs. */
export const RENDER_IDLE_MS = 600;
/** Transitional quality between motion and idle: the default tier a paused
 *  view renders at before the stationary refine arrives. */
export const RENDER_BASE_FACTOR = 0.75;

/** Adaptive rendering resolution: cheap while the user is moving, full budget
 *  once they stop. The tiers only apply where a mouse/touchpad/keyboard
 *  session is expected (desktop gate); mobile devices already manage their
 *  own density and thermal profile, so they permanently resolve to idle -
 *  today's full target. */
export class RenderQualityPolicy {
  private lastActivity = Number.NEGATIVE_INFINITY;

  /** `desktop` comes from device facts once at construction, matching the
   *  device-mode contract of keeping obsidian imports out of testable units. */
  constructor(private readonly desktop: boolean = true) {}

  /** Records an input or navigation signal (timestamps share one clock:
   *  performance.now() and DOM event timeStamp are both performance ms). */
  note(at: number): void {
    if (Number.isFinite(at)) this.lastActivity = Math.max(this.lastActivity, at);
  }

  tier(at: number): RenderTier {
    if (this.desktop && Number.isFinite(at)) {
      const quiet = at - this.lastActivity;
      if (quiet < RENDER_MOTION_MS) return "motion";
      if (quiet < RENDER_IDLE_MS) return "base";
    }
    return "idle";
  }
}

/** Tile/canvas backing density for the current tier. The motion tier's hard
 *  ceiling at 1 backing pixel per CSS pixel is the legibility floor: content
 *  never renders below what a non-retina monitor shows, so a fast pan still
 *  shows what every page (PDF included) is about. */
export function tierDensity(tier: RenderTier, dpr: number, zoom: number): number {
  const target = dpr * zoom;
  if (tier === "motion") return Math.min(1, target);
  if (tier === "base") return target * RENDER_BASE_FACTOR;
  return target;
}
