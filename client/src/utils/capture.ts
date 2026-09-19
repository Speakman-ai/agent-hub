/**
 * Preview capture helpers.
 */

export function buildCaptureArtifacts(captures: any) {
  const screenshots = captures.filter((c: any) => c.type === 'screenshot');
  const videos = captures.filter((c: any) => c.type === 'video');
  return { screenshots, videos };
}

export function formatCaptureSize(bytes: any) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function buildUploadsUrl(serverBase: any, filePath: any) {
  return `${serverBase}/uploads/${filePath}`;
}
