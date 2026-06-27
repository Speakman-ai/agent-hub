/** AppIcon name per session-control value — maps to lucide via appIconLucide. */
export const SESSION_CONTROL_APP_ICON_MAP: Record<string, string> = {
  consult: 'chatbubbles-outline',
  design: 'color-palette-outline',
  scoping: 'git-network-outline',
  'skill-builder': 'sparkles-outline',
  manual: 'hammer-outline',
  review: 'flask-outline',
  push: 'cloud-upload-outline',
  merge: 'git-merge-outline',
};

export function sessionControlAppIcon(value: string | null | undefined): string {
  if (!value) return 'construct-outline';
  return SESSION_CONTROL_APP_ICON_MAP[value] ?? 'construct-outline';
}
