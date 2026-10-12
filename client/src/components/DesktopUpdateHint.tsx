import PointerHint from './PointerHint';

export default function DesktopUpdateHint({
  target,
  version,
  onDismiss,
}: {
  target: 'Settings' | 'General';
  version: string | null;
  onDismiss: () => void;
}) {
  const label = version ? `Agent Hub ${version} is available.` : 'A desktop update is available.';
  return (
    <PointerHint
      testId="desktop-update-hint"
      message={
        target === 'Settings'
          ? `${label} Open Settings to download it.`
          : `${label} Choose General to download it.`
      }
      dismissLabel="Dismiss update notice"
      onDismiss={onDismiss}
    />
  );
}
