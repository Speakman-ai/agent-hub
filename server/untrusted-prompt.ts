/**
 * Neutralization for attacker-controlled text embedded inside an untrusted-data
 * fence in an agent prompt.
 *
 * This is the shared core of the support-ticket investigation fence
 * (`escapeTicketUntrusted`) and the customer-log context pack
 * (`escapeLogUntrusted`): both take content from an untrusted source and must
 * guarantee it renders as inert data, never as instructions. Keeping one
 * implementation means a fix to the neutralization (a new control byte, a new
 * fence-forgery shape) lands for every prompt surface at once.
 */

// ESC (0x1b) and BEL (0x07) via char codes so the source carries no literal
// control bytes and no `\u` escapes (which some editors mangle).
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// Complete ANSI escape sequences, stripped as a unit so removing the lone ESC
// byte can't leave a `[31m` parameter tail behind. Order of alternatives:
//  1. OSC: ESC ] ... terminated by BEL or ST (ESC backslash)
//  2. DCS/SOS/PM/APC: ESC (P|X|^|_) ... terminated by ST
//  3. CSI: ESC [ params intermediates final-byte
//  4. any other two-char Fe escape: ESC 0x40-0x5f
const ANSI_SEQUENCES = new RegExp(
  `${ESC}\\][\\s\\S]*?(?:${BEL}|${ESC}\\\\)` +
    `|${ESC}[P^_X][\\s\\S]*?${ESC}\\\\` +
    `|${ESC}\\[[0-?]*[ -\\/]*[@-~]` +
    `|${ESC}[@-_]`,
  'g',
);

/**
 * Remove complete ANSI escape sequences (OSC / DCS-family / CSI / two-char Fe)
 * as whole units. Shared so every neutralization path strips the same set and a
 * lone ESC byte is never left behind as a `[31m` parameter tail.
 */
export function stripAnsiSequences(input: string): string {
  return input.replace(ANSI_SEQUENCES, '');
}

/**
 * Strip C0 control characters (0x00-0x1f) except TAB (0x09) and LF (0x0a), plus
 * DEL (0x7f). Runs after the ANSI pass, so a bare/unterminated ESC left behind
 * is still removed here. Codepoint comparison keeps the source free of literal
 * control bytes.
 */
function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const c = ch.codePointAt(0) as number;
    if (c === 0x09 || c === 0x0a) {
      out += ch; // keep TAB / LF
    } else if (c <= 0x1f || c === 0x7f) {
      continue; // drop remaining C0 controls + DEL
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Neutralize a single untrusted field before it goes between BEGIN/END fence
 * markers: normalize newlines, strip complete ANSI escape sequences, strip
 * remaining ASCII control characters (TAB and LF survive), and defang any line
 * that tries to forge a `----- BEGIN/END … -----` fence marker by replacing its
 * dashes with a middot. Trims surrounding whitespace. Null/undefined collapse to
 * an empty string.
 */
export function escapeUntrustedForPrompt(value: string | null | undefined): string {
  if (!value) return '';
  const normalized = stripAnsiSequences(value.replace(/\r\n?/g, '\n'));
  return stripControlChars(normalized)
    .replace(/-{3,}[ \t]*(?:BEGIN|END)\b/gi, (marker) => marker.replace(/-/g, '·'))
    .trim();
}
