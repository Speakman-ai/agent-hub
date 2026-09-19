/** Trim a build-time URL env value and strip trailing slashes. Non-strings become ''. */
export function trimTrailingSlashes(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}
