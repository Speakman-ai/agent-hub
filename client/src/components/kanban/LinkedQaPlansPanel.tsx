import { ClipboardCheck } from 'lucide-react';
import type { QaPlanListItemWire } from '../../utils/api';
import { QA_TONE_CLASS, QA_TONE_LABELS, qaPlanTone } from '../../utils/qaLinks';

type Props = {
  plans: QaPlanListItemWire[] | undefined;
  onOpenPlan?: (planId: string) => void;
};

/**
 * QA plans linked to an epic or card, each with its status badge. A row opens
 * the plan detail on the QA page. Renders nothing when no plan links here.
 */
export default function LinkedQaPlansPanel({ plans, onOpenPlan }: Props) {
  if (!plans || plans.length === 0) return null;
  return (
    <div data-testid="linked-qa-plans">
      <label className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-gray-500">
        <ClipboardCheck size={12} />
        QA plans ({plans.length})
      </label>
      <ul className="space-y-1.5">
        {plans.map((plan) => {
          const tone = qaPlanTone(plan);
          const run = plan.summary.latestRun;
          return (
            <li key={plan.id}>
              <button
                type="button"
                data-testid="linked-qa-plan"
                onClick={() => onOpenPlan?.(plan.id)}
                disabled={!onOpenPlan}
                className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-left hover:border-white/[0.14] disabled:cursor-default"
                title={plan.targetUrl}
              >
                <span className="min-w-0 flex-1 truncate text-sm text-gray-200">{plan.title}</span>
                {run ? (
                  <span className="shrink-0 text-[10px] tabular-nums text-gray-500">
                    #{run.iteration} · {run.verdicts.pass}/{plan.summary.caseCount} pass
                  </span>
                ) : null}
                <span
                  data-testid="linked-qa-plan-status"
                  className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${QA_TONE_CLASS[tone]}`}
                >
                  {QA_TONE_LABELS[tone]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
