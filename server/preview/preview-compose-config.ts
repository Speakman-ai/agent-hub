import type { PreviewComposeConfig } from '../types.js';

/**
 * The old compose preview contract required both fields to identify the app
 * service and its container port. A compose block without them is now only
 * project metadata for backing services, which the managed dev server starts
 * from its `startCommand`.
 */
export type LegacyPreviewComposeConfig = PreviewComposeConfig & {
  entryService: string;
  entryPort: number;
};

export const LEGACY_COMPOSE_PREVIEW_WARNING =
  'This project uses the deprecated compose app-wrapping preview. ' +
  'Migrate prEnv.preview.compose to prEnv.devServer; compose is reserved for backing services.';

export function isLegacyPreviewComposeConfig(
  compose: PreviewComposeConfig | undefined,
): compose is LegacyPreviewComposeConfig {
  return (
    !!compose &&
    typeof compose.entryService === 'string' &&
    compose.entryService.trim().length > 0 &&
    typeof compose.entryPort === 'number' &&
    Number.isInteger(compose.entryPort) &&
    compose.entryPort >= 1 &&
    compose.entryPort <= 65535
  );
}
