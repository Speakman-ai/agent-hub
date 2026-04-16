/**
 * Reject uploads that are native executables / shared libraries / JVM bytecode,
 * while allowing normal documents, media, archives, text, etc.
 */

const REJECTED_MIME_EXACT = new Set([
  'application/x-executable',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/x-elf',
  'application/x-mach-binary',
  'application/x-mach-binary-64',
  'application/x-sharedlib',
  'application/x-shared-library',
  'application/vnd.microsoft.portable-executable',
  'application/x-sharedlib-amd64',
]);

const REJECTED_MIME_PREFIXES = ['application/x-executable'];

function normalizeMime(ct: string): string {
  return ct.split(';')[0]?.trim().toLowerCase() || '';
}

export function mimeLooksExecutable(contentType: string): boolean {
  const t = normalizeMime(contentType);
  if (!t) return false;
  if (REJECTED_MIME_EXACT.has(t)) return true;
  for (const p of REJECTED_MIME_PREFIXES) {
    if (t.startsWith(p)) return true;
  }
  return false;
}

function looksLikeElf(buf: Buffer): boolean {
  return (
    buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46
  );
}

function looksLikePe(buf: Buffer): boolean {
  if (buf.length < 0x40 || buf[0] !== 0x4d || buf[1] !== 0x5a) return false;
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 4 > buf.length) return false;
  return (
    buf[peOffset] === 0x50 &&
    buf[peOffset + 1] === 0x45 &&
    buf[peOffset + 2] === 0 &&
    buf[peOffset + 3] === 0
  );
}

/** Thin Mach-O magics (both endiannesses as stored on disk). */
const THIN_MACHO = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe]);

/** Fat binary magics (need disambiguation from Java .class). */
const FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function isProbablyFatMachOOrJavaClass(buf: Buffer): boolean {
  if (buf.length < 8) return true;
  const nfatOrJavaPrefix = buf.readUInt32BE(4);
  if (nfatOrJavaPrefix >= 1 && nfatOrJavaPrefix <= 32) return true;
  const major = buf.readUInt16BE(6);
  return major >= 45 && major <= 80;
}

export function bufferLooksLikeExecutableBinary(buf: Buffer): boolean {
  if (!buf || buf.length < 4) return false;
  if (looksLikeElf(buf)) return true;
  if (looksLikePe(buf)) return true;

  const be = buf.readUInt32BE(0);
  const le = buf.readUInt32LE(0);
  if (THIN_MACHO.has(be) || THIN_MACHO.has(le)) return true;

  if (FAT_MAGICS.has(be) || FAT_MAGICS.has(le)) {
    return isProbablyFatMachOOrJavaClass(buf);
  }

  return false;
}

/**
 * Returns an error message if the upload should be rejected, or null if allowed.
 */
export function validateUploadContent(contentType: string, buf: Buffer): string | null {
  if (mimeLooksExecutable(contentType)) {
    return 'Executable or system-binary MIME type is not allowed';
  }
  if (bufferLooksLikeExecutableBinary(buf)) {
    return 'File appears to be an executable or native binary';
  }
  return null;
}
