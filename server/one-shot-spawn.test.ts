// Tests for the unified one-shot spawn helper. We exercise the
// pure-function arg builder for each engine; the actual `spawn()` flow
// is covered indirectly by the existing summarize tests. The arg
// builder is what could silently regress when adding a new engine, so
// it's the highest-value layer to lock down.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildOneShotSpawnArgs } from './one-shot-spawn.js';
import type { AppConfig } from './types.js';

const CFG: AppConfig = {
  claudeBin: '/bin/claude',
  cursorBin: '/bin/cursor-agent',
  geminiBin: '/bin/gemini',
  codexBin: '/bin/codex',
  grokBin: '/bin/grok',
} as AppConfig;

const tempHomes: string[] = [];

afterEach(() => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function writeCodexHomeWithModels(home: string, models: string[]): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  writeFileSync(
    join(home, 'models_cache.json'),
    JSON.stringify({ client_version: '0.144.3', models: models.map((slug) => ({ slug })) }),
  );
}

function codexHomeWithModels(models: string[]): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-hub-codex-models-'));
  writeCodexHomeWithModels(home, models);
  tempHomes.push(home);
  return home;
}

describe('buildOneShotSpawnArgs — claude-code', () => {
  it('emits --print + permission mode + model + system + prompt with -- terminator', () => {
    const out = buildOneShotSpawnArgs(
      {
        engine: 'claude-code',
        model: 'claude-sonnet-4-5',
        prompt: 'do the thing',
        systemPrompt: 'be helpful',
      },
      CFG,
    );
    expect(out.bin).toBe('/bin/claude');
    expect(out.args[0]).toBe('--print');
    expect(out.args).toContain('--permission-mode');
    expect(out.args).toContain('bypassPermissions');
    expect(out.args).toContain('--model');
    expect(out.args).toContain('claude-sonnet-4-5');
    expect(out.args).toContain('--system-prompt');
    expect(out.args).toContain('be helpful');
    // The `--` terminator must precede the prompt so the variadic
    // --disallowed-tools doesn't swallow it.
    const dashIdx = out.args.indexOf('--');
    expect(dashIdx).toBeGreaterThan(0);
    expect(out.args[dashIdx + 1]).toBe('do the thing');
  });

  it('omits --model when no model is provided', () => {
    const out = buildOneShotSpawnArgs({ engine: 'claude-code', model: '', prompt: 'p' }, CFG);
    expect(out.args).not.toContain('--model');
  });
});

describe('buildOneShotSpawnArgs — cursor-agent', () => {
  it('emits --print --force --model and the prompt as a positional', () => {
    const out = buildOneShotSpawnArgs(
      { engine: 'cursor-agent', model: 'auto', prompt: 'do it' },
      CFG,
    );
    expect(out.bin).toBe('/bin/cursor-agent');
    expect(out.args).toContain('--print');
    expect(out.args).toContain('--force');
    expect(out.args).toContain('--model');
    expect(out.args).toContain('auto');
    expect(out.args[out.args.length - 1]).toBe('do it');
  });

  it('passes --system-prompt when supplied', () => {
    const out = buildOneShotSpawnArgs(
      { engine: 'cursor-agent', model: 'auto', prompt: 'p', systemPrompt: 's' },
      CFG,
    );
    expect(out.args).toContain('--system-prompt');
    expect(out.args).toContain('s');
  });
});

describe('buildOneShotSpawnArgs — gemini-cli', () => {
  it('concatenates system + prompt because gemini lacks --system-prompt', () => {
    const out = buildOneShotSpawnArgs(
      { engine: 'gemini-cli', model: 'gemini-2.0-flash', prompt: 'P', systemPrompt: 'S' },
      CFG,
    );
    expect(out.bin).toBe('/bin/gemini');
    expect(out.args[0]).toBe('-p');
    expect(out.args[1]).toBe('S\n\nP');
    expect(out.args).toContain('--model');
    expect(out.args).toContain('gemini-2.0-flash');
  });

  it('omits --model when model is "auto"', () => {
    const out = buildOneShotSpawnArgs({ engine: 'gemini-cli', model: 'auto', prompt: 'P' }, CFG);
    expect(out.args).not.toContain('--model');
  });
});

describe('buildOneShotSpawnArgs — grok-cli', () => {
  it('concatenates system + prompt and sets headless flags', () => {
    const out = buildOneShotSpawnArgs(
      { engine: 'grok-cli', model: 'grok-composer-2.5-fast', prompt: 'P', systemPrompt: 'S' },
      CFG,
    );
    expect(out.bin).toBe('/bin/grok');
    expect(out.args[0]).toBe('-p');
    expect(out.args[1]).toBe('S\n\nP');
    expect(out.args).toContain('--no-auto-update');
    expect(out.args).toContain('--always-approve');
    expect(out.args).toContain('--model');
    expect(out.args).toContain('grok-composer-2.5-fast');
  });

  it('omits --model when no model is provided', () => {
    const out = buildOneShotSpawnArgs({ engine: 'grok-cli', model: '', prompt: 'P' }, CFG);
    expect(out.args).not.toContain('--model');
    expect(out.args[1]).toBe('P');
  });

  it('maps retired grok-build-0.1 to grok-build when allowlist is configured', () => {
    const cfg = {
      ...CFG,
      engineValidModels: { 'grok-cli': ['grok-build', 'grok-composer-2.5-fast'] },
      engineDefaultModels: { 'grok-cli': 'grok-composer-2.5-fast' },
    } as AppConfig;
    const out = buildOneShotSpawnArgs(
      { engine: 'grok-cli', model: 'grok-build-0.1', prompt: 'P' },
      cfg,
    );
    expect(out.args).toContain('--model');
    expect(out.args).toContain('grok-build');
  });
});

describe('buildOneShotSpawnArgs — codex-cli', () => {
  it('passes the Luna default when the installed CLI advertises it', () => {
    const home = codexHomeWithModels(['gpt-5.6-luna']);
    const out = buildOneShotSpawnArgs(
      { engine: 'codex-cli', model: 'gpt-5.6-luna', prompt: 'P', env: { CODEX_HOME: home } },
      CFG,
    );
    expect(out.args).toContain('--model');
    expect(out.args).toContain('gpt-5.6-luna');
  });

  it('drops the Luna default when the installed CLI does not advertise it', () => {
    const home = codexHomeWithModels(['gpt-5.5']);
    const out = buildOneShotSpawnArgs(
      { engine: 'codex-cli', model: 'gpt-5.6-luna', prompt: 'P', env: { CODEX_HOME: home } },
      CFG,
    );
    expect(out.args).not.toContain('--model');
    expect(out.args).not.toContain('gpt-5.6-luna');
  });

  it('uses the resolved data-dir Codex home for both auth and capability probes', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-hub-codex-data-'));
    tempHomes.push(dataDir);
    const codexHome = join(dataDir, 'host-creds', 'home', '.codex');
    writeCodexHomeWithModels(codexHome, ['gpt-5.6-luna']);
    const out = buildOneShotSpawnArgs(
      { engine: 'codex-cli', model: 'gpt-5.6-luna', prompt: 'P', env: {} },
      { ...CFG, dataDir } as AppConfig,
    );
    expect(out.args).toContain('--model');
    expect(out.args).toContain('gpt-5.6-luna');
  });

  it('emits exec --json --skip-git-repo-check --sandbox read-only and the body', () => {
    const out = buildOneShotSpawnArgs(
      {
        engine: 'codex-cli',
        model: '',
        prompt: 'P',
        systemPrompt: 'S',
        env: {
          HOME: '/tmp/agent-hub-home',
          PATH: '/app/server/default-skills/agent-hub/scripts:/usr/bin',
          AGENT_HUB_SKILLS_DIR: '/app/server/default-skills/agent-hub',
        },
      },
      CFG,
    );
    expect(out.bin).toBe('/bin/codex');
    expect(out.args.slice(0, 5)).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
    ]);
    // Body is the last positional and includes the system prompt.
    expect(out.args[out.args.length - 1]).toBe('S\n\nP');
    expect(out.args).toContain(
      'shell_environment_policy.set.PATH="/app/server/default-skills/agent-hub/scripts:/usr/bin"',
    );
  });

  it('appends --profile when cfg.codexProfile is set', () => {
    const cfgWithProfile = { ...CFG, codexProfile: 'oneshot-profile' } as AppConfig;
    const out = buildOneShotSpawnArgs(
      { engine: 'codex-cli', model: '', prompt: 'P', systemPrompt: 'S' },
      cfgWithProfile,
    );
    const idx = out.args.indexOf('--profile');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out.args[idx + 1]).toBe('oneshot-profile');
    // Must precede the prompt body (last positional).
    expect(idx).toBeLessThan(out.args.length - 1);
  });

  it('omits --profile when cfg.codexProfile is null/empty/whitespace', () => {
    // Belt-and-braces: covers null, undefined, AND whitespace-only values that
    // could slip through a future PATCH config path.
    for (const profile of [null, undefined, '', '   ', '\t']) {
      const cfg = { ...CFG, codexProfile: profile } as AppConfig;
      const out = buildOneShotSpawnArgs(
        { engine: 'codex-cli', model: '', prompt: 'P', systemPrompt: 'S' },
        cfg,
      );
      expect(out.args).not.toContain('--profile');
    }
  });

  it('trims surrounding whitespace from cfg.codexProfile', () => {
    const cfg = { ...CFG, codexProfile: '  oneshot-profile  ' } as AppConfig;
    const out = buildOneShotSpawnArgs(
      { engine: 'codex-cli', model: '', prompt: 'P', systemPrompt: 'S' },
      cfg,
    );
    const idx = out.args.indexOf('--profile');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out.args[idx + 1]).toBe('oneshot-profile');
  });
});
