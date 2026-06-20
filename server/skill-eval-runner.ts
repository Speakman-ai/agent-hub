/**
 * Skill Builder, Phase 3 — eval runner.
 *
 * Orchestrates the with-skill vs baseline comparison: for each eval prompt it
 * runs the prompt twice through an injected `OneShotRunner` — once with the
 * draft skill's SKILL.md injected as the system prompt (with-skill) and once
 * without (baseline) — grades both against the eval's assertions, and renders a
 * side-by-side Markdown report the coach surfaces to the user.
 *
 * The actual CLI spawn is injected (`OneShotRunner`) so this module stays
 * pure-ish and unit-testable without ever touching `child_process`. The route
 * builds the real runner from `runOneShotPrompt`; tests pass a stub.
 */

import { gradeOutput, type GradeResult, type SkillEval } from './skill-evals.js';

/**
 * Runs a single prompt and resolves the model's final text. `systemPrompt` is
 * the with-skill injection (the SKILL.md body) on the with-skill pass and
 * `undefined` on the baseline pass.
 */
export type OneShotRunner = (input: { prompt: string; systemPrompt?: string }) => Promise<string>;

export interface EvalVariantResult {
  output: string;
  grade: GradeResult;
  /** Set when the spawn itself failed; `output` is then the error message. */
  error?: string;
}

export interface EvalRunResult {
  evalId: string;
  prompt: string;
  /** True when the eval had assertions (objective); false = subjective diff. */
  graded: boolean;
  withSkill: EvalVariantResult;
  baseline: EvalVariantResult;
  /**
   * The headline signal for an objective eval: did adding the skill flip this
   * prompt from failing (baseline) to passing (with-skill)? `null` for
   * subjective evals (no assertions to decide it).
   */
  improved: boolean | null;
}

export interface SkillEvalSummary {
  skillId: string;
  total: number;
  /** Count of evals that had assertions (auto-graded). */
  graded: number;
  withSkillPassed: number;
  baselinePassed: number;
  /** Objective evals that went baseline-fail → with-skill-pass. */
  improvedCount: number;
  results: EvalRunResult[];
  /** Rendered side-by-side report for the coach to surface / save as artifact. */
  markdown: string;
}

export interface RunSkillEvalsOptions {
  skillId: string;
  /**
   * The with-skill system-prompt injection — typically `buildSkillInjection()`
   * of the draft skill. Passed verbatim as the `systemPrompt` for with-skill
   * runs; the baseline run omits it.
   */
  skillInjection: string;
  evals: SkillEval[];
  runner: OneShotRunner;
}

async function runVariant(
  runner: OneShotRunner,
  prompt: string,
  systemPrompt: string | undefined,
  assertions: SkillEval['assertions'],
): Promise<EvalVariantResult> {
  try {
    const output = await runner({ prompt, systemPrompt });
    return { output, grade: await gradeOutput(output, assertions) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: message,
      grade: await gradeOutput('', assertions),
      error: message,
    };
  }
}

function truncate(s: string, max = 1500): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}\n…(truncated)` : t;
}

/**
 * Wrap untrusted model output in a backtick code fence that is guaranteed to
 * contain it. Raw output can include ``` runs; a fixed three-backtick fence
 * would let that output close the fence early and inject arbitrary Markdown/
 * HTML into the rendered report. CommonMark requires the opening fence to be
 * longer than any backtick run inside, so we size the fence to (longest run +
 * 1), never fewer than three. Returns the lines (open fence, content, close).
 */
function fencedBlock(content: string): string[] {
  let longestRun = 0;
  let current = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '`') {
      current++;
      if (current > longestRun) longestRun = current;
    } else {
      current = 0;
    }
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return [fence, content, fence];
}

/**
 * Render an untrusted string as inline code that always contains it. Assertion
 * values come from evals.json, so they can hold backticks (which would close a
 * single-backtick span and leak the rest as Markdown) or newlines (which would
 * break the list item). Collapse to one line and size the backtick delimiter
 * to (longest run + 1), padding when the content edges are backticks per the
 * CommonMark inline-code rules.
 */
function inlineCode(s: string): string {
  const oneLine = s.replace(/\s*\n\s*/g, ' ').trim();
  let longestRun = 0;
  let current = 0;
  for (let i = 0; i < oneLine.length; i++) {
    if (oneLine[i] === '`') {
      current++;
      if (current > longestRun) longestRun = current;
    } else {
      current = 0;
    }
  }
  const ticks = '`'.repeat(longestRun + 1);
  const pad = oneLine.startsWith('`') || oneLine.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${oneLine}${pad}${ticks}`;
}

function renderMarkdown(skillId: string, summary: Omit<SkillEvalSummary, 'markdown'>): string {
  const lines: string[] = [];
  lines.push(`# Eval results — \`${skillId}\``);
  lines.push('');
  lines.push(
    `**${summary.withSkillPassed}/${summary.graded}** objective evals pass with the skill ` +
      `(baseline: **${summary.baselinePassed}/${summary.graded}**). ` +
      `${summary.improvedCount} prompt(s) improved (baseline-fail → with-skill-pass).`,
  );
  if (summary.graded < summary.total) {
    lines.push('');
    lines.push(
      `> ${summary.total - summary.graded} subjective eval(s) have no assertions — judge the side-by-side diff below.`,
    );
  }

  for (const r of summary.results) {
    lines.push('');
    // evalId is a validated slug (lowercase/digits/hyphens), safe inline.
    lines.push(`## ${r.evalId}`);
    lines.push('');
    // The prompt is user-controlled (it comes from evals.json / the request),
    // so it can contain raw Markdown/HTML. Fence it like the model output below
    // so a crafted prompt can't inject content into the rendered report.
    lines.push('**Prompt:**');
    lines.push('');
    lines.push(...fencedBlock(truncate(r.prompt, 400)));
    lines.push('');
    if (r.graded) {
      const w = r.withSkill.grade.passed ? '✅ pass' : '❌ fail';
      const b = r.baseline.grade.passed ? '✅ pass' : '❌ fail';
      const delta = r.improved === true ? ' (improved 🎯)' : r.improved === false ? '' : '';
      lines.push(`- with-skill: ${w}${delta}`);
      lines.push(`- baseline: ${b}`);
      const failed = r.withSkill.grade.assertionResults.filter((a) => !a.passed);
      if (failed.length > 0) {
        lines.push(
          `- failing assertions (with-skill): ${failed
            .map(
              (a) =>
                `${inlineCode(`${a.assertion.type}: ${a.assertion.value}`)}${
                  a.timedOut ? ' (timed out — pattern too slow, simplify it)' : ''
                }`,
            )
            .join(', ')}`,
        );
      }
    } else {
      lines.push('_Subjective — no assertions. Compare the two outputs:_');
    }
    lines.push('');
    lines.push('<details><summary>with-skill output</summary>');
    lines.push('');
    lines.push(...fencedBlock(truncate(r.withSkill.output)));
    lines.push('</details>');
    lines.push('');
    lines.push('<details><summary>baseline output</summary>');
    lines.push('');
    lines.push(...fencedBlock(truncate(r.baseline.output)));
    lines.push('</details>');
  }

  return lines.join('\n');
}

/**
 * Run every eval through the with-skill and baseline variants and grade them.
 *
 * Per eval the two variants run concurrently (a 2-wide fan-out); evals run
 * sequentially to keep total in-flight spawns bounded (2 at a time) — an eval
 * suite is small (<=10 prompts) but each spawn is a real CLI process.
 */
export async function runSkillEvals(opts: RunSkillEvalsOptions): Promise<SkillEvalSummary> {
  const { skillId, skillInjection, evals, runner } = opts;
  const results: EvalRunResult[] = [];

  for (const ev of evals) {
    const [withSkill, baseline] = await Promise.all([
      runVariant(runner, ev.prompt, skillInjection, ev.assertions),
      runVariant(runner, ev.prompt, undefined, ev.assertions),
    ]);
    const graded = withSkill.grade.graded;
    const improved = graded ? withSkill.grade.passed && !baseline.grade.passed : null;
    results.push({
      evalId: ev.id,
      prompt: ev.prompt,
      graded,
      withSkill,
      baseline,
      improved,
    });
  }

  const graded = results.filter((r) => r.graded);
  const partial: Omit<SkillEvalSummary, 'markdown'> = {
    skillId,
    total: results.length,
    graded: graded.length,
    withSkillPassed: graded.filter((r) => r.withSkill.grade.passed).length,
    baselinePassed: graded.filter((r) => r.baseline.grade.passed).length,
    improvedCount: results.filter((r) => r.improved === true).length,
    results,
  };

  return { ...partial, markdown: renderMarkdown(skillId, partial) };
}
