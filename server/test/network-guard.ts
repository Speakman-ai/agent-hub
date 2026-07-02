/**
 * Fail-closed guard that keeps test runs away from live deployments.
 *
 * Sibling rail to the CLI-spawn guard (server/test/setup.ts) and the
 * DB-safety guard (server/db-safety.ts). Those stop tests from spawning the
 * real CLI binaries and from opening a real database; this one stops a test
 * from reaching a live deployment over the network — e.g. `fetch()`-ing a
 * prod URL because someone forgot to mock it. A test that hits prod can
 * mutate real data, page on-call, or hammer a rate limit, and it makes the
 * suite non-deterministic and network-dependent.
 *
 * How it works: `installTestNetworkGuard()` wraps the global `fetch` so any
 * call whose target resolves to a non-loopback host throws immediately with a
 * loud pointer to the fix (mock it). Loopback targets (127.0.0.0/8, ::1,
 * localhost — what supertest and the preview health probes use) pass through
 * to the real implementation. Tests that replace `globalThis.fetch` with a
 * mock (`vi.fn()` / `vi.stubGlobal`) bypass the guard entirely — that's the
 * intended safe path.
 *
 * Escape hatch: AGENT_HUB_ALLOW_TEST_NETWORK=1 — intentionally loud and
 * explicit; nothing in the repo sets it.
 */

const LOOPBACK_LITERALS = new Set(['localhost', '0.0.0.0', '::1', '0:0:0:0:0:0:0:1', '']);

/** Is this hostname a loopback / local target that tests may reach? */
export function isLoopbackHost(hostname: string): boolean {
  // URL host for IPv6 arrives bracketed ("[::1]"); strip the brackets.
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (LOOPBACK_LITERALS.has(h)) return true;
  // Entire 127.0.0.0/8 block (the preview health tests use 127.0.0.2).
  if (/^127(?:\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

/** Pull a URL string out of the many shapes `fetch()` accepts. */
function extractUrl(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === 'object' && 'url' in input) {
    const u = (input as { url?: unknown }).url;
    if (typeof u === 'string') return u;
  }
  return null;
}

/**
 * True when a `fetch()` target is safe to allow in tests. Loopback http(s)
 * hosts and non-network schemes (data:, blob:, file:) are allowed. Anything
 * that parses to an http(s) URL on a non-loopback host is blocked. Targets we
 * cannot parse (relative URLs, garbage) pass through to the real `fetch`,
 * which raises its own error — we only guard clearly-remote targets.
 */
export function isAllowedFetchTarget(input: unknown): boolean {
  const raw = extractUrl(input);
  if (raw == null) return true;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true; // unparseable / relative — let real fetch reject it naturally
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  return isLoopbackHost(url.hostname);
}

export class LiveDeploymentNetworkError extends Error {
  constructor(target: string) {
    super(
      `[network-guard] REFUSING fetch() to "${target}": tests must never hit a ` +
        'live deployment. A real network call can mutate prod data, trip rate ' +
        'limits, or page on-call, and makes the suite flaky and network-dependent. ' +
        "Mock it instead — set globalThis.fetch = vi.fn() (or vi.stubGlobal('fetch', ...)) " +
        'in the test, or vi.mock the wrapper module that calls fetch. Only ' +
        'loopback (127.0.0.0/8, localhost, ::1) is allowed. If you are ABSOLUTELY ' +
        'sure, set AGENT_HUB_ALLOW_TEST_NETWORK=1 to override.',
    );
    this.name = 'LiveDeploymentNetworkError';
  }
}

const GUARD_MARK = Symbol.for('agent-hub.test.network-guard');
const REAL_FETCH = Symbol.for('agent-hub.test.network-guard.real-fetch');

type FetchLike = typeof fetch;
interface GuardGlobal {
  fetch?: FetchLike;
  [REAL_FETCH]?: FetchLike;
}

/**
 * Wrap the global `fetch` so non-loopback targets throw. Idempotent and
 * self-healing: it always re-wraps the ORIGINAL fetch (captured once on a
 * global symbol), so re-running per-file setup never double-wraps and a
 * leaked mock from a prior file is replaced by the guard again.
 */
export function installTestNetworkGuard(
  target: GuardGlobal = globalThis as unknown as GuardGlobal,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const current = target.fetch;
  if (typeof current !== 'function') return; // no global fetch to guard

  // Capture the true original once on a global symbol. On the first run
  // `current` is the real undici fetch; on later runs (per-file setup, or a
  // leaked mock) we re-wrap that same captured original, never the mock.
  const original = target[REAL_FETCH] ?? current;
  target[REAL_FETCH] = original;

  const guarded = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    if (env.AGENT_HUB_ALLOW_TEST_NETWORK !== '1' && !isAllowedFetchTarget(input)) {
      throw new LiveDeploymentNetworkError(extractUrl(input) ?? String(input));
    }
    return original(input, init);
  }) as FetchLike;
  (guarded as unknown as Record<symbol, unknown>)[GUARD_MARK] = true;

  target.fetch = guarded;
}
