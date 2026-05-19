/**
 * Per-project AWS IAM Identity Center (SSO) profile definitions.
 *
 * Persisted on the project record (`project.awsSsoProfiles`) and rendered
 * to an ini file at spawn time for `AWS_CONFIG_FILE`. Not credentials —
 * SSO tokens still live under the spawning user's `~/.aws/sso/cache`.
 */

export interface ProjectAwsSsoProfile {
  sso_account_id: string;
  sso_start_url: string;
  sso_region: string;
  sso_role_name: string;
  region: string;
  /** Defaults to `json` when omitted in storage. */
  output?: string;
}

export type ProjectAwsSsoProfilesMap = Record<string, ProjectAwsSsoProfile>;

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

function validateOneProfile(name: string, raw: unknown): ProjectAwsSsoProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ProjectAwsProfileValidationError(`profile "${name}" must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const req = (field: keyof ProjectAwsSsoProfile): string => {
    const v = o[field];
    if (typeof v !== 'string' || !v.trim()) {
      throw new ProjectAwsProfileValidationError(`profile "${name}".${field} is required`);
    }
    return v.trim();
  };
  const sso_account_id = req('sso_account_id');
  if (!ACCOUNT_ID_RE.test(sso_account_id)) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".sso_account_id must be a 12-digit AWS account id`,
    );
  }
  const sso_start_url = trimUrl(req('sso_start_url'));
  if (!sso_start_url.startsWith('https://')) {
    throw new ProjectAwsProfileValidationError(
      `profile "${name}".sso_start_url must be an https URL`,
    );
  }
  const sso_region = req('sso_region');
  const region = req('region');
  for (const [label, r] of [
    ['sso_region', sso_region],
    ['region', region],
  ] as const) {
    if (!REGION_RE.test(r)) {
      throw new ProjectAwsProfileValidationError(
        `profile "${name}".${label} must be a valid AWS region (e.g. us-east-2)`,
      );
    }
  }
  const sso_role_name = req('sso_role_name');
  const out: ProjectAwsSsoProfile = {
    sso_account_id,
    sso_start_url,
    sso_region,
    sso_role_name,
    region,
  };
  if (o.output !== undefined) {
    if (typeof o.output !== 'string' || !o.output.trim()) {
      throw new ProjectAwsProfileValidationError(
        `profile "${name}".output must be a non-empty string`,
      );
    }
    out.output = o.output.trim();
  }
  return out;
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

/** Render `~/.aws/config`-style ini for the given profiles. */
export function renderProjectAwsConfigIni(profiles: ProjectAwsSsoProfilesMap): string {
  const lines: string[] = [];
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const p = profiles[name];
    lines.push(`[profile ${name}]`);
    lines.push(`sso_account_id = ${p.sso_account_id}`);
    lines.push(`sso_start_url = ${p.sso_start_url}`);
    lines.push(`sso_region = ${p.sso_region}`);
    lines.push(`sso_role_name = ${p.sso_role_name}`);
    lines.push(`region = ${p.region}`);
    lines.push(`output = ${p.output ?? 'json'}`);
    lines.push('');
  }
  return lines.join('\n');
}
