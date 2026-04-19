#!/usr/bin/env node
/**
 * scripts/ah-api.mjs — canonical user-facing wrapper for the Agent Hub API.
 *
 * Node-based (not bash) because Electron end-users on Windows won't have
 * bash on PATH. See the wiki page "Scripts Layer — Node CLI Convention"
 * for the decision record.
 *
 * Invocation:
 *   ./scripts/ah-api.mjs GET  /api/health
 *   ./scripts/ah-api.mjs GET  /api/projects/agent-hub/board
 *   ./scripts/ah-api.mjs POST /api/projects/agent-hub/board/cards \
 *     --body '{"title":"Triage incoming PRs"}'
 *
 * Exit codes:
 *   0   success (HTTP 2xx)
 *   1   HTTP non-2xx (response body is still printed to stdout)
 *   2   bad invocation / usage error
 *   3   transport failure (connection refused, DNS, etc.)
 */

import { pathToFileURL } from 'node:url';
import { callApi, parseArgs, USAGE } from './lib/ah-api-core.mjs';

/**
 * Main entry. Exported for tests — they invoke it with injected argv + a
 * mock fetch so we don't need to spawn a subprocess.
 *
 * @param {object} opts
 * @param {string[]} opts.argv
 * @param {NodeJS.WriteStream | { write(chunk: string): unknown }} opts.stdout
 * @param {NodeJS.WriteStream | { write(chunk: string): unknown }} opts.stderr
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<number>}  exit code
 */
export async function main({ argv, stdout, stderr, fetchImpl }) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n`);
    stderr.write(USAGE);
    return 2;
  }

  let result;
  try {
    result = await callApi({
      method: parsed.method,
      path: parsed.path,
      body: parsed.body,
      fetchImpl,
    });
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
    stderr.write(`error: request failed: ${msg}\n`);
    return 3;
  }

  // Pretty-print JSON so humans can read the output; fall back to raw text
  // for non-JSON bodies.
  if (typeof result.body === 'string') {
    stdout.write(result.body);
    if (!result.body.endsWith('\n')) stdout.write('\n');
  } else {
    stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
  }
  return result.ok ? 0 : 1;
}

// Only run main() when executed directly, not when imported by tests.
// pathToFileURL handles Windows drive-letter paths (C:\...) correctly,
// unlike manual `file://` concatenation which misparses the authority.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main({
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
  }).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
      process.exit(3);
    },
  );
}
