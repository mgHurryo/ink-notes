import type { InkNotebook, InkPage, InkStroke } from "./model";
import { cloneSticky } from "./sticky-model";
import { clampPercent, normalizePressureCurve } from "./rendering";

export interface NotebookReconciliation {
  pageIndex: number;
  pageRailChanged: boolean;
  currentPageChanged: boolean;
  currentInkChanged: boolean;
  currentPaperChanged: boolean;
  dimensionsChanged: boolean;
  changedPageIds: string[];
  metadataOnlyChanges: { stroke: InkStroke; previousUpdatedAt: number }[];
}

export function reconcileNotebook(target: InkNotebook, incoming: InkNotebook, selectedPageId: string,
  previousPageIndex: number): NotebookReconciliation {
  const dimensionsChanged = target.pageWidth !== incoming.pageWidth || target.pageHeight !== incoming.pageHeight;
  const previousPages = target.pages;
  const metadataOnlyChanges: NotebookReconciliation["metadataOnlyChanges"] = [];
  const previousById = new Map(previousPages.map((page) => [page.id, page]));
  const pageChanges = new Map<string, { ink: boolean; paper: boolean; rail: boolean }>();

  const pages = incoming.pages.map((incomingPage) => {
    const page = previousById.get(incomingPage.id);
    if (!page) {
      pageChanges.set(incomingPage.id, { ink: true, paper: true, rail: true });
      return incomingPage;
    }

    const paperChanged = page.paper !== incomingPage.paper;
    // Tags/flags render on the rail, so a peer-merged change must mark the
    // rail dirty exactly like a title/paper change does.
    const railChanged = page.title !== incomingPage.title || paperChanged
      || (page.tags ?? []).join("\n") !== (incomingPage.tags ?? []).join("\n")
      || page.flag !== incomingPage.flag;
    const inkChanged = reconcilePage(page, incomingPage, metadataOnlyChanges);
    pageChanges.set(page.id, { ink: inkChanged, paper: paperChanged, rail: railChanged });
    return page;
  });

  const pageListChanged = previousPages.length !== pages.length
    || previousPages.some((page, index) => page.id !== pages[index]?.id);
  if (pages.length === 0) {
    // An empty incoming sequence (a pre-fix merge could write one) has no page
    // to select; return a neutral result and leave the local notebook alone
    // instead of crashing on pages[-1].
    return {
      pageIndex: Math.max(0, previousPageIndex),
      pageRailChanged: false,
      currentPageChanged: false,
      currentInkChanged: false,
      currentPaperChanged: false,
      dimensionsChanged,
      changedPageIds: [],
      metadataOnlyChanges,
    };
  }
  const selectedIndex = pages.findIndex((page) => page.id === selectedPageId);
  const pageIndex = selectedIndex >= 0 ? selectedIndex : Math.min(previousPageIndex, pages.length - 1);
  const currentPage = pages[pageIndex];
  const currentPageChanged = currentPage.id !== selectedPageId;
  const currentChanges = pageChanges.get(currentPage.id);

  target.schema = incoming.schema;
  target.title = incoming.title;
  target.pageWidth = incoming.pageWidth;
  target.pageHeight = incoming.pageHeight;
  target.pages = pageListChanged ? pages : previousPages;
  target.pageOrder = arraysEqual(target.pageOrder, incoming.pageOrder) ? target.pageOrder : [...incoming.pageOrder];
  target.deletedPages = recordsEqual(target.deletedPages, incoming.deletedPages)
    ? target.deletedPages : { ...incoming.deletedPages };
  target.pageOrderUpdatedAt = incoming.pageOrderUpdatedAt;
  target.updatedAt = incoming.updatedAt;

  return {
    pageIndex,
    pageRailChanged: pageListChanged || [...pageChanges.values()].some((change) => change.rail),
    currentPageChanged,
    currentInkChanged: currentPageChanged || currentChanges?.ink === true,
    currentPaperChanged: !currentPageChanged && currentChanges?.paper === true,
    dimensionsChanged,
    changedPageIds: [...pageChanges].filter(([, change]) => change.ink || change.paper).map(([id]) => id),
    metadataOnlyChanges,
  };
}

function reconcilePage(target: InkPage, incoming: InkPage, metadataOnlyChanges: NotebookReconciliation["metadataOnlyChanges"]): boolean {
  const stickyChanged = JSON.stringify(target.stickyNotes ?? []) !== JSON.stringify(incoming.stickyNotes ?? []);
  if (stickyChanged) target.stickyNotes = incoming.stickyNotes?.map(cloneSticky);
  target.deletedStickyNotes = { ...incoming.deletedStickyNotes };
  const imagesChanged = JSON.stringify(target.images ?? []) !== JSON.stringify(incoming.images ?? []);
  if (imagesChanged) target.images = incoming.images?.map((image) => ({ ...image }));
  target.deletedImageIds = [...(incoming.deletedImageIds ?? [])];
  const previousStrokes = target.strokes;
  const previousById = new Map(previousStrokes.map((stroke) => [stroke.id, stroke]));
  const strokes = incoming.strokes.map((incomingStroke) => {
    const stroke = previousById.get(incomingStroke.id);
    if (!stroke || !strokeAppearanceEqual(stroke, incomingStroke)) return incomingStroke;
    // updatedAt participates in conflict resolution but not in rendering.
    if (stroke.updatedAt !== incomingStroke.updatedAt) metadataOnlyChanges.push({ stroke, previousUpdatedAt: stroke.updatedAt });
    stroke.updatedAt = incomingStroke.updatedAt;
    return stroke;
  });
  const inkChanged = previousStrokes.length !== strokes.length
    || previousStrokes.some((stroke, index) => stroke !== strokes[index]);

  target.title = incoming.title;
  target.paper = incoming.paper;
  // Tag surface ([] and absent are the same state; keep untagged pages
  // key-free so legacy files stay byte-stable through unrelated saves).
  if (incoming.tags?.length) target.tags = [...incoming.tags];
  else delete target.tags;
  target.flag = incoming.flag;
  if (inkChanged) target.strokes = strokes;
  target.deletedStrokeIds = arraysEqual(target.deletedStrokeIds, incoming.deletedStrokeIds)
    ? target.deletedStrokeIds : [...incoming.deletedStrokeIds];
  target.createdAt = incoming.createdAt;
  target.updatedAt = incoming.updatedAt;
  return inkChanged || imagesChanged || stickyChanged;
}

function strokeAppearanceEqual(left: InkStroke, right: InkStroke): boolean {
  if (left.id !== right.id || left.pageId !== right.pageId || left.tool !== right.tool
    || left.color !== right.color || left.width !== right.width || left.opacity !== right.opacity
    || left.createdAt !== right.createdAt || left.points.length !== right.points.length
    || !strokeDynamicsEqual(left, right)) return false;
  for (let index = 0; index < left.points.length; index++) {
    const a = left.points[index];
    const b = right.points[index];
    if (a.x !== b.x || a.y !== b.y || a.pressure !== b.pressure || a.t !== b.t
      || a.tiltX !== b.tiltX || a.tiltY !== b.tiltY) return false;
  }
  return true;
}

function strokeDynamicsEqual(left: InkStroke, right: InkStroke): boolean {
  const a = left.dynamics, b = right.dynamics;
  // Normalization omits default dynamics. That is the same appearance as an
  // explicit default captured by the pen, not a reason to repaint local ink.
  return clampPercent(a?.taper, 0) === clampPercent(b?.taper, 0)
    && clampPercent(a?.pressure, 100) === clampPercent(b?.pressure, 100)
    && clampPercent(a?.speed, 0) === clampPercent(b?.speed, 0)
    && JSON.stringify(normalizePressureCurve(a?.pressureCurve)) === JSON.stringify(normalizePressureCurve(b?.pressureCurve));
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordsEqual(left: Record<string, number>, right: Record<string, number>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
