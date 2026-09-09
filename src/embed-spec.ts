import { INK_FOLDER } from "./storage";

export interface InkEmbedSpec { path: string; pageId?: string }

export function parseInkEmbed(source: string): InkEmbedSpec {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const path = lines[0] ?? "";
  if (!path.startsWith(`${INK_FOLDER}/`) || !path.toLowerCase().endsWith(".ink") || path.includes("..")) {
    throw new Error(`Ink path must be a .ink file inside ${INK_FOLDER}/`);
  }
  if (lines.length > 2 || (lines[1] && !/^page:\s*\S+$/i.test(lines[1]))) {
    throw new Error("Optional second line must use: page: <page-id>");
  }
  return { path, pageId: lines[1]?.replace(/^page:\s*/i, "") };
}
