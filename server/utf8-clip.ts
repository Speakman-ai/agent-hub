/**
 * Clip a UTF-8 string to a maximum byte length without splitting a codepoint
 * (avoids replacement characters from `Buffer.subarray` + `toString`).
 */
export function clipUtf8StringToMaxBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf-8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0) {
    const chunk = buf.subarray(0, end);
    const decoded = chunk.toString('utf-8');
    const roundTrip = Buffer.from(decoded, 'utf-8');
    if (roundTrip.length === chunk.length && roundTrip.equals(chunk)) {
      return decoded;
    }
    end -= 1;
  }
  return '';
}
