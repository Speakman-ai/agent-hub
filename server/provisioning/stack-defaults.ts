/**
 * Stack defaulting for the provisioning orchestrator.
 *
 * Resolves a payload's `appType` + `stack` into one of the concrete
 * template ids shipped under `server/provisioning/templates/`. Pure —
 * no I/O, no logging. The real template executor calls this to decide
 * which tree to copy during the `copy-template` phase.
 *
 * Contract:
 *   - If `stack` is a string that matches a known template id, return it
 *     verbatim (the user's explicit choice wins).
 *   - If `stack` is `'idk'`, null, undefined, or any non-matching string,
 *     fall back to the per-`appType` default.
 *   - If `appType` is also unknown, fall back to a universal default
 *     (`typescript-node-tsx`) — the safest generalist when we have
 *     no signal about what the user is building.
 *
 * New templates go in two places:
 *   1. `server/provisioning/templates/<id>/` on disk.
 *   2. `KNOWN_TEMPLATE_IDS` below (narrows the union type).
 *
 * App-type → default mapping lines up with the storyboard (Act II
 * Frame 4): Bot / ML / API-ish flows lean Python, CLIs lean Go, and
 * everything else defaults to TypeScript + Node so the web/desktop/
 * mobile/library flows land in a familiar toolchain.
 */

/** Concrete template ids shipped with the server. Keep in sync with the
 *  subdirectories under `server/provisioning/templates/`. */
export const KNOWN_TEMPLATE_IDS = [
  'python-fastapi-uv',
  'typescript-node-tsx',
  'go-cobra',
  'rust-axum',
] as const;

export type TemplateId = (typeof KNOWN_TEMPLATE_IDS)[number];

/** Universal fallback when we have no signal at all. */
export const UNIVERSAL_DEFAULT_TEMPLATE_ID: TemplateId = 'typescript-node-tsx';

/**
 * Per-appType default template. Unknown app types fall through to
 * `UNIVERSAL_DEFAULT_TEMPLATE_ID`. The keys match values from
 * `client/src/utils/adaptiveQuestionnaire.js` `APP_TYPE_OPTIONS`.
 *
 * "Bot" isn't in APP_TYPE_OPTIONS today but the storyboard mentions it,
 * so we accept it as an alias for the API / service flavour.
 */
export const APP_TYPE_DEFAULTS: Record<string, TemplateId> = {
  'web-app': 'typescript-node-tsx',
  api: 'python-fastapi-uv',
  cli: 'go-cobra',
  mobile: 'typescript-node-tsx',
  desktop: 'typescript-node-tsx',
  ml: 'python-fastapi-uv',
  library: 'typescript-node-tsx',
  // Storyboard-era aliases / synonyms. Kept permissive so an upstream
  // rename of the questionnaire doesn't silently break defaulting.
  bot: 'python-fastapi-uv',
  service: 'rust-axum',
  backend: 'python-fastapi-uv',
};

export function isKnownTemplateId(value: unknown): value is TemplateId {
  return typeof value === 'string' && (KNOWN_TEMPLATE_IDS as readonly string[]).includes(value);
}

/**
 * Resolve a concrete template id from `appType` + `stack`.
 *
 * The returned id is ALWAYS one of `KNOWN_TEMPLATE_IDS` — callers can
 * look it up directly in the templates registry without a second null
 * check.
 */
export function resolveTemplateId(
  appType: string | null | undefined,
  stack: string | null | undefined,
): TemplateId {
  if (isKnownTemplateId(stack)) return stack;
  if (appType != null && appType !== 'idk') {
    const viaAppType = APP_TYPE_DEFAULTS[appType];
    if (viaAppType) return viaAppType;
  }
  return UNIVERSAL_DEFAULT_TEMPLATE_ID;
}

/**
 * True when the caller explicitly asked for a known template
 * (vs. we defaulted them into one). Useful for log messages like
 * "defaulted to python-fastapi-uv because you picked Bot".
 */
export function stackWasExplicit(stack: string | null | undefined): boolean {
  return isKnownTemplateId(stack);
}
