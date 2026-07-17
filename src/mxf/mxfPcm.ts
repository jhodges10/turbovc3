import type { MxfDescriptor } from "./mxfTypes.js";

export interface MxfPcmLayout {
  validBitsPerSample: number;
  storedBitsPerSample: 16 | 24 | 32;
  bytesPerSample: 2 | 3 | 4;
}

export function resolveMxfPcmLayout(descriptor: MxfDescriptor | null): MxfPcmLayout | null {
  const validBitsPerSample = descriptor?.bitsPerSample;
  const storedBitsPerSample = descriptor?.storedBitsPerSample ?? validBitsPerSample;
  if (
    !validBitsPerSample ||
    !storedBitsPerSample ||
    (storedBitsPerSample !== 16 && storedBitsPerSample !== 24 && storedBitsPerSample !== 32) ||
    validBitsPerSample < 1 ||
    validBitsPerSample > storedBitsPerSample
  ) {
    return null;
  }
  return {
    validBitsPerSample,
    storedBitsPerSample,
    bytesPerSample: storedBitsPerSample / 8 as 2 | 3 | 4
  };
}

export function readMxfPcmSample(
  view: DataView,
  offset: number,
  layout: MxfPcmLayout
): number {
  let signed: number;
  if (layout.storedBitsPerSample === 16) {
    signed = view.getInt16(offset, true);
  } else if (layout.storedBitsPerSample === 24) {
    const value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    signed = (value & 0x800000) ? value - 0x1000000 : value;
  } else {
    signed = view.getInt32(offset, true);
  }
  const paddingBits = layout.storedBitsPerSample - layout.validBitsPerSample;
  const validSample = paddingBits === 0 ? signed : signed >> paddingBits;
  return validSample / 2 ** (layout.validBitsPerSample - 1);
}
