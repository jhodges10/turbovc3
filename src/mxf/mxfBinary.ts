export function readU16BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

export function readU32BE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

export function readI64BE(bytes: Uint8Array, offset: number): number {
  const value = readU64BE(bytes, offset);
  return value >= 0x8000000000000000n ? safeNumber(value - 0x10000000000000000n) : safeNumber(value);
}

export function readU64BE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  return value;
}

export function safeNumber(value: bigint): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new RangeError(`MXF integer ${value} exceeds JavaScript's safe integer range.`);
  }
  return numberValue;
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function signedByte(value: number): number {
  return value > 127 ? value - 256 : value;
}

export function utf16Be(bytes: Uint8Array): string {
  let result = "";
  for (let offset = 0; offset + 1 < bytes.length; offset += 2) {
    const code = readU16BE(bytes, offset);
    if (code !== 0) {
      result += String.fromCharCode(code);
    }
  }
  return result;
}
