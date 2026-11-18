import { describe, expect, it } from 'vitest';
import { extractForwardBlocks } from '../shared/utils/extractForwardBlocks.js';
import { buildSessionForwardGuidance } from './session-forward-prompt.js';

describe('buildSessionForwardGuidance', () => {
  it('tells a Build session to emit a forward card instead of dispatching', () => {
    const text = buildSessionForwardGuidance({ projectId: 'acme-app', agentId: 'st-dev' });
    expect(text).toContain('forward this session');
    expect(text).toContain('do **not** run `sessions.sh dispatch`');
    expect(text).toContain('"projectId": "acme-app"');
    expect(text).toContain('"agentId": "st-dev"');
    expect(text).toContain('Build and Review (`review`)');
  });

  it('example block parses as a real forward card for this project and agent', () => {
    const text = buildSessionForwardGuidance({ projectId: 'acme-app', agentId: 'st-dev' });
    const blocks = extractForwardBlocks(text).forwards;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ projectId: 'acme-app', agentId: 'st-dev' });
  });

  it('suggests consult on workflow projects', () => {
    const text = buildSessionForwardGuidance({ projectId: 'ops', agentId: 'a', workflow: true });
    expect(text).toContain('set `"mode": "consult"`');
    expect(text).not.toContain('Build and Review');
  });
});
