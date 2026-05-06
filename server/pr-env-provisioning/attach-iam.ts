/**
 * `attach-iam` adapter.
 *
 * Goal: ensure the resolved EC2 instance role has the inline policy
 * `agent-hub-pr-env` attached so future certbot runs (and the per-PR
 * dispatcher) can call Route 53. Two paths are supported:
 *
 *   A) **Auto-attach** — when the operator's saved row carries explicit
 *      AWS keys, or the instance role itself can call `iam:PutRolePolicy`
 *      (rare — typically requires self-elevation), the SDK call lands and
 *      the phase finishes `ok`.
 *   B) **Copy-paste fallback** — when neither path is available, the
 *      adapter still finishes `ok` (it surfaced the right next action;
 *      the wizard didn't *fail*) but attaches a remediation card with
 *      the CLI command + Terraform stanza the operator needs to run.
 *
 * The adapter does NOT carry remediations on the result for path B —
 * the orchestrator only forwards remediations from the `verify` phase.
 * Instead, we surface remediations through `extraRemediations` which the
 * executor stitches in. We *also* return the card so callers (tests)
 * can inspect it directly.
 */

import type { DetectedHost } from './detect-host.js';
import type { ExecutorPhaseResult, RemediationCard } from './orchestrator.js';

export interface IamClient {
  putRolePolicy(input: {
    RoleName: string;
    PolicyName: string;
    PolicyDocument: string;
  }): Promise<void>;
  /** Resolve the role name attached to an instance profile. */
  getInstanceProfile?(input: { InstanceProfileName: string }): Promise<{ RoleName: string }>;
}

export interface AttachIamOptions {
  /** Detected host — supplies instanceRoleArn / instanceRoleName. */
  detected: DetectedHost;
  /** When false, skip the SDK call and emit the copy-paste card instead. */
  hasExplicitAwsCreds: boolean;
  /** IAM client. Production wires `@aws-sdk/client-iam`; tests inject a fake. */
  iam: IamClient | null;
  /** Optional ctx.log forwarder. */
  log?: (line: string) => void;
}

export interface AttachIamResult extends ExecutorPhaseResult {
  /**
   * Optional copy-paste card the executor can attach to verify's
   * remediations array (or render directly in path B).
   */
  card?: RemediationCard;
}

export const POLICY_NAME = 'agent-hub-pr-env';

export const POLICY_DOCUMENT = JSON.stringify(
  {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'Route53PreviewDns',
        Effect: 'Allow',
        Action: [
          'route53:GetHostedZone',
          'route53:ListHostedZones',
          'route53:ChangeResourceRecordSets',
          'route53:GetChange',
        ],
        Resource: '*',
      },
    ],
  },
  null,
  2,
);

function copyPasteCard(roleName: string | null): RemediationCard {
  const headline = roleName
    ? `Attach IAM policy "${POLICY_NAME}" to ${roleName}`
    : `Attach IAM policy "${POLICY_NAME}" to the EC2 instance role`;
  const cliRole = roleName ?? '<your-ec2-role-name>';
  const cli = [
    `cat > /tmp/${POLICY_NAME}.json <<'JSON'`,
    POLICY_DOCUMENT,
    'JSON',
    'aws iam put-role-policy \\',
    `  --role-name ${cliRole} \\`,
    `  --policy-name ${POLICY_NAME} \\`,
    `  --policy-document file:///tmp/${POLICY_NAME}.json`,
  ].join('\n');
  const terraform = [
    `resource "aws_iam_role_policy" "${POLICY_NAME.replace(/-/g, '_')}" {`,
    `  name = "${POLICY_NAME}"`,
    `  role = "${cliRole}"`,
    `  policy = jsonencode(${POLICY_DOCUMENT})`,
    '}',
  ].join('\n');
  return {
    check: 'route53',
    severity: 'amber',
    headline,
    detail:
      'No AWS keys configured and the EC2 instance role cannot call iam:PutRolePolicy. ' +
      'Run the CLI below from a workstation with admin perms, or commit the Terraform block.',
    actions: [
      { label: 'Copy CLI', kind: 'copy', payload: cli },
      { label: 'Copy Terraform', kind: 'copy', payload: terraform },
      ...(roleName
        ? [
            {
              label: `Open IAM console for ${roleName}`,
              kind: 'link' as const,
              payload: `https://console.aws.amazon.com/iam/home#/roles/${encodeURIComponent(roleName)}`,
            },
          ]
        : []),
    ],
  };
}

export async function attachIam(opts: AttachIamOptions): Promise<AttachIamResult> {
  const log = opts.log ?? (() => {});
  const { detected, hasExplicitAwsCreds, iam } = opts;

  // No keys + no instance role → copy-paste card; phase is still ok.
  if (!hasExplicitAwsCreds && !detected.instanceRoleArn) {
    log('attach-iam: no AWS keys and no detected instance role — emitting copy-paste card');
    return {
      status: 'ok',
      message: 'copy-paste required (no AWS keys, no instance role)',
      card: copyPasteCard(null),
    };
  }

  // Explicit keys + no instance role → operator's explicit AWS keys will be
  // used at runtime directly. There's nothing to attach a policy to — the
  // keys *are* the auth path. Common in `containerized` installs where
  // there is no EC2 instance role available, and a perfectly valid setup
  // for `pm2-on-ec2` hosts where the operator prefers static keys over
  // an instance-profile attachment.
  if (hasExplicitAwsCreds && !detected.instanceRoleArn && !detected.instanceRoleName) {
    log(
      'attach-iam: explicit AWS keys provided and no instance role detected — keys will be used directly at runtime; nothing to attach',
    );
    return {
      status: 'ok',
      message: 'explicit AWS keys will be used at runtime; no role attachment needed',
    };
  }

  // We have *either* explicit creds or a detected instance role. Try the SDK
  // path; the operator either provided keys (path A) or the instance role
  // itself has iam:PutRolePolicy (also path A — rare but possible).
  if (!iam) {
    log('attach-iam: IAM client not provided — emitting copy-paste card');
    return {
      status: 'ok',
      message: 'IAM client unavailable; copy-paste card emitted',
      card: copyPasteCard(detected.instanceRoleName),
    };
  }

  // Resolve role name. The detected ARN is the *instance profile* arn; the
  // role usually shares the profile's name but not always. When they
  // diverge we fall back to GetInstanceProfile.
  let roleName = detected.instanceRoleName;
  if (!roleName && detected.instanceRoleArn && iam.getInstanceProfile) {
    const profileName = detected.instanceRoleArn.split('/').pop() ?? '';
    if (profileName) {
      try {
        const resolved = await iam.getInstanceProfile({ InstanceProfileName: profileName });
        roleName = resolved.RoleName;
        log(`attach-iam: GetInstanceProfile resolved role ${roleName}`);
      } catch (err) {
        log(`attach-iam: GetInstanceProfile failed (${(err as Error).message})`);
      }
    }
  }

  if (!roleName) {
    return {
      status: 'ok',
      message: 'role name not resolvable — copy-paste card emitted',
      card: copyPasteCard(null),
    };
  }

  try {
    await iam.putRolePolicy({
      RoleName: roleName,
      PolicyName: POLICY_NAME,
      PolicyDocument: POLICY_DOCUMENT,
    });
    log(`attach-iam: PutRolePolicy ok (role=${roleName}, policy=${POLICY_NAME})`);
    return {
      status: 'ok',
      message: `attached ${POLICY_NAME} to ${roleName}`,
    };
  } catch (err) {
    const e = err as { name?: string; message?: string };
    log(`attach-iam: PutRolePolicy failed (${e.name ?? 'Error'}: ${e.message ?? String(err)})`);
    return {
      status: 'ok',
      message: `PutRolePolicy failed (${e.name ?? 'Error'}); copy-paste card emitted`,
      card: copyPasteCard(roleName),
    };
  }
}
