import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  backfillSkillBuilderAgents,
  SKILL_BUILDER_BACKFILL_MARKER,
} from './backfill-skill-builder-agents.js';

describe('backfillSkillBuilderAgents', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'sb-backfill-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('runs the seed and writes the marker on first call', () => {
    const ensure = vi.fn();

    const result = backfillSkillBuilderAgents({ dataDir, ensureSkillBuilderAgents: ensure });

    expect(result.ran).toBe(true);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(existsSync(result.markerPath)).toBe(true);
    expect(result.markerPath).toBe(path.join(dataDir, SKILL_BUILDER_BACKFILL_MARKER));
  });

  it('is a no-op once the marker exists — does not re-seed (respects deletions)', () => {
    const ensure = vi.fn();

    const first = backfillSkillBuilderAgents({ dataDir, ensureSkillBuilderAgents: ensure });
    expect(first.ran).toBe(true);

    // A second boot (e.g. after a user deleted their coach) must not run again.
    const second = backfillSkillBuilderAgents({ dataDir, ensureSkillBuilderAgents: ensure });

    expect(second.ran).toBe(false);
    expect(ensure).toHaveBeenCalledTimes(1); // still only the first run
  });

  it('treats a pre-existing marker as already-done without calling the seed', () => {
    writeFileSync(path.join(dataDir, SKILL_BUILDER_BACKFILL_MARKER), 'prior-run\n', 'utf-8');
    const ensure = vi.fn();

    const result = backfillSkillBuilderAgents({ dataDir, ensureSkillBuilderAgents: ensure });

    expect(result.ran).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('writes the marker AFTER seeding so a crash mid-seed re-runs next boot', () => {
    const order: string[] = [];
    const ensure = vi.fn(() => {
      // At the moment the seed runs, the marker must not exist yet.
      order.push(`marker-exists:${existsSync(path.join(dataDir, SKILL_BUILDER_BACKFILL_MARKER))}`);
    });

    backfillSkillBuilderAgents({ dataDir, ensureSkillBuilderAgents: ensure });

    expect(order).toEqual(['marker-exists:false']);
  });

  it('stamps the marker with the provided timestamp', () => {
    const ensure = vi.fn();

    const result = backfillSkillBuilderAgents({
      dataDir,
      ensureSkillBuilderAgents: ensure,
      nowIso: () => '2026-06-22T00:00:00.000Z',
    });

    expect(readFileSync(result.markerPath, 'utf-8')).toBe('2026-06-22T00:00:00.000Z\n');
  });

  it('creates the data dir if it does not yet exist', () => {
    const nested = path.join(dataDir, 'does', 'not', 'exist');
    const ensure = vi.fn();

    const result = backfillSkillBuilderAgents({
      dataDir: nested,
      ensureSkillBuilderAgents: ensure,
    });

    expect(result.ran).toBe(true);
    expect(existsSync(result.markerPath)).toBe(true);
  });
});
