/**
 * On/off switch for Orchestrate in the simple view. The full Hub keeps the
 * multi-mode picker; this chat only needs consult or Orchestrate.
 */
export default function SimpleOrchestrateToggle({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label="Orchestrate"
      data-testid="simple-orchestrate-toggle"
      disabled={disabled}
      title={enabled ? 'Turn Orchestrate off' : 'Turn Orchestrate on'}
      onClick={() => onChange(!enabled)}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs disabled:opacity-50 ${
        enabled
          ? 'border-sky-600 bg-sky-900/40 text-sky-100'
          : 'border-gray-700 text-gray-300 hover:bg-gray-800'
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 rounded-full ${enabled ? 'bg-sky-300' : 'bg-gray-600'}`}
      />
      Orchestrate
    </button>
  );
}
