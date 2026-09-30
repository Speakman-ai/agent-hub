import { useFinalizeRun, isFinalizeInFlight, isReadyToPush } from '../../hooks/useFinalizeRun';
import { discardBlockedReason } from '@shared/utils/discardChanges';
import DiscardChangesButton from './DiscardChangesButton';
import type { DiscardResult } from './DiscardChangesButton';

interface Props {
  sessionId: string;
  onDiscarded: (result: DiscardResult) => void;
  onError?: (msg: string) => void;
}

/**
 * Discard entry for the session Actions menu. It reads the Finalize run itself
 * so the item disables for the same reasons the server would refuse.
 */
export default function SessionDiscardMenuItem({ sessionId, onDiscarded, onError }: Props) {
  const { status } = useFinalizeRun({ sessionId, enabled: !!sessionId });
  return (
    <DiscardChangesButton
      sessionId={sessionId}
      variant="menu"
      blockedReason={discardBlockedReason({
        sessionId,
        finalizeInFlight: isFinalizeInFlight(status),
        readyToPush: isReadyToPush(status),
      })}
      onDiscarded={onDiscarded}
      onError={onError}
    />
  );
}
