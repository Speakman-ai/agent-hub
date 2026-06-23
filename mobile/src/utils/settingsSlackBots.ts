// Pure helpers for the Settings → Slack Bots tab (mobile). See
// server/routes/slack.ts for the REST contract these mirror.
/**
 * The server masks stored tokens as e.g. "xoxb-****…-ab12cd" in GET
 * responses, and its PUT handler ignores any token containing "****"
 * (treats it as "keep the stored value"). Detect that sentinel so the UI
 * can render placeholder text and the payload builder can drop unchanged
 * tokens.
 */
export function isMaskedSlackToken(value: any) {
    return typeof value === 'string' && value.includes('****');
}
/**
 * Validate the bot form. `isNew` requires both tokens (POST contract:
 * name, bot_token, app_token, agent_id all required). On update, tokens
 * may stay masked/blank (= keep stored values).
 * Returns an error string or null.
 */
export function validateSlackBotForm(form: any, { isNew = false }: any = {}) {
    if (!(form?.name || '').trim())
        return 'Name is required.';
    if (!(form?.agent_id || '').trim())
        return 'Agent ID is required.';
    const bot = (form?.bot_token || '').trim();
    const app = (form?.app_token || '').trim();
    if (isNew) {
        if (!bot || isMaskedSlackToken(bot))
            return 'Bot token (xoxb-…) is required.';
        if (!app || isMaskedSlackToken(app))
            return 'App token (xapp-…) is required.';
    }
    return null;
}
/**
 * Build the POST/PUT body from the form. On update, masked or empty token
 * fields are omitted entirely so the server keeps the stored encrypted
 * values.
 */
export function buildSlackBotPayload(form: any, { isNew = false }: any = {}) {
    const payload: Record<string, any> = {
        name: (form.name || '').trim(),
        agent_id: (form.agent_id || '').trim(),
    };
    const bot = (form.bot_token || '').trim();
    const app = (form.app_token || '').trim();
    if (isNew || (bot && !isMaskedSlackToken(bot)))
        payload.bot_token = bot;
    if (isNew || (app && !isMaskedSlackToken(app)))
        payload.app_token = app;
    if (form.enabled !== undefined)
        payload.enabled = !!form.enabled;
    return payload;
}
/**
 * Human-readable summary of a POST /api/slack/bots/:id/test response.
 * Success shape: { ok: true, team, user }. Failures throw before reaching
 * here in the api helper, but a non-ok body is handled defensively.
 */
export function describeSlackTestResult(result: any) {
    if (result?.ok) {
        const team = result.team ? ` team "${result.team}"` : '';
        const user = result.user ? ` as ${result.user}` : '';
        return `Connected to${team}${user}`.trim();
    }
    return result?.error || 'Connection test failed';
}
