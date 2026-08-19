/**
 * Client-side form helpers for the dev-server config
 * (`Project.prEnv.devServer`). The bounds and rules below mirror the
 * server Zod schema in `server/dev-server-config.ts` so the settings form
 * surfaces the same validation errors at edit time that the PATCH would
 * reject at save time.
 *
 * Secrets are **key references only**: `secretKeys[]` names entries in the
 * project-secrets store. The form never round-trips a stored secret value
 * — secret rows load masked (empty input, `hadSecret` flag) and only a
 * freshly-typed value is written back to the store (write-only).
 */

export const DEV_SERVER_DEFAULT_START_COMMAND = 'npm run dev';

/** Matches the server secrets store MASK sentinel (`server/secret-crypto.ts`). */
export const SECRET_MASK = '••••••••';

// Bounds mirror `server/dev-server-config.ts`.
export const MAX_START_COMMAND_LEN = 2000;
export const MAX_ENV_VARS = 64;
export const MAX_ENV_KEY_LEN = 128;
export const MAX_ENV_VALUE_LEN = 4096;
export const MAX_SECRET_KEYS = 64;
export const MAX_PORT_MAP_ENTRIES = 16;
export const MAX_LABEL_LEN = 64;
export const MAX_HEALTH_PATH_LEN = 256;
export const MAX_CWD_LEN = 512;
export const READY_TIMEOUT_MIN_MS = 5_000;
export const READY_TIMEOUT_MAX_MS = 3_600_000;
export const MAX_APT_PACKAGES = 64;
export const MAX_APT_PACKAGE_LEN = 128;

/** POSIX env var name: leading [A-Za-z_], rest [A-Za-z0-9_]. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** apt package name (+ optional `=version`) — mirrors `APT_PACKAGE_RE` server-side. */
const APT_PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]*(=[A-Za-z0-9.+:~-]+)?$/;

/** Split an apt-packages textarea into tokens (whitespace- or comma-separated). */
export function parseAptPackagesText(text: string): string[] {
  return (text || '')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
/** Server-injected namespace — mirrors `server/preview/reserved-env-keys.ts`. */
const RESERVED_KEY_RE = /^(AGENT_HUB_|NODE_|PATH$|HOME$)/;
/** PORT is derived from the primary portMap entry and injected by the runtime. */
const RESERVED_PLAIN_KEYS = new Set(['PORT']);

export function isReservedDevServerKey(key: string): boolean {
  return RESERVED_KEY_RE.test(key) || RESERVED_PLAIN_KEYS.has(key);
}

export interface DevServerEnvRow {
  key: string;
  value: string;
}
export interface DevServerSecretRow {
  key: string;
  /** Write-only: freshly-typed value pushed to the store on save; blank = keep. */
  value: string;
  /** True when a `secret`-kind value is already stored for this key. */
  hadSecret: boolean;
}
export interface DevServerPortRow {
  /** String while editing a controlled <input type="number">. */
  internalPort: string;
  label: string;
  primary: boolean;
}
export interface DevServerForm {
  /** Optional build step run before startCommand; empty = none. */
  buildCommand: string;
  startCommand: string;
  envRows: DevServerEnvRow[];
  secretRows: DevServerSecretRow[];
  portRows: DevServerPortRow[];
  healthPath: string;
  /** Empty = no override (server default). */
  readyTimeoutMs: string;
  cwd: string;
  /** Whitespace/comma-separated apt package names. Empty = none. */
  aptPackagesText: string;
}

export interface DevServerValidationError {
  field: string;
  /** Row index for the array fields (env/secret/port), else undefined. */
  index?: number;
  error: string;
}

export interface StoredSecret {
  key: string;
  kind?: 'plain' | 'secret';
  value?: string;
}

export function emptyDevServerForm(): DevServerForm {
  return {
    buildCommand: '',
    startCommand: DEV_SERVER_DEFAULT_START_COMMAND,
    envRows: [],
    secretRows: [],
    portRows: [],
    healthPath: '',
    readyTimeoutMs: '',
    cwd: '',
    aptPackagesText: '',
  };
}

/**
 * Build editable form state from a project + its (masked) secrets list.
 * Secret rows are marked `hadSecret` when a `secret`-kind value already
 * exists for the referenced key, so the UI can render the masked state.
 */
export function devServerFormFromProject(
  project: any,
  secrets: StoredSecret[] = [],
): DevServerForm {
  const ds = project?.prEnv?.devServer || {};
  const secretByKey = new Map((secrets || []).map((s) => [s.key, s]));
  const env = ds.env && typeof ds.env === 'object' ? ds.env : {};
  return {
    buildCommand: typeof ds.buildCommand === 'string' ? ds.buildCommand : '',
    startCommand:
      typeof ds.startCommand === 'string' && ds.startCommand.trim()
        ? ds.startCommand
        : DEV_SERVER_DEFAULT_START_COMMAND,
    envRows: Object.keys(env).map((key) => ({ key, value: String(env[key] ?? '') })),
    secretRows: (Array.isArray(ds.secretKeys) ? ds.secretKeys : []).map((key: string) => ({
      key,
      value: '',
      hadSecret: secretByKey.get(key)?.kind === 'secret',
    })),
    portRows: (Array.isArray(ds.portMap) ? ds.portMap : []).map((p: any) => ({
      internalPort: p?.internalPort != null ? String(p.internalPort) : '',
      label: typeof p?.label === 'string' ? p.label : '',
      primary: p?.primary === true,
    })),
    healthPath: typeof ds.healthPath === 'string' ? ds.healthPath : '',
    readyTimeoutMs:
      typeof ds.readyTimeoutMs === 'number' && Number.isFinite(ds.readyTimeoutMs)
        ? String(ds.readyTimeoutMs)
        : '',
    cwd: typeof ds.cwd === 'string' ? ds.cwd : '',
    aptPackagesText: (Array.isArray(ds.aptPackages) ? ds.aptPackages : []).join('\n'),
  };
}

/**
 * Mirror the server Zod validation. Returns the first issue found, or
 * null when the form would pass `parseDevServerConfig`.
 */
export function validateDevServerForm(form: DevServerForm): DevServerValidationError | null {
  const buildCommand = (form.buildCommand || '').trim();
  if (buildCommand.length > MAX_START_COMMAND_LEN) {
    return {
      field: 'buildCommand',
      error: `Build command must be at most ${MAX_START_COMMAND_LEN} characters.`,
    };
  }

  const startCommand = (form.startCommand || '').trim();
  if (!startCommand) {
    return { field: 'startCommand', error: 'Start command must not be empty.' };
  }
  if (startCommand.length > MAX_START_COMMAND_LEN) {
    return {
      field: 'startCommand',
      error: `Start command must be at most ${MAX_START_COMMAND_LEN} characters.`,
    };
  }

  // env
  const envRows = form.envRows.filter((r) => r.key.trim());
  if (envRows.length > MAX_ENV_VARS) {
    return { field: 'env', error: `At most ${MAX_ENV_VARS} env variables are supported.` };
  }
  const seenEnv = new Set<string>();
  for (let i = 0; i < form.envRows.length; i++) {
    const key = form.envRows[i].key.trim();
    if (!key) continue;
    if (key.length > MAX_ENV_KEY_LEN) {
      return {
        field: 'env',
        index: i,
        error: `env key "${key}" exceeds ${MAX_ENV_KEY_LEN} chars.`,
      };
    }
    if (!ENV_NAME_RE.test(key)) {
      return {
        field: 'env',
        index: i,
        error: `env key "${key}" must match [A-Za-z_][A-Za-z0-9_]* (POSIX env var name).`,
      };
    }
    if (isReservedDevServerKey(key)) {
      return {
        field: 'env',
        index: i,
        error: `env key "${key}" is reserved (injected by the server at spawn).`,
      };
    }
    if (seenEnv.has(key)) {
      return { field: 'env', index: i, error: `env key "${key}" is listed more than once.` };
    }
    seenEnv.add(key);
    if ((form.envRows[i].value ?? '').length > MAX_ENV_VALUE_LEN) {
      return { field: 'env', index: i, error: `env value exceeds ${MAX_ENV_VALUE_LEN} chars.` };
    }
  }

  // secretKeys
  const secretRows = form.secretRows.filter((r) => r.key.trim());
  if (secretRows.length > MAX_SECRET_KEYS) {
    return { field: 'secretKeys', error: `At most ${MAX_SECRET_KEYS} secret keys are supported.` };
  }
  const seenSecret = new Set<string>();
  for (let i = 0; i < form.secretRows.length; i++) {
    const key = form.secretRows[i].key.trim();
    if (!key) continue;
    if (key.length > MAX_ENV_KEY_LEN) {
      return {
        field: 'secretKeys',
        index: i,
        error: `secret key "${key}" exceeds ${MAX_ENV_KEY_LEN} chars.`,
      };
    }
    if (!ENV_NAME_RE.test(key)) {
      return {
        field: 'secretKeys',
        index: i,
        error: `secret key "${key}" must match [A-Za-z_][A-Za-z0-9_]* (POSIX env var name).`,
      };
    }
    if (isReservedDevServerKey(key)) {
      return {
        field: 'secretKeys',
        index: i,
        error: `secret key "${key}" is reserved (injected by the server at spawn).`,
      };
    }
    if (seenSecret.has(key)) {
      return {
        field: 'secretKeys',
        index: i,
        error: `secret key "${key}" is listed more than once.`,
      };
    }
    seenSecret.add(key);
    if (seenEnv.has(key)) {
      return {
        field: 'secretKeys',
        index: i,
        error: `"${key}" appears in both env and secret keys — a key resolves from exactly one place.`,
      };
    }
    // A brand-new secret reference (no stored value yet) must ship a value.
    // Otherwise the config would list a `secretKeys` entry the store has no
    // row for, and the dev server would reference a missing secret at spawn.
    // Existing stored secrets (`hadSecret`) may keep a blank value — blank
    // means "leave the stored value unchanged".
    if (!form.secretRows[i].hadSecret && !(form.secretRows[i].value ?? '').trim()) {
      return {
        field: 'secretKeys',
        index: i,
        error: `Enter a value for the new secret "${key}" (or remove the row).`,
      };
    }
  }

  // portMap
  const portRows = form.portRows.filter((r) => String(r.internalPort).trim() || r.label.trim());
  if (portRows.length > MAX_PORT_MAP_ENTRIES) {
    return {
      field: 'portMap',
      error: `At most ${MAX_PORT_MAP_ENTRIES} port entries are supported.`,
    };
  }
  const seenPort = new Set<number>();
  let primaryCount = 0;
  for (let i = 0; i < form.portRows.length; i++) {
    const row = form.portRows[i];
    const raw = String(row.internalPort).trim();
    if (!raw && !row.label.trim()) continue;
    const port = Number(raw);
    if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
      return {
        field: 'portMap',
        index: i,
        error: 'Internal port must be an integer between 1 and 65535.',
      };
    }
    if (seenPort.has(port)) {
      return {
        field: 'portMap',
        index: i,
        error: `Internal port ${port} is listed more than once.`,
      };
    }
    seenPort.add(port);
    const label = row.label.trim();
    if (!label) {
      return { field: 'portMap', index: i, error: 'Each port needs a label.' };
    }
    if (label.length > MAX_LABEL_LEN) {
      return { field: 'portMap', index: i, error: `Label exceeds ${MAX_LABEL_LEN} chars.` };
    }
    if (row.primary) primaryCount += 1;
  }
  if (primaryCount > 1) {
    return { field: 'portMap', error: 'Only one port may be marked primary.' };
  }

  // healthPath
  const healthPath = (form.healthPath || '').trim();
  if (healthPath) {
    if (!healthPath.startsWith('/')) {
      return { field: 'healthPath', error: 'Health path must start with `/`.' };
    }
    if (healthPath.length > MAX_HEALTH_PATH_LEN) {
      return { field: 'healthPath', error: `Health path exceeds ${MAX_HEALTH_PATH_LEN} chars.` };
    }
  }

  // readyTimeoutMs
  const rtRaw = (form.readyTimeoutMs || '').trim();
  if (rtRaw) {
    const rt = Number(rtRaw);
    if (!Number.isInteger(rt) || rt < READY_TIMEOUT_MIN_MS || rt > READY_TIMEOUT_MAX_MS) {
      return {
        field: 'readyTimeoutMs',
        error: `Ready timeout must be an integer between ${READY_TIMEOUT_MIN_MS} and ${READY_TIMEOUT_MAX_MS} ms.`,
      };
    }
  }

  // cwd
  const cwd = (form.cwd || '').trim();
  if (cwd) {
    if (cwd.length > MAX_CWD_LEN) {
      return { field: 'cwd', error: `Working directory exceeds ${MAX_CWD_LEN} chars.` };
    }
    if (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd)) {
      return { field: 'cwd', error: 'Working directory must be relative to the worktree root.' };
    }
    if (
      cwd
        .replace(/\\/g, '/')
        .split('/')
        .some((seg) => seg === '..')
    ) {
      return {
        field: 'cwd',
        error: 'Working directory must not escape the worktree root (no `..`).',
      };
    }
  }

  // aptPackages
  const aptPackages = parseAptPackagesText(form.aptPackagesText);
  if (aptPackages.length > MAX_APT_PACKAGES) {
    return {
      field: 'aptPackages',
      error: `At most ${MAX_APT_PACKAGES} apt packages are supported.`,
    };
  }
  const seenApt = new Set<string>();
  for (let i = 0; i < aptPackages.length; i++) {
    const pkg = aptPackages[i];
    if (pkg.length > MAX_APT_PACKAGE_LEN) {
      return {
        field: 'aptPackages',
        index: i,
        error: `apt package "${pkg}" exceeds ${MAX_APT_PACKAGE_LEN} chars.`,
      };
    }
    if (!APT_PACKAGE_RE.test(pkg)) {
      return {
        field: 'aptPackages',
        index: i,
        error: `"${pkg}" is not a valid apt package name (allowed: a-z, 0-9, "+.-", optional "=version").`,
      };
    }
    if (seenApt.has(pkg)) {
      return {
        field: 'aptPackages',
        index: i,
        error: `apt package "${pkg}" is listed more than once.`,
      };
    }
    seenApt.add(pkg);
  }

  return null;
}

/**
 * Build the `devServer` object for the project PATCH. Only non-empty
 * optionals are included so the payload stays minimal and round-trips
 * cleanly through `parseDevServerConfig`.
 */
export function buildDevServerConfig(form: DevServerForm): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (const row of form.envRows) {
    const key = row.key.trim();
    if (key) env[key] = row.value ?? '';
  }

  const secretKeys: string[] = [];
  for (const row of form.secretRows) {
    const key = row.key.trim();
    if (key && !secretKeys.includes(key)) secretKeys.push(key);
  }

  const portMap = form.portRows
    .filter((r) => String(r.internalPort).trim())
    .map((r) => {
      const entry: { internalPort: number; label: string; primary?: boolean } = {
        internalPort: Number(String(r.internalPort).trim()),
        label: r.label.trim(),
      };
      if (r.primary) entry.primary = true;
      return entry;
    });

  const config: Record<string, unknown> = {
    startCommand: form.startCommand.trim(),
    env,
    secretKeys,
    portMap,
  };

  const buildCommand = (form.buildCommand || '').trim();
  if (buildCommand) config.buildCommand = buildCommand;

  const healthPath = (form.healthPath || '').trim();
  if (healthPath) config.healthPath = healthPath;

  const rtRaw = (form.readyTimeoutMs || '').trim();
  if (rtRaw) config.readyTimeoutMs = Math.trunc(Number(rtRaw));

  const cwd = (form.cwd || '').trim();
  if (cwd) config.cwd = cwd;

  const aptPackages = parseAptPackagesText(form.aptPackagesText);
  if (aptPackages.length > 0) config.aptPackages = aptPackages;

  return config;
}

/**
 * Build the full secrets PUT payload, preserving every existing secret
 * (MASK sentinel for unchanged `secret`-kind rows) and upserting only the
 * dev-server secret rows the user typed a fresh value into. Returns null
 * when there is nothing to write (no stored secrets and no typed values),
 * so the caller can skip the request entirely.
 *
 * Plaintext for an unchanged secret is never sent back — the MASK sentinel
 * tells the store to keep the ciphertext it already holds.
 */
export type SecretsPutPayload = Array<{ key: string; value: string; kind: 'plain' | 'secret' }>;

/**
 * Build the PUT payload that reproduces the current stored-secret set
 * verbatim (MASK sentinel for `secret`-kind rows so their ciphertext is
 * kept, plaintext for `plain` rows). Because a secrets PUT is a full
 * replace, PUTting this snapshot removes any key not present in it — which
 * is exactly what a rollback needs: restore the pre-save set and drop a
 * just-written key. Returns null when there is nothing to restore.
 */
export function buildSecretsSnapshotPayload(
  secrets: StoredSecret[] = [],
): SecretsPutPayload | null {
  const snapshot: SecretsPutPayload = (secrets || [])
    .filter((s) => s.key)
    .map((s) => {
      const kind: 'plain' | 'secret' = s.kind === 'plain' ? 'plain' : 'secret';
      return { key: s.key, value: kind === 'secret' ? SECRET_MASK : (s.value ?? ''), kind };
    });
  return snapshot.length > 0 ? snapshot : null;
}

export function buildSecretsPutPayload(
  form: DevServerForm,
  existingSecrets: StoredSecret[] = [],
): SecretsPutPayload | null {
  const byKey = new Map<string, { key: string; value: string; kind: 'plain' | 'secret' }>();

  for (const s of existingSecrets || []) {
    if (!s.key) continue;
    const kind = s.kind === 'plain' ? 'plain' : 'secret';
    byKey.set(s.key, {
      key: s.key,
      value: kind === 'secret' ? SECRET_MASK : (s.value ?? ''),
      kind,
    });
  }

  let typedCount = 0;
  for (const row of form.secretRows) {
    const key = row.key.trim();
    const value = row.value ?? '';
    if (!key || !value.trim()) continue;
    typedCount += 1;
    byKey.set(key, { key, value, kind: 'secret' });
  }

  if (byKey.size === 0 || (typedCount === 0 && (existingSecrets?.length ?? 0) === 0)) {
    return null;
  }
  if (typedCount === 0) return null;

  return [...byKey.values()];
}
