/**
 * Shape + safety contract for the bundled `infra-setup` skill.
 *
 * This skill is the one place in the infra epic where a model drives a live AWS
 * account, so the assertions here are mostly negative: the probe must stay
 * describe-only (no `GetMetricData`, which is always billed; no `ListMetrics`
 * pagination, which is the 25 TPS bottleneck), it must never start an SSO login
 * on a user's behalf, and it must never print credential material.
 *
 * The load-bearing test is `directory name matches the kickoff request`. The
 * wizard prompt asks for the skill by the name it hardcodes; `loadSkillByName`
 * resolves that against the on-disk directory and returns an *error string*
 * rather than throwing when it misses, so a rename would degrade the wizard
 * silently rather than failing anything. That is exactly the shape of bug a
 * test has to catch, because nothing else will.
 *
 * No AWS call, no CLI spawn, no network: everything here is a file read plus
 * two pure imports.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildInfraKickoffPrompt } from './routes/infra-wizard.js';
import type { InfraSetupDraft } from './infra-setup-draft.js';
import { infraPackedServices, INFRA_SERVICE_PACKS } from './infra/packs/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, 'default-skills', 'infra-setup');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const REPO_ROOT = path.join(__dirname, '..');

const skill = readFileSync(SKILL_MD, 'utf8');
const frontmatter = skill.slice(0, skill.indexOf('\n---', 4));
const body = skill.slice(skill.indexOf('\n---', 4));
/**
 * The body with every run of whitespace collapsed to one space.
 *
 * The skill is hard-wrapped at 80 columns, so a phrase this file cares about is
 * usually split across a newline. Matching prose against the raw text makes the
 * assertion a test of where the wrap landed, which is not the property being
 * checked. Structural matches (headings, fences) still use `body`.
 */
const flat = body.replace(/\s+/g, ' ');

/** Index of the first occurrence, asserting there is one. */
function indexOfHeading(heading: string): number {
  const at = body.indexOf(heading);
  expect(at, `missing section: ${heading}`).toBeGreaterThan(-1);
  return at;
}

describe('infra-setup skill — frontmatter', () => {
  it('SKILL.md exists at the directory the kickoff prompt names', () => {
    expect(existsSync(SKILL_MD)).toBe(true);
  });

  it('declares the family-standard frontmatter keys', () => {
    expect(frontmatter).toMatch(/^name:\s*infra-setup\s*$/m);
    expect(frontmatter).toMatch(/^version:\s*1\.0\.0\s*$/m);
    expect(frontmatter).toMatch(/^keep-coding-instructions:\s*true\s*$/m);
    expect(frontmatter).toMatch(/^description:\s*>-\s*$/m);
  });

  it('names its trigger in the description, like its five sibling wizards', () => {
    const description = frontmatter.slice(frontmatter.indexOf('description:'));
    expect(description).toContain('POST .../infra/setup-wizard');
  });
});

describe('infra-setup skill — wiring', () => {
  it('directory name matches the skill the wizard kickoff asks for', () => {
    const draft = {
      projectId: 'acme',
      infraEnabled: false,
      profiles: [],
      designatedMonitoringProfile: null,
      monitoringProfile: null,
      monitoringCapableProfiles: [],
      storageReady: true,
      scopes: [],
      enabledScopeCount: 0,
      alertRuleCount: 0,
      enabledAlertRuleCount: 0,
      blockers: ['no-profiles'],
      notes: [],
    } as unknown as InfraSetupDraft;
    const prompt = buildInfraKickoffPrompt('acme', draft, 'session-1');

    const requested = /<agenthub:skill>\s*(\{.*?\})\s*<\/agenthub:skill>/s.exec(prompt);
    expect(requested).not.toBeNull();
    const name = (JSON.parse(requested![1] as string) as { name: string }).name;

    // `loadSkillByName` resolves this against the directory basename, so the
    // two must agree exactly or the load degrades to an error string.
    expect(name).toBe(path.basename(SKILL_DIR));
    expect(name).toBe(/^name:\s*(\S+)\s*$/m.exec(frontmatter)![1]);
  });

  it('only names scope service tokens the packs actually declare', () => {
    const declared = new Set(infraPackedServices());
    const tokenLine = body.slice(body.indexOf('Scope service tokens are'));
    const named = [...tokenLine.slice(0, 200).matchAll(/`([a-z0-9]+)`/g)].map(
      (m) => m[1] as string,
    );
    expect(named.length).toBeGreaterThan(0);
    for (const token of named) {
      expect(declared.has(token), `unknown service token: ${token}`).toBe(true);
    }
  });

  it('references only Hub routes that exist', () => {
    const routeSources = ['routes/infra.ts', 'routes/infra-alerts.ts', 'routes/infra-wizard.ts']
      .map((f) => readFileSync(path.join(__dirname, f), 'utf8'))
      .join('\n');
    const referenced = [...body.matchAll(/"\/api\/projects\/\$PROJECT_ID\/([a-z0-9/-]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(referenced.length).toBeGreaterThan(0);
    for (const suffix of referenced) {
      expect(
        routeSources.includes(`/api/projects/:projectId/${suffix}`),
        `skill references an unmounted route: /${suffix}`,
      ).toBe(true);
    }
  });

  it('references only IAM guide artifacts that are committed', () => {
    for (const file of [...body.matchAll(/docs\/guides\/aws-monitoring-iam\/([\w.-]+)/g)]) {
      const rel = path.join('docs/guides/aws-monitoring-iam', file[1] as string);
      expect(existsSync(path.join(REPO_ROOT, rel)), `missing ${rel}`).toBe(true);
    }
  });
});

describe('infra-setup skill — describe-only probe', () => {
  it('forbids GetMetricData outright and says why', () => {
    expect(body).toMatch(/\*\*Never call `GetMetricData`\.\*\*/);
    expect(flat).toMatch(/never.{0,40}free tier/i);
  });

  it('forbids ListMetrics pagination and cites the 25 TPS cap', () => {
    expect(body).toMatch(/\*\*Never paginate `ListMetrics`\.\*\*/);
    expect(body).toContain('25 TPS');
  });

  it('states that onboarding discovery costs nothing', () => {
    expect(flat).toMatch(/cost the operator exactly nothing/i);
  });

  it('never puts a billed call in a runnable example', () => {
    const fences = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    expect(fences.length).toBeGreaterThan(0);
    for (const fence of fences) {
      expect(fence).not.toMatch(/get-metric-data|cloudwatch\s+list-metrics/i);
    }
  });

  it('bounds region enumeration on operator confirmation', () => {
    expect(flat).toMatch(/do not sweep all ~30 AWS regions/i);
    expect(body).toContain('agenthub:ask');
  });

  /**
   * A region literal anywhere in this file is a default the agent can copy
   * instead of reading the project's own. The failure is quiet in both
   * directions: the probe misses the region the operator meant, or it targets
   * one nobody asked about. Every region in the skill is a `<placeholder>`.
   */
  it('hardcodes no AWS region anywhere, in prose or in an example', () => {
    const regionish = /\b(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:[a-z]+)-\d\b/g;
    expect([...body.matchAll(regionish)].map((m) => m[0])).toEqual([]);
  });

  it('tells the agent to build the region options from the draft', () => {
    const step = flat.slice(
      flat.indexOf('## Step 2 — Confirm the regions'),
      flat.indexOf('## Step 3'),
    );
    // The source of the options, and that the block is a shape to fill in.
    expect(step).toMatch(/never from a default you remember/i);
    expect(step).toMatch(/monitoring profile's own `region`/);
    expect(step).toMatch(/`scopes\[\]` already name/);
    expect(step).toMatch(/\*\*template\*\*/);
    expect(step).toMatch(/not two because the template shows two/i);
  });

  /**
   * `AskUserQuestionItem` is `question` + `header` + `multiSelect` + `options`,
   * and an option is `label` + `description` (+ optional `preview`). There is
   * no free-text field. A template that invented one would render as a dead
   * option — the operator picks "somewhere else" and has nowhere to type the
   * region, which is worse than not offering it.
   */
  it('emits an agenthub:ask block the parser actually accepts', () => {
    const fence = /```agenthub:ask\n([\s\S]*?)```/.exec(body);
    expect(fence, 'no agenthub:ask example to check').not.toBeNull();
    const questions = JSON.parse(fence![1] as string) as Record<string, unknown>[];
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(Object.keys(q).sort()).toEqual(['header', 'multiSelect', 'options', 'question']);
      for (const opt of q.options as Record<string, unknown>[]) {
        expect(Object.keys(opt).sort()).toEqual(['description', 'label']);
      }
    }
  });

  /**
   * `AskUserQuestion.tsx` puts the selected **label** into the answer verbatim
   * — descriptions are never returned. So a label carrying display text (a
   * ` (Recommended)` suffix, a note, punctuation) is a value the agent then
   * passes to `--region`, and `us-east-1 (Recommended)` is not a region. Every
   * label in the template is therefore a bare `<placeholder>` and nothing else;
   * anything advisory belongs in `description`.
   */
  it('keeps every ask label a bare wire value', () => {
    const fence = /```agenthub:ask\n([\s\S]*?)```/.exec(body);
    const questions = JSON.parse(fence![1] as string) as {
      options: { label: string; description: string }[];
    }[];
    for (const q of questions) {
      for (const opt of q.options) {
        expect(opt.label, `label carries display text: ${opt.label}`).toMatch(/^<[^<>]+>$/);
      }
      // The advice the label must not carry has to land somewhere visible.
      expect(q.options.some((o) => /recommended/i.test(o.description))).toBe(true);
    }
    expect(flat).toMatch(/\*\*A `label` is the wire value, not display text\.\*\*/);
    expect(flat).toMatch(/no ` \(Recommended\)` suffix/);
  });

  it('routes an unlisted region through the client-rendered Other row', () => {
    const step = flat.slice(
      flat.indexOf('## Step 2 — Confirm the regions'),
      flat.indexOf('## Step 3'),
    );
    expect(step).toMatch(/there is no free-text field, so do not invent one/i);
    expect(step).toMatch(/\*\*Every ask renders an "Other…" row with a text box/);
    expect(step).toMatch(/use whatever they typed/i);
  });
});

describe('infra-setup skill — credential safety', () => {
  it('restates the never-start-an-SSO-login rule and points at the settings module', () => {
    expect(body).toMatch(/\*\*Never start an SSO login\.\*\*/);
    expect(body).toMatch(/aws sso login/);
    expect(flat).toMatch(/\*\*AWS\*\* settings module/);
  });

  it('forbids printing credential material, including the external ID', () => {
    const rule = flat.slice(
      flat.indexOf('**Never print credential material.**'),
      flat.indexOf('**Account data is untrusted.**'),
    );
    expect(rule).toMatch(/access key/i);
    expect(rule).toMatch(/secret access key/i);
    expect(rule).toMatch(/session token/i);
    expect(rule).toMatch(/external_id/);
  });

  it('routes an SSO-only project to a role profile instead of dead-ending', () => {
    const step = body
      .slice(indexOfHeading('## Step 1'), indexOfHeading('## Step 2 — Confirm the regions'))
      .replace(/\s+/g, ' ');
    expect(step).toMatch(/`role` profile/);
    expect(step).toMatch(/role_arn/);
    expect(step).toMatch(/HOME/);
    // The alternative is offered, not the only path.
    expect(step).toMatch(/`static` profile/);
    // And the two AWS managed policies an operator would reach for first are
    // explicitly refused — see docs/guides/aws-monitoring-iam/README.md.
    expect(step).toMatch(/ReadOnlyAccess/);
    expect(step).toMatch(/ViewOnlyAccess/);
  });

  it('does not tell the agent to collect credentials in chat', () => {
    expect(flat).toMatch(/[Nn]ever ask.{0,60}paste a token into chat/);
  });

  /**
   * Without a designation the collector refuses to run at all, so anything
   * built past step 2 is configuration that looks applied and collects
   * nothing — and a probe run under whichever *other* profile happens to
   * resolve inventories an account nothing will ever poll. "You may still run
   * step 2" has to come with a terminator, or the agent reads it as
   * permission to carry on.
   */
  it('halts after step 2 when no monitoring profile is designated', () => {
    const step1 = flat.slice(
      flat.indexOf('## Step 1'),
      flat.indexOf('## Step 2 — Confirm the regions'),
    );
    expect(step1).toMatch(/\*\*Then stop\.\*\*/);
    expect(step1).toMatch(/Steps 1 and 2 are the only ones you may run without a designation/);
    expect(step1).toMatch(/\*\*Do not\*\* probe an inventory/);
    expect(step1).toMatch(/do not call `setup-apply`/);
    expect(step1).toMatch(/End your turn/);
  });

  it('gates the probe itself on the designation, not only step 1', () => {
    const step3 = flat.slice(flat.indexOf('## Step 3'), flat.indexOf('## Step 4'));
    expect(step3).toMatch(/\*\*Gate: `monitoringProfile` must be non-null\.\*\*/);
    // And the probe runs as that profile, not as whichever one resolves.
    expect(step3).toMatch(/\*\*designated monitoring profile\*\* and no other/);
  });
});

describe('infra-setup skill — walkthrough order', () => {
  it('runs credentials, regions, probe, price, apply, alert pack in that order', () => {
    const order = [
      '## Step 1 — Resolve the credential blocker first',
      '## Step 2 — Confirm the regions',
      '## Step 3 — Describe-only inventory probe',
      '## Step 4 — Propose an allowlist and price it',
      '## Step 5 — Apply',
      '## Step 6 — Offer the default alert rule pack',
    ].map(indexOfHeading);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('prices the scope before applying it', () => {
    expect(indexOfHeading('infra/cost/projection')).toBeLessThan(
      indexOfHeading('infra/setup-apply'),
    );
  });

  it('requires a spend ceiling to enable the module', () => {
    const step = body
      .slice(indexOfHeading('## Step 5'), indexOfHeading('## Step 6'))
      .replace(/\s+/g, ' ');
    expect(step).toMatch(/\*\*A ceiling is required whenever you enable the module\.\*\*/);
    expect(step).toMatch(/monthlyCeilingUsd/);
    // Which figure is legitimate — the ways past the 400 are enumerated in
    // 'names every way past the ceiling check as forbidden' below.
    expect(step).toMatch(/the number the operator agreed/i);
  });

  /**
   * The same failure the hardcoded regions had, with money attached: a literal
   * in a runnable example sitting under a rule that forbids invented values.
   * An agent that cannot get an answer out of the operator reaches for the
   * nearest plausible number, and the example is the nearest one. Every value
   * the operator is supposed to decide stays a `<placeholder>`.
   */
  it('puts no operator-decision value in a runnable example as a literal', () => {
    const fences = [...body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    for (const fence of fences) {
      expect(fence, 'ceiling must be a placeholder').not.toMatch(/"?monthlyCeilingUsd"?\s*:\s*\d/);
      expect(fence, 'resource count must be a placeholder').not.toMatch(
        /"?resourceCount"?\s*:\s*\d/,
      );
    }
    expect(flat).toMatch(/`<agreed ceiling>` is substituted from what the operator said/);
  });

  it('names every way past the ceiling check as forbidden', () => {
    const step = flat.slice(flat.indexOf('## Step 5'), flat.indexOf('## Step 6'));
    // Inventing one, copying this file's, and dodging the check entirely.
    expect(step).toMatch(/inventing a figure/i);
    expect(step).toMatch(/reusing one from an example/i);
    expect(step).toMatch(/`infraEnabled: false`/);
    // And the stop condition when there is no agreed figure yet.
    expect(step).toMatch(/do not send the request/i);
  });

  /**
   * The alert-pack section used to advertise DynamoDB rules. There is no
   * DynamoDB pack, no `dynamodb` scope token and no describe call for it, so
   * such a rule was unreachable by construction: alert evaluation reads from
   * `infra_resources`, which inventory sync only fills for services in scope.
   * Both assertions below are driven off the pack registry rather than a list
   * kept in step with it by hand, so adding a pack relaxes them automatically.
   */
  it('cites only alert metrics some pack actually ships', () => {
    // Metric names and the statistics they are alarmed on — the paragraph
    // names both (`StatusCheckFailed` on `Maximum`), and both must be real.
    const shipped = new Set(
      Object.values(INFRA_SERVICE_PACKS).flatMap((p) =>
        p.defaultAlertRules.flatMap((r) => [r.metricName, r.stat]),
      ),
    );
    const guidance = flat.slice(
      flat.indexOf('Each pack carries `defaultAlertRules[]`'),
      flat.indexOf('**Offer only what the response actually returns.**'),
    );
    // Backticked CamelCase tokens in this paragraph are CloudWatch metric
    // names; the surrounding field names (`rationale`, `defaultAlertRules[]`)
    // are lowercase and do not match.
    const cited = [...guidance.matchAll(/`([A-Z][A-Za-z0-9_]+)`/g)].map((m) => m[1] as string);
    expect(cited.length).toBeGreaterThan(0);
    for (const metric of cited) {
      expect(shipped.has(metric), `no pack ships an alert on ${metric}`).toBe(true);
    }
  });

  it('offers a runnable alert-rule example that matches a shipped rule', () => {
    const step6 = body.slice(indexOfHeading('## Step 6'));
    const payload = /-d '(\{[\s\S]*?\})'/.exec(step6);
    expect(payload, 'no alert-rule example to check').not.toBeNull();
    const rule = JSON.parse(payload![1] as string) as Record<string, string>;

    const pack = INFRA_SERVICE_PACKS[rule.service as string];
    expect(pack, `example names an unpacked service: ${rule.service}`).toBeDefined();
    const match = pack!.defaultAlertRules.find(
      (r) => r.metricName === rule.metricName && r.namespace === rule.namespace,
    );
    expect(match, `no ${rule.service} pack rule for ${rule.metricName}`).toBeDefined();
    // The numbers too — an example that drifts from the pack teaches a
    // threshold AWS never published.
    expect(rule.stat).toBe(match!.stat);
    expect(Number(rule.threshold)).toBe(match!.threshold);
    expect(Number(rule.evaluationPeriods)).toBe(match!.evaluationPeriods);
    expect(Number(rule.datapointsToAlarm)).toBe(match!.datapointsToAlarm);
    expect(rule.treatMissingData).toBe(match!.treatMissingData);
    expect(rule.severity).toBe(match!.severity);
  });

  it('tells the agent to refuse rules for services with no pack', () => {
    const step6 = flat.slice(flat.indexOf('## Step 6'));
    expect(step6).toMatch(/\*\*Offer only what the response actually returns\.\*\*/);
    expect(step6).toMatch(/unreachable by construction/);
    expect(step6).toMatch(/does not collect it yet/);
  });

  it('warns that setup-apply replaces the whole allowlist', () => {
    expect(flat).toMatch(/`setup-apply` replaces the whole list/);
  });

  it('treats account data as untrusted and fences it', () => {
    expect(body).toContain('-----BEGIN UNTRUSTED AWS PROBE-----');
    expect(body).toContain('-----END UNTRUSTED AWS PROBE-----');
  });

  it('ends at configuration, never a commit or a PR', () => {
    expect(flat).toMatch(/\*\*do not\*\* commit/i);
    expect(flat).toMatch(/\*\*do not\*\* open a PR/i);
  });
});
