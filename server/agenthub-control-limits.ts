/**
 * Max UTF-8 bytes for JSON payloads inside the small host-parsed control blocks
 * (`<agenthub:wiki>`, orchestration, skill, close-card, …) before `JSON.parse`
 * — avoids pathological model output tying up the event loop. These blocks only
 * ever carry short scalar fields, so a tight cap is safe.
 */
export const MAX_AGENTHUB_CONTROL_BLOCK_JSON_BYTES = 64 * 1024;

/**
 * Max UTF-8 bytes for a `<agenthub:react>` block's JSON body.
 *
 * The react block is the one control block that carries a large payload: the
 * `design` action embeds a full HTML document (up to `MAX_DESIGN_HTML_BYTES` =
 * 512 KB, validated per-action in chat.ts) as a JSON string. JSON-encoding a
 * printable HTML document up to ~doubles its byte length (each `"`, `\`, and
 * newline/tab expands to a two-byte escape), so the block cap must clear twice
 * the design HTML budget plus room for the `{"actions":[…]}` wrapper — otherwise
 * a large-but-valid design render is rejected as "byte cap" *before* per-action
 * validation ever runs, and the user just sees the turn error out. Kept as a
 * standalone number (not derived from MAX_DESIGN_HTML_BYTES) to avoid importing
 * the Chromium-backed design module into this leaf limits file; the invariant
 * `MAX_REACT_CONTROL_BLOCK_JSON_BYTES >= 2 * MAX_DESIGN_HTML_BYTES` is asserted
 * in test. 1 MB of JSON.parse is trivial for the event loop.
 */
export const MAX_REACT_CONTROL_BLOCK_JSON_BYTES = 1024 * 1024 + 64 * 1024;
