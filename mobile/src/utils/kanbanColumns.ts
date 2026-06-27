/** Columns required by board automation — cannot be deleted or renamed. */
export function isSystemLockedColumnName(columnName: string | null | undefined): boolean {
  if (!columnName) return false;
  const n = String(columnName).trim().toLowerCase();
  return n === 'to do' || n === 'in progress' || n === 'done';
}
