import type { AssignableUser } from '../utils/kanbanUserFilter';

type KanbanUserFilterChipsProps = {
  users: AssignableUser[];
  selectedUserIds: Set<string>;
  onToggle: (userId: string) => void;
  onClear: () => void;
  testIdPrefix?: string;
};

export default function KanbanUserFilterChips({
  users,
  selectedUserIds,
  onToggle,
  onClear,
  testIdPrefix = 'kanban-user-filter',
}: KanbanUserFilterChipsProps) {
  if (users.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={`${testIdPrefix}-list`}>
      {users.map((user) => {
        const active = selectedUserIds.has(user.id);
        return (
          <button
            key={user.id}
            type="button"
            onClick={() => onToggle(user.id)}
            data-testid={`${testIdPrefix}-${user.username}`}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              active
                ? 'border-sky-500/40 bg-sky-500/15 text-sky-200'
                : 'border-white/[0.08] bg-white/[0.04] text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]'
            }`}
          >
            {user.username}
          </button>
        );
      })}
      {selectedUserIds.size > 0 ? (
        <button
          type="button"
          onClick={onClear}
          data-testid={`${testIdPrefix}-clear`}
          className="text-[11px] text-gray-500 hover:text-gray-300 px-1"
        >
          Clear users
        </button>
      ) : null}
    </div>
  );
}
