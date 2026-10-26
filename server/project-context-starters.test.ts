import { buildStarterContextFiles } from './project-context-starters.js';

describe('buildStarterContextFiles', () => {
  const files = buildStarterContextFiles('Acme');

  it('seeds every context file, named after the project', () => {
    expect(Object.keys(files).sort()).toEqual([
      'AGENTS.md',
      'MEMORY.md',
      'SOUL.md',
      'TOOLS.md',
      'USER.md',
    ]);
    expect(files['AGENTS.md']).toMatch(/^# AGENTS\.md - Acme\n/);
    expect(files['SOUL.md']).toMatch(/^# SOUL\.md - Acme\n/);
  });

  it('describes the QA agent in AGENTS.md', () => {
    const agents = files['AGENTS.md'];
    expect(agents).toContain('## QA agent');
    expect(agents).toContain('Acme QA (role `qa`)');
    expect(agents).toContain('read-only on code');
    expect(agents).toContain('`qa-finding` card');
    // The tool choice depends on the target: public web vs this project's preview.
    expect(agents).toMatch(/`browser` tool for public sites, the `preview` tool/);
  });

  it('mentions QA validation and sign-off in SOUL.md', () => {
    expect(files['SOUL.md']).toContain('QA agent');
    expect(files['SOUL.md']).toContain('human sign-off');
  });
});
