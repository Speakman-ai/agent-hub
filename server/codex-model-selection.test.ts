import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveCodexModelSelection } from './codex-model-selection.js';

describe('resolveCodexModelSelection', () => {
  const tempHomes: string[] = [];

  afterEach(() => {
    for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function makeCodexHome(authMode: 'chatgpt' | 'apikey', models: string[]): string {
    const home = mkdtempSync(join(tmpdir(), 'agent-hub-codex-selection-'));
    tempHomes.push(home);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: authMode }));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'models_cache.json'),
      JSON.stringify({ models: models.map((slug) => ({ slug })) }),
    );
    return home;
  }

  it('uses the spawn environment home for a per-user GPT-5.6 capability check', () => {
    const home = makeCodexHome('chatgpt', ['gpt-5.6-luna']);

    const selection = resolveCodexModelSelection('gpt-5.6-luna', { CODEX_HOME: home });

    expect(selection).toEqual({
      passModel: true,
      authMode: 'chatgpt',
      codexHome: home,
    });
  });

  it('uses the spawn home auth mode when the process home is different', () => {
    const home = makeCodexHome('chatgpt', ['gpt-5.5']);

    const selection = resolveCodexModelSelection('gpt-5.6-luna', { CODEX_HOME: home });

    expect(selection.authMode).toBe('chatgpt');
    expect(selection.passModel).toBe(false);
  });

  it('honors a resolved host Codex home even when HOME points elsewhere', () => {
    const home = makeCodexHome('chatgpt', ['gpt-5.5']);
    const processHome = makeCodexHome('apikey', ['gpt-5.6-luna']);

    const selection = resolveCodexModelSelection('gpt-5.6-luna', { HOME: processHome }, home);

    expect(selection.codexHome).toBe(home);
    expect(selection.authMode).toBe('chatgpt');
    expect(selection.passModel).toBe(false);
  });
});
