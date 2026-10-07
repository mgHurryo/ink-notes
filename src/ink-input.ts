/**
 * Shared pointer-input contracts for both ink editors. The notebook and PDF
 * views must behave identically at this layer: every bug fixed here applies
 * to both, instead of being patched into one fork and missed in the other.
 */

/**
 * Document-level pointerup/pointercancel fallback, bound to the element's
 * window and rebound if the element migrates between Obsidian popout windows.
 *
 * Host-level end listeners alone lose strokes: iPadOS interrupts a Pencil
 * stroke (system gesture, Pencil haptic tick, palm-rejection retarget) so the
 * pointerup never reaches the host element, and a pen lifted outside an
 * uncaptured element is missed entirely. The stroke then stays preview-only
 * and the next render wipes it - "write a stroke, lose a stroke".
 *
 * The callback must be idempotent per stroke: both the host listener and this
 * fallback fire for ordinary endings, and the view's active-pointer guard
 * dedupes them.
 */
export function registerDocumentPointerEndEvents(
  element: HTMLElement,
  register: (cleanup: () => void) => void,
  onEnd: (event: PointerEvent, cancelled: boolean) => void,
): void {
  let owner = element.ownerDocument;
  const end = (event: PointerEvent) => onEnd(event, event.type === "pointercancel");
  const bind = () => {
    owner.addEventListener("pointerup", end);
    owner.addEventListener("pointercancel", end);
  };
  const unbind = () => {
    owner.removeEventListener("pointerup", end);
    owner.removeEventListener("pointercancel", end);
  };
  bind();
  const stopMigration = element.onWindowMigrated?.(() => {
    if (owner === element.ownerDocument) return;
    unbind();
    owner = element.ownerDocument;
    bind();
  });
  register(() => {
    stopMigration?.();
    unbind();
  });
}
