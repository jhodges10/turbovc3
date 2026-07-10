export interface AsciiMatch { needle: string; offset: number }
export interface FindAsciiOptions { start?: number; limit?: number }

export function extensionOf(filename?: string): string {
  if (!filename) return "";
  const lastDot = filename.lastIndexOf(".");
  return lastDot === -1 ? "" : filename.slice(lastDot).toLowerCase();
}

export function hasExtension(filename: string | undefined, extensions: readonly string[]): boolean {
  const extension = extensionOf(filename);
  return extensions.some((candidate) => candidate.toLowerCase() === extension);
}

export function findAscii(bytes: Uint8Array, needles: readonly string[], options: FindAsciiOptions = {}): AsciiMatch[] {
  const encoder = new TextEncoder();
  const matches: AsciiMatch[] = [];
  const start = Math.max(0, options.start ?? 0);
  const limit = Math.min(bytes.length, options.limit ?? bytes.length);
  for (const needle of needles) {
    const candidate = encoder.encode(needle);
    for (let offset = start; offset <= limit - candidate.length; offset += 1) {
      if (candidate.every((value, index) => bytes[offset + index] === value)) matches.push({ needle, offset });
    }
  }
  return matches.sort((left, right) => left.offset - right.offset);
}
