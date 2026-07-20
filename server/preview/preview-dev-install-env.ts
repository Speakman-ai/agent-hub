/**
 * Dev-mode npm semantics for preview / dev-server spawns.
 *
 * The Hub process runs under `NODE_ENV=production` (PM2 sets it in
 * `ecosystem.config.cjs`). Every preview process the Hub spawns inherits the
 * parent env — DevServerRuntime through the host session-env `baseEnv`
 * default of `process.env`, PreviewRuntime through the `...process.env` merge.
 * A preview start command that runs `npm ci` / `npm install` therefore sees
 * `NODE_ENV=production` and silently omits `devDependencies`. Build toolchains
 * shipped as devDependencies (`@angular-devkit/build-angular`, `vite`, `tsx`,
 * webpack, …) never install, and the dev server fails to boot — e.g. Angular's
 * `ng serve` dies with "Could not find the
 * '@angular-devkit/build-angular:dev-server' builder's node package."
 *
 * A preview is a development environment, so we force dev-mode install
 * semantics. `NODE_ENV=development` is the primary lever; `NPM_CONFIG_INCLUDE=dev`
 * is defense-in-depth so a leaked `npm_config_omit=dev` / `NPM_CONFIG_PRODUCTION`
 * from the host env can't still strip devDependencies (npm resolves a type as
 * installed when it appears in `include`, even if also in `omit`).
 *
 * Both defaults yield to an explicit project setting: if the project configured
 * the key on its dev-server / preview env, we leave the project's value alone.
 */

/** Env keys this module owns unless the project explicitly sets them. */
export const PREVIEW_DEV_INSTALL_DEFAULTS: Readonly<Record<string, string>> = {
  NODE_ENV: 'development',
  NPM_CONFIG_INCLUDE: 'dev',
};

/**
 * Apply dev-mode install defaults onto a mutable spawn-env map.
 *
 * @param target             The env object handed to the spawn (mutated in place).
 * @param isProjectConfigured Returns true when the project explicitly set `key`
 *                            (via dev-server `env` or a preview envFile), in
 *                            which case that value is preserved.
 */
export function applyPreviewDevInstallDefaults(
  target: Record<string, string | undefined>,
  isProjectConfigured: (key: string) => boolean,
): void {
  for (const [key, value] of Object.entries(PREVIEW_DEV_INSTALL_DEFAULTS)) {
    if (!isProjectConfigured(key)) target[key] = value;
  }
}
