// Container pool — starter CLI version-bump detector (W3).
//
// Pure logic for comparing the pinned starter-CLI manifest
// (docker/starter-versions.json) against what's currently on the
// upstream "latest" dist-tag. The wrapper script
// (scripts/check-starter-versions.mjs) handles argv/IO/exit; this
// module stays pure so it is unit-testable via Vitest with an injected
// `fetchImpl`.
//
// Design per the "Scripts Layer" wiki convention:
//   - No `process.*` references here
//   - No `console.log` / `process.exit` / `process.argv`
//   - All side effects injected (fetch, now)
//   - Default exports are named, not default
//
// Contract used by the CI workflow (.github/workflows/base-images.yml):
//   - `loadManifest(raw)`             → parsed manifest
//   - `fetchLatestVersion(pkg, deps)` → `{ name, latest }` for one package
//   - `checkManifest(manifest, deps)` → `{ bumps: [...], hasMajorBump }`
//
// Sources of truth for the "latest" version:
//   - npm packages (create-next-app, create-expo-app, pnpm, yarn) →
//     https://registry.npmjs.org/<pkg>/latest (public, no auth, 200ms)
//   - `gh` CLI → https://api.github.com/repos/cli/cli/releases/latest
//     (public, no auth for unauthenticated reads; uses
//     `X-GitHub-Api-Version: 2022-11-28` per Platform API docs)

// -------------------- manifest I/O ------------------------------------------

/**
 * Parses the manifest string into a validated shape.
 * Throws Error on malformed input — the wrapper surfaces this as
 * exit code 2 (bad invocation).
 *
 * @param {string} raw   contents of docker/starter-versions.json
 * @returns {{packages: Record<string, {version: string, major: number, dockerArg: string, source?: 'npm'|'github'}>}}
 */
export function loadManifest(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('manifest must be an object');
  }
  const pkgs = parsed.packages;
  if (!pkgs || typeof pkgs !== 'object') {
    throw new Error('manifest.packages must be an object');
  }
  for (const [name, entry] of Object.entries(pkgs)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`manifest.packages["${name}"] must be an object`);
    }
    if (typeof entry.version !== 'string') {
      throw new Error(`manifest.packages["${name}"].version must be a string`);
    }
    if (typeof entry.major !== 'number' || !Number.isInteger(entry.major)) {
      throw new Error(
        `manifest.packages["${name}"].major must be an integer`
      );
    }
    // `major` must match the leading integer of `version` — catches
    // "I bumped the pin to 16.0.0 but forgot to bump major: 15".
    const versionMajor = parseMajor(entry.version);
    if (versionMajor !== entry.major) {
      throw new Error(
        `manifest.packages["${name}"]: version "${entry.version}" parses to major ${versionMajor}, but manifest declares major ${entry.major}`
      );
    }
  }
  return parsed;
}

/**
 * Extracts the leading integer from a semver-ish string.
 * `"15.0.0-canary.4"` → 15. Throws if no leading integer.
 */
export function parseMajor(version) {
  const match = /^(\d+)(?:\.|$|-)/.exec(String(version).trim());
  if (!match) {
    throw new Error(`cannot parse major from version "${version}"`);
  }
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n)) {
    throw new Error(`cannot parse major from version "${version}"`);
  }
  return n;
}

// -------------------- upstream fetchers -------------------------------------

/**
 * Fetches the latest version of ONE package.
 *
 * @param {string} name          package name from the manifest
 * @param {object} deps          { fetchImpl?: typeof fetch, source?: 'npm'|'github' }
 * @returns {Promise<{name: string, latest: string, major: number, source: 'npm'|'github'}>}
 */
export async function fetchLatestVersion(name, deps = {}) {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('no fetch implementation available');
  }
  const source = deps.source ?? defaultSourceFor(name);

  if (source === 'npm') {
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(
        `npm registry returned ${res.status} for ${name}: ${await safeText(res)}`
      );
    }
    const body = await res.json();
    if (typeof body?.version !== 'string') {
      throw new Error(`npm response for ${name} has no .version`);
    }
    return { name, latest: body.version, major: parseMajor(body.version), source };
  }

  if (source === 'github') {
    // `gh` CLI is the only supported github-sourced entry. Repo is
    // hard-coded — intentional, we don't want the manifest to start
    // shelling out to arbitrary repos on CI.
    if (name !== 'gh') {
      throw new Error(`source=github is only supported for "gh", got "${name}"`);
    }
    const url = 'https://api.github.com/repos/cli/cli/releases/latest';
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(
        `github api returned ${res.status} for ${name}: ${await safeText(res)}`
      );
    }
    const body = await res.json();
    // Releases are tagged "v2.62.0" — strip the leading v.
    const tag = String(body?.tag_name ?? '').replace(/^v/, '');
    if (!tag) {
      throw new Error(`github response for ${name} has no .tag_name`);
    }
    return { name, latest: tag, major: parseMajor(tag), source };
  }

  throw new Error(`unknown source "${source}" for package "${name}"`);
}

/**
 * Checks every manifest entry against upstream and returns a diff.
 *
 * @param {ReturnType<typeof loadManifest>} manifest
 * @param {{fetchImpl?: typeof fetch}} [deps]
 * @returns {Promise<{
 *   bumps: Array<{name: string, pinned: string, latest: string, pinnedMajor: number, latestMajor: number, kind: 'major'|'minor-or-patch'|'none', source: 'npm'|'github'}>,
 *   hasMajorBump: boolean,
 * }>}
 */
export async function checkManifest(manifest, deps = {}) {
  const entries = Object.entries(manifest.packages);
  // Run concurrently — the registry is fast and the manifest is small;
  // serial polling adds seconds to every CI run for no reason.
  const results = await Promise.all(
    entries.map(async ([name, entry]) => {
      const upstream = await fetchLatestVersion(name, {
        fetchImpl: deps.fetchImpl,
        source: entry.source,
      });
      const kind = classifyBump(entry, upstream);
      return {
        name,
        pinned: entry.version,
        latest: upstream.latest,
        pinnedMajor: entry.major,
        latestMajor: upstream.major,
        source: upstream.source,
        kind,
      };
    })
  );
  const hasMajorBump = results.some((r) => r.kind === 'major');
  return { bumps: results, hasMajorBump };
}

// -------------------- classification ----------------------------------------

/**
 * Decides whether the upstream version represents a major bump, a
 * smaller bump, or no change at all.
 *
 * A DOWN-bump (upstream rolled back from 16 to 15) is treated as
 * 'none' — we pin explicit versions, so a registry rollback doesn't
 * affect what we ship. Logged but not alerted.
 */
export function classifyBump(pinnedEntry, upstream) {
  if (upstream.latest === pinnedEntry.version) return 'none';
  if (upstream.major > pinnedEntry.major) return 'major';
  if (upstream.major < pinnedEntry.major) return 'none';
  // Same major, different version → minor or patch bump.
  return 'minor-or-patch';
}

// -------------------- rendering ---------------------------------------------

/**
 * Renders a bump report as a human-readable multi-line string, used
 * for the CI step summary and the GitHub issue body when a major bump
 * is detected.
 */
export function renderReport({ bumps, hasMajorBump }) {
  const lines = [];
  lines.push(`Starter CLI version check — ${bumps.length} packages examined.`);
  lines.push('');
  for (const b of bumps) {
    const marker =
      b.kind === 'major' ? '⚠️  MAJOR' : b.kind === 'minor-or-patch' ? '·  minor' : '✓  ok';
    lines.push(
      `${marker}  ${b.name.padEnd(20)} pinned=${b.pinned.padEnd(14)} latest=${b.latest.padEnd(14)} (${b.source})`
    );
  }
  lines.push('');
  if (hasMajorBump) {
    lines.push(
      'At least one major bump detected — the :latest tag retag will be SKIPPED for this run.'
    );
    lines.push(
      'The :YYYYMMDD tag is still pushed, but operators must review and bump the pin in docker/starter-versions.json before :latest moves again.'
    );
  } else {
    lines.push('No major bumps. Safe to retag :latest after build.');
  }
  return lines.join('\n');
}

// -------------------- helpers -----------------------------------------------

function defaultSourceFor(name) {
  return name === 'gh' ? 'github' : 'npm';
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return '<unreadable body>';
  }
}
