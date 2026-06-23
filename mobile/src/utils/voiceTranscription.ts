// Pure helpers for chat voice transcription — mirrors the web composer's
// insertTranscriptAtAnchor / baseAudioContentType logic in MessageInput.jsx.
/**
 * Inserts transcribed text at `anchor` within `prev`, adding spaces so words
 * do not run together. Returns `{ text, caret }` — caret is the index after
 * the inserted transcript (or the anchor when nothing was inserted).
 */
export function applyTranscriptAtAnchor(prev: any, transcript: any, anchor: any) {
    const pos = anchor === null || anchor === undefined
        ? prev.length
        : Math.min(Math.max(0, anchor), prev.length);
    if (!transcript)
        return { text: prev, caret: pos };
    const trimmed = transcript.trim();
    if (!trimmed)
        return { text: prev, caret: pos };
    const before = prev.slice(0, pos);
    const after = prev.slice(pos);
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
    const insertion = (needsLeadingSpace ? ' ' : '') + trimmed + (needsTrailingSpace ? ' ' : '');
    return { text: before + insertion + after, caret: before.length + insertion.length };
}
/** Text-only variant used by tests and simple call sites. */
export function insertTranscriptAtAnchor(prev: any, transcript: any, anchor: any) {
    return applyTranscriptAtAnchor(prev, transcript, anchor).text;
}
/** Strip codec parameters from a MIME type (e.g. "audio/webm;codecs=opus"). */
export function baseAudioContentType(mimeType: any) {
    if (!mimeType)
        return 'audio/m4a';
    const base = mimeType.split(';')[0].trim().toLowerCase();
    return base || 'audio/m4a';
}
/** Infer Content-Type for a local recording URI from its file extension. */
export function contentTypeForRecordingUri(uri: any) {
    if (!uri)
        return 'audio/m4a';
    const path = uri.split('?')[0];
    const ext = path.split('.').pop()?.toLowerCase();
    const map: Record<string, any> = {
        m4a: 'audio/m4a',
        mp4: 'audio/mp4',
        caf: 'audio/mp4',
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        webm: 'audio/webm',
        ogg: 'audio/ogg',
        aac: 'audio/aac',
        flac: 'audio/flac',
    };
    return map[ext] || 'audio/m4a';
}
