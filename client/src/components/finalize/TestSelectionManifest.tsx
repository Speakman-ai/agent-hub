import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, MinusCircle, CheckCircle2 } from 'lucide-react';
import { api } from '../../utils/api';
import {
  boardCardPath,
  DEFAULT_BRANCH_HEALTH_POLL_MS,
  defaultBranchFailureName,
  defaultBranchRedLabel,
  forcedFullLabel,
  selectionChipLabel,
  selectionInstanceName,
  selectionInstanceReason,
  sortedSelectionInstances,
  type TestSelectionWire,
} from '@shared/utils/testSelectionDisplay';
import { createUseDefaultBranchHealth } from '@shared/hooks/useDefaultBranchHealth';

const useDefaultBranchHealth = createUseDefaultBranchHealth({ useEffect, useState });

const MAX_FILES_SHOWN = 5;

/**
 * Collapsible view of a run's test-selection manifest: which job instances
 * ran, why, and which were left out. Renders nothing for full-mode runs.
 */
export function TestSelectionManifest({
  selection,
  testIdPrefix = 'test-selection',
}: {
  selection: TestSelectionWire | null;
  testIdPrefix?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!selection) return null;
  const chip = selectionChipLabel(selection);
  const forced = forcedFullLabel(selection);
  return (
    <div className="text-xs" data-testid={`${testIdPrefix}-manifest`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 text-left text-slate-400 hover:text-slate-200"
        data-testid={`${testIdPrefix}-manifest-toggle`}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="text-slate-300">Test selection</span>
        {chip ? <span className="text-slate-500">· {chip}</span> : null}
      </button>
      {forced ? (
        <p className="pl-4 text-amber-300/90" data-testid={`${testIdPrefix}-forced-full`}>
          {forced}
        </p>
      ) : null}
      {open ? (
        <ul className="mt-1 space-y-1 pl-4" data-testid={`${testIdPrefix}-manifest-list`}>
          {sortedSelectionInstances(selection).map((i) => {
            const name = selectionInstanceName(i);
            return (
              <li
                key={`${i.jobId}::${i.matrixKey}`}
                data-testid={`${testIdPrefix}-manifest-row`}
                data-selected={i.selected ? 'true' : 'false'}
                className={i.selected ? '' : 'opacity-60'}
              >
                <div className="flex items-center gap-1.5">
                  {i.selected ? (
                    <CheckCircle2 size={11} className="text-emerald-400" aria-label="selected" />
                  ) : (
                    <MinusCircle size={11} className="text-slate-500" aria-label="not selected" />
                  )}
                  <code className="font-mono text-slate-200">{name}</code>
                  <span className="text-slate-500">{i.selected ? 'ran' : 'not selected'}</span>
                </div>
                {!forced ? (
                  <p className="pl-4 text-slate-500">{selectionInstanceReason(i)}</p>
                ) : null}
                {i.files.length > 0 ? (
                  <p className="pl-4 font-mono text-[10px] text-slate-600">
                    {i.files.slice(0, MAX_FILES_SHOWN).join(', ')}
                    {i.files.length > MAX_FILES_SHOWN
                      ? ` +${i.files.length - MAX_FILES_SHOWN} more`
                      : ''}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Red banner while the project's default branch has instances failing in
 * the full push-CI run, linking the breakage card. Renders nothing when the
 * branch is green, unknown, or the read fails.
 */
export function DefaultBranchHealthBanner({
  projectId,
  refreshKey = '',
  pollMs = DEFAULT_BRANCH_HEALTH_POLL_MS,
}: {
  projectId: string;
  /** Refetch whenever this changes (e.g. a push-CI run settles). */
  refreshKey?: string;
  pollMs?: number;
}) {
  const health = useDefaultBranchHealth(projectId, api.getDefaultBranchHealth, {
    refreshKey,
    pollMs,
  });
  const label = defaultBranchRedLabel(health);
  if (!health || !label) return null;
  const cardHref = boardCardPath(projectId, health.breakage?.card_id);
  return (
    <div
      className="rounded-lg border border-red-800/60 bg-red-950/30 px-3 py-2 text-xs text-red-200"
      data-testid="default-branch-red-banner"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={13} className="text-red-400 shrink-0" />
        <span className="font-medium">{label}</span>
        {cardHref ? (
          <a
            href={cardHref}
            target="_blank"
            rel="noreferrer"
            className="ml-auto text-red-300 underline decoration-dotted hover:text-red-100"
            data-testid="default-branch-breakage-card"
          >
            breakage card
          </a>
        ) : null}
      </div>
      {health.failures.length > 0 ? (
        <ul className="mt-1 space-y-0.5 pl-5" data-testid="default-branch-failures">
          {health.failures.map((f) => (
            <li key={`${f.job_id}::${f.matrix_key}`} className="flex items-center gap-2">
              <code className="font-mono text-red-100">{defaultBranchFailureName(f)}</code>
              <span className="text-red-300/70">
                since <code className="font-mono">{f.first_failing_sha.slice(0, 8)}</code>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-red-300/70">
        Merges are not blocked. Session runs that fail only on these instances pass as inherited.
      </p>
    </div>
  );
}
