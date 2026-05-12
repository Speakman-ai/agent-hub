/**
 * skill-credentials-github.ts — Targeted accessor for the GitHub skill's
 * `GH_TOKEN` row in `user_skill_credentials`.
 *
 * The general-purpose decryption path
 * (`skill-credentials-store.ts#mergeDecryptedSkillCredentialsIntoEnv`) is
 * built for spawn-time env injection: it walks every stored row for a list
 * of skill ids and merges them into a `process.env` shape. The session
 * workspace clone (and the project auto-clone fallback) run *before* an
 * agent shell exists — there's no spawn env to merge into and we only care
 * about one specific `(skill_id='github', key_name='GH_TOKEN')` pair.
 *
 * This helper exposes that single lookup directly so callers in
 * `worktree.ts` can authenticate a `git clone` against a private GitHub
 * repo using the session owner's stored PAT, without depending on the
 * spawn-time env machinery.
 *
 * Schema gating happens at PUT time in `skill-credentials-routes.ts`: a row
 * only exists if the github skill's `credentials:` block accepted
 * `GH_TOKEN`. We don't re-validate the schema here — by the time the row
 * is in the DB it has already passed the declaration check.
 */

import { decryptSecret } from './secret-crypto.js';
import { getOrgsDb } from './orgs.js';

const LAST_USED_DEBOUNCE_MS = 60_000;
const lastUsedWriteAt = new Map<string, number>();

/**
 * Fetch and decrypt the GitHub `GH_TOKEN` PAT stored for the given user.
 *
 * Returns `null` (never throws) when:
 *   - `userId` is missing / falsy
 *   - no row exists for `(user_id, skill_id='github', key_name='GH_TOKEN')`
 *   - the stored ciphertext fails to decrypt (e.g. key rotation)
 *   - the decrypted value is empty / whitespace
 *
 * Touches `last_used_at` (debounced to one write per row per 60s) so the
 * Settings UI can show stale-credential indicators.
 */
export function getGithubPatForUser(userId: string | null | undefined): string | null {
  if (!userId) return null;
  try {
    const db = getOrgsDb();
    const row = db
      .prepare(
        `SELECT id, value_enc FROM user_skill_credentials
         WHERE user_id = ? AND skill_id = 'github' AND key_name = 'GH_TOKEN'
         LIMIT 1`,
      )
      .get(userId) as { id: string; value_enc: string } | undefined;
    if (!row) return null;
    let token: string;
    try {
      token = decryptSecret(row.value_enc).trim();
    } catch {
      return null;
    }
    if (!token) return null;
    maybeTouchLastUsed(row.id);
    return token;
  } catch (err: unknown) {
    // Log DB-level failures separately from "user has no row" (which is
    // silent) so operators can distinguish credential-store outages from
    // normal no-PAT cases. The token is never present in this catch
    // branch (we haven't decrypted it yet), so no redaction needed.
    console.warn(
      '[skill-credentials-github] PAT lookup failed:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function maybeTouchLastUsed(rowId: string): void {
  const now = Date.now();
  const last = lastUsedWriteAt.get(rowId) ?? 0;
  if (now - last < LAST_USED_DEBOUNCE_MS) return;
  lastUsedWriteAt.set(rowId, now);
  try {
    getOrgsDb()
      .prepare('UPDATE user_skill_credentials SET last_used_at = ? WHERE id = ?')
      .run(new Date(now).toISOString(), rowId);
  } catch {
    /* best-effort — surface the value either way */
  }
}

/**
 * Build the git argv prefix that injects an `Authorization: basic …`
 * header scoped to `https://github.com/` for a single git invocation.
 *
 * The header is the GH Actions `actions/checkout` pattern: it tells git
 * to attach the header to outgoing HTTPS requests for github.com **only**
 * (the trailing slash in the config key matters — it's a URL match prefix)
 * and only for the lifetime of this child process. Crucially, because
 * the value is passed via `-c` and never written to `.git/config`, the
 * token does NOT end up on disk in the resulting repo's config — even
 * after a successful `git clone`. Subsequent fetches will need their own
 * auth args.
 *
 * Caller responsibilities:
 *   - Strip any embedded userinfo from the URL (`x-access-token:…@`) before
 *     passing it to git, otherwise both auth mechanisms compete.
 *   - Pass `token = null` (or an empty string) when no PAT is available;
 *     this helper returns an empty array so the argv is unchanged.
 *
 * The header form is `Authorization: basic <base64(x-access-token:<TOKEN>)>`.
 * `x-access-token` is the GitHub-documented username for user-to-server
 * OAuth tokens; classic and fine-grained PATs both accept it.
 */
export function gitAuthArgsForGithubPat(token: string | null | undefined): string[] {
  if (!token) return [];
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  return ['-c', `http.https://github.com/.extraheader=Authorization: basic ${basic}`];
}
