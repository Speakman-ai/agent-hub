/**
 * detect-compose-preview
 *
 * Pure helper that inspects a project's checkout for a top-level
 * `docker-compose.yml` / `compose.yml` and, when found, parses out the
 * list of services + a best-guess entry service + entry port.
 *
 * Why a separate detector from `detect-preview-defaults.ts`?
 *   - Compose detection is biased toward "if a compose file exists,
 *     prefer compose mode even when a JS stack is also detectable" —
 *     surveys-tracker etc. ship both a Vite app and a compose file, and
 *     PR 4 of the compose pivot is going to delete the script-mode
 *     branch entirely. Keeping the detectors separate makes the
 *     priority explicit at the call site.
 *   - The two detectors return different shapes (`stack` + script vs.
 *     `compose` block), and the Settings → Preview client treats them
 *     differently (different "Accept" branches).
 *
 * Entry-service heuristic: we pick the first service in this priority
 * order — `frontend`, `web`, `client`, `app`, `ui`, then the first
 * service in declaration order. Most real compose files name the
 * user-facing service one of those four. Operators can override the
 * pick by editing the dropdown after Accept.
 *
 * Entry-port heuristic: when the selected service has a `ports:`
 * mapping, we extract the container-side port (the part after `:` in
 * `"3000:3000"`). When `ports:` is missing or unparseable we fall back
 * to 3000 — sane default for `node` / `npm run dev` web servers and
 * obvious enough that the user notices to override.
 *
 * Pure with respect to filesystem and dependency-free beyond `fs` +
 * the `yaml` parser already installed for the server (transitively via
 * `openapi3-ts`). Safe to call without spinning up the rest of the
 * server.
 */

import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

export interface DetectedComposePreview {
  /** Stack tag — always `'compose'` for this detector. */
  stack: 'compose';
  /** Compose-shape block the client populates the form from. */
  compose: {
    /** Compose file path, relative to the project root. */
    file: string;
    /** Best-guess entry service, or `null` when the file lists none. */
    entryService: string | null;
    /** Container-side port for the entry service, or a sane default. */
    entryPort: number;
    /** Full list of service names, in declaration order. */
    services: string[];
    /** Optional env file inferred from a sibling `.env.preview` etc. */
    envFile?: string;
  };
  captureRoutes: string[];
  idleTTL: number;
}

const COMPOSE_FILENAMES = [
  'compose.preview.yml',
  'compose.preview.yaml',
  'docker-compose.yml',
  'compose.yml',
  'docker-compose.yaml',
  'compose.yaml',
];
const PREFERRED_ENTRY_SERVICES = ['frontend', 'web', 'client', 'app', 'ui'];
const DEFAULT_ENTRY_PORT = 3000;

/**
 * Inspect `workspaceDir` for a compose file. Returns a populated
 * suggestion when one is found, or `null` otherwise.
 *
 * Returns `null` (rather than throwing) on malformed YAML — the caller
 * (the detect route) is expected to fall back to the legacy JS-stack
 * detector so a broken compose file doesn't hide the suggestion.
 */
export function detectComposePreview(workspaceDir: string): DetectedComposePreview | null {
  if (!workspaceDir || typeof workspaceDir !== 'string') return null;
  if (!existsSync(workspaceDir)) return null;

  // Find the first matching compose filename in the workspace root.
  let composePath: string | null = null;
  let composeFileRel: string | null = null;
  for (const name of COMPOSE_FILENAMES) {
    const candidate = path.join(workspaceDir, name);
    if (existsSync(candidate)) {
      composePath = candidate;
      composeFileRel = name;
      break;
    }
  }
  if (!composePath || !composeFileRel) return null;

  let parsed: unknown;
  try {
    const text = readFileSync(composePath, 'utf8');
    parsed = parseYaml(text);
  } catch {
    // Malformed YAML or unreadable — treat as "no compose suggestion".
    // The caller falls back to the legacy JS-stack detector.
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const servicesRaw = root.services;
  if (!servicesRaw || typeof servicesRaw !== 'object' || Array.isArray(servicesRaw)) {
    // A compose file is allowed to omit `services:` (just `volumes:` /
    // `networks:`), but the preview surface needs at least one service
    // to target — bail.
    return null;
  }
  const services = Object.keys(servicesRaw as Record<string, unknown>);
  if (services.length === 0) return null;

  // Pick the entry service via priority list, falling back to the
  // first service in declaration order.
  let entryService: string | null = null;
  for (const candidate of PREFERRED_ENTRY_SERVICES) {
    if (services.includes(candidate)) {
      entryService = candidate;
      break;
    }
  }
  if (!entryService) entryService = services[0] ?? null;

  // Extract the container-side port from the entry service's `ports:`
  // mapping when present. Compose supports two shapes:
  //   - short form: ["3000:3000", "8080:80"]
  //   - long form: [{ target: 3000, published: 3000, protocol: "tcp" }]
  // We handle both, but be liberal — anything we can't parse falls back
  // to the default port so the suggestion is still useful.
  let entryPort = DEFAULT_ENTRY_PORT;
  if (entryService) {
    const svc = (servicesRaw as Record<string, unknown>)[entryService] as
      | Record<string, unknown>
      | undefined;
    if (svc && Array.isArray(svc.ports)) {
      const parsedPort = extractFirstContainerPort(svc.ports);
      if (parsedPort !== null) entryPort = parsedPort;
    }
  }

  // Optional env-file inference. Only suggest if a `.env.preview` /
  // `.env` sits next to the compose file — never assume.
  let envFile: string | undefined;
  for (const candidate of ['.env.preview', '.env']) {
    if (existsSync(path.join(workspaceDir, candidate))) {
      envFile = candidate;
      break;
    }
  }

  return {
    stack: 'compose',
    compose: {
      file: composeFileRel,
      entryService,
      entryPort,
      services,
      ...(envFile ? { envFile } : {}),
    },
    captureRoutes: ['/'],
    idleTTL: 600,
  };
}

/**
 * Pull the container-side port out of the first parseable entry of a
 * compose `ports:` array. Returns `null` if none of the entries can be
 * parsed — caller defaults.
 *
 * Exported for unit tests; the route doesn't use it directly.
 */
export function extractFirstContainerPort(ports: unknown[]): number | null {
  for (const entry of ports) {
    if (typeof entry === 'string') {
      // Forms: "3000", "3000:3000", "127.0.0.1:8080:80", "8080:80/tcp"
      // The container-side port is the LAST numeric segment before any
      // trailing protocol.
      const stripped = entry.split('/')[0]; // drop "/tcp" etc.
      const parts = stripped.split(':');
      const lastNumeric = parts[parts.length - 1];
      const n = Number(lastNumeric);
      if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const e = entry as Record<string, unknown>;
      const target = typeof e.target === 'number' ? e.target : Number(e.target);
      if (Number.isInteger(target) && target > 0 && target <= 65535) return target;
    }
  }
  return null;
}
