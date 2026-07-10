export interface MxfSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export type MxfSourceInput = MxfSource | Uint8Array | ArrayBuffer | Blob;

export class MxfBufferSource implements MxfSource {
  readonly size: number;
  private readonly bytes: Uint8Array;

  constructor(input: Uint8Array | ArrayBuffer) {
    this.bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.size = this.bytes.byteLength;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    validateRange(offset, length, this.size);
    return this.bytes.subarray(offset, offset + length);
  }
}

export class MxfBlobSource implements MxfSource {
  readonly size: number;

  constructor(private readonly blob: Blob) {
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    validateRange(offset, length, this.size);
    return new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
  }
}

export function toMxfSource(input: MxfSourceInput): MxfSource {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    return new MxfBufferSource(input);
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new MxfBlobSource(input);
  }
  if (isMxfSource(input)) {
    return input;
  }
  throw new TypeError("MXF input must be a Uint8Array, ArrayBuffer, Blob, or MxfSource.");
}

function isMxfSource(input: MxfSourceInput): input is MxfSource {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as MxfSource).size === "number" &&
    typeof (input as MxfSource).read === "function"
  );
}

function validateRange(offset: number, length: number, size: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size) {
    throw new RangeError(`MXF source range ${offset}+${length} is outside 0-${size}.`);
  }
}
