declare module "pako" {
  export function gzip(data: string, options?: { level?: number }): Uint8Array;
  export class Inflate {
    constructor(options?: { chunkSize?: number });
    onData: (chunk: Uint8Array) => void;
    push(data: Uint8Array, final: boolean): boolean;
    err: number;
    msg: string;
    ended: boolean;
    strm: { avail_in: number };
  }
}
