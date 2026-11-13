/** Page-rail width behavior shared by the notebook editor and the PDF view:
 *  a right-edge drag handle plus localStorage persistence. One width serves
 *  BOTH rails (a width set on either editor applies everywhere); the legacy
 *  per-view keys migrate into the shared slot on first read. */

export const RAIL_MIN_WIDTH = 150;
export const RAIL_MAX_WIDTH = 420;
export const RAIL_WIDTH_STORAGE_KEY = "ink-page-rail-width";
/** Pre-unification keys; the shared key wins, the first valid legacy value
 *  seeds it, and a completed drag finally clears them. */
const LEGACY_RAIL_WIDTH_KEYS = ["ink-notes-page-rail-width", "ink-pdf-page-rail-width"];

function storedRailWidth(): number | null {
  try {
    for (const key of [RAIL_WIDTH_STORAGE_KEY, ...LEGACY_RAIL_WIDTH_KEYS]) {
      const width = Number(window.localStorage.getItem(key));
      if (Number.isFinite(width) && width >= RAIL_MIN_WIDTH && width <= RAIL_MAX_WIDTH) return width;
    }
  } catch {
    // localStorage can be unavailable (privacy modes); the CSS default holds.
  }
  return null;
}

/** Applies the persisted rail width as a CSS variable so the stylesheet
 *  keeps owning width/flex-basis (the container-query narrow width still
 *  wins where it applies). */
export function applyStoredRailWidth(rail: HTMLElement): void {
  const width = storedRailWidth();
  if (width !== null) rail.style.setProperty("--ink-rail-width", `${Math.round(width)}px`);
}

export interface RailResizerOptions {
  /** Runs once per drag end so the view can repaint thumbnails at the
   *  final width (they raster at the old size during the drag). */
  onDragEnd?: () => void;
}

/** Drag handle on the rail's right edge: horizontal pointer drag widens or
 *  narrows the rail, the final width persists to localStorage. Pointer
 *  capture keeps the gesture alive outside the handle's hit box. Drag state
 *  lives in this closure instead of the view: a handle replaced by a rail
 *  rebuild mid-gesture must not wedge the replacement's first drag. */
export function mountRailResizer(rail: HTMLElement, options: RailResizerOptions): void {
  const handle = rail.createDiv({ cls: "ink-rail-resizer", attr: { "aria-hidden": "true" } });
  let drag: { pointerId: number; startWidth: number; startX: number } | null = null;
  handle.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { pointerId: event.pointerId, startWidth: rail.getBoundingClientRect().width, startX: event.clientX };
    // The width must track the pointer exactly; the expand/collapse
    // transition would otherwise lag every drag step by 200ms.
    rail.classList.add("is-resizing");
    if (typeof handle.setPointerCapture === "function") handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyRailWidth(rail, drag.startWidth + event.clientX - drag.startX);
  });
  const finish = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    rail.classList.remove("is-resizing");
    if (typeof handle.hasPointerCapture === "function" && handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
    const width = parseFloat(rail.style.getPropertyValue("--ink-rail-width"));
    if (Number.isFinite(width)) {
      try {
        window.localStorage.setItem(RAIL_WIDTH_STORAGE_KEY, String(width));
        for (const key of LEGACY_RAIL_WIDTH_KEYS) window.localStorage.removeItem(key);
      } catch {
        // Persistence is best-effort; the drag result still applies live.
      }
    }
    options.onDragEnd?.();
  };
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

function applyRailWidth(rail: HTMLElement, width: number): void {
  const clamped = Math.round(Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, width)));
  rail.style.setProperty("--ink-rail-width", `${clamped}px`);
}
