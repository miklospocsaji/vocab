// Soft hyphen, zero-width space, ZWNJ, ZWJ, byte order mark.
const INVISIBLE = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0xfeff]);

export function cleanUsage(sentence: string): string {
  let visible = "";
  for (const char of sentence) {
    if (!INVISIBLE.has(char.codePointAt(0) ?? -1)) visible += char;
  }
  return visible.replace(/\s+/g, " ").trim();
}
