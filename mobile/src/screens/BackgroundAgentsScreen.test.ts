import { describe, expect, it } from 'vitest';
import { backgroundAgentsPatch } from '../utils/backgroundAgents';

describe('backgroundAgentsPatch', () => {
  it('keeps owner and model while applying the edited schedule', () => {
    const body = backgroundAgentsPatch(
      { enabled: true, schedule: '0 4 * * *', ownerUserId: 'user-1', model: 'opus' },
      [
        {
          id: 'custom-1',
          name: '  Digest ',
          prompt: 'Summarize',
          enabled: true,
          schedule: '',
          skills: ['wiki'],
        },
      ],
    );
    expect(body.backgroundAgents.wiki).toMatchObject({
      enabled: true,
      schedule: '0 4 * * *',
      ownerUserId: 'user-1',
      model: 'opus',
    });
    expect(body.backgroundAgents.custom[0]).toMatchObject({
      id: 'custom-1',
      name: 'Digest',
      schedule: '0 3 * * *',
      skills: ['wiki'],
      sessionMode: 'manual',
    });
  });

  it('defaults a workflow project custom agent to consult mode', () => {
    const body = backgroundAgentsPatch(
      { enabled: false },
      [{ id: 'a', name: 'A', prompt: 'p' }],
      'workflow',
    );
    expect(body.backgroundAgents.custom[0].sessionMode).toBe('consult');
  });
});
