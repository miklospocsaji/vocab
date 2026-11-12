/** The most a check's output may hold in `gates.json`: 16 KB, in UTF-8 bytes. */
export const OUTPUT_LIMIT = 16 * 1024;

/** Secrets shorter than this are not replaced: they would match ordinary text. */
const MIN_SECRET_LENGTH = 8;

/** Replaces each secret of at least 8 characters with `[redacted]`, everywhere in `text`. */
export function redact(text: string, secrets: readonly string[]): string {
  // Longest first, so a secret that contains another is replaced whole.
  const long = secrets.filter((secret) => secret.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
  return long.reduce((result, secret) => result.split(secret).join("[redacted]"), text);
}

/** Keeps the end of `text`, at most `limit` UTF-8 bytes, cut at a line start where there is one. */
export function boundOutput(text: string, limit: number = OUTPUT_LIMIT): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  let start = bytes.length - limit;
  if (bytes[start - 1] !== 0x0a) {
    const newline = bytes.indexOf(0x0a, start);
    // Cut after the next newline, unless the kept part is one unfinished line.
    if (newline !== -1 && newline + 1 < bytes.length) start = newline + 1;
    // Never start inside a multi-byte character.
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
  }
  return bytes.subarray(start).toString("utf8");
}
