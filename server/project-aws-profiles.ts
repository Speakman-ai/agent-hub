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

export type ProjectAwsProfile = ProjectAwsSsoProfile | ProjectAwsStaticProfile;
export type ProjectAwsSsoProfilesMap = Record<string, ProjectAwsProfile>;

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ACCOUNT_ID_RE = /^\d{12}$/;
const REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d$/;

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

function validateOneProfile(name: string, raw: unknown): ProjectAwsProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectAwsProfileValidationError(`profile "${name}" must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const rawType = optionalString(o, name, 'type');
  if (rawType !== undefined && rawType !== 'sso' && rawType !== 'static') {
    throw new ProjectAwsProfileValidationError(`profile "${name}".type must be "sso" or "static"`);
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
  return out;
}

export function isProjectAwsStaticProfile(
  profile: ProjectAwsProfile | undefined,
): profile is ProjectAwsStaticProfile {
  return profile?.type === 'static';
}

/** Render `~/.aws/config`-style ini for the given profiles. */
export function renderProjectAwsConfigIni(profiles: ProjectAwsSsoProfilesMap): string {
  const lines: string[] = [];
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const p = profiles[name];
    lines.push(`[profile ${name}]`);
    if (!isProjectAwsStaticProfile(p)) {
      lines.push(`sso_account_id = ${p.sso_account_id}`);
      lines.push(`sso_start_url = ${p.sso_start_url}`);
      lines.push(`sso_region = ${p.sso_region}`);
      lines.push(`sso_role_name = ${p.sso_role_name}`);
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
