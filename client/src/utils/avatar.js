/**
 * Avatar helpers
 *
 * An agent's `avatar` field is a free-form string that can be one of:
 *   - an uploaded image path, e.g. "/uploads/abc123.png"
 *   - an icon reference, e.g. "icon:Rocket"  (Lucide icon name)
 *   - empty string / null — no avatar set
 *
 * Keeping this as a single string (rather than two columns) means we stay
 * backward-compatible with existing rows and with the server's `/api/upload`
 * endpoint that returns a `url` field.
 */

export const ICON_AVATAR_PREFIX = 'icon:';

/** Returns true if the avatar value refers to a Lucide icon. */
export function isIconAvatar(avatar) {
  return typeof avatar === 'string' && avatar.startsWith(ICON_AVATAR_PREFIX);
}

/** Returns the icon name for an icon-style avatar, or null if it isn't one. */
export function parseIconAvatar(avatar) {
  if (!isIconAvatar(avatar)) return null;
  const name = avatar.slice(ICON_AVATAR_PREFIX.length).trim();
  return name || null;
}

/** Builds an icon-style avatar string from a Lucide icon name. */
export function buildIconAvatar(iconName) {
  return `${ICON_AVATAR_PREFIX}${iconName}`;
}

/**
 * Resolves an avatar value to an <img> src URL. Returns null for icon avatars
 * (callers should render the icon component instead) or for empty values.
 *
 * `serverBase` is the API base URL (e.g. '/api' or 'https://remote/api') used
 * to prefix server-relative upload paths. Absolute URLs are returned as-is.
 */
export function resolveAvatarImageSrc(avatar, serverBase = '') {
  if (!avatar || typeof avatar !== 'string') return null;
  if (isIconAvatar(avatar)) return null;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  if (!serverBase) return avatar;
  return `${serverBase}${avatar}`;
}

/**
 * Curated list of ~30 Lucide icons exposed in the picker. Names must match
 * the exports from `lucide-react`. Keep the list short — the picker is meant
 * for a quick one-click choice, not exhaustive browsing.
 */
export const AVATAR_ICON_NAMES = [
  'Bot',
  'User',
  'Cpu',
  'Code',
  'Code2',
  'Terminal',
  'GitBranch',
  'Github',
  'Cloud',
  'Server',
  'Database',
  'Globe',
  'Zap',
  'Sparkles',
  'Bug',
  'Wrench',
  'Hammer',
  'Rocket',
  'Flame',
  'Briefcase',
  'Brain',
  'Eye',
  'MessageSquare',
  'Bell',
  'Mail',
  'FileText',
  'Folder',
  'Book',
  'Shield',
  'Key',
  'Compass',
  'Star',
];
