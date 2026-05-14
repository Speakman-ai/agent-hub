/**
 * clone-url-auth.ts — Classify clone URLs and inject OAuth/PAT credentials.
 *
 * The "Clone from GitHub" wizard accepts arbitrary git URLs but the only
 * URL family we can authenticate transparently is GitHub HTTPS. SSH URLs
 * require a registered key + known_hosts entries, neither of which we
 * can guarantee on Docker-deployed Hubs (no persistent `~/.ssh` mount,
 * no key registered with GitHub). Public HTTPS clones for other hosts
 * (gitlab, bitbucket, plain `https://github.com/...` for public repos)
 * still pass through unchanged.
 *
 * This module is pure — no DB, no spawn — so the URL-rewrite logic can
 * be unit-tested without bringing up the Express app or the orgs DB.
 */

export type CloneUrlKind = 'github-https' | 'github-ssh' | 'other';

export interface ParsedCloneUrl {
  kind: CloneUrlKind;
  /** Original URL exactly as passed in. */
  original: string;
  /** Owner segment for github-https / github-ssh; null otherwise. */
  owner: string | null;
  /** Repo name (no `.git`) for github-https / github-ssh; null otherwise. */
  repo: string | null;
}

/**
 * Inspect a clone URL and report whether we can inject a token, must
 * reject (SSH), or should leave it alone.
 *
 * Recognized GitHub HTTPS forms:
 *   - https://github.com/owner/repo
 *   - https://github.com/owner/repo.git
 *   - http://github.com/owner/repo (rare; treated identically)
 *   - https://www.github.com/owner/repo (rare; canonicalized to github.com)
 *
 * Recognized GitHub SSH forms:
 *   - git@github.com:owner/repo.git
 *   - ssh://git@github.com/owner/repo.git
 *
 * Anything else (gitlab, bitbucket, file://, custom hosts) returns kind
 * `'other'` and is passed through without rewriting.
 */
export function classifyCloneUrl(url: string): ParsedCloneUrl {
  const trimmed = (url || '').trim();
  const fail: ParsedCloneUrl = { kind: 'other', original: url, owner: null, repo: null };
  if (!trimmed) return fail;

  // ── GitHub HTTPS ────────────────────────────────────────────────
  // Match http(s)://[www.]github.com/owner/repo[.git][/]
  const httpsMatch = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+?)(?:\.git)?\/?(?:[?#].*)?$/i,
  );
  if (httpsMatch) {
    return {
      kind: 'github-https',
      original: url,
      owner: httpsMatch[1],
      repo: httpsMatch[2],
    };
  }

  // ── GitHub SSH (scp-like) ───────────────────────────────────────
  const scpMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (scpMatch) {
    return { kind: 'github-ssh', original: url, owner: scpMatch[1], repo: scpMatch[2] };
  }

  // ── GitHub SSH (ssh:// URL form) ────────────────────────────────
  const sshUrlMatch = trimmed.match(
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
  );
  if (sshUrlMatch) {
    return { kind: 'github-ssh', original: url, owner: sshUrlMatch[1], repo: sshUrlMatch[2] };
  }

  return fail;
}

/**
 * Build an HTTPS URL with the token embedded in the userinfo segment.
 * Always uses the canonical `https://github.com/owner/repo.git` form so
 * `git -C ... remote set-url origin <original>` after the clone restores
 * exactly what the user pasted.
 *
 * The `x-access-token` username is the form GitHub documents for
 * user-to-server OAuth tokens — it works for fine-grained PATs and
 * classic PATs as well, so callers don't need to switch on token shape.
 */
export function buildAuthenticatedUrl(parsed: ParsedCloneUrl, token: string): string {
  if (parsed.kind !== 'github-https' || !parsed.owner || !parsed.repo) {
    throw new Error('buildAuthenticatedUrl: only github-https URLs are supported');
  }
  if (!token) throw new Error('buildAuthenticatedUrl: token is required');
  return `https://x-access-token:${token}@github.com/${parsed.owner}/${parsed.repo}.git`;
}

/**
 * Replace any occurrence of `token` in `text` with `***`. Used before
 * broadcasting clone-progress messages so a token that leaked into a
 * git error string never reaches the WebSocket log.
 *
 * Tokens shorter than 6 characters are not redacted — the cost of
 * accidentally redacting common short strings (e.g. "main") outweighs
 * the marginal leak risk, and real GitHub tokens are >40 chars anyway.
 */
export function redactToken(text: string, token: string | null | undefined): string {
  if (!token || token.length < 6) return text;
  // Escape regex specials in the token so a `+` or `.` doesn't break things.
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(escaped, 'g'), '***');
}

/**
 * Strip Authorization header values from a string regardless of the
 * scheme used. `redactToken` only finds raw token substrings; when git
 * fails the spawn error echoes the full argv, including
 * `-c http.https://github.com/.extraheader=Authorization: basic <BASE64>`,
 * and the base64-encoded `x-access-token:<TOKEN>` form contains none of
 * the raw token's characters. This helper is shape-based, not value-based:
 * any `Authorization: <scheme> <value>` substring is rewritten to
 * `Authorization: <scheme> ***`, so future leak shapes are caught even
 * if the redactToken caller forgets to pass the matching `token`.
 *
 * The match is intentionally permissive on the value (any non-space run)
 * to cover basic + bearer + token + future schemes; the scheme keyword
 * itself is kept verbatim so error messages still make sense.
 */
export function redactAuthHeader(text: string): string {
  if (!text) return text;
  // `i` so `Authorization` / `authorization` / mixed case all match —
  // git emits lower-case `authorization:` in some error paths.
  return text.replace(/(Authorization:\s*\S+\s+)\S+/gi, '$1***');
}

/**
 * Friendly user-facing message for SSH URLs we can't satisfy. Used both
 * for the synchronous 400 response and as a fallback when git itself
 * surfaces `Host key verification failed`.
 */
export const SSH_NOT_SUPPORTED_MESSAGE =
  'SSH cloning is not supported in this deployment — paste the HTTPS URL form (https://github.com/owner/repo.git) and connect your GitHub account in Settings → GitHub for private repos.';
