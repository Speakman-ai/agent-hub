import { execFileSync } from 'child_process';
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
  // The deploy target is parameterized via repo Variables / workflow inputs
  // ONLY — no literal instance-id fallback. A real `i-...` fallback used to ship
  // here and leaked a private EC2 instance id into the public tree (card #1598).
  // The DEPLOY_INSTANCE_ID line must resolve from inputs / vars; the job's own
  // preflight fails loudly when none are set.
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
    // Prefer explicit input, then DEV Hub var, then legacy sandbox var.
    expect(line, 'DEPLOY_INSTANCE_ID must resolve from inputs/vars only').toMatch(
      /inputs\.deploy_instance_id\s*\|\|\s*vars\.DOCKER_DEPLOY_INSTANCE_ID/,
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
  // fallback. The sandbox env dir was renamed ryan -> dev and then
  // decommissioned. Prod config now lives in committed prod.tfvars; the
  // workflow still sources the deploy target from DOCKER_DEPLOY_INSTANCE_ID.
  // What is still guardable here: the dev `.example` template documents the
  // same knob with a placeholder, never a real id, and the workflow keeps
  // the deploy target parameterized via the repo Variable.
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
    expect(yml, 'workflow must keep DEPLOY_INSTANCE_ID sourced from inputs/vars').toMatch(
      /DEPLOY_INSTANCE_ID:\s*\$\{\{\s*inputs\.deploy_instance_id\s*\|\|\s*vars\.DOCKER_DEPLOY_INSTANCE_ID/,
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
    expect(yml).toContain('host :\\$DEPLOY_TAG digest');
    expect(yml).toMatch(/!=\s+just-pushed digest/);
  });

  it('asserts against the moving tag it published rather than a literal main', () => {
    // A dispatch on a non-main ref publishes `<ref-name>` and the target host is
    // pointed at that same tag. Comparing a hardcoded `:main` there inspected an
    // unrelated, usually older image, so the assertion could only fail: the image
    // was live and correct while CI reported the rollout as broken.
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toMatch(/moving_tag:\s*\$\{\{\s*steps\.tags\.outputs\.branch\s*\}\}/);
    expect(yml).toMatch(
      /DEPLOY_TAG:\s*\$\{\{\s*needs\.push\.outputs\.moving_tag\s*\|\|\s*'main'\s*\}\}/,
    );
    expect(yml, 'the digest lookup must use the tag, not a literal').not.toMatch(
      /docker image inspect \$\{ECR_PUBLIC_URI\}:main/,
    );
  });

  /**
   * Runs the workflow's tag sanitizer + moving-tag assignment, so this cannot
   * drift from what CI does.
   */
  function computeMovingTag(opts: {
    githubRefName?: string;
    gitRef?: string;
    versionTag?: string;
    shaShort?: string;
  }): string {
    const shaShort = opts.shaShort ?? 'abc123def456';
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    const start = yml.indexOf('sanitize_docker_tag() {');
    const end = yml.indexOf('echo "sha_short=', start);
    expect(start, 'sanitize_docker_tag in Compute tags step').toBeGreaterThan(-1);
    expect(end, 'sha_short output in Compute tags step').toBeGreaterThan(start);
    const script = `SHA_SHORT="${shaShort}"
INPUT_VERSION_TAG="${opts.versionTag ?? ''}"
INPUT_GIT_REF="${opts.gitRef ?? ''}"
${yml.slice(start, end)}
printf '%s' "$BRANCH"`;
    return execFileSync('bash', ['-c', script], {
      env: { ...process.env, GITHUB_REF_NAME: opts.githubRefName ?? 'main' },
      encoding: 'utf8',
    });
  }

  function computeBranchTag(refName: string, shaShort = 'abc123def456'): string {
    return computeMovingTag({ githubRefName: refName, shaShort });
  }

  it('turns a slashed branch into a usable docker tag with a SHA suffix', () => {
    expect(computeBranchTag('preview/session-owned-environment')).toBe(
      'preview-session-owned-environment-abc123def456',
    );
  });

  it('preserves stable main and semver tags without a SHA suffix', () => {
    expect(computeBranchTag('main')).toBe('main');
    expect(computeBranchTag('v1.2.3')).toBe('v1.2.3');
    expect(computeBranchTag('1.2.3')).toBe('1.2.3');
  });

  it('suffixes non-stable refs so sanitize collisions cannot collide', () => {
    expect(computeBranchTag('feature/a')).toBe('feature-a-abc123def456');
    expect(computeBranchTag('feature-a', 'deadbeef0001')).toBe('feature-a-deadbeef0001');
  });

  it('produces a tag docker will accept for any ref name', () => {
    const dockerTag = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
    for (const ref of ['feat/a b', 'release/v1.2.3', 'user@host/test', 'main']) {
      expect(computeBranchTag(ref), ref).toMatch(dockerTag);
    }
  });

  it('sanitizes invalid characters and collapses repeated dashes', () => {
    expect(computeBranchTag('feat/@foo--bar')).toBe('feat-foo-bar-abc123def456');
  });

  it('truncates the base so the full SHA suffix always remains', () => {
    const longRef = `release/${'a'.repeat(200)}`;
    const tag = computeBranchTag(longRef);
    expect(tag).toHaveLength(128);
    expect(tag.endsWith('-abc123def456')).toBe(true);
  });

  it('falls back to branch when sanitization leaves nothing usable', () => {
    expect(computeBranchTag('@@@')).toBe('branch-abc123def456');
  });

  it('Release version_tag owns the moving tag even when the caller ref is main', () => {
    // Reusable workflows inherit the caller's GITHUB_REF_NAME. Release is
    // dispatched from main while checking out refs/tags/vX.Y.Z — using the
    // inherited `main` retagged :main and raced Deploy DEV Hub from main.
    expect(
      computeMovingTag({
        githubRefName: 'main',
        gitRef: 'refs/tags/v2.31.77',
        versionTag: 'refs/tags/v2.31.77',
      }),
    ).toBe('v2.31.77');
    expect(
      computeMovingTag({
        githubRefName: 'main',
        gitRef: 'abc123def456',
      }),
    ).toBe('main');
  });

  it('does not retag main when publishing a release version tag', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toContain('INPUT_GIT_REF: ${{ inputs.git_ref }}');
    expect(yml).toMatch(/if \[\[ -n "\$EXTRA_TAG" \]\]; then\s*\n\s*MOVING_SRC="\$EXTRA_TAG"/);
  });

  it('reset path also writes image-tag and verifies digest', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    const resetStart = yml.indexOf('if [[ "$BOOL_RESET" == "true" ]]');
    const resetEnd = yml.indexOf('CI fresh-setup reset');
    expect(resetStart).toBeGreaterThan(-1);
    expect(resetEnd).toBeGreaterThan(resetStart);
    const resetBlock = yml.slice(resetStart, resetEnd);
    expect(resetBlock).toContain('/etc/agent-hub/image-tag');
    expect(resetBlock).toMatch(/LOCAL_DIGEST/);
    expect(resetBlock).toMatch(/EXPECTED_DIGEST/);
  });

  it('writes the deploy tag before restarting systemd', () => {
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toContain('/etc/agent-hub/image-tag');
    expect(yml).toMatch(/tee \/etc\/agent-hub\/image-tag/);
  });

  it('heals host run scripts that ignore image-tag before restart', () => {
    // Prod Release v2.31.78: CI wrote image-tag=v2.31.78 but agenthub-server-run.sh
    // still always pulled :main (script only refreshed at first boot). Digest gate
    // saw empty LOCAL_REPO_DIGEST for :v2.31.78 while the container stayed on :main.
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toContain('ensure_image_tag_override');
    expect(yml).toMatch(/Patching \$script to honor \/etc\/agent-hub\/image-tag/);
    // Both reset and normal deploy paths must call it after writing the tag.
    const calls = yml.match(/ensure_image_tag_override\b/g) ?? [];
    expect(calls.length, 'define once + call from both deploy paths').toBeGreaterThanOrEqual(3);
  });

  it('prints the tag it rolled out in the run summary', () => {
    // The escapes elsewhere are deliberate — those lines are inside the
    // heredoc sent to SSM, where expansion has to happen on the remote host.
    // The summary is an ordinary step shell, so the same escape reaches the
    // reader as the literal `$DEPLOY_TAG` and the summary stops naming which
    // image actually went out.
    const yml = readFileSync(ecrPublishWorkflowPath, 'utf8');
    expect(yml).toMatch(/pull picks up \\`:\$DEPLOY_TAG\\`/);
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

  it('does not auto-deploy the decommissioned DEV Hub from main', () => {
    const yml = readFileSync(path.join(workflowsDir, 'deploy-dev-hub-on-main.yml'), 'utf8');
    expect(yml, 'must not auto-run on pushes to main').not.toMatch(/^\s*push:\s*$/m);
    expect(yml).toMatch(/^\s*workflow_dispatch:\s*$/m);
    expect(yml).toMatch(/DEV Hub is decommissioned/);
    expect(yml).toMatch(/torn down 2026-08-17/);
    expect(yml, 'must fail closed rather than skip green').toMatch(/exit 1/);
    // Never bake a concrete instance id into the public tree.
    expect(yml.match(/i-[a-f0-9]+/)?.[0], 'no hardcoded instance id').toBeFalsy();
    // Must not silently fall back to the sandbox Variable.
    expect(yml).not.toMatch(
      /deploy_instance_id:\s*\$\{\{\s*vars\.DOCKER_DEPLOY_INSTANCE_ID\s*\}\}/,
    );
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
