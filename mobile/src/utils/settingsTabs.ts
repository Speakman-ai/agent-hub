/**
 * Normalize a raw `route.params.tab` value to a valid Settings tab id.
 *
 * Mirrors the precedence the Settings screen needs both on first mount and
 * when re-navigated while already mounted (React Navigation keeps the screen
 * alive, so a deep-link such as the dashboard "Account" shortcut must still
 * switch tabs):
 *   1. an exact current tab id wins;
 *   2. the renamed `orgs` → `servers` alias;
 *   3. any other legacy/removed tab id collapses to `general`;
 *   4. anything unknown (or empty) falls back to `general`.
 *
 * Pure / synchronous so it can back both the `useState` initializer and the
 * `route.params.tab` effect from one source of truth.
 *
 * @param {string | null | undefined} rawTab
 * @param {readonly string[] | Set<string>} validIds  current tab ids
 * @param {Set<string>} legacyIds                      retired tab ids
 * @returns {string} a valid current tab id
 */
export function normalizeSettingsTab(rawTab: any, validIds: any, legacyIds: any) {
    if (!rawTab)
        return 'general';
    const isValid = validIds instanceof Set ? validIds.has(rawTab) : Array.isArray(validIds) && validIds.includes(rawTab);
    if (isValid)
        return rawTab;
    if (rawTab === 'orgs')
        return 'servers';
    if (legacyIds instanceof Set && legacyIds.has(rawTab))
        return 'general';
    return 'general';
}
