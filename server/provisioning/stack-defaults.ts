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
 *     verbatim (an explicit legacy/API choice still wins).
 *   - Otherwise return the blank scaffold. The first build session
 *     chooses language/framework from the project description; copying
 *     a Node/Python/Go/Rust starter locked the stack too early.
 *
 * New templates go in two places:
 *   1. `server/provisioning/templates/<id>/` on disk.
 *   2. `KNOWN_TEMPLATE_IDS` below (narrows the union type).
 */

/** Concrete template ids shipped with the server. Keep in sync with the
 *  subdirectories under `server/provisioning/templates/`. */
export const KNOWN_TEMPLATE_IDS = [
  'blank',
  'python-fastapi-uv',
  'typescript-node-tsx',
  'go-cobra',
  'rust-axum',
] as const;

export type TemplateId = (typeof KNOWN_TEMPLATE_IDS)[number];

/** Universal fallback when we have no explicit template id. */
export const UNIVERSAL_DEFAULT_TEMPLATE_ID: TemplateId = 'blank';

/**
 * Per-appType default template. Unused by resolveTemplateId (description-
 * first provisioning always lands on `blank` unless `stack` is a known
 * id) but kept so older callers / docs can still name a language starter.
 */
export const APP_TYPE_DEFAULTS: Record<string, TemplateId> = {
  'web-app': 'typescript-node-tsx',
  api: 'python-fastapi-uv',
  cli: 'go-cobra',
  mobile: 'typescript-node-tsx',
  desktop: 'typescript-node-tsx',
  ml: 'python-fastapi-uv',
  library: 'typescript-node-tsx',
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
 * check. App-type is ignored: only an explicit known `stack` id copies
 * a language starter; everything else is the blank scaffold.
 */
export function resolveTemplateId(
  _appType: string | null | undefined,
  stack: string | null | undefined,
): TemplateId {
  if (isKnownTemplateId(stack) && stack !== 'blank') return stack;
  if (stack === 'blank') return 'blank';
  return UNIVERSAL_DEFAULT_TEMPLATE_ID;
}

/**
 * True when the caller explicitly asked for a known language template
 * (vs. we defaulted them onto the blank scaffold).
 */
export function stackWasExplicit(stack: string | null | undefined): boolean {
  return isKnownTemplateId(stack) && stack !== 'blank';
}
