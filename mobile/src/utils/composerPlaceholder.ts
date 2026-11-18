/** Placeholder for the mobile composer. A mode-specific one (Orchestrate) wins over Consult. */
export function composerPlaceholderText({
  disabled,
  consultMode,
  composerPlaceholder,
}: {
  disabled?: boolean;
  consultMode?: boolean;
  composerPlaceholder?: string | null;
}): string {
  if (disabled) return 'Waiting...';
  if (composerPlaceholder) return composerPlaceholder;
  return consultMode ? 'Consult on Agent Hub…' : 'Message...';
}
