import { describe, it, expect } from 'vitest';
import {
  appendDevAgentShippingContract,
  applyOnboardDevAgentShippingContracts,
  SHIPPING_CONTRACT_MARKER,
  buildDevAgentShippingContract,
} from './shipping-prompt.js';
import type { Project } from '../types.js';

const project = {
  id: 'demo',
  name: 'Demo App',
  cwd: '/tmp/demo',
  ahw: '/tmp/demo-ahw',
  color: '#6366F1',
  agents: [],
  githubRepo: 'acme/demo',
} as Project;

describe('shipping-prompt', () => {
  it('buildDevAgentShippingContract mentions Finalize and no direct push', () => {
    const text = buildDevAgentShippingContract(project);
    expect(text).toContain('Finalize Code Changes');
    expect(text).toContain('git push');
    expect(text).toContain('Send It');
  });

  it('appendDevAgentShippingContract is idempotent', () => {
    const once = appendDevAgentShippingContract('You are a dev.', project);
    expect(once).toContain(SHIPPING_CONTRACT_MARKER);
    const twice = appendDevAgentShippingContract(once, project);
    expect(twice.match(new RegExp(SHIPPING_CONTRACT_MARKER, 'g'))).toHaveLength(1);
  });

  it('applyOnboardDevAgentShippingContracts patches dev agents only', () => {
    const p = {
      ...project,
      agents: [
        {
          id: 'dev',
          name: 'Dev',
          engine: 'claude-code',
          role: 'dev',
          systemPrompt: 'Build features.',
        },
        {
          id: 'rev',
          name: 'Rev',
          engine: 'claude-code',
          role: 'reviewer',
          systemPrompt: 'Review only.',
        },
      ],
    } as Project;
    expect(applyOnboardDevAgentShippingContracts(p)).toBe(true);
    expect(p.agents[0].systemPrompt).toContain(SHIPPING_CONTRACT_MARKER);
    expect(p.agents[1].systemPrompt).not.toContain(SHIPPING_CONTRACT_MARKER);
  });
});
