export function parseRawReviewVerdictContent(content: any) {
    if (typeof content !== 'string')
        return null;
    let parsed;
    try {
        parsed = JSON.parse(content.trim());
    }
    catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return null;
    const verdict = parsed.verdict;
    if (verdict !== 'approved' && verdict !== 'changes_requested')
        return null;
    return {
        verdict,
        threads: Array.isArray(parsed.threads) ? parsed.threads : [],
    };
}
