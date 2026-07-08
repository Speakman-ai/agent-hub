/**
 * Normalize a build-time endpoint / base-URL env value to the sovereign default.
 *
 * Returns the value trimmed with any trailing slashes removed, or '' when it is
 * unset or not a string. Shared across web (Vite) and mobile (Expo) so the
 * disabled-by-default normalization is byte-for-byte identical on every surface
 * — an unconfigured build always resolves to '' (feature off, no phone-home).
 */
export function trimTrailingSlashes(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}
