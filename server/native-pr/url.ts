/**
 * url.ts — native PR URL scheme.
 *
 * Native PRs live at `/projects/<projectId>/pulls/<number>` (a client
 * route, not github.com). Everything that stores or parses `pr_url`
 * treats it as an opaque string, so this is the only module that knows
 * the shape. `parseNativePrUrl` accepts an optional `http(s)://host`
 * prefix so absolute links (e.g. from notifications) also resolve.
 */

const NATIVE_PR_RE = /^(?:https?:\/\/[^/]+)?\/projects\/([^/\s]+)\/pulls\/(\d+)(?:[?#].*)?$/;

export function buildNativePrUrl(projectId: string, number: number): string {
  return `/projects/${projectId}/pulls/${number}`;
}

export function parseNativePrUrl(
  url: string | null | undefined,
): { projectId: string; number: number } | null {
  if (!url) return null;
  const match = url.trim().match(NATIVE_PR_RE);
  if (!match) return null;
  const number = Number.parseInt(match[2], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { projectId: match[1], number };
}

export function isNativePrUrl(url: string | null | undefined): boolean {
  return parseNativePrUrl(url) !== null;
}
