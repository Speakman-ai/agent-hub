/**
 * Guard: no shipped skill file teaches the removed sub-agent dispatch protocol.
 *
 * `<delegate>` and `<handoff>` were parsed and dispatched by the server once.
 * They are gone — chat.ts now answers a `<delegate>` block with a "sub-agent
 * delegation has been removed" system message. Skill docs are injected into
 * every enriched system prompt, so a leftover mention doesn't just rot, it
 * actively steers the model into emitting a block that can only fail.
 *
 * This walks both shipped skill trees and fails on the literal tags.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SKILL_TREES = [
  path.join(REPO_ROOT, 'server', 'default-skills'),
  path.join(REPO_ROOT, 'plugin', 'skills'),
];

/** Literal tags that must not survive anywhere in a shipped skill tree. */
const FORBIDDEN = ['<delegate>', '</delegate>', '<handoff>', '</handoff>'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (st.isFile()) out.push(full);
  }
  return out;
}

describe('shipped skills — removed sub-agent dispatch protocol', () => {
  const trees = SKILL_TREES.filter((d) => existsSync(d));

  it('has at least one skill tree to scan', () => {
    expect(trees.length).toBeGreaterThan(0);
  });

  it('no skill file mentions <delegate> or <handoff>', () => {
    const offenders: string[] = [];
    for (const tree of trees) {
      for (const file of walk(tree)) {
        let body: string;
        try {
          body = readFileSync(file, 'utf8');
        } catch {
          continue; // unreadable / binary — nothing to teach the model
        }
        const hits = FORBIDDEN.filter((tag) => body.includes(tag));
        if (hits.length > 0) {
          offenders.push(`${path.relative(REPO_ROOT, file)} → ${hits.join(', ')}`);
        }
      }
    }
    expect(
      offenders,
      `Shipped skill files still teach the removed dispatch protocol:\n${offenders.join('\n')}\n` +
        'Agents that read these emit a block the server rejects. Remove the tags.',
    ).toEqual([]);
  });

  it('the sessions skill documents that dispatch is gone', () => {
    const skill = readFileSync(
      path.join(REPO_ROOT, 'server', 'default-skills', 'agent-hub-sessions', 'SKILL.md'),
      'utf8',
    );
    expect(skill).toMatch(/no app-level sub-agent dispatch/i);
  });
});
