import { describe, it, expect } from 'vitest';
import { buildNoteScopingKickoff } from './note-scoping.js';

describe('buildNoteScopingKickoff', () => {
  it('embeds the project name, title, and trimmed content', () => {
    const out = buildNoteScopingKickoff({
      content: '\n- one\n- two\n',
      title: 'Templates',
      projectName: 'Acme',
    });
    expect(out).toContain('"Acme"');
    expect(out).toContain('**Source:** Templates');
    expect(out).toContain('- one\n- two');
    // Trims the leading/trailing whitespace of the content block.
    expect(out).not.toMatch(/## Notes\n\n\n/);
  });

  it('falls back to "Untitled notes" when no title is given', () => {
    const out = buildNoteScopingKickoff({ content: 'x', title: null, projectName: 'Acme' });
    expect(out).toContain('**Source:** Untitled notes');
    const out2 = buildNoteScopingKickoff({ content: 'x', title: '   ', projectName: 'Acme' });
    expect(out2).toContain('**Source:** Untitled notes');
  });

  it('instructs the agent to build the epic hierarchy', () => {
    const out = buildNoteScopingKickoff({ content: 'x', projectName: 'Acme' });
    expect(out).toMatch(/epic/i);
    expect(out).toMatch(/phase/i);
    expect(out).toMatch(/ticket/i);
  });
});
