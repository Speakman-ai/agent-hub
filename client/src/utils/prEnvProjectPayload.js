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

/** Default empty form state for a brand-new project. */
export const EMPTY_FORM = Object.freeze({
  enabled: false,
  setupCommand: '',
  startScript: '',
  internalPort: '',
  healthPath: '',
  dockerfilePath: '',
});

/**
 * Hydrate a form state from an existing `project.prEnv` object (or
 * undefined when the project hasn't been configured yet). All fields
 * are coerced to strings/booleans the inputs can render directly.
 */
export function formFromConfig(config) {
  if (!config || typeof config !== 'object') return { ...EMPTY_FORM };
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

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const payload = {
    enabled: true,
    startScript,
    internalPort,
  };
  if (setupCommand) payload.setupCommand = setupCommand;
  if (healthPath) payload.healthPath = healthPath;
  if (dockerfilePath) payload.dockerfilePath = dockerfilePath;
  return { ok: true, payload };
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
