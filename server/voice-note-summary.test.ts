import { describe, it, expect, vi } from 'vitest';
import type { AppConfig } from './types.js';

vi.mock('./hub-assistant.js', () => ({
  resolveHubEngineAndModel: vi.fn(() => ({ engine: 'codex-cli', model: 'gpt-user-pick' })),
}));
vi.mock('./per-user-cli-spawn.js', () => ({
  resolveSessionCliSpawnEnv: vi.fn(({ engine }: { engine: string }) => ({ ENGINE: engine })),
  EngineAuthRequiredError: class extends Error {},
}));

const { summarizeVoiceTranscript, cleanVoiceSummaryOutput } =
  await import('./voice-note-summary.js');

const cfg = {} as AppConfig;

function outcome(stdout: string, code = 0, engine = 'codex-cli', model = 'gpt-user-pick') {
  return {
    engine,
    model,
    detailed: { code, stdout, stderr: code ? 'boom' : '', timedOut: false },
    output: stdout,
    failovers: [],
  } as any;
}

describe('summarizeVoiceTranscript', () => {
  it("runs the caller's default engine/model through the failover runner", async () => {
    const resolveEngine = vi.fn(async () => ({ engine: 'codex-cli', model: 'gpt-user-pick' }));
    const runFailover = vi.fn(async () =>
      outcome('**Call Bob.**\n\n- [ ] Call Bob', 0, 'claude-code', 'claude-opus-5-5'),
    );
    const res = await summarizeVoiceTranscript({
      userId: 'u1',
      transcript: '  uh call bob  ',
      config: cfg,
      resolveEngine: resolveEngine as any,
      runFailover,
      cwd: '/tmp',
    });
    expect(resolveEngine).toHaveBeenCalledWith(cfg, {
      userId: 'u1',
      agentId: expect.any(String),
      preferred: 'codex-cli',
      preferredModel: 'gpt-user-pick',
    });
    const input = (runFailover.mock.calls[0] as any)[0];
    expect(input).toMatchObject({ engine: 'codex-cli', model: 'gpt-user-pick', userId: 'u1' });
    expect(input.prompt).toContain('<transcript>\nuh call bob\n</transcript>');
    expect(input.systemPrompt).toMatch(/Markdown/);
    expect(input.buildEnv('grok-cli')).toEqual({ ENGINE: 'grok-cli' });
    // Reports the engine that actually answered after failover.
    expect(res).toEqual({
      summary: '**Call Bob.**\n\n- [ ] Call Bob',
      engine: 'claude-code',
      model: 'claude-opus-5-5',
    });
  });

  it('throws when every engine failed', async () => {
    await expect(
      summarizeVoiceTranscript({
        userId: 'u1',
        transcript: 'x',
        config: cfg,
        resolveEngine: (async () => ({ engine: 'claude-code', model: 'm' })) as any,
        runFailover: async () => outcome('partial', 1),
        cwd: '/tmp',
      }),
    ).rejects.toThrow('boom');
  });
});

describe('cleanVoiceSummaryOutput', () => {
  it('returns clean markdown', () => {
    expect(cleanVoiceSummaryOutput('```markdown\n**Gist.**\n- a\n```')).toBe('**Gist.**\n- a');
    expect(cleanVoiceSummaryOutput('## Summary\n\n**Gist.**')).toBe('**Gist.**');
    expect(cleanVoiceSummaryOutput('**Summary:**\n**Gist.**')).toBe('**Gist.**');
    expect(cleanVoiceSummaryOutput('**Gist.**\n\n\n\n</details>- a <br/>b')).toBe(
      '**Gist.**\n\n- a b',
    );
    expect(cleanVoiceSummaryOutput('x < 3 and a<b')).toBe('x < 3 and a<b');
  });
});
