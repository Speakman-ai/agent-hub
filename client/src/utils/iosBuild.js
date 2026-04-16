/**
 * iosBuild.js — Shared helpers for iOS build data.
 *
 * Used by IosBuildCard in PreviewsPage.jsx and tested in iosBuild.test.js.
 */

/**
 * Status configuration for iOS builds — maps status to visual properties.
 */
export const IOS_BUILD_STATUS_CONFIG = {
  queued: {
    color: 'text-gray-400',
    bg: 'bg-gray-500/10',
    border: 'border-gray-500/20',
    label: 'Queued',
    animate: false,
  },
  provisioning: {
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    label: 'Provisioning VM',
    animate: true,
  },
  building: {
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/20',
    label: 'Building',
    animate: true,
  },
  archiving: {
    color: 'text-purple-400',
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/20',
    label: 'Archiving',
    animate: true,
  },
  uploading: {
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/20',
    label: 'Uploading',
    animate: true,
  },
  ready: {
    color: 'text-green-400',
    bg: 'bg-green-500/10',
    border: 'border-green-500/20',
    label: 'Ready',
    animate: false,
  },
  error: {
    color: 'text-red-400',
    bg: 'bg-red-500/10',
    border: 'border-red-500/20',
    label: 'Error',
    animate: false,
  },
  cancelled: {
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
    label: 'Cancelled',
    animate: false,
  },
};

/**
 * Separate build artifacts by type.
 */
export function buildArtifactGroups(artifacts) {
  return {
    ipas: artifacts.filter((a) => a.type === 'ipa'),
    recordings: artifacts.filter((a) => a.type === 'simulator_recording'),
    screenshots: artifacts.filter((a) => a.type === 'screenshot'),
    logs: artifacts.filter((a) => a.type === 'log'),
  };
}

/**
 * Format build duration from seconds to a human-readable string.
 */
export function formatBuildDuration(seconds) {
  if (seconds == null) return '—';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

/**
 * Check if a build is in an active (non-terminal) state.
 */
export function isBuildActive(status) {
  return ['queued', 'provisioning', 'building', 'archiving', 'uploading'].includes(status);
}

/**
 * Get a descriptive step label for the current build phase.
 */
export function getBuildStepDescription(status) {
  const steps = {
    queued: 'Waiting for available macOS VM...',
    provisioning: 'Launching EC2 Mac instance and installing dependencies...',
    building: 'Running xcodebuild with Expo prebuild...',
    archiving: 'Creating .ipa archive for distribution...',
    uploading: 'Uploading artifacts and generating install link...',
    ready: 'Build complete — install link available',
    error: 'Build failed — check logs for details',
    cancelled: 'Build was cancelled',
  };
  return steps[status] || 'Unknown status';
}
