import config from './config.js';
import { redactCardDescriptionForGit } from './pr-body-redaction.js';

/**
 * Deployment-specific terms that must not reach commit messages on the hosted
 * repo (a private project name, say). Configured, never hardcoded, so the
 * public source does not name them:
 *
 *   AGENT_HUB_COMMIT_REDACTIONS="Some Name=>Acme; Other=>Example"
 *   or `commitRedactions` in config.json / `PATCH /api/config`
 *
 * Each FROM matches case-insensitively, with any run of spaces, `-`, `_`, or a
 * line wrap between its words, so `Some Name`, `some-name`, `SOME_NAME`, and
 * `somename` all match. The replacement follows the casing of the match.
 */
export interface RedactionTerm {
  from: string;
  to: string;
}

export function parseRedactionTerms(raw: unknown): RedactionTerm[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((pair) => pair.split('=>'))
    .filter((parts) => parts.length === 2)
    .map(([from, to]) => ({ from: from.trim(), to: to.trim() }))
    .filter((t) => /[A-Za-z0-9]/.test(t.from));
}

function matchCase(sample: string, word: string): string {
  const letters = sample.replace(/[^A-Za-z]/g, '');
  if (letters && letters === letters.toUpperCase()) return word.toUpperCase();
  if (/^[A-Z]/.test(sample)) return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  return word.toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactTerms(text: string, terms: readonly RedactionTerm[]): string {
  let out = text;
  for (const { from, to } of terms) {
    const words = from
      .split(/[\s_-]+/)
      .filter(Boolean)
      .map(escapeRegExp);
    // Separators: spaces, `-`, `_`, or a line wrap inside a comment (`\n * `).
    const re = new RegExp(words.join('(?:[\\s_-]|\\n\\s*[*#/]+)*'), 'gi');
    out = out.replace(re, (m) => matchCase(m, to));
  }
  return out;
}

/** Terms from env, then config (which `PATCH /api/config` updates live). */
export function configuredRedactionTerms(): RedactionTerm[] {
  const env = process.env.AGENT_HUB_COMMIT_REDACTIONS;
  if (env !== undefined && env.trim() !== '') return parseRedactionTerms(env);
  return parseRedactionTerms(config.commitRedactions);
}

/** `name@domain` → `name`, so a merge trailer does not publish a mail domain. */
export function actorForTrailer(actor: string): string {
  const at = actor.indexOf('@');
  return at > 0 ? actor.slice(0, at) : actor;
}

/** Everything a merge commit message passes through before it is written. */
export function redactCommitMessage(
  message: string,
  terms: readonly RedactionTerm[] = configuredRedactionTerms(),
): string {
  return redactTerms(message, terms);
}

/** PR body as it should appear in a squash-commit message. */
export function prBodyForCommit(body: string): string {
  return redactCardDescriptionForGit(body);
}
