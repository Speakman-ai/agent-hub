// Route a batch of composer attachments through the correct upload endpoint.
//
// - Images carry a `dataUrl` (base64) from expo-image-picker and use the
//   small-body JSON route at /api/upload.
// - Videos and generic files carry a local `uri` + `mimeType` and stream
//   via /api/upload/file (expo-file-system.uploadAsync inside api.uploadFile).
//
// Returned shape is the server's upload response:
//   { id, filename, originalName, contentType, url }
// — same as the web client produces, so ChatMessage/MessageAttachments can
// render identically across platforms.
//
// Tests pass a mock `api` object. Skipping an item (e.g. image without a
// dataUrl) silently drops it rather than crashing the whole batch.
export async function uploadAttachments(items, api) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const tasks = items.map((item) => {
    if (!item) return Promise.resolve(null);
    if (item.kind === 'image') {
      if (!item.dataUrl) return Promise.resolve(null);
      return api.uploadImage(item.dataUrl, item.name);
    }
    // Videos and generic files: send the local URI as raw binary.
    if (!item.uri) return Promise.resolve(null);
    return api.uploadFile({
      uri: item.uri,
      name: item.name,
      type: item.mimeType || 'application/octet-stream',
      size: item.sizeBytes || undefined,
    });
  });
  const results = await Promise.all(tasks);
  return results.filter(Boolean);
}
