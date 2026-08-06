import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CODEX_CAPABILITY_MODELS,
  CODEX_DEFAULT_MODEL,
  readCodexModelsCache,
  advertisedCapabilityModels,
  resolveSelectableCodexModels,
  codexHomeFromEnv,
  __resetCodexModelsCacheMemo,
} from './codex-model-capability.js';

const BASELINE = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2'];

function writeCache(home: string, models: string[], clientVersion = '0.144.0'): string {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'models_cache.json');
  writeFileSync(
    path,
    JSON.stringify({
      fetched_at: '2026-07-13T00:00:00Z',
      etag: 'abc',
      client_version: clientVersion,
      models: models.map((slug) => ({ slug, display_name: slug })),
    }),
  );
  return path;
}

describe('codex-model-capability', () => {
  let dir: string;

  beforeEach(() => {
    __resetCodexModelsCacheMemo();
    dir = mkdtempSync(join(tmpdir(), 'codex-cap-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    __resetCodexModelsCacheMemo();
  });

  describe('readCodexModelsCache', () => {
    it('parses client_version and model slugs', () => {
      const home = join(dir, 'home1');
      writeCache(home, ['gpt-5.6-sol', 'gpt-5.5'], '0.144.0');
      const cache = readCodexModelsCache(home);
      expect(cache).not.toBeNull();
      expect(cache!.clientVersion).toBe('0.144.0');
      expect(cache!.modelSlugs.has('gpt-5.6-sol')).toBe(true);
      expect(cache!.modelSlugs.has('gpt-5.5')).toBe(true);
      expect(cache!.modelSlugs.has('gpt-5.6-luna')).toBe(false);
    });

    it('returns null for a missing cache', () => {
      expect(readCodexModelsCache(join(dir, 'nope'))).toBeNull();
    });

    it('returns null for malformed JSON (never throws)', () => {
      const home = join(dir, 'bad');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'models_cache.json'), '{not valid json');
      expect(readCodexModelsCache(home)).toBeNull();
    });

    it('tolerates a cache with no models array', () => {
      const home = join(dir, 'empty');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, 'models_cache.json'), JSON.stringify({ client_version: '0.142.0' }));
      const cache = readCodexModelsCache(home);
      expect(cache).not.toBeNull();
      expect(cache!.clientVersion).toBe('0.142.0');
      expect(cache!.modelSlugs.size).toBe(0);
    });

    it('re-reads when the file mtime changes (memo invalidation)', () => {
      const home = join(dir, 'memo');
      writeCache(home, ['gpt-5.5'], '0.142.0');
      expect(readCodexModelsCache(home)!.modelSlugs.has('gpt-5.6-sol')).toBe(false);

      // Rewrite with a newer mtime and gpt-5.6-sol present.
      writeCache(home, ['gpt-5.6-sol', 'gpt-5.5'], '0.144.0');
      const future = new Date(Date.now() + 5000);
      utimesSync(join(home, 'models_cache.json'), future, future);
      expect(readCodexModelsCache(home)!.modelSlugs.has('gpt-5.6-sol')).toBe(true);
    });
  });

  describe('advertisedCapabilityModels', () => {
    it('returns [] for a null cache', () => {
      expect(advertisedCapabilityModels(null)).toEqual([]);
    });

    it('returns only advertised gated models, in canonical order', () => {
      const home = join(dir, 'adv');
      // Advertised out of order + includes a non-gated slug.
      writeCache(home, ['gpt-5.6-luna', 'gpt-5.5', 'gpt-5.6-sol']);
      const out = advertisedCapabilityModels(readCodexModelsCache(home));
      expect(out).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna']);
    });
  });

  describe('resolveSelectableCodexModels', () => {
    it('returns baseline only when cache is null (safe fallback)', () => {
      expect(resolveSelectableCodexModels(BASELINE, null)).toEqual(BASELINE);
    });

    it('returns baseline only when the CLI advertises no gated models (0.142.0 host)', () => {
      const home = join(dir, 'old');
      writeCache(home, ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'], '0.142.0');
      expect(resolveSelectableCodexModels(BASELINE, readCodexModelsCache(home))).toEqual(BASELINE);
    });

    it('prepends advertised gated models when the CLI can serve them (0.144.0 host)', () => {
      const home = join(dir, 'new');
      writeCache(home, ['gpt-5.6-sol', 'gpt-5.5', 'gpt-5.4'], '0.144.0');
      expect(resolveSelectableCodexModels(BASELINE, readCodexModelsCache(home))).toEqual([
        'gpt-5.6-sol',
        ...BASELINE,
      ]);
    });

    it('de-duplicates if a gated model somehow appears in the baseline', () => {
      const home = join(dir, 'dup');
      writeCache(home, ['gpt-5.6-sol']);
      const out = resolveSelectableCodexModels(
        ['gpt-5.6-sol', 'gpt-5.5'],
        readCodexModelsCache(home),
      );
      expect(out).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
    });
  });

  describe('codexHomeFromEnv', () => {
    it('prefers CODEX_HOME', () => {
      expect(codexHomeFromEnv({ CODEX_HOME: '/x/codex', HOME: '/home/u' })).toBe('/x/codex');
    });

    it('falls back to HOME/.codex', () => {
      expect(codexHomeFromEnv({ HOME: '/home/u' })).toBe(join('/home/u', '.codex'));
    });
  });

  it('CODEX_CAPABILITY_MODELS are the real tiered gpt-5.6 ids (not a bare gpt-5.6)', () => {
    expect(CODEX_CAPABILITY_MODELS).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(CODEX_CAPABILITY_MODELS).not.toContain('gpt-5.6');
  });

  it('CODEX_DEFAULT_MODEL is Sol — the newest capability-gated model', () => {
    expect(CODEX_DEFAULT_MODEL).toBe('gpt-5.6-sol');
    // The default must stay the head of the picker list: capability resolution
    // prepends advertised gated models newest-first, so a default further down
    // would leave the picker's top entry disagreeing with the default.
    expect(CODEX_DEFAULT_MODEL).toBe(CODEX_CAPABILITY_MODELS[0]);
    const allAdvertised = {
      clientVersion: '0.144.0',
      modelSlugs: new Set(CODEX_CAPABILITY_MODELS),
      path: '/tmp/models_cache.json',
    };
    expect(resolveSelectableCodexModels(BASELINE, allAdvertised)[0]).toBe(CODEX_DEFAULT_MODEL);
  });
});
