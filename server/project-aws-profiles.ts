/**
 * Per-project AWS profile definitions.
 *
 * Persisted on the project record (`project.awsSsoProfiles`) and rendered
 * to project-scoped ini files at spawn time for `AWS_CONFIG_FILE` and
 * `AWS_SHARED_CREDENTIALS_FILE`.
 */

export interface ProjectAwsSsoProfile {
  type?: 'sso';
  sso_account_id: string;
  sso_start_url: string;
  sso_region: string;
  sso_role_name: string;
  region: string;
  /** Defaults to `json` when omitted in storage. */
  output?: string;
}

export interface ProjectAwsStaticProfile {
  type: 'static';
  aws_access_key_id: string;
  aws_secret_access_key: string;
  aws_session_token?: string;
  region: string;
  /** Defaults to `json` when omitted in storage. */
  output?: string;
}

/**
 * A role this Hub assumes on its own, with no human in the loop: the
 * credentials come from the Hub's ambient identity (`credential_source`) or
 * from another project profile (`source_profile`), never from an interactive
 * SSO token that expires with nobody around to refresh it.
 */
export interface ProjectAwsRoleProfile {
  type: 'role';
  role_arn: string;
  external_id?: string;
  /** Chain from another profile in this project. Mutually exclusive with `credential_source`. */
  source_profile?: string;
  /** Where the base credentials come from. Defaults to `Ec2InstanceMetadata` on render. */
  credential_source?: AwsCredentialSource;
  role_session_name?: string;
  region: string;
  /** Defaults to `json` when omitted in storage. */
  output?: string;
}

export type ProjectAwsProfile =
  | ProjectAwsSsoProfile
  | ProjectAwsStaticProfile
  | ProjectAwsRoleProfile;
export type ProjectAwsSsoProfilesMap = Record<string, ProjectAwsProfile>;

/** `credential_source` values the AWS CLI accepts (CLI user guide, "Using an IAM role"). */
export const AWS_CREDENTIAL_SOURCES = [
  'Environment',
  'Ec2InstanceMetadata',
  'EcsContainer',
] as const;
export type AwsCredentialSource = (typeof AWS_CREDENTIAL_SOURCES)[number];

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ACCOUNT_ID_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/;
// Partition varies (aws, aws-us-gov, aws-cn); role names may carry a path.
const ROLE_ARN_RE = /^arn:aws[a-z0-9-]*:iam::\d{12}:role\/[^\s/][^\s]*$/;

export class ProjectAwsProfileValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ProjectAwsProfileValidationError';
  }
}

function trimUrl(url: string): string {
  return url.trim().replace(/#+$/, '');
}

function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ProjectAwsProfileValidationError(
      `profile name "${name}" must match ${PROFILE_NAME_RE.source}`,
    );
  }
}

function reqString(o: Record<string, unknown>, name: string, field: string): string {
  const v = o[field];
  if (typeof v !== 'string' || !v.trim()) {
    throw new ProjectAwsProfileValidationError(`profile "${name}".${field} is required`);
  }
  const trimmed = v.trim();
  if (/[\r\n]/.test(trimmed)) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".${field} must be a single-line string`,
    );
  }
  return trimmed;
}

function optionalString(
  o: Record<string, unknown>,
  name: string,
  field: string,
): string | undefined {
  const v = o[field];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !v.trim()) {
    throw new ProjectAwsProfileValidationError(`profile "${name}".${field} must be a string`);
  }
  const trimmed = v.trim();
  if (/[\r\n]/.test(trimmed)) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".${field} must be a single-line string`,
    );
  }
  return trimmed;
}

function validateRegion(name: string, label: string, region: string): void {
  if (!REGION_RE.test(region)) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".${label} must be a valid AWS region (e.g. us-east-2)`,
    );
  }
}

function validateSsoProfile(name: string, o: Record<string, unknown>): ProjectAwsSsoProfile {
  const sso_account_id = reqString(o, name, 'sso_account_id');
  if (!ACCOUNT_ID_RE.test(sso_account_id)) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".sso_account_id must be a 12-digit AWS account id`,
    );
  }
  const sso_start_url = trimUrl(reqString(o, name, 'sso_start_url'));
  if (!sso_start_url.startsWith('https://')) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".sso_start_url must be an https URL`,
    );
  }
  const sso_region = reqString(o, name, 'sso_region');
  const region = reqString(o, name, 'region');
  validateRegion(name, 'sso_region', sso_region);
  validateRegion(name, 'region', region);
  const out: ProjectAwsSsoProfile = {
    type: 'sso',
    sso_account_id,
    sso_start_url,
    sso_region,
    sso_role_name: reqString(o, name, 'sso_role_name'),
    region,
  };
  const output = optionalString(o, name, 'output');
  if (output) out.output = output;
  return out;
}

function validateStaticProfile(name: string, o: Record<string, unknown>): ProjectAwsStaticProfile {
  const region = reqString(o, name, 'region');
  validateRegion(name, 'region', region);
  const out: ProjectAwsStaticProfile = {
    type: 'static',
    aws_access_key_id: reqString(o, name, 'aws_access_key_id'),
    aws_secret_access_key: reqString(o, name, 'aws_secret_access_key'),
    region,
  };
  const token = optionalString(o, name, 'aws_session_token');
  if (token) out.aws_session_token = token;
  const output = optionalString(o, name, 'output');
  if (output) out.output = output;
  return out;
}

function validateRoleProfile(name: string, o: Record<string, unknown>): ProjectAwsRoleProfile {
  const region = reqString(o, name, 'region');
  validateRegion(name, 'region', region);
  const role_arn = reqString(o, name, 'role_arn');
  if (!ROLE_ARN_RE.test(role_arn)) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".role_arn must be an IAM role ARN (arn:aws:iam::123456789012:role/RoleName)`,
    );
  }
  const source_profile = optionalString(o, name, 'source_profile');
  if (source_profile !== undefined) {
    validateProfileName(source_profile);
    if (source_profile === name) {
      throw new ProjectAwsProfileValidationError(
        `profile "${name}".source_profile cannot reference itself`,
      );
    }
  }
  const credential_source = optionalString(o, name, 'credential_source');
  if (credential_source !== undefined) {
    if (source_profile !== undefined) {
      throw new ProjectAwsProfileValidationError(
        `profile "${name}" must set either source_profile or credential_source, not both`,
      );
    }
    if (!(AWS_CREDENTIAL_SOURCES as readonly string[]).includes(credential_source)) {
      throw new ProjectAwsProfileValidationError(
        `profile "${name}".credential_source must be one of ${AWS_CREDENTIAL_SOURCES.join(', ')}`,
      );
    }
  }
  const out: ProjectAwsRoleProfile = { type: 'role', role_arn, region };
  const external_id = optionalString(o, name, 'external_id');
  if (external_id) out.external_id = external_id;
  if (source_profile) out.source_profile = source_profile;
  if (credential_source) out.credential_source = credential_source as AwsCredentialSource;
  const sessionName = optionalString(o, name, 'role_session_name');
  if (sessionName) out.role_session_name = sessionName;
  const output = optionalString(o, name, 'output');
  if (output) out.output = output;
  return out;
}

function validateOneProfile(name: string, raw: unknown): ProjectAwsProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectAwsProfileValidationError(`profile "${name}" must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const rawType = optionalString(o, name, 'type');
  if (rawType !== undefined && rawType !== 'sso' && rawType !== 'static' && rawType !== 'role') {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".type must be "sso", "static" or "role"`,
    );
  }
  if (rawType === 'role' || (!rawType && 'role_arn' in o)) {
    return validateRoleProfile(name, o);
  }
  if (
    rawType === 'static' ||
    (!rawType && ('aws_access_key_id' in o || 'aws_secret_access_key' in o))
  ) {
    return validateStaticProfile(name, o);
  }
  return validateSsoProfile(name, o);
}

/**
 * `source_profile` chains resolve at CLI time, so a dangling or circular
 * reference only shows up as a cryptic botocore error on the first call. Catch
 * both at save time, once the whole map is known.
 */
function validateRoleChains(profiles: ProjectAwsSsoProfilesMap): void {
  for (const name of Object.keys(profiles)) {
    const seen = new Set<string>([name]);
    let cursor = profiles[name];
    while (isProjectAwsRoleProfile(cursor) && cursor.source_profile) {
      const next = cursor.source_profile;
      if (!profiles[next]) {
        throw new ProjectAwsProfileValidationError(
          `profile "${name}".source_profile "${next}" is not a configured profile`,
        );
      }
      if (seen.has(next)) {
        throw new ProjectAwsProfileValidationError(
          `profile "${name}".source_profile chain is circular via "${next}"`,
        );
      }
      seen.add(next);
      cursor = profiles[next];
    }
  }
}

/**
 * Normalize API / PATCH input into a profile map. Accepts either a map
 * `{ dev: { ... } }` or an array `[{ name: 'dev', ...fields }]`.
 */
export function validateProjectAwsSsoProfiles(raw: unknown): ProjectAwsSsoProfilesMap {
  if (raw === null || raw === undefined) {
    return {};
  }
  const out: ProjectAwsSsoProfilesMap = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ProjectAwsProfileValidationError(`profiles[${i}] must be an object`);
      }
      const name = (entry as Record<string, unknown>).name;
      if (typeof name !== 'string' || !name.trim()) {
        throw new ProjectAwsProfileValidationError(`profiles[${i}].name is required`);
      }
      const profileName = name.trim();
      validateProfileName(profileName);
      if (out[profileName]) {
        throw new ProjectAwsProfileValidationError(`duplicate profile name "${profileName}"`);
      }
      out[profileName] = validateOneProfile(profileName, entry);
    }
    validateRoleChains(out);
    return out;
  }
  if (typeof raw !== 'object') {
    throw new ProjectAwsProfileValidationError('profiles must be an object or array');
  }
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    validateProfileName(name);
    if (out[name]) {
      throw new ProjectAwsProfileValidationError(`duplicate profile name "${name}"`);
    }
    out[name] = validateOneProfile(name, value);
  }
  validateRoleChains(out);
  return out;
}

export function isProjectAwsStaticProfile(
  profile: ProjectAwsProfile | undefined,
): profile is ProjectAwsStaticProfile {
  return profile?.type === 'static';
}

export function isProjectAwsRoleProfile(
  profile: ProjectAwsProfile | undefined,
): profile is ProjectAwsRoleProfile {
  return profile?.type === 'role';
}

/** Legacy stanzas stored before `type` existed are SSO profiles. */
export function isProjectAwsSsoProfile(
  profile: ProjectAwsProfile | undefined,
): profile is ProjectAwsSsoProfile {
  return profile !== undefined && profile.type !== 'static' && profile.type !== 'role';
}

/**
 * Normalize the operator-designated default profile. Empty / absent means "no
 * designation"; a name that is not in `profiles` is a 400 rather than a silent
 * drop, so a rename that orphans the designation surfaces at save time.
 */
export function validateProjectAwsDefaultProfile(
  raw: unknown,
  profiles: ProjectAwsSsoProfilesMap,
): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new ProjectAwsProfileValidationError('defaultProfile must be a string');
  }
  const name = raw.trim();
  if (!name) return null;
  if (!profiles[name]) {
    throw new ProjectAwsProfileValidationError(
      `defaultProfile "${name}" is not a configured profile — configured: ${
        Object.keys(profiles).join(', ') || '(none)'
      }`,
    );
  }
  return name;
}

/**
 * Which profile bare `aws …` commands (no `--profile`) should resolve to.
 *
 * The AWS CLI falls back to a profile literally named `default`, which a
 * project-scoped config file never has — so an un-flagged `aws sso login` dies
 * with "Missing the following required SSO configuration values". Exporting
 * `AWS_PROFILE` overrides that fallback (see the AWS CLI env-var reference).
 *
 * Resolution order:
 *   1. the operator's explicit designation, when it still names a live profile;
 *   2. the sole configured profile — with one profile there is nothing to
 *      disambiguate, and the alternative is a guaranteed error;
 *   3. nothing, so a multi-profile project without a designation keeps the
 *      "say which account you mean" behaviour.
 */
export function resolveProjectAwsDefaultProfile(
  profiles: ProjectAwsSsoProfilesMap,
  configured?: string | null,
): string | null {
  const designated = typeof configured === 'string' ? configured.trim() : '';
  if (designated && profiles[designated]) return designated;
  const names = Object.keys(profiles);
  return names.length === 1 ? names[0] : null;
}

/**
 * Env var an operator sets to pin the `credential_source` rendered for role
 * profiles that do not name one, when detection would get it wrong (EKS IRSA,
 * an IMDS hop limit that blocks the container, a proxied metadata endpoint).
 */
export const AWS_CREDENTIAL_SOURCE_ENV = 'AGENT_HUB_AWS_CREDENTIAL_SOURCE';

/**
 * Which `credential_source` a role profile gets when it names neither a
 * `source_profile` nor an explicit source: the one the Hub's own runtime
 * actually provides. Hardcoding `Ec2InstanceMetadata` only works on an EC2
 * instance-profile deployment and fails everywhere else.
 *
 * Precedence, first match wins:
 *   1. `AGENT_HUB_AWS_CREDENTIAL_SOURCE` — operator override, always honoured.
 *   2. `AWS_CONTAINER_CREDENTIALS_{RELATIVE,FULL}_URI` → `EcsContainer`. ECS,
 *      Fargate and EKS Pod Identity all set one of these.
 *   3. `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` → `Environment`. See the
 *      caveat below — this is the deployment where role profiles need help.
 *   4. `Ec2InstanceMetadata` — the reference EC2 + instance-profile topology,
 *      and the only source that needs no env signal to detect.
 *
 * Caveat for `Environment`: spawns are handed a *scrubbed* env
 * (`AWS_AMBIENT_CREDENTIAL_KEYS` in `project-aws-spawn.ts`) so host credentials
 * cannot shadow the selected project profile, which means a spawned `aws` CLI
 * cannot see the vars this stanza points at. The rendered value is still
 * correct for the in-process SDK path, which resolves inside the Hub process
 * where those vars exist. For CLI use on such a deployment, chain the role off
 * a static project profile with `source_profile` instead.
 *
 * Web-identity federation (EKS IRSA, `AWS_WEB_IDENTITY_TOKEN_FILE`) has no
 * `credential_source` spelling at all; those deployments must chain or pin.
 */
export function resolveAmbientCredentialSource(
  env: NodeJS.ProcessEnv = process.env,
): AwsCredentialSource {
  const override = env[AWS_CREDENTIAL_SOURCE_ENV]?.trim();
  if (override) {
    const match = AWS_CREDENTIAL_SOURCES.find(
      (src) => src.toLowerCase() === override.toLowerCase(),
    );
    if (match) return match;
    console.warn(
      `[project-aws] ignoring ${AWS_CREDENTIAL_SOURCE_ENV}="${override}" — expected one of ${AWS_CREDENTIAL_SOURCES.join(', ')}`,
    );
  }
  if (
    env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI?.trim() ||
    env.AWS_CONTAINER_CREDENTIALS_FULL_URI?.trim()
  ) {
    return 'EcsContainer';
  }
  if (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) {
    return 'Environment';
  }
  return 'Ec2InstanceMetadata';
}

/**
 * The `credential_source` a role profile will actually be rendered with, or
 * null when it chains from another profile and uses none. `ambient` is the
 * Hub-runtime default from `resolveAmbientCredentialSource`.
 */
export function effectiveRoleCredentialSource(
  profile: ProjectAwsRoleProfile,
  ambient: AwsCredentialSource,
): AwsCredentialSource | null {
  if (profile.source_profile) return null;
  return profile.credential_source ?? ambient;
}

export interface RenderProjectAwsConfigOpts {
  /**
   * `credential_source` for role profiles that name no origin. Callers should
   * pass `resolveAmbientCredentialSource(process.env)`; the lazy fallback keeps
   * direct callers honest rather than silently assuming EC2.
   */
  defaultCredentialSource?: AwsCredentialSource;
}

/** Render `~/.aws/config`-style ini for the given profiles. */
export function renderProjectAwsConfigIni(
  profiles: ProjectAwsSsoProfilesMap,
  opts: RenderProjectAwsConfigOpts = {},
): string {
  const defaultCredentialSource =
    opts.defaultCredentialSource ?? resolveAmbientCredentialSource(process.env);
  const lines: string[] = [];
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const p = profiles[name];
    lines.push(`[profile ${name}]`);
    if (isProjectAwsSsoProfile(p)) {
      lines.push(`sso_account_id = ${p.sso_account_id}`);
      lines.push(`sso_start_url = ${p.sso_start_url}`);
      lines.push(`sso_region = ${p.sso_region}`);
      lines.push(`sso_role_name = ${p.sso_role_name}`);
    } else if (isProjectAwsRoleProfile(p)) {
      lines.push(`role_arn = ${p.role_arn}`);
      if (p.external_id) lines.push(`external_id = ${p.external_id}`);
      if (p.role_session_name) lines.push(`role_session_name = ${p.role_session_name}`);
      // Exactly one credential origin: chained profile, or the Hub's own
      // ambient identity. The CLI rejects a stanza carrying both.
      if (p.source_profile) {
        lines.push(`source_profile = ${p.source_profile}`);
      } else {
        lines.push(`credential_source = ${p.credential_source ?? defaultCredentialSource}`);
      }
    }
    lines.push(`region = ${p.region}`);
    lines.push(`output = ${p.output ?? 'json'}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Render `~/.aws/credentials`-style ini for static profiles only. */
export function renderProjectAwsCredentialsIni(profiles: ProjectAwsSsoProfilesMap): string {
  const lines: string[] = [];
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const p = profiles[name];
    if (!isProjectAwsStaticProfile(p)) continue;
    lines.push(`[${name}]`);
    lines.push(`aws_access_key_id = ${p.aws_access_key_id}`);
    lines.push(`aws_secret_access_key = ${p.aws_secret_access_key}`);
    if (p.aws_session_token) lines.push(`aws_session_token = ${p.aws_session_token}`);
    lines.push('');
  }
  return lines.join('\n');
}
