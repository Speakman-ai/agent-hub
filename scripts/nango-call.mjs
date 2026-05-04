#!/usr/bin/env node
/**
 * scripts/nango-call.mjs — thin wrapper for proxied API calls through
 * the configured IntegrationProvider (Nango Cloud / Self-Hosted).
 *
 * Reads the spawn-time env vars Agent Hub injects via `buildSpawnEnv`
 * (see `server/spawn-nango-env.ts` and `references/auth.md`):
 *
 *   - NANGO_SECRET_KEY        — Bearer token for Nango.
 *   - NANGO_PROVIDER_BASE     — e.g. https://api.nango.dev.
 *   - NANGO_CONNECTIONS_JSON  — `{ "<app>": "<connection_id>", ... }`
 *                                — owner-scoped per-user map.
 *
 * Invocation:
 *   ./scripts/nango-call.mjs --app slack --path chat.postMessage \
 *       --method POST --body '{"channel":"C123","text":"hello"}'
 *
 *   ./scripts/nango-call.mjs --app google-mail --path users/me/messages \
 *       --query 'maxResults=5' --query 'q=is:unread'
 *
 * Required flags:
 *   --app  <providerConfigKey>   one of the keys present in
 *                                NANGO_CONNECTIONS_JSON
 *   --path <upstream-path>       relative path forwarded by Nango
 *
 * Optional flags:
 *   --method <GET|POST|PUT|PATCH|DELETE>  default GET
 *   --body   <json string>                request body (sets Content-Type)
 *   --query  key=value                    repeatable query param
 *   --header 'Name: value'                repeatable extra header
 *
 * Exit codes:
 *   0  HTTP 2xx (response printed to stdout)
 *   1  HTTP non-2xx (response body still printed to stdout)
 *   2  bad invocation / missing env / unknown app
 *   3  transport failure (DNS, connection refused, TLS, …)
 *
 * Prints the response body to stdout (pretty-JSON when JSON, raw text
 * otherwise). Never logs the secret key.
 */

import { pathToFileURL } from 'node:url';

const USAGE = `nango-call — proxied call through the IntegrationProvider

Usage:
  scripts/nango-call.mjs --app <key> --path <path> [options]

Options:
  --app    <providerConfigKey>          required (slack, google-mail, github, ...)
  --path   <upstream-path>              required (forwarded to Nango proxy)
  --method <GET|POST|PUT|PATCH|DELETE>  default GET
  --body   <json>                       request body (sets Content-Type: application/json)
  --query  key=value                    URL query param (repeatable)
  --header 'Name: value'                extra header forwarded to the upstream API (repeatable)
  -h, --help                            print this help

Reads NANGO_SECRET_KEY / NANGO_PROVIDER_BASE / NANGO_CONNECTIONS_JSON from env.
`;

/** Parse argv into a structured options object (or an error). */
export function parseArgs(argv) {
  const out = {
    app: null,
    path: null,
    method: 'GET',
    body: null,
    query: [],
    headers: [],
    help: false,
    error: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) {
        out.error = `flag ${a} requires a value`;
        return null;
      }
      i++;
      return v;
    };
    switch (a) {
      case '-h':
      case '--help':
        out.help = true;
        break;
      case '--app':
        out.app = next();
        break;
      case '--path':
        out.path = next();
        break;
      case '--method': {
        const m = next();
        if (m == null) break;
        const upper = m.toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper)) {
          out.error = `unsupported method: ${m}`;
          return out;
        }
        out.method = upper;
        break;
      }
      case '--body':
        out.body = next();
        break;
      case '--query': {
        const v = next();
        if (v == null) break;
        const eq = v.indexOf('=');
        if (eq <= 0) {
          out.error = `--query expected key=value, got ${v}`;
          return out;
        }
        out.query.push([v.slice(0, eq), v.slice(eq + 1)]);
        break;
      }
      case '--header': {
        const v = next();
        if (v == null) break;
        const colon = v.indexOf(':');
        if (colon <= 0) {
          out.error = `--header expected "Name: value", got ${v}`;
          return out;
        }
        out.headers.push([v.slice(0, colon).trim(), v.slice(colon + 1).trim()]);
        break;
      }
      default:
        out.error = `unknown flag: ${a}`;
        return out;
    }
    if (out.error) return out;
  }
  if (out.help) return out;
  if (!out.app) out.error = '--app is required';
  else if (!out.path) out.error = '--path is required';
  return out;
}

/** Read & parse NANGO_CONNECTIONS_JSON safely. */
export function parseConnections(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Resolve env + args into a fetch request and execute it.
 *
 * @param {object} opts
 * @param {string[]} opts.argv
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {{ write(chunk: string): unknown }} opts.stdout
 * @param {{ write(chunk: string): unknown }} opts.stderr
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<number>}  exit code
 */
export async function main({ argv, env, stdout, stderr, fetchImpl }) {
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

  const secretKey = env.NANGO_SECRET_KEY;
  if (!secretKey) {
    stderr.write(
      'error: NANGO_SECRET_KEY is not set — the IntegrationProvider is not configured for this spawn.\n',
    );
    return 2;
  }
  const baseUrl = (env.NANGO_PROVIDER_BASE || 'https://api.nango.dev').replace(/\/+$/, '');
  const connections = parseConnections(env.NANGO_CONNECTIONS_JSON);
  const connectionId = connections[parsed.app];
  if (!connectionId) {
    const known = Object.keys(connections);
    stderr.write(
      `error: no connected '${parsed.app}' integration for the session owner. ` +
        `Connected apps: ${known.length ? known.join(', ') : '(none)'}.\n` +
        "Connect the app from Settings → Integrations and retry.\n",
    );
    return 2;
  }

  const normalisedPath = parsed.path.startsWith('/') ? parsed.path.slice(1) : parsed.path;
  const url = new URL(`${baseUrl}/proxy/${normalisedPath}`);
  for (const [k, v] of parsed.query) {
    url.searchParams.set(k, v);
  }

  /** @type {Record<string, string>} */
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    'Connection-Id': connectionId,
    'Provider-Config-Key': parsed.app,
  };
  for (const [name, value] of parsed.headers) {
    headers[name] = value;
  }

  let bodyInit;
  if (parsed.body !== null) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    bodyInit = parsed.body;
  }

  const f = fetchImpl ?? globalThis.fetch;

  let res;
  try {
    res = await f(url.toString(), {
      method: parsed.method,
      headers,
      body: bodyInit,
    });
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
    stderr.write(`error: request failed: ${msg}\n`);
    return 3;
  }

  const text = await res.text();
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json') && text) {
    try {
      const parsedJson = JSON.parse(text);
      stdout.write(`${JSON.stringify(parsedJson, null, 2)}\n`);
    } catch {
      stdout.write(text);
      if (!text.endsWith('\n')) stdout.write('\n');
    }
  } else if (text) {
    stdout.write(text);
    if (!text.endsWith('\n')) stdout.write('\n');
  }
  return res.ok ? 0 : 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main({
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout,
    stderr: process.stderr,
  })
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`fatal: ${err?.stack ?? err}\n`);
      process.exit(3);
    });
}
