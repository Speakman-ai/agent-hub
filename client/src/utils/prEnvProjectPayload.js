/**
 * Pure helpers for the per-project PR-env Settings UI / wizard.
 *
 * Mirrors the server-side `PrEnvProjectConfig` shape (see
 * `server/types.ts`):
 *
 *   interface PrEnvProjectConfig {
 *     enabled: boolean;
 *     setupCommand?: string;
 *     startScript: string;
 *     internalPort: number;
 *     healthPath?: string;
 *     dockerfilePath?: string;
 *     env?: Record<string, string>;
 *   }
 *
 * The wizard collects free-text fields, then we normalize + validate
 * here so:
 *   - the settings page doesn't ship junk into `PATCH /api/projects/:id`
 *   - users see specific error messages tied to the offending field
 *
 * Kept as a plain ES module (no React) so it can be unit-tested with
 * vitest the same way `humanCron.test.js` is.
 */

// Mirror of the server-side caps in
// `server/routes/projects.ts:validatePrEnvVars`. Kept in sync by hand —
// the test suite asserts both ends agree by exercising the boundaries.
export const PR_ENV_MAX_VARS = 64;
export const PR_ENV_MAX_KEY_LEN = 128;
export const PR_ENV_MAX_VALUE_LEN = 4096;
export const PR_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const PR_ENV_RESERVED_KEYS = new Set(['PORT']);

// Mirror of the preview sub-config caps in
// `server/routes/projects.ts:validatePrEnvPreview`. Kept in sync by hand —
// the test suite exercises each boundary so a server-side bump that
// isn't reflected here will surface as a failing wizard test.
export const PR_ENV_PREVIEW_MAX_ROUTES = 10;
export const PR_ENV_PREVIEW_PORT_MIN = 1024;
export const PR_ENV_PREVIEW_PORT_MAX = 65535;
export const PR_ENV_PREVIEW_IDLE_TTL_MIN = 60;
export const PR_ENV_PREVIEW_IDLE_TTL_MAX = 86400;
/**
 * Idle-TTL preset choices in seconds. The wizard renders these as a
 * dropdown so users don't have to know about the underlying bounds. Any
 * other value is still accepted by the server validator (so a future
 * "custom seconds" input can drop in without churn here).
 */
export const PR_ENV_PREVIEW_IDLE_TTL_PRESETS = Object.freeze([
  { label: '5 minutes', seconds: 300 },
  { label: '10 minutes', seconds: 600 },
  { label: '30 minutes', seconds: 1800 },
  { label: '60 minutes', seconds: 3600 },
]);
/** Default idle-TTL when the user hasn't picked one. Matches the wiki's "10 min" suggestion. */
export const PR_ENV_PREVIEW_DEFAULT_IDLE_TTL = 600;

/** Default empty form state for a brand-new project. */
export const EMPTY_FORM = Object.freeze({
  enabled: false,
  setupCommand: '',
  startScript: '',
  internalPort: '',
  healthPath: '',
  dockerfilePath: '',
  // env is an *array* of {key, value} rows in form state — preserves
  // user typing order and lets duplicates / blank rows exist mid-edit
  // without rerendering the whole list. `validateForm` collapses it
  // into the Record<string,string> shape the server expects.
  envRows: Object.freeze([]),
  // ── preview sub-section ─────────────────────────────────────────────
  // Mirrors PrEnvPreviewConfig (server/types.ts). Kept flat in form
  // state so the wizard can render each control off a single key, then
  // collapsed back into a nested `preview: {…}` payload by validateForm.
  preview: Object.freeze({
    enabled: false,
    startScript: '',
    port: '',
    // Capture-routes use the same stable-row pattern as envRows — the
    // wizard injects a `_id` UUID at hydrate time so React keys survive
    // reorder/insert/delete without remounting the input.
    captureRoutes: Object.freeze([{ value: '/' }]),
    idleTTL: String(PR_ENV_PREVIEW_DEFAULT_IDLE_TTL),
  }),
});

/**
 * Hydrate a form state from an existing `project.prEnv` object (or
 * undefined when the project hasn't been configured yet). All fields
 * are coerced to strings/booleans the inputs can render directly.
 */
export function formFromConfig(config) {
  if (!config || typeof config !== 'object') {
    return {
      ...EMPTY_FORM,
      envRows: [],
      preview: {
        enabled: false,
        startScript: '',
        port: '',
        captureRoutes: [{ value: '/' }],
        idleTTL: String(PR_ENV_PREVIEW_DEFAULT_IDLE_TTL),
      },
    };
  }
  // Hydrate env rows in stable insertion order. Object.entries is
  // ordered for string keys per spec, so a saved → reopened wizard
  // shows the same order the user entered.
  const envRows =
    config.env && typeof config.env === 'object' && !Array.isArray(config.env)
      ? Object.entries(config.env).map(([key, value]) => ({
          key,
          value: typeof value === 'string' ? value : '',
        }))
      : [];
  return {
    enabled: !!config.enabled,
    setupCommand: typeof config.setupCommand === 'string' ? config.setupCommand : '',
    startScript: typeof config.startScript === 'string' ? config.startScript : '',
    internalPort:
      typeof config.internalPort === 'number' && Number.isFinite(config.internalPort)
        ? String(config.internalPort)
        : '',
    healthPath: typeof config.healthPath === 'string' ? config.healthPath : '',
    dockerfilePath: typeof config.dockerfilePath === 'string' ? config.dockerfilePath : '',
    envRows,
    preview: previewFormFromConfig(config.preview),
  };
}

/**
 * Hydrate the preview sub-form from a saved `PrEnvPreviewConfig`. Keeps
 * the wizard rendering even when older projects predate the preview
 * block (we just fall back to the empty defaults).
 *
 * Capture-route rows always include at least one entry — an empty row
 * is friendlier than a "no rows" empty state for a list whose default
 * is `["/"]` anyway, and it matches the env-row pattern.
 */
function previewFormFromConfig(preview) {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    return {
      enabled: false,
      startScript: '',
      port: '',
      captureRoutes: [{ value: '/' }],
      idleTTL: String(PR_ENV_PREVIEW_DEFAULT_IDLE_TTL),
    };
  }
  const rawRoutes = Array.isArray(preview.captureRoutes) ? preview.captureRoutes : null;
  const captureRoutes =
    rawRoutes && rawRoutes.length > 0
      ? rawRoutes.map((value) => ({ value: typeof value === 'string' ? value : '' }))
      : [{ value: '/' }];
  return {
    enabled: !!preview.enabled,
    startScript: typeof preview.startScript === 'string' ? preview.startScript : '',
    port:
      typeof preview.port === 'number' && Number.isFinite(preview.port) ? String(preview.port) : '',
    captureRoutes,
    idleTTL:
      typeof preview.idleTTL === 'number' && Number.isFinite(preview.idleTTL)
        ? String(preview.idleTTL)
        : String(PR_ENV_PREVIEW_DEFAULT_IDLE_TTL),
  };
}

/**
 * Validate the form. Returns `{ ok: true, payload }` if every field
 * passes; otherwise `{ ok: false, errors }` with field → message.
 *
 * `payload` is the exact shape ready to send as
 * `PATCH /api/projects/:id` body's `prEnv` slot — undefined optional
 * fields are stripped out so the server doesn't see empty-string
 * "intent" values.
 *
 * If `enabled` is false, only `enabled` is required — every other
 * field is allowed empty (the user just toggled it off and saved).
 */
export function validateForm(form) {
  const errors = {};
  const enabled = !!form.enabled;

  if (!enabled) {
    return { ok: true, payload: { enabled: false } };
  }

  const startScript = (form.startScript || '').trim();
  if (!startScript) {
    errors.startScript = 'Start script is required (e.g. `npm start` or `./scripts/pr-env.sh`).';
  }

  const portStr = String(form.internalPort ?? '').trim();
  let internalPort;
  if (!portStr) {
    errors.internalPort = 'Port is required (the port your app listens on inside the container).';
  } else {
    const n = Number(portStr);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) {
      errors.internalPort = 'Port must be an integer between 1 and 65535.';
    } else {
      internalPort = n;
    }
  }

  const setupCommand = (form.setupCommand || '').trim();
  const healthPath = (form.healthPath || '').trim();
  const dockerfilePath = (form.dockerfilePath || '').trim();

  if (healthPath && !healthPath.startsWith('/')) {
    errors.healthPath = 'Health path must start with `/` (e.g. `/healthz`).';
  }

  // Mirror the server-side validator: dockerfilePath must be relative to
  // the checkout dir. Surface a friendly field-level error before the
  // wizard hits the API.
  if (dockerfilePath) {
    if (dockerfilePath.startsWith('/')) {
      errors.dockerfilePath = 'Dockerfile path must be relative to the repo root.';
    } else if (
      dockerfilePath
        .replace(/\\/g, '/')
        .split('/')
        .some((seg) => seg === '..')
    ) {
      errors.dockerfilePath = 'Dockerfile path must not escape the repo root (no `..` segments).';
    }
  }

  // Env-var rows: trim, drop entirely-blank rows, validate names,
  // reject duplicates / reserved keys / oversized values. Errors are
  // collected per-row keyed by row index (`env.0.key`, `env.1.value`)
  // so the UI can highlight the exact input. Stops at the first error
  // per row but keeps scanning later rows so users see all problems
  // at once.
  const envRows = Array.isArray(form.envRows) ? form.envRows : [];
  const seenKeys = new Set();
  const env = {};
  let envCount = 0;
  for (let i = 0; i < envRows.length; i++) {
    const row = envRows[i] || {};
    const rawKey = typeof row.key === 'string' ? row.key.trim() : '';
    const rawValue = typeof row.value === 'string' ? row.value : '';
    // A row is "entirely blank" when both fields trim to empty —
    // covers the user clicking "Add variable" then changing their
    // mind, including stray whitespace in either input. Values
    // themselves are NOT trimmed when sent to the server, since
    // some credentials/tokens can include intentional whitespace.
    if (!rawKey && rawValue.trim() === '') continue;
    if (!rawKey) {
      errors[`env.${i}.key`] = 'Variable name is required.';
      continue;
    }
    if (rawKey.length > PR_ENV_MAX_KEY_LEN) {
      errors[`env.${i}.key`] = `Variable name exceeds ${PR_ENV_MAX_KEY_LEN} characters.`;
      continue;
    }
    if (!PR_ENV_NAME_RE.test(rawKey)) {
      errors[`env.${i}.key`] =
        'Variable name must start with a letter or _ and contain only letters, digits, and _.';
      continue;
    }
    if (PR_ENV_RESERVED_KEYS.has(rawKey)) {
      errors[`env.${i}.key`] = `"${rawKey}" is reserved (set by Agent Hub from internal port).`;
      continue;
    }
    if (seenKeys.has(rawKey)) {
      errors[`env.${i}.key`] = `Duplicate variable name "${rawKey}".`;
      continue;
    }
    if (rawValue.length > PR_ENV_MAX_VALUE_LEN) {
      errors[`env.${i}.value`] = `Value exceeds ${PR_ENV_MAX_VALUE_LEN} characters.`;
      continue;
    }
    seenKeys.add(rawKey);
    env[rawKey] = rawValue;
    envCount += 1;
  }
  if (envCount > PR_ENV_MAX_VARS) {
    errors.env = `At most ${PR_ENV_MAX_VARS} environment variables are allowed (got ${envCount}).`;
  }

  // ── preview sub-config ────────────────────────────────────────────
  // Mirrors `validatePrEnvPreview` in `server/routes/projects.ts`. We
  // only re-check fields the user actually filled in: an entirely
  // untouched (or `enabled: false`) preview block falls through with
  // no payload contribution, matching the server's "absent slot" path.
  const previewPayload = validatePreviewSubForm(form.preview, errors);

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const payload = {
    enabled: true,
    startScript,
    internalPort,
  };
  if (setupCommand) payload.setupCommand = setupCommand;
  if (healthPath) payload.healthPath = healthPath;
  if (dockerfilePath) payload.dockerfilePath = dockerfilePath;
  if (envCount > 0) payload.env = env;
  if (previewPayload) payload.preview = previewPayload;
  return { ok: true, payload };
}

/**
 * Validate the preview sub-form and return the payload-shaped object
 * the server expects under `prEnv.preview`. Errors are mutated onto
 * `errors` keyed under `preview.<field>` so the wizard can highlight
 * the offending input. Returns `undefined` when the preview block was
 * left at its defaults (toggle off, no fields touched) — the server
 * treats absence and `enabled: false` differently for round-tripping,
 * so we always emit `{enabled: false}` once the user has flipped the
 * toggle even briefly.
 */
function validatePreviewSubForm(rawPreview, errors) {
  const preview = rawPreview && typeof rawPreview === 'object' ? rawPreview : null;
  if (!preview) return undefined;
  const enabled = !!preview.enabled;

  // Toggle off: round-trip the explicit off state, ignore every other
  // field. Mirrors the server's "preserve the slot when disabled" rule.
  if (!enabled) {
    return { enabled: false };
  }

  const startScript = typeof preview.startScript === 'string' ? preview.startScript.trim() : '';

  // Port: optional. Empty string falls back to the parent's internalPort
  // at runtime — we only validate if the user provided a value.
  let port;
  const portStr = String(preview.port ?? '').trim();
  if (portStr) {
    const n = Number(portStr);
    if (
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n < PR_ENV_PREVIEW_PORT_MIN ||
      n > PR_ENV_PREVIEW_PORT_MAX
    ) {
      errors['preview.port'] =
        `Port must be an integer between ${PR_ENV_PREVIEW_PORT_MIN} and ${PR_ENV_PREVIEW_PORT_MAX}.`;
    } else {
      port = n;
    }
  }

  // Capture routes: drop blank rows, validate each remaining entry, cap
  // at PR_ENV_PREVIEW_MAX_ROUTES. Errors are keyed by row index so the
  // chip editor can highlight the bad row.
  const rows = Array.isArray(preview.captureRoutes) ? preview.captureRoutes : [];
  const routes = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const raw = typeof row.value === 'string' ? row.value.trim() : '';
    if (!raw) continue;
    if (!raw.startsWith('/')) {
      errors[`preview.captureRoutes.${i}`] = 'Route must start with `/` (e.g. `/dashboard`).';
      continue;
    }
    routes.push(raw);
  }
  if (routes.length > PR_ENV_PREVIEW_MAX_ROUTES) {
    errors['preview.captureRoutes'] =
      `At most ${PR_ENV_PREVIEW_MAX_ROUTES} capture routes are allowed (got ${routes.length}).`;
  }

  // Idle TTL: dropdown values are always in-range, but we still bound
  // here because the wizard could grow a custom-seconds input later.
  let idleTTL;
  const ttlStr = String(preview.idleTTL ?? '').trim();
  if (ttlStr) {
    const n = Number(ttlStr);
    if (
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n < PR_ENV_PREVIEW_IDLE_TTL_MIN ||
      n > PR_ENV_PREVIEW_IDLE_TTL_MAX
    ) {
      errors['preview.idleTTL'] =
        `Idle TTL must be between ${PR_ENV_PREVIEW_IDLE_TTL_MIN} and ${PR_ENV_PREVIEW_IDLE_TTL_MAX} seconds.`;
    } else {
      idleTTL = n;
    }
  }

  // Bail before building the payload if any preview field errored —
  // the parent will surface the per-field messages.
  const hasPreviewErrors = Object.keys(errors).some((k) => k.startsWith('preview.'));
  if (hasPreviewErrors) return undefined;

  const payload = { enabled: true };
  if (startScript) payload.startScript = startScript;
  if (port !== undefined) payload.port = port;
  if (routes.length > 0) payload.captureRoutes = routes;
  if (idleTTL !== undefined) payload.idleTTL = idleTTL;
  return payload;
}

/**
 * Generate a sane default Dockerfile for a Node project. The wizard
 * shows this in step 3 when the user clicks "Generate one for me" —
 * they can copy it into their repo and commit. Deliberately
 * deterministic + offline; no network round-trip required.
 *
 * The `setupCommand` is bake-time (e.g. `npm install`); the
 * `startScript` runs at container start. We pick `npm install`
 * (instead of `npm ci`) when no setup command is provided because
 * many repos commit a `package.json` without a lockfile.
 */
export function generateDefaultDockerfile({ setupCommand, startScript, internalPort } = {}) {
  const setup = (setupCommand || '').trim() || 'npm install';
  const start = (startScript || '').trim() || 'npm start';
  const port = Number.isInteger(internalPort) && internalPort > 0 ? internalPort : 3000;
  return [
    '# Auto-generated by Agent Hub PR-env wizard.',
    '# Tweak as needed — Agent Hub will `docker build` this per PR ref',
    '# when you set `dockerfilePath` in the per-project PR-env settings.',
    'FROM node:20-slim',
    '',
    'WORKDIR /workspace',
    '',
    '# Bake-time install. Re-runs only when package*.json changes.',
    'COPY package*.json ./',
    `RUN ${setup}`,
    '',
    '# Copy the rest of the repo. Bind-mounted at runtime when the',
    '# builder uses the no-Dockerfile path, but `COPY .` is needed',
    '# here so the image is self-contained and reproducible.',
    'COPY . .',
    '',
    `EXPOSE ${port}`,
    `ENV PORT=${port}`,
    `CMD ["sh", "-c", ${JSON.stringify(start)}]`,
    '',
  ].join('\n');
}
