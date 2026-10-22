import { useEffect, useState } from 'react';
import { CheckCircle2, CircleDashed, Loader2, XCircle, Zap } from 'lucide-react';
import { api } from '../utils/api';
import { relativePrTime } from '../utils/prFormatting';
import { createUseDefaultBranchCi } from '@shared/hooks/useDefaultBranchCi';
import { ciOnPushEnabled, type DefaultBranchCiTone } from '@shared/utils/defaultBranchCiStatus';

const useDefaultBranchCi = createUseDefaultBranchCi({ useEffect, useState });

const fetchLatestPushRun = (projectId: string) =>
  api.getCiRuns(projectId, { trigger: 'git_push', limit: 1 });

const TONE: Record<DefaultBranchCiTone, { Icon: typeof CheckCircle2; cls: string }> = {
  passed: { Icon: CheckCircle2, cls: 'text-gh-success' },
  failed: { Icon: XCircle, cls: 'text-gh-danger' },
  running: { Icon: Loader2, cls: 'text-amber-400 animate-spin' },
  cancelled: { Icon: CircleDashed, cls: 'text-gh-muted' },
  none: { Icon: Zap, cls: 'text-gh-muted' },
};

/**
 * Default-branch CI status strip for the top of the Repository page. Renders
 * nothing unless the project has CI on push enabled.
 */
export default function DefaultBranchCiBadge({
  projectId,
  project,
  onOpenRunners,
}: {
  projectId: string;
  project: unknown;
  onOpenRunners?: (projectId: string) => void;
}) {
  const enabled = ciOnPushEnabled(project);
  const status = useDefaultBranchCi(projectId, enabled, fetchLatestPushRun);
  if (!enabled || !status) return null;
  const { Icon, cls } = TONE[status.tone];
  return (
    <div
      className="mb-3 flex items-center gap-2 rounded-md border border-gh-border bg-gh-subtle px-3 py-2 text-sm"
      data-testid="repo-default-branch-ci"
      data-tone={status.tone}
    >
      <Icon size={15} className={`shrink-0 ${cls}`} />
      <span className="font-medium text-gh-fg truncate" data-testid="repo-default-branch-ci-label">
        {status.label}
      </span>
      {status.sha && (
        <code className="text-[12px] text-gh-muted font-mono">{status.sha.slice(0, 8)}</code>
      )}
      {status.at != null && (
        <span className="text-xs text-gh-muted tabular-nums">
          {relativePrTime(new Date(status.at).toISOString())}
        </span>
      )}
      {onOpenRunners && (
        <button
          type="button"
          onClick={() => onOpenRunners(projectId)}
          className="ml-auto text-xs text-gh-accent hover:underline shrink-0"
          data-testid="repo-default-branch-ci-open"
        >
          View runs
        </button>
      )}
    </div>
  );
}
