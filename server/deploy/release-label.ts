/**
 * release-label.ts — server entry point for the user-facing deployment/release
 * label. The implementation is shared with the web client and mobile so their
 * labels can never drift; see `shared/utils/deploymentReleaseLabel.ts` for the
 * resolution order and rationale. This file only re-exports it for existing
 * server callers (release-notification emails).
 */
export {
  deploymentReleaseLabel,
  type ReleaseLabel,
  type ReleaseLabelDeployment,
} from '../../shared/utils/deploymentReleaseLabel.js';
