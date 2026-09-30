/**
 * Client-side reading of a note's sharing state, used by the web and mobile
 * notes screens. Rows from older servers carry no `shared` / `can_manage`
 * fields; they were visible to the whole project, so they read as shared and
 * manageable.
 */
export interface NoteVisibilityFields {
  shared?: boolean | null;
  can_manage?: boolean | null;
  owner_username?: string | null;
}

export interface NoteVisibility {
  shared: boolean;
  canManage: boolean;
  label: 'Shared' | 'Private';
  /** Tooltip / accessibility hint describing who can see the note. */
  hint: string;
}

export function describeNoteVisibility(note: NoteVisibilityFields): NoteVisibility {
  const shared = note.shared !== false;
  const canManage = note.can_manage !== false;
  const label = shared ? 'Shared' : 'Private';
  const hint = canManage
    ? shared
      ? 'Visible to everyone in this project.'
      : 'Only you can see this note.'
    : `Shared by ${note.owner_username || 'another member'}. Only the owner can change this.`;
  return { shared, canManage, label, hint };
}
