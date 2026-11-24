import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Folder, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import type { SessionFolderWire } from '@shared/utils/sessionFolders';

const NAME_MAX = 80;

/** Inline text field that commits on Enter or blur and cancels on Escape. */
export function FolderNameInput({
  initial = '',
  placeholder = 'Folder name',
  onCommit,
  onCancel,
  testId,
}: {
  initial?: string;
  placeholder?: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
  testId?: string;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const name = value.trim();
    if (commit && name && name !== initial) onCommit(name);
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={value}
      maxLength={NAME_MAX}
      placeholder={placeholder}
      data-testid={testId}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
      className="flex-1 min-w-0 text-xs bg-gray-700 text-gray-200 px-2 py-1 rounded outline-none focus:ring-1 focus:ring-indigo-500"
    />
  );
}

/** Collapsible folder group in an agent's session list. */
export function SessionFolderGroup({
  folder,
  count,
  collapsed,
  onToggle,
  onRename,
  onDelete,
  children,
}: {
  folder: SessionFolderWire;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div data-testid={`session-folder-${folder.id}`}>
      <div className="group relative flex items-center rounded-md mb-0.5 text-gray-500 hover:bg-gray-800/50 hover:text-gray-300">
        {editing ? (
          <div className="flex items-center gap-1.5 px-2 py-1 flex-1 min-w-0">
            <Folder size={12} className="flex-shrink-0" />
            <FolderNameInput
              initial={folder.name}
              testId={`session-folder-rename-input-${folder.id}`}
              onCommit={(name) => {
                setEditing(false);
                onRename(name);
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={onToggle}
              onDoubleClick={() => setEditing(true)}
              aria-expanded={!collapsed}
              data-testid={`session-folder-toggle-${folder.id}`}
              className="flex-1 min-w-0 text-left px-2 py-2 md:py-1.5 pr-14 text-xs flex items-center gap-1.5 cursor-pointer"
            >
              {collapsed ? (
                <ChevronRight size={11} className="flex-shrink-0" />
              ) : (
                <ChevronDown size={11} className="flex-shrink-0" />
              )}
              <Folder size={12} className="flex-shrink-0" />
              <span className="truncate font-medium">{folder.name}</span>
              <span className="flex-shrink-0 text-[10px] text-gray-600">{count}</span>
            </button>
            <div className="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex items-center rounded bg-gray-800">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="p-1.5 text-gray-600 hover:text-gray-200 rounded hover:bg-gray-700/80"
                title="Rename folder"
                data-testid={`session-folder-rename-${folder.id}`}
              >
                <Pencil size={11} />
              </button>
              <button
                type="button"
                onClick={onDelete}
                className="p-1.5 text-gray-600 hover:text-red-400 rounded hover:bg-gray-700/80"
                title="Delete folder (its sessions move back to the list)"
                data-testid={`session-folder-delete-${folder.id}`}
              >
                <Trash2 size={11} />
              </button>
            </div>
          </>
        )}
      </div>
      {!collapsed && <div className="ml-3 border-l border-gray-800 pl-1">{children}</div>}
    </div>
  );
}

/** Dropdown for filing one session: pick a folder, unfile, or create a folder and file into it. */
export function MoveToFolderMenu({
  sessionId,
  folders,
  currentFolderId,
  onMove,
  onCreateAndMove,
  onClose,
}: {
  sessionId: string;
  folders: SessionFolderWire[];
  currentFolderId: string | null;
  onMove: (folderId: string | null) => void;
  onCreateAndMove: (name: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const item =
    'w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 text-gray-300 hover:bg-gray-700 disabled:opacity-50 disabled:hover:bg-transparent';
  return (
    <div
      ref={ref}
      role="menu"
      data-testid={`session-folder-menu-${sessionId}`}
      onClick={(e) => e.stopPropagation()}
      className="absolute right-1 top-full mt-0.5 z-30 w-48 py-1 rounded-md border border-gray-700 bg-gray-800 shadow-lg"
    >
      {folders.map((f) => (
        <button
          key={f.id}
          type="button"
          role="menuitem"
          className={item}
          disabled={f.id === currentFolderId}
          onClick={() => onMove(f.id)}
        >
          {f.id === currentFolderId ? <Check size={11} /> : <Folder size={11} />}
          <span className="truncate">{f.name}</span>
        </button>
      ))}
      {currentFolderId && (
        <button type="button" role="menuitem" className={item} onClick={() => onMove(null)}>
          <span className="w-[11px]" />
          Remove from folder
        </button>
      )}
      {folders.length > 0 && <div className="my-1 border-t border-gray-700" />}
      {creating ? (
        <div className="px-2 py-1 flex">
          <FolderNameInput
            testId={`session-folder-menu-new-input-${sessionId}`}
            onCommit={onCreateAndMove}
            onCancel={() => setCreating(false)}
          />
        </div>
      ) : (
        <button type="button" role="menuitem" className={item} onClick={() => setCreating(true)}>
          <FolderPlus size={11} />
          New folder…
        </button>
      )}
    </div>
  );
}
