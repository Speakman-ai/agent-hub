/**
 * pkt-line.ts — minimal pkt-line encoding for the git smart-HTTP protocol.
 *
 * The smart-HTTP ref advertisement (`GET /info/refs?service=…`) must begin
 * with a pkt-line announcing the service, followed by a flush packet,
 * before the raw `--advertise-refs` output is streamed. This module holds
 * only the encoding side — Agent Hub never needs to *parse* pkt-lines
 * because request/response payloads are piped verbatim between the HTTP
 * socket and the spawned `git upload-pack` / `git receive-pack` process.
 *
 * Format (gitprotocol-common(5)): each pkt-line is a 4-digit lower-case
 * hex length prefix counting the prefix itself plus the payload, followed
 * by the payload. A length of "0000" is the flush packet and carries no
 * payload.
 */

/** Flush packet — terminates a pkt-line section. */
export const FLUSH_PKT = '0000';

/** Maximum payload bytes for one pkt-line (65520 total - 4 prefix). */
const MAX_PAYLOAD_BYTES = 65516;

/**
 * Encode one pkt-line: 4 hex digits of (payload byte length + 4) followed
 * by the payload. The payload is measured in bytes, not JS string length,
 * so multi-byte UTF-8 stays correct.
 */
export function pktLine(payload: string): string {
  const byteLength = Buffer.byteLength(payload, 'utf8');
  if (byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`pktLine: payload exceeds ${MAX_PAYLOAD_BYTES} bytes (${byteLength})`);
  }
  const length = (byteLength + 4).toString(16).padStart(4, '0');
  return `${length}${payload}`;
}

/**
 * The preamble written before `--advertise-refs` output on
 * `GET /git/<repo>/info/refs?service=<service>`:
 *
 *   001e# service=git-upload-pack\n0000
 *
 * Smart clients require the `# service=` line and the flush packet before
 * the actual ref advertisement (gitprotocol-http(5)).
 */
export function serviceAdvertisementPreamble(
  service: 'git-upload-pack' | 'git-receive-pack',
): string {
  return pktLine(`# service=${service}\n`) + FLUSH_PKT;
}
