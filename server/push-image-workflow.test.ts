import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.join(__dirname, '..');
const workflowsDir = path.join(repoRoot, '.github', 'workflows');
const ecrPublishWorkflowPath = path.join(workflowsDir, 'ecr-publish-rollout-docker-dev.yml');
const pushImageWorkflowPath = path.join(workflowsDir, 'push-image.yml');

/**
 * Guards CI contract: ECR push + dev-sandbox SSM rollout live in the reusable
 * workflow; the thin `push-image.yml` entrypoint stays manual-only.
 */
describe('ECR publish + push-image deploy contract', () => {
  // The deploy target is parameterized via repo Variables ONLY — no literal
  // instance-id fallback. A real `i-...` fallback used to ship here and leaked a
  // private EC2 instance id into the public tree (card #1598). The DEPLOY_INSTANCE_ID
  // line must resolve purely from `vars.DOCKER_DEPLOY_INSTANCE_ID`; the job's own
  // preflight fails loudly when that repo Variable is unset.
  function deployInstanceIdLine(workflowYaml: string): string {
    const line = workflowYaml.match(/^\s*DEPLOY_INSTANCE_ID:.*$/m);
    expect(line?.[0], 'DEPLOY_INSTANCE_ID in ecr-publish-rollout-docker-dev.yml').toBeTruthy();
    return line![0];
  }

  it('defines deploy-dev-sandbox with SSM restart and a var-sourced DEPLOY_INSTANCE_ID target', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toContain('deploy-dev-sandbox:');
    expect(yml).toContain('systemctl restart agenthub-server');
    expect(yml).toContain('DEPLOY_INSTANCE_ID');
    const line = deployInstanceIdLine(yml);
    // Sourced from the repo Variable...
    expect(line, 'DEPLOY_INSTANCE_ID must resolve from vars.DOCKER_DEPLOY_INSTANCE_ID').toMatch(
      /vars\.DOCKER_DEPLOY_INSTANCE_ID/,
    );
    // ...with NO literal instance-id fallback (regression guard for card #1598).
    expect(line.match(/i-[a-f0-9]+/)?.[0], 'no hardcoded instance id may ship').toBeFalsy();
    // The job must fail closed when the variable is unset, rather than SSM an empty id.
    expect(yml, 'deploy step must preflight an empty DEPLOY_INSTANCE_ID').toMatch(
      /if \[ -z "\$DEPLOY_INSTANCE_ID" \]/,
    );
  });

  // Previously this asserted the dev-sandbox `ci_ssm_deploy_instance_id` in
  // ryan.tfvars stayed byte-identical to the workflow's DEPLOY_INSTANCE_ID
  // fallback. As of AH-1388 the real per-env tfvars are gitignored (they carried
  // live account / instance ids) and the sandbox env dir was renamed ryan -> dev,
  // so the real instance id no longer lives in the tracked tree — the workflow
  // sources it from the DOCKER_DEPLOY_INSTANCE_ID repo Variable and operators
  // keep the matching value in their private tfvars overlay. What is still
  // guardable in-tree: the dev `.example` template documents the same knob (so an
  // operator knows which var to set) with a placeholder, never a real id, and the
  // workflow keeps the deploy target parameterized via the repo Variable.
  it('documents the dev-sandbox CI SSM instance knob in the tracked .example template', () => {
    const example = readFileSync(
      path.join(repoRoot, 'ops', 'terraform', 'environments', 'dev', 'dev.tfvars.example'),
      'utf8',
    );
    const m = example.match(/^\s*ci_ssm_deploy_instance_id\s*=\s*"([^"]+)"\s*$/m);
    expect(m?.[1], 'ci_ssm_deploy_instance_id in dev.tfvars.example').toBeTruthy();
    // Placeholder only — the real instance id must never ship in the public tree.
    expect(m![1]).not.toMatch(/^i-[a-f0-9]{8,}$/);

    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml, 'workflow must keep DEPLOY_INSTANCE_ID sourced from a repo Variable').toMatch(
      /DEPLOY_INSTANCE_ID:\s*\$\{\{\s*vars\.DOCKER_DEPLOY_INSTANCE_ID/,
    );
  });

  // Regression guard for kanban 89903017. The previous deploy flow trusted
  // `systemctl restart agenthub-server` to do the right thing. When the
  // wrapper's pull silently failed, `systemctl is-active` still returned 0
  // because the container was running (on the stale cached image), and CI
  // reported success. The new flow exposes the just-pushed digest via
  // job outputs + EXPECTED_DIGEST and asserts the running container matches.
  it('exports the build digest from the push job for end-to-end verification', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    // The push job must assign an `id` to the build step and surface its
    // digest output, otherwise needs.push.outputs.digest is empty.
    expect(yml, 'build step needs `id: build` so its outputs are addressable').toMatch(
      /-\s+name: Build \+ push server image\s*\n\s+id: build/,
    );
    expect(yml, 'push job must export digest in `outputs:`').toMatch(
      /outputs:\s*\n\s*digest:\s*\$\{\{\s*steps\.build\.outputs\.digest\s*\}\}/,
    );
  });

  it('asserts the dev-sandbox container is running the just-pushed digest', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml, 'EXPECTED_DIGEST must be threaded from needs.push.outputs.digest').toMatch(
      /EXPECTED_DIGEST:\s*\$\{\{\s*needs\.push\.outputs\.digest\s*\}\}/,
    );
    // The SSM script must perform the equality check (anchor on the FATAL
    // line so a future refactor can't accidentally drop the assertion).
    expect(yml).toContain('LOCAL_REPO_DIGEST');
    expect(yml).toContain('host :main digest');
    expect(yml).toMatch(/!=\s+just-pushed digest/);
  });

  // Regression guard for the dev-sandbox manual-deploy switch. The thin
  // `push-image.yml` entrypoint must stay manual-only (no `push:` trigger).
  // Rollout itself is additionally gated by `inputs.rollout` on the reusable
  // workflow so callers (Release vs manual) can opt out without editing YAML.
  it('keeps push-image.yml manual-only and delegates ECR + rollout to the reusable workflow', () => {
    const yml = readFileSync(pushImageWorkflowPath, 'utf8');
    expect(yml, 'push-image must call the reusable ECR + rollout workflow').toMatch(
      /uses:\s*\.\/\.github\/workflows\/ecr-publish-rollout-docker-dev\.yml/,
    );
    expect(yml, 'push-image must not auto-run on pushes to main').not.toMatch(/^\s*push:\s*$/m);
  });

  it('gates deploy-dev-sandbox rollout behind inputs.rollout on the reusable workflow', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    const jobMatch = yml.match(/^ {2}deploy-dev-sandbox:\s*\n([\s\S]*?)^ {4}steps:\s*$/m);
    expect(jobMatch, 'deploy-dev-sandbox job header must exist in ECR workflow').toBeTruthy();
    const jobHead = jobMatch![1];
    const ifMatch = jobHead.match(/^ {4}if:\s*(.+?)\s*$/m);
    expect(ifMatch, 'deploy-dev-sandbox must declare a job-level `if:` gate').toBeTruthy();
    expect(ifMatch![1]).toContain('inputs.rollout');
  });

  // Regression guard for kanban f1015656 (false-positive ECR deploy failures).
  // The original verification did `sleep 8` + single-shot inspect, which raced
  // the wrapper's async `docker pull` + `docker run` and reported FATAL even
  // though the image was being deployed successfully. The fix is a poll loop
  // that waits for the host digest and container image-id to converge on the
  // just-pushed image before asserting. Make sure no one accidentally
  // reverts to the single-shot inspect.
  it('polls instead of single-shot sleeping before the digest assertion', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    // Poll loop sentinels — these tokens are unique to the new wait_for_deploy
    // implementation and let a future diff make the regression obvious.
    expect(yml, 'must declare a POLL_TIMEOUT for the wait loop').toMatch(/POLL_TIMEOUT=\d+/);
    expect(yml, 'must declare a POLL_DEADLINE driven by date +%s').toMatch(/POLL_DEADLINE=/);
    expect(yml, 'must emit wait_for_deploy progress lines').toContain('wait_for_deploy');
    // The old single-shot `sleep 8` must be gone. Any future fixed-duration
    // sleep before the inspect block is the regression we are guarding against.
    expect(yml, 'fixed `sleep 8` before inspect must not return').not.toMatch(/^\s*sleep 8\s*$/m);
  });

  // Regression guard for Release run 30917756003. The push job builds BOTH the
  // server image and the Finalize runner image under ONE timeout. Warm builds
  // take ~7s each (full gha cache hit), which made 30m look generous — but the
  // runner Dockerfile's `FROM ubuntu:24.04` floats, so when Docker Hub
  // republished that tag (base digest 4fbb8e6a -> 561618e2 on 2026-08-04) every
  // layer invalidated and the cold rebuild blew straight through 30m inside a
  // single apt-get layer.
  //
  // That failure is self-perpetuating and cannot be retried out of:
  // `cache-to` only exports on SUCCESS, so a timed-out run writes no cache and
  // the next attempt starts cold again. The timeout must therefore carry enough
  // headroom for a full cold build of both images. It only ever binds on a
  // cache-miss run, so raising it costs a warm release nothing.
  it('gives the push job enough timeout headroom for a cold, cache-miss image build', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    const jobMatch = yml.match(/^ {2}push:\s*\n([\s\S]*?)^ {4}steps:\s*$/m);
    expect(jobMatch, 'push job header must exist in ECR workflow').toBeTruthy();
    const timeoutMatch = jobMatch![1].match(/^ {4}timeout-minutes:\s*(\d+)\s*$/m);
    expect(timeoutMatch, 'push job must declare a job-level `timeout-minutes`').toBeTruthy();
    // 30m demonstrably could not fit a cold build of the runner image; require
    // meaningful headroom above the observed ~30m cold-build floor.
    expect(
      Number(timeoutMatch![1]),
      'push job timeout must leave room for a cold rebuild of both images (a timed-out build exports no cache, so retries stay cold)',
    ).toBeGreaterThanOrEqual(60);
  });
});

// Hard gate for going public (AH-1395 / AH-1341 flip): no account-specific
// infra identifier may ship in any GitHub Actions workflow. Account IDs and
// role ARNs must be sourced from repo/org Actions Variables & Secrets, not
// baked into the public tree. This mirrors the acceptance grep on the card:
//   grep -rE "1205696|350025135582|797611956947|arn:aws" .github/workflows -> 0
describe('workflow infra-id hygiene (publishable surface)', () => {
  const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
    { label: 'real AWS account id', re: /\b(?:120569607241|350025135582|797611956947)\b/ },
    { label: 'literal AWS ARN', re: /arn:aws:/ },
  ];

  function workflowFiles(): string[] {
    return readdirSync(workflowsDir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => path.join(workflowsDir, f));
  }

  it('scans at least the ECR publish workflow', () => {
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain(ecrPublishWorkflowPath);
  });

  it('contains no hardcoded AWS account ids or ARNs in any workflow', () => {
    const offenders: string[] = [];
    for (const file of workflowFiles()) {
      const body = readFileSync(file, 'utf8');
      for (const { label, re } of FORBIDDEN) {
        const m = body.match(re);
        if (m) offenders.push(`${path.basename(file)}: ${label} (${m[0]})`);
      }
    }
    expect(offenders, `account-specific literals found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('sources the ECR push role from a repo/org Actions Variable', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    // Push role and rollout role must resolve from vars.*, never a literal ARN.
    expect(yml).toMatch(/AWS_ROLE_TO_ASSUME:\s*\$\{\{\s*vars\.ECR_PUSH_ROLE_ARN\s*\}\}/);
    expect(yml).toMatch(/vars\.DOCKER_DEPLOY_ROLE_ARN\s*\|\|\s*vars\.ECR_PUSH_ROLE_ARN/);
  });

  it('parameterizes the ECR registry base via vars.ECR_REGISTRY', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toMatch(/vars\.ECR_REGISTRY\s*\|\|\s*'public\.ecr\.aws\/h9t4v7h0'/);
  });
});
