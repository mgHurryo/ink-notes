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
