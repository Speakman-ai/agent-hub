import { describe, it, expect } from 'vitest';
import { buildHubModePreamble, requiredHubSkillIds } from './hub-mode-prompt.js';

describe('hub-mode-prompt', () => {
  it('force-loads Hub skills only in hub mode', () => {
    expect(requiredHubSkillIds({ session_mode: 'hub' })).toEqual([
      'agent-hub',
      'agent-hub-kanban',
      'agent-hub-sessions',
      'agent-hub-heartbeats-crons',
    ]);
    expect(requiredHubSkillIds({ session_mode: 'consult' })).toEqual([]);
  });

  it('forbids scraping Agent Hub and unbounded spawns', () => {
    const text = buildHubModePreamble({ browserToolsEnabled: true });
    expect(text).toContain('## Hub');
    expect(text).toContain('do not scrape Agent Hub itself');
    expect(text).toContain('more than one');
    expect(text).toContain('GET /api/me/dashboard');
    expect(text).toContain('Dashboard (assigned work');
  });
});
