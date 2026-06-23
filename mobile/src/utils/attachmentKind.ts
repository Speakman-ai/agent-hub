// Classify a server-side upload record as 'image' | 'video' | 'file'.
//
// Mirrors the web client's ChatMessage detection so mobile renders the
// same chip variants. Looks at the stored content-type first, falls back
// to file extension parsed off the URL.
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
function extOf(urlOrName: any) {
    if (!urlOrName)
        return '';
    const clean = String(urlOrName).split('?')[0].split('#')[0];
    const dot = clean.lastIndexOf('.');
    if (dot < 0)
        return '';
    return clean.slice(dot + 1).toLowerCase();
}
export function attachmentKind(attachment: any) {
    if (!attachment)
        return 'file';
    const ct = (attachment.contentType || attachment.type || '').toLowerCase();
    if (ct.startsWith('video/'))
        return 'video';
    if (ct.startsWith('image/'))
        return 'image';
    const ext = extOf(attachment.url || attachment.filename || attachment.originalName);
    if (VIDEO_EXT.has(ext))
        return 'video';
    if (IMAGE_EXT.has(ext))
        return 'image';
    return 'file';
}
