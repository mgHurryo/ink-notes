import type { StickyNote } from "./sticky-model";
import { STICKY_HEADER } from "./sticky-ink";
import { STICKY_UNIT, stickyPosition, stickyTextBoxes, stickyText, stickyFont, stickyFontSize } from "./sticky-model";
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
    for (const box of stickyTextBoxes(note)) {
      if (!box.text) continue;
      const frame = document.createElement("div"), content = document.createElement("div");
      frame.setAttribute("style", `position:absolute;left:${box.x - note.scrollX}px;top:${box.y - note.scrollY}px;width:${box.width}px;font:${stickyFont(box, true)};${box.height === undefined ? "" : `height:${box.height}px;overflow:hidden;`}`);
      await MarkdownRenderer.render(context.app, box.text, content, context.source, component);
      frame.append(content); el.append(frame);
    }
    el.querySelectorAll("img,image,use,iframe,video,audio,object,script,style,link").forEach((node) => node.remove());
    const body = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    body.setAttribute("style", "font:20px/1.4 sans-serif;color:#25221d;position:relative;");
    body.append(...Array.from(el.childNodes));
    body.querySelectorAll("*").forEach((node) => {
      for (const attr of Array.from(node.attributes)) if (!(attr.name === "style" && node.parentElement === body) && (attr.name !== "href" || node.tagName.toLowerCase() !== "a")) node.removeAttribute(attr.name);
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
export function paintStickyBoard(ctx: CanvasRenderingContext2D, note: StickyNote, width: number, height: number, scale = 1, background: boolean | "transparent" = true): void {
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, width, height); ctx.clip();
  // The DOM already owns the paper and Markdown below this ink canvas.
  // Snapshots still paint their own opaque paper by default.
  if (background === true) { ctx.fillStyle = note.color; ctx.fillRect(0, 0, width, height); }
  else if (background === false) ctx.clearRect(0, 0, width, height);
  ctx.scale(scale, scale); ctx.translate(-note.scrollX, -note.scrollY);
  ctx.fillStyle = "#202020"; ctx.font = "20px sans-serif"; ctx.textBaseline = "top";
  for (const box of stickyTextBoxes(note)) {
    if (!box.text) continue;
    ctx.font = stickyFont(box);
    const lineHeight = stickyFontSize(box.fontSize) * 1.4;
    const lines: string[] = [];
    for (const paragraph of stickyTextLines(box.text)) {
      let line = "";
      for (const char of paragraph) {
        if (line && ctx.measureText(line + char).width > box.width) { lines.push(line); line = ""; }
        line += char;
      }
      lines.push(line);
    }
    const first = Math.max(0, Math.floor((note.scrollY - box.y) / lineHeight));
    if (first >= lines.length) continue;
    ctx.save();
    if (box.height !== undefined) { ctx.beginPath(); ctx.rect(box.x, box.y, box.width, box.height); ctx.clip(); }
    for (let index = first; index < Math.min(lines.length, first + Math.ceil(height / scale / lineHeight) + 2); index++) ctx.fillText(lines[index], box.x, box.y + index * lineHeight);
    ctx.restore();
  }
  for (const stroke of note.strokes) drawInkStroke(ctx, stroke, STICKY_UNIT, STICKY_UNIT);
  ctx.restore();
}

export function stickyFrameHeight(note: StickyNote, pageWidth: number, pageHeight: number): number {
  return note.collapsed ? 80 * pageWidth / note.boardPageWidth : note.height * pageHeight;
}
export function stickyFrameWidth(note: StickyNote, pageWidth: number): number {
  return note.collapsed ? 80 * pageWidth / note.boardPageWidth : note.width * pageWidth;
}

/** The folded icon previews the same board viewport without mutating content. */
export function paintStickyIcon(ctx: CanvasRenderingContext2D, note: StickyNote, width: number, height: number, pageAspect: number): void {
  ctx.save(); ctx.fillStyle = note.color; ctx.fillRect(0, 0, width, height);
  if (note.preview && (stickyText(note) || note.strokes.length)) {
    const boardWidth = note.width * note.boardPageWidth;
    const boardHeight = Math.max(1, note.height * note.boardPageWidth * pageAspect - STICKY_HEADER);
    const scale = Math.min((width - width * .15) / boardWidth, (height - height * .15) / boardHeight);
    ctx.translate((width - boardWidth * scale) / 2, (height - boardHeight * scale) / 2);
    paintStickyBoard(ctx, note, boardWidth * scale, boardHeight * scale, scale);
  } else {
    ctx.strokeStyle = "#25221d"; ctx.lineWidth = width * .035;
    ctx.strokeRect(width * .25, height * .2, width * .5, height * .6);
    for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(width * .35, height * (.35 + i * .13)); ctx.lineTo(width * .65, height * (.35 + i * .13)); ctx.stroke(); }
  }
  ctx.restore();
}

export function paintStickyFrame(ctx: CanvasRenderingContext2D, note: StickyNote, pageWidth: number, pageHeight: number): void {
  const width = stickyFrameWidth(note, pageWidth), height = stickyFrameHeight(note, pageWidth, pageHeight), scale = pageWidth / note.boardPageWidth;
  const { x, y } = stickyPosition(note);
  ctx.save(); ctx.translate(x * pageWidth, y * pageHeight);
  if (note.kind === "text") {
    paintStickyBoard(ctx, note, width, height, scale, "transparent"); ctx.restore(); return;
  }
  if (note.collapsed) { paintStickyIcon(ctx, note, width, height, pageHeight / pageWidth); ctx.restore(); return; }
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
  ctx.scale(scale, scale); paintStickyFrame(ctx, { ...note, x: 0, y: 0, text: markdown && !note.collapsed ? "" : note.text,
    textBoxes: markdown && !note.collapsed ? [] : note.textBoxes,
    strokes: markdown && stickyText(note) && !note.collapsed ? [] : note.strokes }, pageWidth, pageHeight);
  if (markdown && stickyText(note) && !note.collapsed) {
    const boardScale = pageWidth / note.boardPageWidth;
    const header = note.kind === "text" ? 0 : STICKY_HEADER;
    const img = await markdownImage(note, markdown, width / boardScale, Math.max(1, height / boardScale - header));
    ctx.save(); ctx.beginPath(); ctx.rect(0, header * boardScale, width, height - header * boardScale); ctx.clip();
    ctx.drawImage(img, 0, header * boardScale, img.width * boardScale, img.height * boardScale);
    ctx.scale(boardScale, boardScale); ctx.translate(0, header); ctx.translate(-note.scrollX, -note.scrollY);
    for (const stroke of note.strokes) drawInkStroke(ctx, stroke, STICKY_UNIT, STICKY_UNIT);
    ctx.restore();
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not render sticky note")), "image/png"));
  return blob.arrayBuffer();
}
