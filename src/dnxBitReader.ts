export class DnxBitReader {
  private bitOffset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get bitsRead(): number {
    return this.bitOffset;
  }

  get byteOffset(): number {
    return Math.floor(this.bitOffset / 8);
  }

  get bitsRemaining(): number {
    return this.bytes.length * 8 - this.bitOffset;
  }

  readBits(count: number): number | null {
    const value = this.peekBits(count);
    if (value === null) {
      return null;
    }

    this.bitOffset += count;
    return value;
  }

  peekBits(count: number): number | null {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new RangeError("count must be an integer between 0 and 32.");
    }
    if (count > this.bitsRemaining) {
      return null;
    }
    if (count === 0) {
      return 0;
    }
    if (count <= 16 && this.bitsRemaining >= 16) {
      const prefix = this.peek16();
      return prefix === null ? null : prefix >>> (16 - count);
    }

    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const absoluteBit = this.bitOffset + index;
      const byte = this.bytes[absoluteBit >> 3];
      const bit = (byte >> (7 - (absoluteBit & 7))) & 1;
      value = value * 2 + bit;
    }

    return value;
  }

  peek16(): number | null {
    if (this.bitsRemaining < 16) {
      return null;
    }

    const byteOffset = this.bitOffset >> 3;
    const bitInByte = this.bitOffset & 7;
    const window =
      (this.bytes[byteOffset] << 16) |
      (this.bytes[byteOffset + 1] << 8) |
      (this.bytes[byteOffset + 2] ?? 0);
    return (window >>> (8 - bitInByte)) & 0xffff;
  }

  skipBits(count: number): boolean {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError("count must be a non-negative integer.");
    }
    if (count > this.bitsRemaining) {
      return false;
    }

    this.bitOffset += count;
    return true;
  }

  readSignedBits(count: number): number | null {
    const value = this.readBits(count);
    if (value === null || count === 0) {
      return value;
    }

    const signBit = 1 << (count - 1);
    return value & signBit ? value - (1 << count) : value;
  }
}
