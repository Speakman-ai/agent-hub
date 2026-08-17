import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function readWorkflow(name: string): string {
  return fs.readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8');
}

function isExecutable(relPath: string): boolean {
  return Boolean(fs.statSync(path.join(repoRoot, relPath)).mode & 0o100);
}

/**
 * Comment-free view of a workflow. These files carry long explanatory headers
 * that name the very scripts and switches under test, so asserting on the raw
 * text either matches prose or orders steps by where they are documented rather
 * than where they run.
 */
function withoutComments(workflow: string): string {
  return workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('release workflows', () => {
  it.each(['release-all.yml', 'release-prod.yml'])(
    '%s regenerates and commits OpenAPI docs after bumping the app version',
    (workflowName) => {
      const workflow = readWorkflow(workflowName);
      const installServerDeps = workflow.indexOf(
        '\n        run: cd server && npm ci --include=dev',
      );
      const versionBump = workflow.indexOf('npm version "$BUMP" --no-git-tag-version');
      const generateOpenApi = workflow.indexOf('\n          npm run generate:openapi');
      const commitOpenApi = workflow.indexOf('docs/api/openapi.yaml');

      expect(installServerDeps).toBeGreaterThanOrEqual(0);
      expect(versionBump).toBeGreaterThanOrEqual(0);
      expect(installServerDeps).toBeLessThan(generateOpenApi);
      expect(generateOpenApi).toBeGreaterThan(versionBump);
      expect(commitOpenApi).toBeGreaterThan(generateOpenApi);
    },
  );

  it('configures non-gating reusable AMI bakes inside the called workflow', () => {
    const bake = parseYaml(readWorkflow('bake-finalize-runner-ami.yml'));
    const dev = parseYaml(readWorkflow('deploy-dev-hub-on-main.yml'));
    const release = parseYaml(readWorkflow('release-all.yml'));
    const callers = [dev.jobs['bake-finalize-ami'], release.jobs['bake-finalize-ami-prod']];

    expect(bake.on.workflow_call.inputs.allow_failure).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(bake.jobs.bake['continue-on-error']).toBe('${{ inputs.allow_failure }}');
    for (const caller of callers) {
      expect(caller.uses).toBe('./.github/workflows/bake-finalize-runner-ami.yml');
      expect(caller.with.allow_failure).toBe(true);
      expect(caller).not.toHaveProperty('continue-on-error');
    }
  });

  it('serializes AMI bake and pin operations per fleet', () => {
    const bake = parseYaml(readWorkflow('bake-finalize-runner-ami.yml'));

    expect(bake.jobs.bake.concurrency).toEqual({
      group: 'finalize-runner-ami-${{ inputs.fleet }}',
      'cancel-in-progress': false,
    });
  });
});

/**
 * The prod Terraform apply runs unattended on every release. Three properties
 * make that safe, and each is a silent-until-catastrophic failure if it drifts:
 * the apply always runs, it cannot land an unguarded plan, and env changes are
 * adopted in place rather than by rebuilding the Hub.
 */
describe('release-all.yml — unattended prod terraform apply', () => {
  const workflow = readWorkflow('release-all.yml');
  const steps = withoutComments(workflow);

  it('applies on every release rather than behind an opt-in input', () => {
    expect(steps).toContain('terraform-apply:');
    // The old `apply_terraform` dispatch input gated the job off by default,
    // which is how infra changes sat unapplied for weeks.
    expect(steps).not.toContain('apply_terraform');
  });

  it('guards the saved plan before applying it', () => {
    const plan = steps.indexOf('-out="$RUNNER_TEMP/prod.plan"');
    const guard = steps.indexOf('./scripts/assert-no-protected-replacements.sh');
    const apply = steps.indexOf(
      'terraform apply -input=false -auto-approve "$RUNNER_TEMP/prod.plan"',
    );

    expect(plan).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(plan);
    // Apply must consume the SAVED plan. A fresh `terraform apply -var-file=...`
    // here would re-plan and could land changes the guard never inspected.
    expect(apply).toBeGreaterThan(guard);
  });

  it('adopts env changes over SSM instead of replacing the instance', () => {
    expect(steps).toContain('ops/scripts/sync-hub-env.sh');
    expect(steps).toContain('hub_env_managed');
    // Nothing the pipeline actually executes may force an instance rebuild.
    expect(steps).not.toMatch(/user_data_replace_on_change/);
    expect(steps).not.toMatch(/-replace=aws_instance\.app/);
  });

  it('hands the sync its managed-key inventory so disabled features are retracted', () => {
    // Without the inventory the sync is upsert-only: turning a feature off in
    // Terraform leaves its old keys live on the Hub and reports no change.
    expect(steps).toContain('hub_env_managed_keys');
    expect(steps).toContain('--managed-keys-file');
  });

  it('passes the retraction-check exemptions so a retraction is verified, not assumed', () => {
    // The host fails the release when a retracted key is still set in the
    // container; without this list the keys pinned by docker run -e would trip
    // it on every retraction.
    expect(steps).toContain('hub_env_runtime_injected_keys');
    expect(steps).toContain('--runtime-keys-file');
  });

  it('never swallows a failed terraform output', () => {
    // An empty hub_env_managed is a valid instruction meaning "retract every
    // managed key", so a swallowed failure hands that instruction to the live
    // Hub. Behaviour is covered in release-hub-env-inputs.test.ts, which runs
    // the step; this pins the shape so the suppression cannot creep back.
    const collect = steps.slice(
      steps.indexOf('- name: Collect Hub env sync inputs'),
      steps.indexOf('- name: Sync Hub env over SSM'),
    );
    expect(collect).not.toContain('|| true');
    expect(collect).not.toContain('2>/dev/null');
  });

  it('ships the referenced helper scripts as executables', () => {
    expect(isExecutable('ops/terraform/scripts/assert-no-protected-replacements.sh')).toBe(true);
    expect(isExecutable('ops/scripts/sync-hub-env.sh')).toBe(true);
    expect(isExecutable('ops/scripts/hub-env-upsert.remote.sh')).toBe(true);
  });
});
