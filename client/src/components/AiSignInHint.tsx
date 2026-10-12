import PointerHint from './PointerHint';

export default function AiSignInHint({
  target,
  onDismiss,
}: {
  target: 'Settings' | 'Account';
  onDismiss: () => void;
}) {
  return (
    <PointerHint
      message={
        target === 'Settings'
          ? 'Open Settings to connect your AI account.'
          : 'Choose Account to sign in with your AI credentials.'
      }
      dismissLabel="Dismiss AI sign-in guide"
      onDismiss={onDismiss}
    />
  );
}
