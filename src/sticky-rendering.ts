import type { StickyNote } from "./sticky-model";
import { STICKY_HEADER } from "./sticky-ink";
import { STICKY_UNIT } from "./sticky-model";
import { drawInkStroke } from "./rendering";
import { App, Component, MarkdownRenderer } from "obsidian";

export interface StickyMarkdownContext { app: App; source: string }

/** Use the host Markdown renderer for both the card and PDF snapshot. The
 * snapshot is self-contained: remote/embed resources are omitted, so SVG
 * rasterization cannot initiate additional requests or taint the canvas. */
async function markdownImage(note: StickyNote, context: StickyMarkdownContext, viewportWidth: number, viewportHeight: number): Promise<HTMLImageElement> {
  const component = new Component(); component.load();
  const el = document.createElement("div");
  try {
    await MarkdownRenderer.render(context.app, note.text, el, context.source, component);
    el.querySelectorAll("img,image,use,iframe,video,audio,object,script,style,link").forEach((node) => node.remove());
    const body = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    body.setAttribute("style", `font:20px/1.4 sans-serif;color:#25221d;position:absolute;left:${16 - note.scrollX}px;top:${16 - note.scrollY}px;width:${Math.max(60, note.textWidth ?? note.width * note.boardPageWidth - 32)}px`);
    body.append(...Array.from(el.childNodes));
    body.querySelectorAll("*").forEach((node) => {
      for (const attr of Array.from(node.attributes)) if (attr.name !== "href" || node.tagName.toLowerCase() !== "a") node.removeAttribute(attr.name);
      if (node.tagName.toLowerCase() === "p") node.setAttribute("style", "margin:0 0 12px");
      if (/^h[1-6]$/i.test(node.tagName)) {
        const sizes = [2, 1.5, 1.17, 1, .83, .67];
        node.setAttribute("style", `font-size:${sizes[Number(node.tagName.slice(1)) - 1]}em;line-height:1.4;margin:0 0 12px;font-weight:700`);
      }
      if (node.tagName.toLowerCase() === "a") node.setAttribute("style", "color:#2459a6;text-decoration:underline");
    });
    const wrapper = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    wrapper.setAttribute("style", `position:relative;overflow:hidden;width:${viewportWidth}px;height:${viewportHeight}px`); wrapper.append(body);
    const width = Math.max(1, viewportWidth), height = Math.max(1, viewportHeight);
    const xml = new XMLSerializer().serializeToString(wrapper);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Sticky Markdown snapshot timed out")), 5000);
      img.onload = () => { clearTimeout(timer); resolve(); };
      img.onerror = () => { clearTimeout(timer); reject(new Error("Could not render sticky Markdown")); };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    });
    return img;
  } finally { component.unload(); }
}

export function stickyTextLines(text: string): string[] { return text.replace(/\r/g, "").split("\n"); }

/** Paint only the viewport. Changing its dimensions never changes stored content. */
export function paintStickyBoard(ctx: CanvasRenderingContext2D, note: StickyNote, width: number, height: number, scale = 1, background = true): void {
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  // The DOM already owns the paper and Markdown below this ink canvas.
  // Snapshots still paint their own opaque paper by default.
  if (background) { ctx.fillStyle = note.color; ctx.fillRect(0, 0, width, height); }
  else ctx.clearRect(0, 0, width, height);
  ctx.scale(scale, scale); ctx.translate(-note.scrollX, -note.scrollY);
  ctx.fillStyle = "#202020"; ctx.font = "20px sans-serif"; ctx.textBaseline = "top";
  const lines = stickyTextLines(note.text);
  const first = Math.max(0, Math.floor((note.scrollY - 16) / 28));
  for (let index = first; index < Math.min(lines.length, first + Math.ceil(height / scale / 28) + 2); index++) ctx.fillText(lines[index], 16, 16 + index * 28);
  for (const stroke of note.strokes) drawInkStroke(ctx, stroke, STICKY_UNIT, STICKY_UNIT);
  ctx.restore();
}

export function stickyFrameHeight(note: StickyNote, pageWidth: number, pageHeight: number): number {
  return note.collapsed ? (note.preview ? 100 : STICKY_HEADER) * pageWidth / note.boardPageWidth : note.height * pageHeight;
}
export function stickyFrameWidth(note: StickyNote, pageWidth: number): number {
  return note.collapsed ? Math.min(note.width * pageWidth, 180 * pageWidth / note.boardPageWidth) : note.width * pageWidth;
}

export function paintStickyFrame(ctx: CanvasRenderingContext2D, note: StickyNote, pageWidth: number, pageHeight: number): void {
  const width = stickyFrameWidth(note, pageWidth), height = stickyFrameHeight(note, pageWidth, pageHeight), scale = pageWidth / note.boardPageWidth;
  ctx.save(); ctx.translate(note.x * pageWidth, note.y * pageHeight);
  ctx.fillStyle = note.color; ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#202020"; ctx.font = `bold ${16 * scale}px sans-serif`; ctx.textBaseline = "top";
  ctx.fillText(note.title || "Sticky note", 8 * scale, 8 * scale, Math.max(1, width - 16 * scale));
  if (!note.collapsed || note.preview) {
    ctx.translate(0, STICKY_HEADER * scale); paintStickyBoard(ctx, note, width, Math.max(1, height - STICKY_HEADER * scale), scale);
  }
  ctx.restore();
}

export function paintPageStickies(ctx: CanvasRenderingContext2D, notes: StickyNote[] | undefined, pageWidth: number, pageHeight: number): void {
  for (const note of notes ?? []) paintStickyFrame(ctx, note, pageWidth, pageHeight);
}

export async function stickyPng(note: StickyNote, pageWidth: number, pageHeight: number, markdown?: StickyMarkdownContext): Promise<ArrayBuffer> {
  const width = stickyFrameWidth(note, pageWidth), height = stickyFrameHeight(note, pageWidth, pageHeight);
  const scale = Math.min(2, 4096 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale));
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Sticky note rendering is unavailable");
  ctx.scale(scale, scale); paintStickyFrame(ctx, { ...note, x: 0, y: 0, text: markdown ? "" : note.text,
    strokes: markdown && note.text && (!note.collapsed || note.preview) ? [] : note.strokes }, pageWidth, pageHeight);
  if (markdown && note.text && (!note.collapsed || note.preview)) {
    const boardScale = pageWidth / note.boardPageWidth;
    const img = await markdownImage(note, markdown, width / boardScale, Math.max(1, height / boardScale - STICKY_HEADER));
    ctx.save(); ctx.beginPath(); ctx.rect(0, STICKY_HEADER * boardScale, width, height - STICKY_HEADER * boardScale); ctx.clip();
    ctx.drawImage(img, 0, STICKY_HEADER * boardScale, img.width * boardScale, img.height * boardScale);
    ctx.scale(boardScale, boardScale); ctx.translate(0, STICKY_HEADER); ctx.translate(-note.scrollX, -note.scrollY);
    for (const stroke of note.strokes) drawInkStroke(ctx, stroke, STICKY_UNIT, STICKY_UNIT);
    ctx.restore();
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not render sticky note")), "image/png"));
  return blob.arrayBuffer();
}
