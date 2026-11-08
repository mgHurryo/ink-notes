import { gzip, Inflate } from "pako";

// Non-JSON magic deliberately makes old readers refuse the file instead of
// normalizing an unfamiliar JSON wrapper into an empty, writable notebook.
const MAGIC = "INK-GZIP-1\n";
const MIN_COMPRESS_LENGTH = 1024;
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

/** Disk only: preserve JSON's exact sample/number representation through gzip. */
export function serializeStoredJson(value: unknown): string {
  const plain = `${JSON.stringify(value)}\n`;
  if (plain.length < MIN_COMPRESS_LENGTH) return plain;
  const bytes = new TextEncoder().encode(plain);
  // Keep very large legacy documents readable without exceeding decoder bounds.
  if (bytes.length > MAX_INFLATED_BYTES) return plain;
  const compressed = gzip(plain, { level: 6 });
  // Base64 supports the Vault's atomic text/CAS API on mobile and desktop.
  let binary = "";
  for (let offset = 0; offset < compressed.length; offset += 8192)
    binary += String.fromCharCode(...compressed.subarray(offset, offset + 8192));
  const encoded = `${MAGIC}${btoa(binary)}\n`;
  return encoded.length < bytes.length ? encoded : plain;
}

/** Accept legacy JSON as-is; corrupt/unknown encodings must block writes. */
export function parseStoredJson(raw: string): any {
  if (!raw.startsWith(MAGIC)) return JSON.parse(raw);
  try {
    const base64 = raw.slice(MAGIC.length).trim();
    if (!base64 || base64.length > Math.ceil(MAX_INFLATED_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid base64");
    const binary = atob(base64), data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
    if (data.length < 18 || data[0] !== 31 || data[1] !== 139 || data[2] !== 8) throw new Error("Invalid gzip header");
    if (new DataView(data.buffer).getUint32(data.length - 4, true) > MAX_INFLATED_BYTES) throw new Error("Notebook exceeds 256 MiB decompression limit");
    const chunks: Uint8Array[] = []; let size = 0;
    const inflate = new Inflate({ chunkSize: 65536 });
    inflate.onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_INFLATED_BYTES) throw new Error("Notebook exceeds 256 MiB decompression limit");
      chunks.push(chunk);
    };
    // pako 1.x's forced finish accepts a missing gzip footer. Let the stream
    // itself finish and require its checksum/length trailer to be consumed.
    if (!inflate.push(data, false) || inflate.err || !inflate.ended || inflate.strm.avail_in !== 0) throw new Error(inflate.msg || "Incomplete or trailing gzip data");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new SyntaxError(`Invalid compressed Ink Notes file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

type ProgressiveOpenPreview = (notebook: unknown, parsedStrokes: number) => boolean | void | Promise<boolean | void>;

/** Parse large notebook files without keeping the UI thread in one JSON.parse task. */
export async function parseStoredJsonProgressively(raw: string, onPreview: ProgressiveOpenPreview,
  isCancelled: () => boolean = () => false): Promise<unknown> {
  const json = raw.startsWith(MAGIC) ? await inflateStoredJsonProgressively(raw, isCancelled) : raw;
  const first = skipWhitespace(json, 0);
  if (json[first] !== "{") return JSON.parse(json);
  return parseNotebookObject(json, first, onPreview, isCancelled);
}

async function inflateStoredJsonProgressively(raw: string, isCancelled: () => boolean): Promise<string> {
  try {
    const base64 = raw.slice(MAGIC.length).trim();
    if (!base64 || base64.length > Math.ceil(MAX_INFLATED_BYTES / 3) * 4 || base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid base64");
    const binary = atob(base64), data = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index);
    if (data.length < 18 || data[0] !== 31 || data[1] !== 139 || data[2] !== 8) throw new Error("Invalid gzip header");
    if (new DataView(data.buffer).getUint32(data.length - 4, true) > MAX_INFLATED_BYTES)
      throw new Error("Notebook exceeds 256 MiB decompression limit");

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text: string[] = [];
    let size = 0;
    const inflate = new Inflate({ chunkSize: 65536 });
    inflate.onData = (chunk) => {
      size += chunk.length;
      if (size > MAX_INFLATED_BYTES) throw new Error("Notebook exceeds 256 MiB decompression limit");
      text.push(decoder.decode(chunk, { stream: true }));
    };
    let sliceStarted = performance.now();
    for (let offset = 0; offset < data.length; offset += 16_384) {
      if (isCancelled()) throw new ProgressiveParseCancelled();
      const end = Math.min(data.length, offset + 16_384);
      if (!inflate.push(data.subarray(offset, end), false) || inflate.err) throw new Error(inflate.msg || "Invalid gzip data");
      if (performance.now() - sliceStarted >= 4) {
        await yieldToBrowser();
        sliceStarted = performance.now();
      }
    }
    if (!inflate.ended || inflate.strm.avail_in !== 0) throw new Error(inflate.msg || "Incomplete or trailing gzip data");
    text.push(decoder.decode());
    return text.join("");
  } catch (error) {
    if (error instanceof ProgressiveParseCancelled) throw error;
    throw new SyntaxError(`Invalid compressed Ink Notes file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

class ProgressiveParseCancelled extends Error {}

async function parseNotebookObject(json: string, start: number, onPreview: ProgressiveOpenPreview,
  isCancelled: () => boolean): Promise<unknown> {
  const notebook: Record<string, unknown> = {};
  const end = await parseObjectMembers(json, start, notebook, "notebook", notebook, -1, onPreview, isCancelled);
  const trailing = skipWhitespace(json, end);
  if (trailing !== json.length) throw new SyntaxError("Unexpected content after Ink Notes JSON");
  return notebook;
}

type ObjectKind = "notebook" | "page" | "value";

async function parseObjectMembers(json: string, start: number, target: Record<string, unknown>, kind: ObjectKind,
  notebook: Record<string, unknown>, pageIndex: number, onPreview: ProgressiveOpenPreview,
  isCancelled: () => boolean): Promise<number> {
  if (json[start] !== "{") throw new SyntaxError("Expected JSON object");
  let cursor = skipWhitespace(json, start + 1);
  if (json[cursor] === "}") return cursor + 1;
  while (cursor < json.length) {
    if (isCancelled()) throw new ProgressiveParseCancelled();
    if (json[cursor] !== '"') throw new SyntaxError("Expected JSON object key");
    const keyEnd = await scanStringEnd(json, cursor, isCancelled);
    const key = JSON.parse(json.slice(cursor, keyEnd)) as string;
    cursor = skipWhitespace(json, keyEnd);
    if (json[cursor] !== ":") throw new SyntaxError("Expected colon after JSON object key");
    const valueStart = skipWhitespace(json, cursor + 1);
    let valueEnd: number;
    let value: unknown;
    if (kind === "notebook" && key === "pages" && json[valueStart] === "[") {
      const pages: unknown[] = [];
      target[key] = pages;
      valueEnd = await parsePageArray(json, valueStart, pages, notebook, onPreview, isCancelled);
      value = pages;
    } else if (kind === "page" && key === "strokes" && json[valueStart] === "[") {
      const strokes: unknown[] = [];
      target[key] = strokes;
      valueEnd = await parseStrokeArray(json, valueStart, strokes, target, notebook, pageIndex, onPreview, isCancelled);
      value = strokes;
    } else {
      valueEnd = await scanJsonValueEnd(json, valueStart, isCancelled);
      value = JSON.parse(json.slice(valueStart, valueEnd));
      target[key] = value;
    }
    cursor = skipWhitespace(json, valueEnd);
    if (json[cursor] === "}") return cursor + 1;
    if (json[cursor] !== ",") throw new SyntaxError("Expected comma or closing brace in JSON object");
    cursor = skipWhitespace(json, cursor + 1);
  }
  throw new SyntaxError("Unterminated JSON object");
}

async function parsePageArray(json: string, start: number, pages: unknown[], notebook: Record<string, unknown>,
  onPreview: ProgressiveOpenPreview, isCancelled: () => boolean): Promise<number> {
  let cursor = skipWhitespace(json, start + 1);
  if (json[cursor] === "]") return cursor + 1;
  let pageIndex = 0;
  while (cursor < json.length) {
    if (isCancelled()) throw new ProgressiveParseCancelled();
    let end: number;
    let page: unknown;
    if (json[cursor] === "{") {
      const object: Record<string, unknown> = {};
      pages.push(object);
      end = await parseObjectMembers(json, cursor, object, "page", notebook, pageIndex, onPreview, isCancelled);
      page = object;
    } else {
      end = await scanJsonValueEnd(json, cursor, isCancelled);
      page = JSON.parse(json.slice(cursor, end));
      pages.push(page);
    }
    pageIndex++;
    cursor = skipWhitespace(json, end);
    if (json[cursor] === "]") return cursor + 1;
    if (json[cursor] !== ",") throw new SyntaxError("Expected comma or closing bracket in pages array");
    cursor = skipWhitespace(json, cursor + 1);
  }
  throw new SyntaxError("Unterminated pages array");
}

async function parseStrokeArray(json: string, start: number, strokes: unknown[], page: Record<string, unknown>,
  notebook: Record<string, unknown>, pageIndex: number, onPreview: ProgressiveOpenPreview,
  isCancelled: () => boolean): Promise<number> {
  let cursor = skipWhitespace(json, start + 1);
  if (json[cursor] === "]") return cursor + 1;
  // Keep the first preview deliberately small so low-power devices can show
  // visible ink before parsing and normalizing the rest of a large file.
  let nextPreviewAt = 8;
  let previewComplete = false;
  let sliceStarted = performance.now();
  while (cursor < json.length) {
    if (isCancelled()) throw new ProgressiveParseCancelled();
    const end = await scanJsonValueEnd(json, cursor, isCancelled);
    strokes.push(JSON.parse(json.slice(cursor, end)));
    if (!previewComplete && pageIndex === 0 && strokes.length >= nextPreviewAt && typeof page.id === "string") {
      const partialPage = { ...page, strokes: [...strokes] };
      const partialNotebook = { ...notebook, pages: [partialPage], pageOrder: [page.id] };
      previewComplete = (await onPreview(partialNotebook, strokes.length)) === true;
      nextPreviewAt += 32;
    }
    cursor = skipWhitespace(json, end);
    if (json[cursor] === "]") return cursor + 1;
    if (json[cursor] !== ",") throw new SyntaxError("Expected comma or closing bracket in strokes array");
    cursor = skipWhitespace(json, cursor + 1);
    if (performance.now() - sliceStarted >= 4) {
      await yieldToBrowser();
      sliceStarted = performance.now();
    }
  }
  throw new SyntaxError("Unterminated strokes array");
}

async function scanJsonValueEnd(json: string, start: number, isCancelled: () => boolean): Promise<number> {
  const first = json[start];
  if (first === '"') return scanStringEnd(json, start, isCancelled);
  if (first !== "{" && first !== "[") {
    let end = start;
    while (end < json.length && !/[\s,}\]]/.test(json[end])) end++;
    if (end === start) throw new SyntaxError("Expected JSON value");
    return end;
  }
  const closes: string[] = [first === "{" ? "}" : "]"];
  let inString = false;
  let escaped = false;
  let sliceStarted = performance.now();
  for (let index = start + 1; index < json.length; index++) {
    const char = json[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") closes.push("}");
    else if (char === "[") closes.push("]");
    else if (char === "}" || char === "]") {
      if (closes.pop() !== char) throw new SyntaxError("Mismatched JSON container");
      if (closes.length === 0) return index + 1;
    }
    if ((index & 0x3fff) === 0 && performance.now() - sliceStarted >= 4) {
      if (isCancelled()) throw new ProgressiveParseCancelled();
      await yieldToBrowser();
      sliceStarted = performance.now();
    }
  }
  throw new SyntaxError("Unterminated JSON container");
}

async function scanStringEnd(json: string, start: number, isCancelled: () => boolean): Promise<number> {
  let escaped = false;
  let sliceStarted = performance.now();
  for (let index = start + 1; index < json.length; index++) {
    const char = json[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === '"') return index + 1;
    if ((index & 0x3fff) === 0 && performance.now() - sliceStarted >= 4) {
      if (isCancelled()) throw new ProgressiveParseCancelled();
      await yieldToBrowser();
      sliceStarted = performance.now();
    }
  }
  throw new SyntaxError("Unterminated JSON string");
}

function skipWhitespace(json: string, start: number): number {
  let index = start;
  while (index < json.length && /\s/.test(json[index])) index++;
  return index;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
