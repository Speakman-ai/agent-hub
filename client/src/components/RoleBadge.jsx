import { Shield, ShieldCheck, User } from 'lucide-react';
import { getUserRole } from '../utils/auth.js';

/**
 * Visual indicator for the signed-in user's role (Phase 2 auth).
 *
 * Accepts an explicit `role` prop (used by tests and server-driven
 * contexts like /api/auth/users) or falls back to the role stored in
 * the local auth record. Renders nothing when no role is known — the
 * legacy apiKey flow and unauthenticated states stay unchanged.
 */
export default function RoleBadge({ role, className = '' }) {
  const effective = role || getUserRole();
  if (!effective) return null;

  const styles = {
    Owner: {
      icon: ShieldCheck,
      tone: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300',
      label: 'Owner',
    },
    Admin: {
      icon: Shield,
      tone: 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300',
      label: 'Admin',
    },
    User: {
      icon: User,
      tone: 'bg-gray-500/15 border-gray-500/40 text-gray-300',
      label: 'User',
    },
  };
  const entry = styles[effective] || styles.User;
  const Icon = entry.icon;

  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-medium rounded border ${entry.tone} ${className}`}
      title={`Your role: ${entry.label}`}
      data-role={effective}
    >
      <Icon size={10} aria-hidden="true" />
      {entry.label}
    </span>
  );
}
