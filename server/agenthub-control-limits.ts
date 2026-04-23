/**
 * Max UTF-8 bytes for JSON payloads inside host-parsed fenced control blocks
 * (`<agenthub:react>`, `<agenthub:wiki>`, …) before
 * `JSON.parse` — avoids pathological model output tying up the event loop.
 */
export const MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES = 64 * 1024;
