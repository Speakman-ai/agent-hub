/**
 * Hub-local draft for the **Infrastructure setup wizard**
 * (`GET .../infra/setup-draft`).
 *
 * Pure, AWS-free, DB-free, spawn-free: a total function over the project record
 * plus already-read Hub state, returning a JSON-serializable summary of what is
 * configured and what still blocks unattended monitoring.
 *
 * ## Why this one does not probe the account (decision INFRA-WIZARD)
 *
 * Every other setup wizard's draft scans a repository. Infra has no repo to
 * scan — the equivalent input is a live AWS account, and probing one costs
 * money, takes seconds to minutes, and needs credentials that resolve. Making
 * the draft depend on that would be exactly backwards: the wizard's single most
 * common first job is a project whose only profiles are interactive SSO, which
 * therefore *cannot* monitor anything (decision INFRA-CRED). A draft that
 * needed working non-SSO credentials to render would fail precisely when the
 * wizard is most needed, and the operator would get an auth error where they
 * needed the sentence "you have no monitoring profile, here is how to make one".
 *
 * So the split is: this module answers "what does the Hub already know?", and
 * the live account probe happens inside the spawned wizard session, performed by
 * the agent with the `aws-cli` skill under that decision's describe-only rules.
 * Keeping this half free and instant is what lets the endpoint be the thing the
 * empty state calls on every render.
 *
 * ## Purity is enforced by having no runtime imports at all
 *
 * Everything this module needs arrives as an argument, and its only imports are
 * `import type` (erased at runtime) plus `project-aws-profiles.js`, which is
 * itself dependency-free string/ini logic. There is no path from here to an AWS
 * SDK client, to `getInfraDb()`, or to `child_process` — not as a discipline the
 * reader has to verify, but as a property of the import graph. `infra-scopes`
 * and alert rows are read by the route and passed in, mirroring how
 * `logs-wizard.ts` enriches `collectLogsSetupDraft` with its log sources.
 *
 * ## Secrets
 *
 * Profiles are summarized to `{ name, type, region }` and nothing else. Static
 * profiles hold an access key, a secret key and possibly a session token; role
 * profiles hold the Hub's external ID, which is the shared half of a customer's
 * trust policy. None of those are read here, so there is no serialization path
 * that could carry them — the safest way to not leak a field is to never load
 * it. `infra-setup-draft.test.ts` asserts this against a project stuffed with
 * credential material.
 */

import {
  isProjectAwsSsoProfile,
  resolveProjectAwsMonitoringProfile,
  type ProjectAwsProfile,
  type ProjectAwsSsoProfilesMap,
} from './project-aws-profiles.js';
import type { InfraScope } from './infra/infra-scope-store.js';
import type { InfraAlertRuleRow } from './infra/alert-store.js';
import type { Project } from './types.js';

/** The three arms of the project profile union, as the wizard reports them. */
export type InfraSetupProfileType = 'sso' | 'static' | 'role';

/**
 * One configured AWS profile, reduced to what the wizard reasons about.
 *
 * Deliberately three scalar fields and a derived boolean. See the module
 * header: no credential material is read, so none can be serialized.
 */
export interface InfraSetupProfileSummary {
  name: string;
  type: InfraSetupProfileType;
  /** The profile's default region — the wizard's starting suggestion for scope. */
  region: string;
  /**
   * Whether this profile could back unattended background collection, i.e. it
   * is not interactive SSO. Mirrors the rule
   * {@link resolveProjectAwsMonitoringProfile} enforces, so the UI never offers
   * a designation the validator would reject.
   */
  monitoringCapable: boolean;
}

/** One `infra_scopes` row, reduced to the allowlist triple and its health. */
export interface InfraSetupScopeSummary {
  profileName: string;
  /** Filled in asynchronously by the first `sts:GetCallerIdentity`; null until then. */
  accountId: string | null;
  region: string;
  service: string;
  enabled: boolean;
  /** Whether a tag predicate narrows this scope. The predicate itself is not needed here. */
  hasTagFilter: boolean;
  /**
   * Non-terminated resources inventory currently holds for the triple. Zero on
   * a fresh scope is expected — inventory sync runs hourly — and the wizard
   * should say so rather than read it as "this scope is broken".
   */
  resourceCount: number;
}

/**
 * A precondition that is not met yet, named so the UI and the wizard prompt can
 * branch without re-deriving the rule.
 *
 * Causes and state are reported separately and can co-occur:
 * `only-sso-profiles` is *why* there is no designation, `no-monitoring-profile`
 * is *that* there is none. The wizard needs the second to decide whether
 * monitoring can run at all, and the first to decide what to tell the operator
 * to do about it.
 */
export type InfraSetupBlocker =
  | 'infra-disabled'
  | 'no-profiles'
  | 'only-sso-profiles'
  | 'no-monitoring-profile'
  | 'storage-unavailable'
  | 'no-scope';

export interface InfraSetupDraft {
  projectId: string;
  /** Whether the Infrastructure module is switched on for this project. */
  infraEnabled: boolean;
  profiles: InfraSetupProfileSummary[];
  /**
   * The raw `awsMonitoringProfile` designation as stored, even when it no
   * longer names a usable profile. Kept distinct from `monitoringProfile` so a
   * designation orphaned by a rename or a flip to SSO reads as "this is set but
   * dead" instead of vanishing.
   */
  designatedMonitoringProfile: string | null;
  /**
   * The profile background collection would actually run as, or null. Resolved
   * through {@link resolveProjectAwsMonitoringProfile}, so it is null whenever
   * the collector would also refuse.
   */
  monitoringProfile: string | null;
  /** Names of profiles eligible for designation — the picker's option list. */
  monitoringCapableProfiles: string[];
  /** Whether `infra.db` is open. False means the scope/alert figures below are unknown, not zero. */
  storageReady: boolean;
  scopes: InfraSetupScopeSummary[];
  /** Enabled scopes only — the ones that actually cause billed requests. */
  enabledScopeCount: number;
  alertRuleCount: number;
  enabledAlertRuleCount: number;
  /** Unmet preconditions, in the order an operator should resolve them. */
  blockers: InfraSetupBlocker[];
  /** Human-readable observations for the operator and the wizard prompt. */
  notes: string[];
}

export interface CollectInfraSetupDraftOptions {
  /**
   * Rows from `listInfraScopes`. Omitted means "none configured"; pass
   * `storageReady: false` to distinguish that from "could not be read".
   */
  scopes?: readonly InfraScope[];
  /** Rows from `listInfraAlertRules`. */
  alertRules?: readonly InfraAlertRuleRow[];
  /**
   * Whether `infra.db` was open when `scopes` / `alertRules` were read.
   * Defaults to true, matching the normal server where the DB is initialized.
   */
  storageReady?: boolean;
}

function profileType(profile: ProjectAwsProfile): InfraSetupProfileType {
  if (profile.type === 'static') return 'static';
  if (profile.type === 'role') return 'role';
  // Legacy stanzas stored before `type` existed are SSO, per
  // `isProjectAwsSsoProfile`. Reusing that predicate keeps the two in step.
  return 'sso';
}

function summarizeProfiles(profiles: ProjectAwsSsoProfilesMap): InfraSetupProfileSummary[] {
  return Object.keys(profiles)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const profile = profiles[name] as ProjectAwsProfile;
      return {
        name,
        type: profileType(profile),
        region: profile.region,
        monitoringCapable: !isProjectAwsSsoProfile(profile),
      };
    });
}

function summarizeScopes(scopes: readonly InfraScope[]): InfraSetupScopeSummary[] {
  return scopes.map((scope) => ({
    profileName: scope.profileName,
    accountId: scope.accountId,
    region: scope.region,
    service: scope.service,
    enabled: scope.enabled,
    hasTagFilter: scope.tagFilter !== null && Object.keys(scope.tagFilter).length > 0,
    resourceCount: scope.resourceCount,
  }));
}

/**
 * Summarize a project's monitoring readiness from Hub-side state only.
 *
 * Never throws and never performs IO: a project with no AWS configuration at
 * all yields a fully-populated draft whose `blockers` explain what to do, which
 * is the case the wizard exists to serve.
 */
export function collectInfraSetupDraft(
  project: Project,
  opts: CollectInfraSetupDraftOptions = {},
): InfraSetupDraft {
  const storageReady = opts.storageReady !== false;
  const scopeRows = opts.scopes ?? [];
  const alertRules = opts.alertRules ?? [];

  const rawProfiles = (project.awsSsoProfiles ?? {}) as ProjectAwsSsoProfilesMap;
  const profiles = summarizeProfiles(rawProfiles);
  const monitoringCapableProfiles = profiles.filter((p) => p.monitoringCapable).map((p) => p.name);

  const designatedMonitoringProfile =
    typeof project.awsMonitoringProfile === 'string' && project.awsMonitoringProfile.trim() !== ''
      ? project.awsMonitoringProfile.trim()
      : null;
  const monitoringProfile = resolveProjectAwsMonitoringProfile(
    rawProfiles,
    designatedMonitoringProfile,
  );

  const scopes = summarizeScopes(scopeRows);
  const enabledScopeCount = scopes.filter((s) => s.enabled).length;
  const enabledAlertRuleCount = alertRules.filter((r) => r.enabled === 1).length;
  const infraEnabled = project.infraEnabled === true;

  const blockers: InfraSetupBlocker[] = [];
  const notes: string[] = [];

  if (!infraEnabled) {
    blockers.push('infra-disabled');
    notes.push(
      'The Infrastructure module is off for this project. Turn it on in Settings → Projects; nothing is collected while it is off.',
    );
  }

  if (profiles.length === 0) {
    blockers.push('no-profiles');
    notes.push(
      'No AWS profiles are configured for this project. Add one in the project AWS settings module before scoping anything.',
    );
  } else if (monitoringCapableProfiles.length === 0) {
    blockers.push('only-sso-profiles');
    notes.push(
      'Every configured profile is IAM Identity Center (SSO). An SSO token cache is keyed to a user’s HOME and expires with nobody around to re-run "aws sso login", so background collection would stop within hours. Add a static or assume-role profile to monitor this project.',
    );
  }

  if (!monitoringProfile) {
    blockers.push('no-monitoring-profile');
    if (designatedMonitoringProfile) {
      // The designation survived but no longer resolves: renamed profile,
      // hand-edited projects.json, or a profile flipped to SSO. Saying "none
      // designated" here would send the operator to a field that already looks
      // filled in.
      notes.push(
        `Monitoring profile "${designatedMonitoringProfile}" is designated but no longer resolves to a usable non-SSO profile. Re-designate it in the project AWS settings module.`,
      );
    } else if (monitoringCapableProfiles.length > 0) {
      notes.push(
        `No monitoring profile is designated. Eligible profiles: ${monitoringCapableProfiles.join(', ')}. Designating one is an explicit act — the Hub never assumes a profile to spend AWS API budget under.`,
      );
    }
  }

  if (!storageReady) {
    // Distinct from `no-scope`: the operator cannot fix this by adding a scope,
    // and reporting zero scopes as if it were a configuration choice would send
    // them to the wrong screen.
    blockers.push('storage-unavailable');
    notes.push(
      'The infrastructure database is not open, so existing scopes and alert rules could not be read. The counts below are unknown, not zero.',
    );
  } else if (enabledScopeCount === 0) {
    blockers.push('no-scope');
    notes.push(
      scopes.length > 0
        ? 'Every collection scope is disabled, so nothing is polled. A disabled scope is a pause, not a delete.'
        : 'No collection scope is defined. Collection is an explicit allowlist — the absence of a scope means "poll nothing", never "poll everything".',
    );
  }

  if (storageReady && alertRules.length === 0 && enabledScopeCount > 0) {
    notes.push(
      'Scopes are collecting but no alert rules exist yet — metrics will be stored and charted, and nothing will notify. Consider applying the default rule pack for the scoped services.',
    );
  }

  return {
    projectId: project.id,
    infraEnabled,
    profiles,
    designatedMonitoringProfile,
    monitoringProfile,
    monitoringCapableProfiles,
    storageReady,
    scopes,
    enabledScopeCount,
    alertRuleCount: alertRules.length,
    enabledAlertRuleCount,
    blockers,
    notes,
  };
}
