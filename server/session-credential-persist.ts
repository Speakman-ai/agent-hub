/**
 * Promote a session-scoped credential-request submission into the session
 * owner's *persistent* per-user skill credential store.
 *
 * The session credential box (`session-credential-requests.ts`) is ephemeral by
 * design — TTL-bounded, "discarded when they expire". That is the right shape
 * for a one-off secret, but wrong for a *standing* skill login: the user would
 * have to re-type it every session. When the agent's
 * `agenthub:credential-request` block declares a `persist` target (a skill id
 * plus a map of request-field key → the skill's declared credential key name),
 * submitting the box ALSO writes the values into `user_skill_credentials` for
 * the session owner. Future spawns then inject those keys as env vars, exactly
 * like a credential stored under Settings → My Skill Credentials.
 *
 * Two guardrails make this safe to expose to the (owner-authenticated) client:
 *   1. The persist target is bound to the session's own project skill store /
 *      bundled defaults — the caller cannot name an arbitrary skill schema.
 *   2. Every mapped key name must be *declared* in that skill's `credentials:`
 *      frontmatter. A key the skill does not declare is skipped, never stored,
 *      so the box can only seed keys the skill would actually consume.
 */

import { readCredentialsSchemaForSkill } from './skill-credentials-resolve.js';
import { upsertUserSkillCredential } from './skill-credentials-store.js';
import { SessionCredentialRequestError } from './session-credential-requests.js';
import {
  normalizeCredentialPersistTarget,
  PERSIST_SKILL_ID_RE,
  PERSIST_KEY_NAME_RE,
  type CredentialPersistTarget,
} from '../shared/utils/credentialPersistOutcome.js';

export type SessionCredentialPersistTarget = CredentialPersistTarget;

export interface SessionCredentialPersistResult {
  skillId: string;
  /** Credential key names actually written to the owner's store. */
  stored: string[];
  /** Mapped keys that were not stored, with a short machine-readable reason. */
  skipped: Array<{ keyName: string; reason: string }>;
}

/**
 * Validate + normalize a raw `persist` payload from the submit body. This is
 * the authoritative server-side boundary: it delegates to the single shared
 * normalizer (also used by the web + mobile clients) so the rules — including
 * unique destination credential keys — can't drift between surfaces. Returns
 * `null` when the payload is absent or malformed, so the caller treats "no
 * persist" and "bad persist" the same benign way: skip persistence, keep the
 * ephemeral submit.
 */
export function normalizePersistTarget(raw: unknown): SessionCredentialPersistTarget | null {
  return normalizeCredentialPersistTarget(raw);
}

/**
 * Write the mapped values into the owner's per-user skill credential store.
 *
 * Throws `SessionCredentialRequestError` for *skill-level* failures the agent
 * should fix (bad skill id, invalid/absent credential schema). Per-key problems
 * (a key the skill does not declare, an empty value) are collected in `skipped`
 * rather than thrown, so a partially-correct map still stores what it can.
 */
export function persistSessionCredentialToSkill(opts: {
  ownerUserId: string;
  actorUserId: string;
  target: SessionCredentialPersistTarget;
  values: Record<string, string>;
  projectSkillsDirs?: readonly string[];
}): SessionCredentialPersistResult {
  const { skillId, map } = opts.target;
  if (!PERSIST_SKILL_ID_RE.test(skillId)) {
    throw new SessionCredentialRequestError('persist.skillId is invalid');
  }
  const schema = readCredentialsSchemaForSkill(skillId, {
    projectSkillsDirs: opts.projectSkillsDirs ? [...opts.projectSkillsDirs] : [],
  });
  if (schema.error) {
    throw new SessionCredentialRequestError(
      `skill "${skillId}" has an invalid credential schema: ${schema.error}`,
    );
  }
  if (schema.credentials.length === 0) {
    throw new SessionCredentialRequestError(
      `skill "${skillId}" declares no credentials in SKILL.md frontmatter to persist into`,
    );
  }

  const declared = new Set(schema.credentials.map((c) => c.name));
  const stored: string[] = [];
  const skipped: Array<{ keyName: string; reason: string }> = [];

  for (const [fieldKey, keyName] of Object.entries(map)) {
    if (!PERSIST_KEY_NAME_RE.test(keyName)) {
      skipped.push({ keyName, reason: 'invalid-key-name' });
      continue;
    }
    if (!declared.has(keyName)) {
      skipped.push({ keyName, reason: 'not-declared-by-skill' });
      continue;
    }
    const value = opts.values[fieldKey];
    if (typeof value !== 'string' || value.trim().length === 0) {
      skipped.push({ keyName, reason: 'no-value-for-field' });
      continue;
    }
    // Catch per key rather than letting one failed write abort the loop. A
    // throw here would otherwise unwind past the caller, which reports
    // `stored: []` — telling the user nothing was saved even though earlier
    // keys were already written. Recording the failure as a skip keeps the
    // returned `stored`/`skipped` an accurate account of what actually landed,
    // which the client renders as a partial-save disclosure.
    try {
      upsertUserSkillCredential({
        userId: opts.ownerUserId,
        skillId,
        keyName,
        value,
        actorUserId: opts.actorUserId,
      });
      stored.push(keyName);
    } catch {
      skipped.push({ keyName, reason: 'store-failed' });
    }
  }

  return { skillId, stored, skipped };
}
