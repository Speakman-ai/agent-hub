import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// server/autopilot -> repo root is two levels up.
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUIDE = path.join(REPO_ROOT, 'docs', 'guides', 'experimental-autopilot.md');

describe('autopilot operator runbook', () => {
  it('is published as a docs guide', () => {
    expect(existsSync(GUIDE)).toBe(true);
  });

  it('documents setup and a recovery runbook without requiring a shell', () => {
    const doc = readFileSync(GUIDE, 'utf8');
    // Setup surface: per-project enablement, opt-in config, readiness/start.
    expect(doc).toMatch(/Enable Autopilot for the project/i);
    expect(doc).toMatch(/per project/i);
    expect(doc).toMatch(/Readiness and Start/i);
    expect(doc).toMatch(/Pause, Resume, Stop/i);
    // Recovery runbook covers the induced-failure paths this epic validates.
    expect(doc).toMatch(/Recovery runbook/i);
    expect(doc).toMatch(/failed recovery/i);
    expect(doc).toMatch(/wrong live revision/i);
    expect(doc).toMatch(/budget exhaustion/i);
    expect(doc).toMatch(/no-improvement plateau/i);
  });

  it('states the explicit limit of evaluator scores', () => {
    // Collapse wrapping so multi-line phrases still match.
    const doc = readFileSync(GUIDE, 'utf8').replace(/\s+/g, ' ');
    expect(doc).toMatch(/not proof of product value/i);
    expect(doc).toMatch(/monotonic improvement/i);
  });

  it('states that recovery is a code-only rollback, not a database rollback', () => {
    const doc = readFileSync(GUIDE, 'utf8').replace(/\s+/g, ' ');
    expect(doc).toMatch(/code rollback is not a database rollback/i);
  });
});
