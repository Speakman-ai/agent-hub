import { createHash } from 'crypto';

export interface BannedToken {
  /** SHA-256 hex of the lowercased token with separators removed. */
  sha256: string;
  /** Token length; only same-length windows are checked. */
  length: number;
  /**
   * `rollingHash(token)`: a 31-bit fingerprint used only to skip SHA-256 on
   * windows that cannot match. Far too small to identify the token.
   */
  rolling: number;
  label: string;
}

/**
 * Internal-only identifiers that must never appear in the public tree or in
 * commit messages. Stored as hashes so the guard does not itself publish the
 * names it protects, and so a history rewrite that replaces those names
 * cannot neuter the guard.
 *
 * To add one (lowercase, no separators): `printf %s '<token>' | sha256sum`
 * for `sha256`, and `rollingHash('<token>')` (e.g. via `npx tsx -e`) for
 * `rolling`. The ban-list test fails if the two disagree on length.
 */
export const BANNED_TOKENS: readonly BannedToken[] = [
  {
    sha256: '681b47af83daf9770f594f009bf99042eddd6177bf1b302e3927fbb6842f3831',
    length: 13,
    rolling: 1965391286,
    label: 'private project name',
  },
  {
    sha256: '80c3e375bb00622b77ffd94f74c9b8e231fb5a873c7b24dc453b77a20c091327',
    length: 7,
    rolling: 646459699,
    label: 'private org handle',
  },
];

const MOD = 2147483647; // 2^31 - 1
const BASE = 131;

/** Polynomial rolling hash mod 2^31-1 (all intermediates stay below 2^53). */
export function rollingHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * BASE + s.charCodeAt(i)) % MOD;
  return h;
}

function powMod(exp: number): number {
  let r = 1;
  for (let i = 0; i < exp; i++) r = (r * BASE) % MOD;
  return r;
}

/**
 * Return the labels of banned tokens found in `text`. Text is split into
 * lowercase alphanumeric words, and every banned-length window of each word
 * and of each adjacent pair joined without a separator is checked. So
 * `FooBar`, `foo-bar`, `FOO_BAR`, `Foo Bar`, `FooBarDev`, `myfoo-bar`, and a
 * comment-wrapped `Foo\n * Bar` all match a banned `foobar`.
 */
export function findInternalTokens(
  text: string,
  banned: readonly BannedToken[] = BANNED_TOKENS,
): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g);
  if (!words) return [];
  const byLength = new Map<number, { lead: number; tokens: BannedToken[] }>();
  for (const b of banned) {
    const entry = byLength.get(b.length) ?? { lead: powMod(b.length - 1), tokens: [] };
    entry.tokens.push(b);
    byLength.set(b.length, entry);
  }
  const found = new Set<string>();
  const check = (candidate: string) => {
    for (const [len, { lead, tokens }] of byLength) {
      if (candidate.length < len) continue;
      let h = rollingHash(candidate.slice(0, len));
      for (let i = 0; ; i++) {
        for (const t of tokens) {
          if (h === t.rolling) {
            const window = candidate.slice(i, i + len);
            if (createHash('sha256').update(window).digest('hex') === t.sha256) found.add(t.label);
          }
        }
        if (i + len >= candidate.length) break;
        h = (h - ((candidate.charCodeAt(i) * lead) % MOD) + MOD) % MOD;
        h = (h * BASE + candidate.charCodeAt(i + len)) % MOD;
      }
    }
  };
  for (let i = 0; i < words.length; i++) {
    // The pair covers both words and every window spanning the join, so a
    // lone word only needs checking when it is the last one.
    if (i + 1 < words.length) check(words[i] + words[i + 1]);
    else check(words[i]);
  }
  return [...found];
}
