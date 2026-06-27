import type { AssignableUser } from '../utils/kanbanUserFilter';

type EpicLeadUserFieldProps = {
  users: AssignableUser[];
  value: string;
  onChange: (userId: string) => void;
  disabled?: boolean;
};

const LABEL_CLASS = 'block text-[11px] font-semibold uppercase tracking-wider text-gray-500 mb-1.5';
const FIELD_CLASS =
  'w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-colors';

export default function EpicLeadUserField({
  users,
  value,
  onChange,
  disabled = false,
}: EpicLeadUserFieldProps) {
  return (
    <div>
      <label htmlFor="epic-lead-user" className={LABEL_CLASS}>
        Lead user
      </label>
      <select
        id="epic-lead-user"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        data-testid="epic-lead-user-select"
        className={FIELD_CLASS}
      >
        <option value="">Unassigned</option>
        {users.map((user) => (
          <option key={user.id} value={user.id}>
            {user.username}
          </option>
        ))}
      </select>
    </div>
  );
}
