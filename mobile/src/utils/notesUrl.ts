/**
 * Pure URL-building helpers for the Notes API.
 *
 * Separated from `api.js` so the URL construction logic can be unit-tested
 * without pulling in the `fetch` / React Native network layer.
 */
/**
 * Build a GET URL for the Notes list endpoint, optionally with a search
 * query and/or a result limit.
 *
 * @param {string} projectId
 * @param {string} [query]  If provided, appends `?q=<encoded>`.
 * @param {number} [limit]  If provided and a finite positive number, appends `&limit=<n>`.
 * @returns {string} The path (without host), e.g. `/projects/foo/notes?q=hooks&limit=10`
 */
export function buildNotesListUrl(projectId: any, query: any, limit: any) {
    const params = new URLSearchParams();
    if (query && String(query).trim())
        params.set('q', String(query).trim());
    if (limit && Number.isFinite(Number(limit)) && Number(limit) > 0) {
        params.set('limit', String(limit));
    }
    const qs = params.toString();
    return `/projects/${projectId}/notes${qs ? '?' + qs : ''}`;
}
/**
 * Build a URL for a single Note (GET / PUT / DELETE).
 * @param {string} projectId
 * @param {string} noteId
 * @returns {string}
 */
export function buildNoteUrl(projectId: any, noteId: any) {
    return `/projects/${projectId}/notes/${noteId}`;
}
