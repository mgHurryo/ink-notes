import type { StickyNote } from "./sticky-model";
import { STICKY_UNIT } from "./sticky-model";
import { drawInkStroke } from "./rendering";

export function stickyTextLines(text: string): string[] { return text.replace(/\r/g, "").split("\n"); }

/** Paint only the viewport. Changing its dimensions never changes stored content. */
export function paintStickyBoard(ctx: CanvasRenderingContext2D, note: StickyNote, width: number, height: number, scale = 1): void {
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  ctx.fillStyle = note.color; ctx.fillRect(0, 0, width, height);
  ctx.scale(scale, scale); ctx.translate(-note.scrollX, -note.scrollY);
  ctx.fillStyle = "#202020"; ctx.font = "20px sans-serif"; ctx.textBaseline = "top";
  const lines = stickyTextLines(note.text);
  const first = Math.max(0, Math.floor((note.scrollY - 16) / 28));
  for (let index = first; index < Math.min(lines.length, first + Math.ceil(height / scale / 28) + 2); index++) ctx.fillText(lines[index], 16, 16 + index * 28);
  for (const stroke of note.strokes) drawInkStroke(ctx, stroke, STICKY_UNIT, STICKY_UNIT);
  ctx.restore();
}

export function stickyFrameHeight(note: StickyNote, pageWidth: number, pageHeight: number): number {
  return note.collapsed ? (note.preview ? 132 : 32) * pageWidth / note.boardPageWidth : note.height * pageHeight;
}

export function paintStickyFrame(ctx: CanvasRenderingContext2D, note: StickyNote, pageWidth: number, pageHeight: number): void {
  const width = note.width * pageWidth, height = stickyFrameHeight(note, pageWidth, pageHeight), scale = pageWidth / note.boardPageWidth;
  ctx.save(); ctx.translate(note.x * pageWidth, note.y * pageHeight);
  ctx.fillStyle = note.color; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#202020"; ctx.font = `bold ${16 * scale}px sans-serif`; ctx.textBaseline = "top";
  ctx.fillText(note.title || "Sticky note", 8 * scale, 8 * scale, Math.max(1, width - 16 * scale));
  if (!note.collapsed || note.preview) {
    ctx.translate(0, 32 * scale); paintStickyBoard(ctx, note, width, Math.max(1, height - 32 * scale), scale);
  }
  ctx.restore();
}

export function paintPageStickies(ctx: CanvasRenderingContext2D, notes: StickyNote[] | undefined, pageWidth: number, pageHeight: number): void {
  for (const note of notes ?? []) paintStickyFrame(ctx, note, pageWidth, pageHeight);
}

export async function stickyPng(note: StickyNote, pageWidth: number, pageHeight: number): Promise<ArrayBuffer> {
  const width = note.width * pageWidth, height = stickyFrameHeight(note, pageWidth, pageHeight);
  const scale = Math.min(2, 4096 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Sticky note rendering is unavailable");
  ctx.scale(scale, scale); paintStickyFrame(ctx, { ...note, x: 0, y: 0 }, pageWidth, pageHeight);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not render sticky note")), "image/png"));
  return blob.arrayBuffer();
}
