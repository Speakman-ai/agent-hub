/**
 * First-launch auto-provisioning of the Owner account from environment
 * variables. Designed for Terraform / Docker / SSM-driven deployments
 * where there is no human at a keyboard to hit `/api/auth/setup`.
 *
 * Trigger surface (env vars):
 *   - `AGENT_HUB_DEFAULT_PASSWORD`
 *       unset / empty → no-op; the existing interactive setup endpoint
 *           remains the only path to create an Owner.
 *       literal value → use as-is. Must satisfy the same length bounds
 *           enforced by `/api/auth/setup` (`auth-validation.ts`).
 *       `auto`        → generate a URL-safe random password and write it
 *           to `<dataDir>/initial-credentials.txt` (mode 0600). The
 *           operator retrieves it via SSM Session Manager / SSH and is
 *           expected to rotate it at first login.
 *   - `AGENT_HUB_DEFAULT_USERNAME`
 *       defaults to `admin` when only the password is set. Validated
 *       against the same allowlist as `/api/auth/setup`.
 *
 * Idempotency: once `auth.json` exists, this function never overwrites
 * it. That means the first successful provision wins — re-running with
 * a different env will NOT rotate the password. (Rotating the credential
 * is an out-of-band action: delete the auth.json + credentials file,
 * restart, set the new env.)
 *
 * Failure modes:
 *   - Validation failure (bad username regex / short password) is logged
 *     and skipped; the server keeps booting with no Owner so the
 *     interactive endpoint can still be reached.
 *   - For `=auto`, an inability to write the credentials file is fatal:
 *     the random password would otherwise be unrecoverable.
 *   - Migration of the auth record into orgs.db (`migrateAuthRecordIfNeeded`)
 *     is best-effort. A failure there is logged but does not unwind the
 *     auth.json write — the migration runs again on the next request.
 */
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import config from './config.js';
import { hashPassword } from './password.js';
import { getAuthRecord, saveAuthRecord, generateJwtSecret } from './auth-store.js';
import { sanitizeUsername, sanitizePassword, MIN_PASSWORD_LEN } from './auth-validation.js';
import { migrateAuthRecordIfNeeded } from './users-store.js';

const DEFAULT_USERNAME = 'admin';
const AUTO_KEYWORD = 'auto';
/** Bytes of entropy. base64url-encoded → 24 chars, ≥ 128 bits of entropy. */
const AUTO_PASSWORD_BYTES = 18;
const CREDENTIALS_FILENAME = 'initial-credentials.txt';

export interface BootstrapOptions {
  /** Override env source (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Override data directory (defaults to `config.dataDir`). */
  dataDir?: string;
  /** Override timestamp source (defaults to `() => new Date()`). */
  now?: () => Date;
  /** Override RNG (defaults to crypto.randomBytes → base64url). */
  randomPassword?: () => string;
  /** Override logger (defaults to `console.log` / `console.error`). */
  log?: (level: 'info' | 'error', msg: string) => void;
}

export type BootstrapResult =
  | { provisioned: false; reason: BootstrapSkipReason }
  | {
      provisioned: true;
      username: string;
      passwordSource: 'env' | 'auto';
      /** Absolute path of the written credentials file (only for auto). */
      credentialsFile?: string;
    };

export type BootstrapSkipReason =
  | 'no-default-password-env'
  | 'auth-already-configured'
  | 'invalid-username'
  | 'invalid-password'
  /** `index.ts` calls with empty opts during Vitest; do not inherit host deploy env. */
  | 'test-mode';

function defaultLogger(level: 'info' | 'error', msg: string): void {
  (level === 'error' ? console.error : console.log)(msg);
}

function defaultRandomPassword(): string {
  return randomBytes(AUTO_PASSWORD_BYTES).toString('base64url');
}

/**
 * Returns the absolute path of the credentials file for a given data dir.
 * Exported so tests / docs can reference the same path.
 */
export function credentialsFilePath(dataDir: string): string {
  return path.join(dataDir, CREDENTIALS_FILENAME);
}

/**
 * Inspect the env and, when configured, write an Owner record to
 * `auth.json` and (for `=auto`) a credentials file. Safe to call on
 * every boot — exits early when auth is already configured.
 *
 * Returns a structured result rather than throwing for skip cases so
 * callers can log a single line summarising why nothing happened. The
 * one case that does throw is a credential-file write failure under
 * `=auto`, where silently dropping the password would brick the deploy.
 */
export async function maybeAutoProvisionOwner(
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  // Vitest sets AGENT_HUB_TEST_MODE and imports `index.ts`, which calls this
  // with no opts. The Agent Hub host / systemd unit often exports
  // AGENT_HUB_DEFAULT_PASSWORD — auto-provisioning would write auth.json into
  // the isolated test DATA_DIR and gate REST with JWT, so supertest calls
  // without Bearer get 401. Unit tests always pass an explicit `env` object.
  if (process.env.AGENT_HUB_TEST_MODE === '1' && opts.env === undefined) {
    return { provisioned: false, reason: 'test-mode' };
  }

  const env = opts.env ?? process.env;
  const dataDir = opts.dataDir ?? config.dataDir;
  const now = opts.now ?? (() => new Date());
  const randomPassword = opts.randomPassword ?? defaultRandomPassword;
  const log = opts.log ?? defaultLogger;

  const rawPassword = env.AGENT_HUB_DEFAULT_PASSWORD;
  if (typeof rawPassword !== 'string' || rawPassword.length === 0) {
    return { provisioned: false, reason: 'no-default-password-env' };
  }

  // Idempotency guard — never overwrite an existing record. We check
  // BEFORE touching the env-supplied password so an accidental rerun
  // doesn't even appear to consider the value.
  if (getAuthRecord() !== null) {
    return { provisioned: false, reason: 'auth-already-configured' };
  }

  const rawUsername = env.AGENT_HUB_DEFAULT_USERNAME;
  const username = sanitizeUsername(
    typeof rawUsername === 'string' && rawUsername.length > 0 ? rawUsername : DEFAULT_USERNAME,
  );
  if (!username) {
    log(
      'error',
      `[Auth] AGENT_HUB_DEFAULT_USERNAME=${JSON.stringify(rawUsername)} rejected; expected 1–64 chars of [a-zA-Z0-9_.-@]. Skipping auto-provision.`,
    );
    return { provisioned: false, reason: 'invalid-username' };
  }

  // Resolve password: literal vs `auto`. The auto-keyword check is
  // case-insensitive so `Auto` / `AUTO` both work — operators tend to
  // capitalise environment values to make them stand out.
  const isAuto = rawPassword.trim().toLowerCase() === AUTO_KEYWORD;
  const password = isAuto ? randomPassword() : rawPassword;
  const validatedPassword = sanitizePassword(password);
  if (!validatedPassword) {
    if (isAuto) {
      // The default RNG cannot produce a too-short password (18 bytes
      // base64url-encoded = 24 chars). Reaching this branch means a
      // test injected a bad randomPassword override.
      log(
        'error',
        `[Auth] auto-generated password failed length validation (need ≥${MIN_PASSWORD_LEN} chars). This is a programming error.`,
      );
    } else {
      log(
        'error',
        `[Auth] AGENT_HUB_DEFAULT_PASSWORD rejected: must be ${MIN_PASSWORD_LEN}–256 chars. Skipping auto-provision.`,
      );
    }
    return { provisioned: false, reason: 'invalid-password' };
  }

  // Hash + persist the auth record. saveAuthRecord writes atomically
  // (tmp + rename) and chmods 0600 itself.
  const passwordHash = await hashPassword(validatedPassword);
  saveAuthRecord({
    username,
    passwordHash,
    jwtSecret: generateJwtSecret(),
    role: 'Owner',
    createdAt: now().toISOString(),
  });

  // For =auto we surface the password by writing a sibling file. This
  // is the ONLY copy of the cleartext — failure here is fatal because
  // the Owner would otherwise be locked out.
  let credentialsFile: string | undefined;
  if (isAuto) {
    credentialsFile = credentialsFilePath(dataDir);
    mkdirSync(path.dirname(credentialsFile), { recursive: true });
    const body =
      [
        'Initial Owner credentials for Agent Hub',
        `Generated at: ${now().toISOString()}`,
        `Username: ${username}`,
        `Password: ${validatedPassword}`,
        '',
        'IMPORTANT:',
        '  - This is the ONLY copy of this password. Store it somewhere safe.',
        '  - Rotate the password from the Settings → Security page after first login.',
        '  - Once rotated, delete this file.',
      ].join('\n') + '\n';
    writeFileSync(credentialsFile, body, { mode: 0o600 });
  }

  // Phase 3: seed users + memberships. Best-effort — orgs.db may not
  // be initialized yet in some test paths; the migration helper is
  // idempotent and runs again on the next /api/auth/setup or login.
  try {
    migrateAuthRecordIfNeeded();
  } catch (err) {
    log(
      'error',
      `[Auth] migrateAuthRecordIfNeeded after auto-provision failed: ${(err as Error).message}`,
    );
  }

  // Belt-and-suspenders: drop any cached org-owner lookup so the very
  // next system spawn sees the user we just created. The cache no
  // longer memoises `null` (see `session-ownership.ts`), so this is
  // defence-in-depth against a future regression rather than load-
  // bearing today. Imported lazily because session-ownership pulls in
  // the full `db.js` chain, which would force initDb() during this
  // module's load and break tests that mock config without seeding
  // `defaultCwd`.
  try {
    const { resetOrgOwnerCache } = await import('./session-ownership.js');
    resetOrgOwnerCache();
  } catch (err) {
    console.warn('[auth-bootstrap] failed to reset org owner cache:', err);
  }

  // No org-mode flip needed: auth bypass is now keyed off the
  // `AGENT_HUB_MODE` env var (see `isLocalBundledServer()` in
  // `server/auth.ts`), not the persisted `org.mode` column. A web/cloud
  // deployment will not have `AGENT_HUB_MODE=local` set, so the Owner
  // we just provisioned is enforced regardless of what the orgs table
  // says. Electron / dev installs explicitly set the env var and keep
  // the bypass.

  if (isAuto) {
    log(
      'info',
      `[Auth] Auto-provisioned Owner '${username}'; password written to ${credentialsFile} (mode 0600). Rotate after first login.`,
    );
  } else {
    log('info', `[Auth] Auto-provisioned Owner '${username}' from AGENT_HUB_DEFAULT_PASSWORD env.`);
  }

  return {
    provisioned: true,
    username,
    passwordSource: isAuto ? 'auto' : 'env',
    credentialsFile,
  };
}
