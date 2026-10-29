import { InkStroke, newId } from "./model";

export interface InkClipboardContent {
  filePath: string;
  width: number;
  height: number;
  strokes: InkStroke[];
}

/** One in-memory clipboard per plugin instance; never exports ink to the OS. */
export class InkClipboard {
  content: InkClipboardContent | null = null;

  copy(content: InkClipboardContent): void {
    this.content = { ...content, strokes: content.strokes.map(copyStroke) };
  }
}

function copyStroke(stroke: InkStroke): InkStroke {
  return { ...stroke, points: stroke.points.map((point) => ({ ...point })),
    dynamics: stroke.dynamics ? { ...stroke.dynamics,
      pressureCurve: stroke.dynamics.pressureCurve?.map((point) => [...point]) } : undefined };
}

/** Keep the source aspect ratio at the target page's scale, fitting oversized ink. */
export function pasteClipboardStrokes(content: InkClipboardContent, pageId: string,
  width: number, height: number, target: { x: number; y: number }): InkStroke[] {
  if (![width, height, content.width, content.height].every((value) => Number.isFinite(value) && value > 0)) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const stroke of content.strokes) for (const point of stroke.points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return [];
  const yScale = (content.height / content.width) / (height / width);
  const spanX = maxX - minX, spanY = (maxY - minY) * yScale;
  const fit = Math.min(1, 1 / Math.max(spanX, spanY, 1));
  const left = Math.max(0, Math.min(1 - spanX * fit, target.x - spanX * fit / 2));
  const top = Math.max(0, Math.min(1 - spanY * fit, target.y - spanY * fit / 2));
  const now = Date.now();
  return content.strokes.map((stroke) => ({ ...copyStroke(stroke), id: newId("stroke"), pageId,
    // Widths are canonical page widths (STROKE_WIDTH_REFERENCE), so they
    // survive the paste unchanged — only the fit factor travels, exactly like
    // the normalized points. The old width × target/source conversion belonged
    // to the device-pixel width era and made the paste device-dependent.
    width: stroke.width * fit, createdAt: now, updatedAt: now,
    points: stroke.points.map((point) => ({ ...point,
      x: left + (point.x - minX) * fit, y: top + (point.y - minY) * yScale * fit })) }));
}
