import path from 'path';
import type { AppConfig } from './types.js';

/**
 * Resolve the durable upload store.
 *
 * `serverDir/uploads` remains the local-development default. Docker sets the
 * configured directory to `/data/uploads`, which sits below the existing
 * writable data bind mount and therefore does not need a nested bind mount
 * that Docker may create as root before the server starts.
 */
export function resolveUploadsDir(
  config: Partial<Pick<AppConfig, 'uploadsDir'>>,
  serverDir: string,
): string {
  const configured = config.uploadsDir?.trim();
  return configured || path.join(serverDir, 'uploads');
}
