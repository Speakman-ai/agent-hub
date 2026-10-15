import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  answerErrorMessage,
  type ApprovalDecision,
  type ApprovalWire,
} from '@shared/utils/approvals';
import { api } from '../utils/api';

/** App re-dispatches `approval_requested` / `approval_resolved` WS frames on this event. */
export const APPROVAL_WS_EVENT = 'agenthub:approval';

interface ApprovalActionsProps {
  approval: Pick<ApprovalWire, 'id' | 'canRemember'>;
  /** Called after the server accepted the answer, or said it is no longer waiting. */
  onSettled: (approvalId: string, decision: ApprovalDecision | null) => void;
  size?: 'sm' | 'md';
  testIdPrefix?: string;
}

/** Allow once / Always allow / Deny buttons for one pending approval. */
export default function ApprovalActions({
  approval,
  onSettled,
  size = 'md',
  testIdPrefix = 'approval',
}: ApprovalActionsProps) {
  const [busy, setBusy] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(decision: ApprovalDecision) {
    setBusy(decision);
    setError(null);
    try {
      await api.answerApproval(approval.id, decision);
      onSettled(approval.id, decision);
    } catch (err) {
      if ((err as { status?: number })?.status === 409) {
        onSettled(approval.id, null);
        return;
      }
      setError(answerErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const pad = size === 'sm' ? 'px-2 py-1 text-[11px]' : 'px-3 py-1.5 text-xs';
  const button = (decision: ApprovalDecision, label: string, tone: string) => (
    <button
      type="button"
      onClick={() => void answer(decision)}
      disabled={busy !== null}
      className={`inline-flex items-center gap-1 rounded-md font-medium disabled:opacity-60 ${pad} ${tone}`}
      data-testid={`${testIdPrefix}-${decision}`}
    >
      {busy === decision && <Loader2 size={12} className="animate-spin" />}
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {button('allow_once', 'Allow once', 'bg-emerald-600 hover:bg-emerald-500 text-white')}
        {approval.canRemember &&
          button(
            'always_allow',
            'Always allow',
            'bg-gray-700 hover:bg-gray-600 text-gray-100 border border-gray-600',
          )}
        {button('deny', 'Deny', 'bg-red-700/80 hover:bg-red-600 text-white')}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-400" data-testid={`${testIdPrefix}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
