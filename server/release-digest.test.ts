import { describe, expect, it, vi } from 'vitest';
import { runModelOnlyReleaseDigest } from './release-digest-model.js';
import type { AppConfig } from './types.js';

describe('runModelOnlyReleaseDigest', () => {
  it('uses a model-only OpenAI request without tools, cwd, or env access', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '## Release digest\n\nCSV export is fixed.' } }],
      }),
    })) as unknown as typeof fetch;

    const digest = await runModelOnlyReleaseDigest({
      prompt: 'Operator guidance plus release facts',
      cfg: { openaiApiKey: 'sk-test' } as AppConfig,
      fetchImpl,
    });

    expect(digest).toBe('## Release digest\n\nCSV export is fixed.');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer sk-test',
          'content-type': 'application/json',
        }),
      }),
    );
    const body = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(body).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [
        expect.objectContaining({
          role: 'system',
          content: expect.stringContaining('no tools, no filesystem access'),
        }),
        { role: 'user', content: 'Operator guidance plus release facts' },
      ],
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('cwd');
    expect(body).not.toHaveProperty('env');
  });

  it('requires an OpenAI key instead of falling back to an agentic CLI', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await expect(
      runModelOnlyReleaseDigest({
        prompt: 'release facts',
        cfg: { openaiApiKey: null } as AppConfig,
        fetchImpl,
      }),
    ).rejects.toThrow('OpenAI API key is required');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
