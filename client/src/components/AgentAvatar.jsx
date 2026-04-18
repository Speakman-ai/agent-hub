import * as LucideIcons from 'lucide-react';
import { User } from 'lucide-react';
import { isIconAvatar, parseIconAvatar, resolveAvatarImageSrc } from '../utils/avatar.js';

/**
 * Render an agent avatar, which may be:
 *   - a Lucide icon reference ("icon:Rocket")
 *   - an uploaded image path ("/uploads/...")
 *   - empty / null, in which case we render the provided `fallback` node
 *     (or a default colored dot).
 *
 * Props:
 *   - avatar      string | null   The raw avatar field from the agent.
 *   - color       string?         Tint used for icon avatars.
 *   - size        number          Pixel size of the rendered avatar (default 20).
 *   - className   string          Classes applied to the outer wrapper.
 *   - apiBase     string          Prefix for relative upload paths.
 *   - rounded     'full' | 'md'   Corner rounding preset (default 'full').
 *   - fallback    ReactNode?      Override for the empty-avatar state.
 */
function AgentAvatar({
  avatar,
  color = '#6b7280',
  size = 20,
  className = '',
  apiBase = '',
  rounded = 'full',
  fallback = null,
}) {
  const roundedCls = rounded === 'full' ? 'rounded-full' : 'rounded-md';
  const wrapperStyle = { width: size, height: size };

  if (isIconAvatar(avatar)) {
    const name = parseIconAvatar(avatar);
    const IconComponent = name && LucideIcons[name];
    if (IconComponent) {
      const iconSize = Math.max(10, Math.round(size * 0.6));
      return (
        <span
          className={`inline-flex items-center justify-center ${roundedCls} ${className}`}
          style={{ ...wrapperStyle, backgroundColor: `${color}22`, color }}
          aria-label="agent icon"
        >
          <IconComponent size={iconSize} />
        </span>
      );
    }
  }

  const src = resolveAvatarImageSrc(avatar, apiBase);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className={`${roundedCls} object-cover ${className}`}
        style={wrapperStyle}
      />
    );
  }

  if (fallback) {
    return <span style={wrapperStyle}>{fallback}</span>;
  }

  return (
    <span
      className={`inline-flex items-center justify-center ${roundedCls} bg-gray-900 border border-gray-700 ${className}`}
      style={wrapperStyle}
      aria-label="no avatar"
    >
      <User size={Math.max(10, Math.round(size * 0.55))} className="text-gray-600" />
    </span>
  );
}

export default AgentAvatar;
