/**
 * Source-shape contract: the board.ts epic create/update handlers must
 * eagerly call `ensureOperatorBaseBranch` when the operator sets a
 * non-blank `prBaseBranch`. Mirrors the pattern in
 * `autonomous-umbrella-branch.test.ts` (the runAutonomousLoop contract).
 *
 * Why a source-shape test rather than a full integration test? The
 * helper makes git network calls via `promisify(execFile)`. Mocking
 * `child_process` for a supertest run that boots the whole app is brittle
 * (every other module that uses `execFile` would need a passthrough); the
 * helper itself already has dedicated unit coverage in
 * `autonomous-umbrella-branch.test.ts`. What we want to lock in here is
 * the *call site* in board.ts — that's a per-route contract that's easy
 * to lose to a future refactor and trivial to assert against the source.
 */

import './setup.js';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

function extractHandlerBody(src: string, anchor: RegExp): string {
  const startMatch = src.match(anchor);
  if (!startMatch || startMatch.index == null) {
    throw new Error(`Anchor ${anchor} not found in board.ts source`);
  }
  // Find the first `{` after the anchor (the arrow-function / async-callback
  // body open) and walk to the matching `}`.
  const openBrace = src.indexOf('{', startMatch.index);
  if (openBrace < 0) throw new Error(`No '{' after anchor ${anchor}`);
  let depth = 0;
  for (let i = openBrace; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openBrace, i + 1);
    }
  }
  throw new Error(`Unbalanced braces after anchor ${anchor}`);
}

describe('board.ts — epic prBaseBranch eager-create contract', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.resolve(here, '..', 'routes', 'board.ts'), 'utf8');

  it('imports ensureOperatorBaseBranch from autonomous.js', () => {
    expect(
      /import\s*\{[^}]*\bensureOperatorBaseBranch\b[^}]*\}\s*from\s*['"]\.\.\/autonomous\.js['"]/.test(
        src,
      ),
      'board.ts must import ensureOperatorBaseBranch from ../autonomous.js so the epic routes can call it directly',
    ).toBe(true);
  });

  it('POST /board/epics calls ensureOperatorBaseBranch when prBaseBranch is set', () => {
    const body = extractHandlerBody(
      src,
      /router\.post\(\s*['"]\/api\/projects\/:projectId\/board\/epics['"]/,
    );
    expect(
      body.includes('ensureOperatorBaseBranch('),
      'POST /board/epics must call ensureOperatorBaseBranch so operator-typed integration branches land on origin before any session opens an auto-PR against them',
    ).toBe(true);
    // Must be gated on truthiness — blank/null prBaseBranch must not trigger
    // a git probe.
    expect(
      /pr_base_branch\s*&&[\s\S]{0,400}ensureOperatorBaseBranch\(/.test(body),
      'POST /board/epics must only call ensureOperatorBaseBranch when the resulting pr_base_branch is truthy',
    ).toBe(true);
  });

  it('PUT /board/epics/:epicId calls ensureOperatorBaseBranch when prBaseBranch is set', () => {
    const body = extractHandlerBody(
      src,
      /router\.put\(\s*['"]\/api\/projects\/:projectId\/board\/epics\/:epicId['"]/,
    );
    expect(
      body.includes('ensureOperatorBaseBranch('),
      'PUT /board/epics/:epicId must call ensureOperatorBaseBranch so updating the integration branch eagerly creates it on origin',
    ).toBe(true);
    // Must be gated on the PUT payload actually carrying a non-blank
    // prBaseBranch (`hasEpicPrBasePut && nextEpicPrBaseField`). PUT bodies
    // that omit the key preserve the existing value — they must NOT
    // re-trigger a git push every time the operator saves the epic for an
    // unrelated field change.
    expect(
      /hasEpicPrBasePut\s*&&[\s\S]{0,400}ensureOperatorBaseBranch\(/.test(body),
      'PUT /board/epics/:epicId must only call ensureOperatorBaseBranch when the request explicitly set prBaseBranch (hasEpicPrBasePut)',
    ).toBe(true);
  });
});
