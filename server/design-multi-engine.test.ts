import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppConfig, DesignMessageRow } from './types.js';
import {
  buildDesignSpawnArgs,
  buildDesignHistoryBootstrap,
  normalizeDesignEngine,
  resolveDesignModelForEngine,
  resolveDesignStudioModel,
  isDesignChatEngine,
} from './design-multi-engine.js';

function cfg(partial: Partial<AppConfig>): AppConfig {
  return partial as AppConfig;
}

const bins = {
  claude: '/bin/claude',
  cursor: '/bin/cursor',
  gemini: '/bin/gemini',
  codex: '/bin/codex',
};

const userMsg = (content: string): DesignMessageRow =>
  ({
    id: 'u1',
    design_id: 'd1',
    role: 'user',
    content,
    created_at: '2026-01-01',
  }) as DesignMessageRow;

describe('normalizeDesignEngine / isDesignChatEngine', () => {
  it('defaults null/empty/unknown to claude-code', () => {
    expect(normalizeDesignEngine(null)).toBe('claude-code');
    expect(normalizeDesignEngine('')).toBe('claude-code');
    expect(normalizeDesignEngine('  ')).toBe('claude-code');
    expect(normalizeDesignEngine('not-an-engine')).toBe('claude-code');
  });

  it('accepts known engine ids', () => {
    expect(normalizeDesignEngine('codex-cli')).toBe('codex-cli');
    expect(isDesignChatEngine('gemini-cli')).toBe(true);
    expect(isDesignChatEngine('gpt-5')).toBe(false);
  });
});

describe('resolveDesignModelForEngine / resolveDesignStudioModel', () => {
  it('uses allowlisted model when set', () => {
    const c = cfg({
      engineValidModels: { 'codex-cli': ['gpt-5.3-codex', 'gpt-5.2'] },
      engineDefaultModels: { 'codex-cli': 'gpt-5.3-codex' },
      defaultModel: 'x',
    });
    expect(resolveDesignModelForEngine('codex-cli', 'gpt-5.2', c)).toBe('gpt-5.2');
    expect(
      resolveDesignStudioModel(
        'claude-sonnet-4-6',
        cfg({
          engineValidModels: { 'claude-code': ['claude-opus-4-8', 'claude-sonnet-4-6'] },
          engineDefaultModels: { 'claude-code': 'claude-opus-4-8' },
          defaultModel: 'claude-opus-4-8',
        }),
      ),
    ).toBe('claude-sonnet-4-6');
  });

  it('falls back when missing or not on list', () => {
    const c = cfg({
      engineValidModels: { 'gemini-cli': ['gemini-2.5-pro'] },
      engineDefaultModels: { 'gemini-cli': 'gemini-2.5-pro' },
      defaultModel: 'fallback',
    });
    expect(resolveDesignModelForEngine('gemini-cli', null, c)).toBe('gemini-2.5-pro');
    expect(resolveDesignModelForEngine('gemini-cli', 'nope', c)).toBe('gemini-2.5-pro');
  });
});

describe('buildDesignHistoryBootstrap', () => {
  it('returns empty when no prior rows', () => {
    expect(buildDesignHistoryBootstrap([])).toBe('');
  });

  it('formats Human/Assistant transcript', () => {
    const prior: DesignMessageRow[] = [
      userMsg('hi'),
      { id: 'a1', design_id: 'd1', role: 'assistant', content: 'hello', created_at: '2026-01-01' },
    ];
    expect(buildDesignHistoryBootstrap(prior)).toContain('Human: hi');
    expect(buildDesignHistoryBootstrap(prior)).toContain('Assistant: hello');
  });
});

describe('buildDesignSpawnArgs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const baseInput = {
    designId: 'design-uuid-1',
    systemPrompt: 'SYS',
    cliContent: 'Do the thing',
    priorMessages: [] as DesignMessageRow[],
    bins,
  };

  it('claude-code: first turn uses --session-id and stream-json flags', () => {
    const { bin, args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      engineSessionId: null,
      isNewEngineSession: true,
    });
    expect(bin).toBe(bins.claude);
    expect(args).toContain('--print');
    expect(args).toContain('--session-id');
    expect(args[args.indexOf('--session-id') + 1]).toBe('design-uuid-1');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args[args.length - 1]).toBe('Do the thing');
  });

  it('claude-code: resume uses --resume', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'claude-code',
      model: 'claude-opus-4-8',
      engineSessionId: 'design-uuid-1',
      isNewEngineSession: false,
    });
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('design-uuid-1');
  });

  it('claude-code: resume without engine_session_id throws', () => {
    expect(() =>
      buildDesignSpawnArgs({
        ...baseInput,
        engine: 'claude-code',
        model: 'm',
        engineSessionId: null,
        isNewEngineSession: false,
      }),
    ).toThrow('claude-code resume requires engine_session_id');
  });

  it('cursor-agent: requires engineSessionId', () => {
    expect(() =>
      buildDesignSpawnArgs({
        ...baseInput,
        engine: 'cursor-agent',
        model: 'composer-2.5',
        engineSessionId: null,
        isNewEngineSession: true,
      }),
    ).toThrow('cursor-agent requires engineSessionId');
  });

  it('cursor-agent: first turn embeds system + prompt and resumes chat id', () => {
    const { bin, args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'cursor-agent',
      model: 'composer-2.5',
      engineSessionId: 'cur-abc',
      isNewEngineSession: true,
    });
    expect(bin).toBe(bins.cursor);
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toContain('SYS');
    expect(args[pIdx + 1]).toContain('Do the thing');
    expect(args).toContain('--resume');
    expect(args[args.indexOf('--resume') + 1]).toBe('cur-abc');
    expect(args).toContain('stream-json');
  });

  it('cursor-agent: follow-up sends only cli content', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'cursor-agent',
      model: 'composer-2.5',
      engineSessionId: 'cur-abc',
      isNewEngineSession: false,
      cliContent: 'Second turn',
    });
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toBe('Second turn');
  });

  it('gemini-cli: merges system + user prompt and adds --yolo', () => {
    const { bin, args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'gemini-cli',
      model: 'gemini-2.5-pro',
      engineSessionId: null,
      isNewEngineSession: true,
    });
    expect(bin).toBe(bins.gemini);
    expect(args[0]).toBe('-p');
    expect(args[1]).toContain('SYS');
    expect(args[1]).toContain('Do the thing');
    expect(args).toContain('--yolo');
  });

  it('gemini-cli: skips --model when auto', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'gemini-cli',
      model: 'auto',
      engineSessionId: null,
      isNewEngineSession: true,
    });
    expect(args.includes('--model')).toBe(false);
  });

  it('codex-cli: first exec has no resume subcommand', () => {
    const { bin, args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      engineSessionId: null,
      isNewEngineSession: true,
    });
    expect(bin).toBe(bins.codex);
    expect(args[0]).toBe('exec');
    expect(args.includes('resume')).toBe(false);
    expect(args[args.length - 1]).toContain('SYS');
  });

  it('codex-cli: codexDangerBypass uses bypass flag instead of --full-auto', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      engineSessionId: null,
      isNewEngineSession: true,
      codexDangerBypass: true,
    });
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--full-auto');
  });

  it('codex-cli: AWS SSO widens sandbox when codexDangerBypass is false', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      engineSessionId: null,
      isNewEngineSession: true,
      codexDangerBypass: false,
      awsSsoEnabled: true,
      awsAccessEnv: {
        HOME: '/data/u1/home',
        AWS_CONFIG_FILE: '/data/project-aws-config/p1/config',
      },
    });
    expect(args).toContain('danger-full-access');
    expect(args).not.toContain('--full-auto');
    expect(args).not.toContain('--add-dir');
  });

  it('codex-cli: resume inserts thread id', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      engineSessionId: 'thr-99',
      isNewEngineSession: false,
      cliContent: 'Continue',
    });
    expect(args[1]).toBe('resume');
    expect(args[2]).toBe('thr-99');
    expect(args[args.length - 1]).toBe('Continue');
  });

  it('codex-cli: resume without engine_session_id throws', () => {
    expect(() =>
      buildDesignSpawnArgs({
        ...baseInput,
        engine: 'codex-cli',
        model: 'gpt-5.3-codex',
        engineSessionId: null,
        isNewEngineSession: false,
      }),
    ).toThrow('codex-cli resume requires engine_session_id');
  });

  it('codex-cli: appends --profile when codexProfile is set', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      engineSessionId: null,
      isNewEngineSession: true,
      codexProfile: 'design-strict',
    });
    const idx = args.indexOf('--profile');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('design-strict');
    // Profile flag must precede the prompt (last positional argv element).
    expect(idx).toBeLessThan(args.length - 1);
  });

  it('codex-cli: omits --profile when codexProfile is null/empty/whitespace', () => {
    // Belt-and-braces: covers null, undefined, AND whitespace-only values that
    // could slip through a future PATCH config path.
    for (const profile of [null, undefined, '', '   ', '\t']) {
      const { args } = buildDesignSpawnArgs({
        ...baseInput,
        engine: 'codex-cli',
        model: 'gpt-5.3-codex',
        engineSessionId: null,
        isNewEngineSession: true,
        codexProfile: profile,
      });
      expect(args).not.toContain('--profile');
    }
  });

  it('codex-cli: trims surrounding whitespace from codexProfile', () => {
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'codex-cli',
      model: 'gpt-5.3-codex',
      engineSessionId: null,
      isNewEngineSession: true,
      codexProfile: '  design-strict  ',
    });
    const idx = args.indexOf('--profile');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('design-strict');
  });

  it('bootstraps prior messages on first engine session', () => {
    const prior = [
      userMsg('first'),
      { ...userMsg(''), id: 'a', role: 'assistant', content: 'ok' } as DesignMessageRow,
    ];
    const { args } = buildDesignSpawnArgs({
      ...baseInput,
      engine: 'claude-code',
      model: 'm',
      priorMessages: prior,
      engineSessionId: null,
      isNewEngineSession: true,
    });
    const last = args[args.length - 1] as string;
    expect(last).toContain('Previous conversation:');
    expect(last).toContain('Human: first');
    expect(last).toContain('Human: Do the thing');
  });
});
