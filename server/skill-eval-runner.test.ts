import { describe, it, expect, vi } from 'vitest';
import { runSkillEvals, type OneShotRunner } from './skill-eval-runner.js';
import type { SkillEval } from './skill-evals.js';

const INJECTION = '## Loaded Skill: tester\nAlways answer with "npx vitest".';

describe('runSkillEvals', () => {
  it('runs each eval with-skill (systemPrompt set) and baseline (unset)', async () => {
    const calls: Array<{ prompt: string; systemPrompt?: string }> = [];
    const runner: OneShotRunner = async (input) => {
      calls.push(input);
      // With-skill answers correctly; baseline does not.
      return input.systemPrompt ? 'use npx vitest' : 'use npm test';
    };

    const evals: SkillEval[] = [
      { id: 'a', prompt: 'how to test?', assertions: [{ type: 'contains', value: 'npx vitest' }] },
    ];

    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals,
      runner,
    });

    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.systemPrompt === INJECTION)).toBe(true);
    expect(calls.some((c) => c.systemPrompt === undefined)).toBe(true);

    expect(summary.total).toBe(1);
    expect(summary.graded).toBe(1);
    expect(summary.withSkillPassed).toBe(1);
    expect(summary.baselinePassed).toBe(0);
    expect(summary.improvedCount).toBe(1);
    expect(summary.results[0].improved).toBe(true);
  });

  it('marks subjective evals (no assertions) as ungraded with improved=null', async () => {
    const runner: OneShotRunner = async (input) => (input.systemPrompt ? 'with skill' : 'baseline');
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'tone', prompt: 'be nice' }],
      runner,
    });
    expect(summary.graded).toBe(0);
    expect(summary.results[0].graded).toBe(false);
    expect(summary.results[0].improved).toBeNull();
    expect(summary.markdown).toMatch(/Subjective/);
  });

  it('improved=false when both variants already pass', async () => {
    const runner: OneShotRunner = async () => 'npx vitest either way';
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'contains', value: 'npx vitest' }] }],
      runner,
    });
    expect(summary.withSkillPassed).toBe(1);
    expect(summary.baselinePassed).toBe(1);
    expect(summary.improvedCount).toBe(0);
    expect(summary.results[0].improved).toBe(false);
  });

  it('captures a spawn error per variant without throwing', async () => {
    const runner: OneShotRunner = vi.fn(async (input) => {
      if (input.systemPrompt) throw new Error('boom');
      return 'npx vitest';
    });
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'contains', value: 'npx vitest' }] }],
      runner,
    });
    expect(summary.results[0].withSkill.error).toBe('boom');
    expect(summary.results[0].withSkill.grade.passed).toBe(false);
    expect(summary.results[0].baseline.grade.passed).toBe(true);
  });

  it('renders a Markdown report with a per-eval section and pass headline', async () => {
    const runner: OneShotRunner = async (input) => (input.systemPrompt ? 'npx vitest' : 'npm test');
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [
        { id: 'happy', prompt: 'x', assertions: [{ type: 'contains', value: 'npx vitest' }] },
      ],
      runner,
    });
    expect(summary.markdown).toMatch(/# Eval results — `tester`/);
    expect(summary.markdown).toMatch(/## happy/);
    expect(summary.markdown).toMatch(/1\/1\*\* objective evals pass/);
    expect(summary.markdown).toMatch(/with-skill output/);
    expect(summary.markdown).toMatch(/baseline output/);
  });

  it('fences output that contains a ``` run so it cannot break out', async () => {
    // Model output with a triple-backtick run would close a fixed 3-backtick
    // fence early and inject markup. The fence must grow past the longest run.
    const evil = 'here is code:\n```js\nalert(1)\n```\n# INJECTED HEADING';
    const runner: OneShotRunner = async () => evil;
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'a', prompt: 'x' }],
      runner,
    });

    // Longest backtick run in the output is 3, so the wrapper fence must be 4.
    // The output is embedded verbatim between two 4-backtick fences, so its
    // inner ``` can never match the wrapper and close it early.
    expect(summary.markdown).toContain(`\`\`\`\`\n${evil}\n\`\`\`\``);
    // And no bare 3-backtick fence is used as a wrapper here.
    expect(summary.markdown).not.toMatch(/\n```\n(here is code)/);
  });

  it('uses a plain 3-backtick fence when output has no backticks', async () => {
    const runner: OneShotRunner = async () => 'plain output, no ticks';
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'a', prompt: 'x' }],
      runner,
    });
    expect(summary.markdown).toContain('```\nplain output, no ticks\n```');
  });

  it('fences the user-controlled prompt so it cannot inject markup', async () => {
    // The prompt is user input; a crafted one could otherwise inject a heading
    // or HTML into the report. It must be fenced like the model output.
    const evilPrompt = '# Injected heading\n```\nfence break\n```\n<script>alert(1)</script>';
    const runner: OneShotRunner = async () => 'ok';
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'a', prompt: evilPrompt }],
      runner,
    });
    // The label is on its own line and the prompt is wrapped in a >=4-backtick
    // fence (longest inner run is 3), so it renders as code, not markup.
    expect(summary.markdown).toContain('**Prompt:**\n');
    expect(summary.markdown).toContain(`\`\`\`\`\n${evilPrompt}\n\`\`\`\``);
    // Not the old vulnerable inline form.
    expect(summary.markdown).not.toContain('**Prompt:** # Injected heading');
  });

  it('renders a failing assertion value containing a backtick as safe inline code', async () => {
    const runner: OneShotRunner = async () => 'nope';
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'contains', value: 'a`b' }] }],
      runner,
    });
    expect(summary.markdown).toMatch(/failing assertions/);
    // The inner backtick forces a 2-backtick inline-code delimiter so it can't
    // close the span and leak the rest as Markdown.
    expect(summary.markdown).toContain('``contains: a`b``');
  });

  it('does not hang on a ReDoS regex assertion and flags the timeout in the report', async () => {
    const runner: OneShotRunner = async () => 'a'.repeat(50) + '!';
    const summary = await runSkillEvals({
      skillId: 'tester',
      skillInjection: INJECTION,
      evals: [{ id: 'a', prompt: 'x', assertions: [{ type: 'regex', value: '(a+)+$' }] }],
      runner,
    });
    expect(summary.withSkillPassed).toBe(0);
    expect(summary.markdown).toMatch(/timed out/);
  });
});
