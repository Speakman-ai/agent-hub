import { describe, it, expect } from 'vitest';
import {
  buildRestartResumeNotice,
  buildRestartResumePrompt,
  formatKilledShellLines,
  type KilledBackgroundShell,
} from './restart-resume-notice.js';

const shell = (overrides: Partial<KilledBackgroundShell> = {}): KilledBackgroundShell => ({
  id: 'shell-1',
  command: 'pytest -q',
  label: null,
  ...overrides,
});

describe('formatKilledShellLines', () => {
  it('is empty when nothing was killed', () => {
    expect(formatKilledShellLines([])).toBe('');
  });

  it('prefers the label and keeps the command', () => {
    const out = formatKilledShellLines([shell({ label: 'backend tests' })]);
    expect(out).toContain('Background shells killed by the restart:');
    expect(out).toContain('- backend tests: `pytest -q`');
  });

  it('falls back to the command alone when unlabelled', () => {
    expect(formatKilledShellLines([shell({ label: '   ' })])).toContain('- `pytest -q`');
  });

  it('collapses whitespace and truncates very long commands', () => {
    const out = formatKilledShellLines([shell({ command: `docker  build\n  ${'x'.repeat(400)}` })]);
    const line = out.split('\n')[1];
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(230);
    expect(line).toContain('…');
  });

  it('truncates the list past ten entries', () => {
    const many = Array.from({ length: 13 }, (_, i) => shell({ id: `s${i}`, command: `cmd-${i}` }));
    const out = formatKilledShellLines(many);
    expect(out).toContain('cmd-9');
    expect(out).not.toContain('cmd-10');
    expect(out).toContain('…and 3 more');
  });
});

describe('buildRestartResumeNotice', () => {
  it('states that the restart killed the session processes', () => {
    const out = buildRestartResumeNotice();
    expect(out).toContain('Session interrupted by server restart');
    expect(out).toMatch(/killed every process this session had started/);
  });

  it('appends partial output when there is some', () => {
    const out = buildRestartResumeNotice({ partial: 'half an answer' });
    expect(out).toContain('Partial output before interruption:\nhalf an answer');
  });

  it('omits the partial section when blank', () => {
    expect(buildRestartResumeNotice({ partial: '   ' })).not.toContain('Partial output');
  });

  it('names the killed background shells', () => {
    const out = buildRestartResumeNotice({ killedShells: [shell({ label: 'e2e' })] });
    expect(out).toContain('- e2e: `pytest -q`');
  });
});

describe('buildRestartResumePrompt', () => {
  // Regression: "Sessions kill processes but continue to wait". A restart
  // drains the CLI child by process group, so the agent's whole subtree dies
  // with it. The old prompt only said "continue where you left off", so the
  // resumed agent went straight back to tailing a log for a run that no longer
  // existed.
  it('tells a resumed agent its processes are gone and not to wait on them', () => {
    const out = buildRestartResumePrompt({ hasEngineSession: true });
    expect(out).toMatch(/killed every process this session had started/);
    expect(out).toMatch(/Do not wait on, poll, or tail/);
  });

  it('asks an engine-resumable session to continue where it left off', () => {
    const out = buildRestartResumePrompt({ hasEngineSession: true, taskPrompt: 'original task' });
    expect(out).toContain('pick up from where you stopped');
    expect(out).not.toContain('original task');
  });

  it('replays the original prompt when there is no engine session to resume', () => {
    const out = buildRestartResumePrompt({ hasEngineSession: false, taskPrompt: 'original task' });
    expect(out).toContain('original task');
  });

  it('falls back to a continue instruction when there is no prompt to replay', () => {
    const out = buildRestartResumePrompt({ hasEngineSession: false, taskPrompt: '  ' });
    expect(out).toContain('Please continue where you left off.');
  });

  it('leads with the kill statement, before the continue instruction', () => {
    const out = buildRestartResumePrompt({
      hasEngineSession: true,
      killedShells: [shell({ label: 'pytest' })],
    });
    expect(out.indexOf('None of it survived.')).toBeLessThan(out.indexOf('pick up from where'));
    expect(out).toContain('- pytest: `pytest -q`');
  });

  it('never emits blank runs of separator lines', () => {
    expect(buildRestartResumePrompt({ hasEngineSession: true })).not.toMatch(/\n{3,}/);
    expect(buildRestartResumeNotice()).not.toMatch(/\n{3,}/);
  });
});
