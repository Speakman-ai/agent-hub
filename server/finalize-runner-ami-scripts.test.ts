import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const bakeScript = path.join(repoRoot, 'ops/scripts/bake-finalize-runner-ami.sh');
const pinScript = path.join(repoRoot, 'ops/scripts/pin-finalize-runner-ami.sh');
const pruneScript = path.join(repoRoot, 'ops/scripts/prune-finalize-runner-amis.sh');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bake-finalize-runner-ami.sh', () => {
  it('rejects shell syntax in the runner image before making an AWS call', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'finalize-ami-image-validation-'));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'aws.log');
    mkdirSync(bin);
    writeFileSync(log, '');

    const aws = path.join(bin, 'aws');
    writeFileSync(aws, '#!/usr/bin/env bash\necho "$*" >>"$AWS_LOG"\n');
    chmodSync(aws, 0o755);

    const result = spawnSync('bash', [bakeScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        AWS_LOG: log,
        FLEET: 'dev',
        RUNNER_IMAGE: 'public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main; touch /tmp/pwned',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('RUNNER_IMAGE must be a valid OCI image reference');
    expect(readFileSync(log, 'utf8')).toBe('');
  });

  it('does not create an AMI when the SSM command never completes', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'finalize-ami-bake-'));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'aws.log');
    mkdirSync(bin);

    const aws = path.join(bin, 'aws');
    writeFileSync(
      aws,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$AWS_LOG"
case "$*" in
  *'/aws/service/ecs/optimized-ami/'*) echo '{"image_id":"ami-base"}' ;;
  *'describe-security-groups'*'GroupId'*) echo 'sg-test' ;;
  *'describe-security-groups'*'VpcId'*) echo 'vpc-test' ;;
  *'describe-subnets'*) echo 'subnet-test' ;;
  *'run-instances'*) echo 'i-build' ;;
  *'describe-instance-information'*) echo 'Online' ;;
  *'send-command'*) echo 'cmd-pull' ;;
  *'get-command-invocation'*) echo 'Pending' ;;
  *'create-image'*) echo 'ami-should-not-exist' ;;
esac
`,
    );
    chmodSync(aws, 0o755);

    const seq = path.join(bin, 'seq');
    writeFileSync(seq, '#!/usr/bin/env bash\necho 1\n');
    chmodSync(seq, 0o755);
    const sleep = path.join(bin, 'sleep');
    writeFileSync(sleep, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(sleep, 0o755);

    const result = spawnSync('bash', [bakeScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        AWS_LOG: log,
        FLEET: 'dev',
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'SSM pull/command did not complete successfully (last status: Pending)',
    );
    const calls = readFileSync(log, 'utf8');
    const encodedRunner = Buffer.from(
      'public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main',
    ).toString('base64');
    expect(calls).toContain(`RUNNER_IMAGE=$(printf '%s' '${encodedRunner}' | base64 -d)`);
    expect(calls).toContain('docker pull \\"$RUNNER_IMAGE\\"');
    expect(calls).not.toContain(
      'docker pull public.ecr.aws/h9t4v7h0/agent-hub-finalize-runner:main',
    );
    expect(calls).not.toContain('ec2 stop-instances');
    expect(calls).not.toContain('ec2 create-image');
  });
});

describe('prune-finalize-runner-amis.sh', () => {
  it('limits candidates to AMIs carrying the matching bake-purpose tag', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'finalize-ami-prune-'));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'aws.log');
    mkdirSync(bin);

    const aws = path.join(bin, 'aws');
    writeFileSync(aws, '#!/usr/bin/env bash\necho "$*" >>"$AWS_LOG"\n');
    chmodSync(aws, 0o755);

    const result = spawnSync('bash', [pruneScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        AWS_LOG: log,
        FLEET: 'dev',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No self-owned Finalize bake AMIs');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('Name=tag:agenthub:fleet,Values=dev');
    expect(calls).toContain('Name=tag:agenthub:purpose,Values=finalize-runner-ami-bake');

    const bakeSource = readFileSync(bakeScript, 'utf8');
    expect(bakeSource).toContain('{Key=agenthub:purpose,Value=finalize-runner-ami-bake}');
  });

  it('deletes only eligible old AMIs and preserves every protected image', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'finalize-ami-prune-mutations-'));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'aws.log');
    mkdirSync(bin);

    const aws = path.join(bin, 'aws');
    writeFileSync(
      aws,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$AWS_LOG"
case "$*" in
  *'ssm get-parameter'*) echo 'ami-pinned' ;;
  *'ec2 describe-launch-templates'*) echo 'lt-fleet' ;;
  *'ec2 describe-launch-template-versions'*) echo 'ami-default' ;;
  *'ec2 describe-images'*'--owners self'*)
    printf 'ami-newest\tami-pinned\tami-default\tami-in-use\tami-delete\n'
    ;;
  *'ec2 describe-instances'*'ami-in-use'*) echo '1' ;;
  *'ec2 describe-instances'*) echo '0' ;;
  *'ec2 describe-images'*'--image-ids ami-delete'*)
    printf 'snap-delete-a\tsnap-delete-b\n'
    ;;
esac
`,
    );
    chmodSync(aws, 0o755);

    const result = spawnSync('bash', [pruneScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        AWS_LOG: log,
        FLEET: 'dev',
        KEEP: '1',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('keep (slot 1/1): ami-newest');
    expect(result.stdout).toContain('skip (SSM pin): ami-pinned');
    expect(result.stdout).toContain('skip (launch template $Default): ami-default');
    expect(result.stdout).toContain('skip (instance still using image');
    expect(result.stdout).toContain('deregister ami-delete');

    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter((call) => call.startsWith('ec2 deregister-image'))).toEqual([
      'ec2 deregister-image --region us-east-2 --image-id ami-delete',
    ]);
    expect(calls.filter((call) => call.startsWith('ec2 delete-snapshot'))).toEqual([
      'ec2 delete-snapshot --region us-east-2 --snapshot-id snap-delete-a',
      'ec2 delete-snapshot --region us-east-2 --snapshot-id snap-delete-b',
    ]);
    expect(calls.some((call) => call.includes('Name=image-id,Values=ami-pinned'))).toBe(false);
    expect(calls.some((call) => call.includes('Name=image-id,Values=ami-default'))).toBe(false);
    expect(
      calls.some(
        (call) => call.includes('describe-images') && call.includes('--image-ids ami-in-use'),
      ),
    ).toBe(false);
  });
});

describe('pin-finalize-runner-ami.sh', () => {
  it('creates a launch-template version, promotes it, and persists the AMI pin', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'finalize-ami-pin-'));
    tempDirs.push(root);
    const bin = path.join(root, 'bin');
    const log = path.join(root, 'aws.log');
    const githubOutput = path.join(root, 'github-output');
    mkdirSync(bin);

    const aws = path.join(bin, 'aws');
    writeFileSync(
      aws,
      `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"$AWS_LOG"
case "$*" in
  *'ec2 describe-launch-templates'*'--launch-template-ids'*)
    echo 'agenthub-dev-finalize-runner-test'
    ;;
  *'ec2 describe-launch-templates'*) echo 'lt-fleet' ;;
  *'ec2 create-launch-template-version'*) echo '42' ;;
esac
`,
    );
    chmodSync(aws, 0o755);

    const result = spawnSync('bash', [pinScript], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        AWS_LOG: log,
        GITHUB_OUTPUT: githubOutput,
        FLEET: 'dev',
        AMI_ID: 'ami-new',
      },
    });

    expect(result.status).toBe(0);
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    const create = calls.findIndex((call) => call.startsWith('ec2 create-launch-template-version'));
    const promote = calls.findIndex((call) => call.startsWith('ec2 modify-launch-template'));
    const persist = calls.findIndex((call) => call.startsWith('ssm put-parameter'));
    expect(create).toBeGreaterThanOrEqual(0);
    expect(promote).toBeGreaterThan(create);
    expect(persist).toBeGreaterThan(promote);
    expect(calls[create]).toContain('--launch-template-id lt-fleet');
    expect(calls[create]).toContain('--source-version $Latest');
    expect(calls[create]).toContain('--launch-template-data {"ImageId":"ami-new"}');
    expect(calls[promote]).toContain('--default-version 42');
    expect(calls[persist]).toContain('--name /agenthub/dev/finalize-runner-ami-id');
    expect(calls[persist]).toContain('--value ami-new --overwrite');
    expect(calls.some((call) => call.includes('start-instance-refresh'))).toBe(false);
    expect(readFileSync(githubOutput, 'utf8')).toBe(
      'launch_template_id=lt-fleet\nlaunch_template_version=42\nami_id=ami-new\n',
    );
  });
});
