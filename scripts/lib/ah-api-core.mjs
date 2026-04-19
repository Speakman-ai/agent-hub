/**
 * scripts/lib/ah-api-core.mjs — pure helpers shared by every user-facing
 * script in scripts/ *and* by server-side code that needs to talk to the
 * local Agent Hub API from the same process (e.g. cron jobs, autonomous
 * dispatch). Keep this file ESM-only, zero runtime deps beyond Node, and
 * pure enough to import from `.ts` (TypeScript resolves `.mjs` via NodeNext).
 *
 * The three responsibilities:
 *   - resolveApiKey(env, home)  → string | null   (precedence-locked)
 *   - resolveBaseUrl(env)        → string
 *   - callApi(opts)             → { status, ok, body }   (thin fetch wrapper)
 *
 * Nothing in here should touch process.exit, process.argv, or console.log —
 * those belong in the CLI entry (`ah-api.mjs`). That split is what lets us
 * unit-test this file without spawning subprocesses.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Resolve the Agent Hub API key, using the same precedence as the bash
 * `ah-api.sh` wrapper shipped with the agent-hub skill:
 *
 *   1. AGENT_HUB_API_KEY env var
 *   2. apiKey in $AGENT_HUB_DATA_DIR/config.json  (if AGENT_HUB_DATA_DIR set)
 *   3. apiKey in <home>/.agent-hub/data/config.json
 *   4. null  (caller decides whether to send the header at all)
 *
 * Intentionally swallows JSON parse errors — a corrupt config file should
 * degrade to "no key" rather than crashing every script.
 *
 * @param {NodeJS.ProcessEnv} [env]  defaults to process.env
 * @param {string} [home]            defaults to os.homedir()
 * @returns {string | null}
 */
export function resolveApiKey(env = process.env, home = homedir()) {
  if (env.AGENT_HUB_API_KEY) return env.AGENT_HUB_API_KEY;

  const candidates = [];
  if (env.AGENT_HUB_DATA_DIR) {
    candidates.push(join(env.AGENT_HUB_DATA_DIR, 'config.json'));
  }
  if (home) {
    candidates.push(join(home, '.agent-hub', 'data', 'config.json'));
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0) {
        return parsed.apiKey;
      }
    } catch {
      // Malformed JSON — skip and try the next candidate.
    }
  }
  return null;
}

/**
 * Resolve the base URL for API calls.
 *   AGENT_HUB_URL (env) → default http://localhost:3051
 * Trailing slash is stripped so callers can safely concatenate `/api/...`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveBaseUrl(env = process.env) {
  const raw = env.AGENT_HUB_URL ?? 'http://localhost:3051';
  return raw.replace(/\/+$/, '');
}

/**
 * Issue a single JSON API call. Does not throw on non-2xx — returns
 * `{ ok: false, status, body }` so the caller can decide how to surface
 * the error. Network failures propagate as thrown errors (AbortError,
 * ECONNREFUSED, etc.) because those indicate a missing server rather
 * than an API-level error.
 *
 * @param {object} opts
 * @param {string} opts.method   HTTP verb (GET, POST, PUT, DELETE, PATCH)
 * @param {string} opts.path     Path portion, e.g. "/api/projects/agent-hub/board"
 * @param {unknown} [opts.body]  JSON-serializable body (omitted for GET/DELETE)
 * @param {string} [opts.baseUrl]  defaults to resolveBaseUrl()
 * @param {string | null} [opts.apiKey]  defaults to resolveApiKey()
 * @param {typeof fetch} [opts.fetchImpl]  injection point for tests
 * @returns {Promise<{ status: number, ok: boolean, body: unknown }>}
 */
export async function callApi({
  method,
  path,
  body,
  baseUrl = resolveBaseUrl(),
  apiKey = resolveApiKey(),
  fetchImpl = fetch,
}) {
  if (!method) throw new Error('callApi: method is required');
  if (!path || !path.startsWith('/')) {
    throw new Error('callApi: path must be an absolute pathname starting with /');
  }
  const headers = {
    Accept: 'application/json',
  };
  if (apiKey) headers['x-api-key'] = apiKey;

  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const res = await fetchImpl(`${baseUrl}${path}`, init);
  // Try JSON first; fall back to text so error pages don't crash the CLI.
  const raw = await res.text();
  let parsed;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    parsed = raw;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

/**
 * Minimal argv parser tuned for the `ah-api` contract:
 *   ah-api <METHOD> <PATH> [--body <json>]
 *   ah-api --help | -h
 *
 * Returns a normalized shape or `{ help: true }` / `{ error: string }`.
 * Kept local (not imported from format-release-notes) because that parser
 * can't distinguish positional args from flag-lookups — the CLI contract
 * here needs both.
 *
 * @param {string[]} argv  argv slice without the node/script prefix
 */
export function parseArgs(argv) {
  if (argv.length === 0) return { help: true };
  if (argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    return { help: true };
  }

  const positionals = [];
  let body;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === '--body') {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: '--body requires a JSON argument' };
      }
      body = next;
      i += 1;
    } else if (tok.startsWith('--')) {
      return { error: `unknown flag: ${tok}` };
    } else {
      positionals.push(tok);
    }
  }

  if (positionals.length < 2) {
    return { error: 'usage: ah-api <METHOD> <PATH> [--body <json>]' };
  }
  const method = positionals[0].toUpperCase();
  const path = positionals[1];
  if (!path.startsWith('/')) {
    return { error: `path must start with /: ${path}` };
  }

  let parsedBody;
  if (body !== undefined) {
    try {
      parsedBody = JSON.parse(body);
    } catch (err) {
      return { error: `--body is not valid JSON: ${err.message}` };
    }
  }
  return { method, path, body: parsedBody };
}

export const USAGE = `usage: ah-api <METHOD> <PATH> [--body <json>]

Proxies a single HTTP call against the Agent Hub API with auth + JSON
headers. Prints the response body as JSON (or raw text if the server
returned non-JSON).

Environment:
  AGENT_HUB_URL       base URL (default http://localhost:3051)
  AGENT_HUB_API_KEY   overrides the key read from config.json
  AGENT_HUB_DATA_DIR  alternate config.json location

Examples:
  ah-api GET  /api/health
  ah-api GET  /api/projects/agent-hub/board
  ah-api POST /api/projects/agent-hub/board/cards --body '{"title":"foo"}'
`;
