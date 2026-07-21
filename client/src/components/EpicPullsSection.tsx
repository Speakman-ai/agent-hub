import { useEffect, useState } from 'react';
import { GitPullRequest, GitMerge, XCircle, ExternalLink } from 'lucide-react';
import { api } from '../utils/api';

/** Human label for a PR's relation to the epic's feature branch. */
export function relationLabel(relation: string): string {
  return relation === 'integration' ? 'Ships branch' : 'Targets branch';
}

function stateStyle(pr: any): { label: string; cls: string; Icon: any } {
  if (pr.merged)
    return { label: 'Merged', cls: 'text-purple-300 bg-purple-500/10', Icon: GitMerge };
  if (pr.state === 'closed')
    return { label: 'Closed', cls: 'text-red-300 bg-red-500/10', Icon: XCircle };
  return { label: 'Open', cls: 'text-emerald-300 bg-emerald-500/10', Icon: GitPullRequest };
}

function isExternalUrl(url: any): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Lists the pull requests tied to an epic's feature branch — those that merge
 * into it (`targets`) or ship it onward (`integration`). Renders nothing until
 * loaded and nothing at all when the epic has no related PRs, so it only
 * surfaces when there is something to show.
 */
export default function EpicPullsSection({ projectId, epicId, onOpenPull }: any) {
  const [pulls, setPulls] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!projectId || !epicId || typeof api.getEpicPulls !== 'function') {
      setPulls([]);
      setLoaded(true);
      return () => {
        alive = false;
      };
    }
    setLoaded(false);
    api
      .getEpicPulls(projectId, epicId)
      .then((data: any) => {
        if (alive) {
          setPulls(Array.isArray(data?.pulls) ? data.pulls : []);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) {
          setPulls([]);
          setLoaded(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [projectId, epicId]);

  // Nothing to show → render nothing (keeps the epic page clean).
  if (!loaded || pulls.length === 0) return null;

  return (
    <section
      className="rounded-xl border border-white/[0.08] bg-white/[0.02] overflow-hidden"
      data-testid="epic-pulls-section"
    >
      <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/[0.06]">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-100">Pull requests</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {pulls.length} pull request{pulls.length === 1 ? '' : 's'} on this feature branch.
          </p>
        </div>
      </div>
      <div className="divide-y divide-white/[0.05]">
        {pulls.map((pr: any) => {
          const st = stateStyle(pr);
          const external = isExternalUrl(pr.html_url);
          const hasHandler = typeof onOpenPull === 'function';
          const clickable = external || hasHandler;
          // External URL → anchor; in-app handler → button; otherwise a plain,
          // non-interactive div (never a disabled button — that reads as an
          // action to assistive tech and blocks any outer handling).
          const RowTag: any = external ? 'a' : hasHandler ? 'button' : 'div';
          const rowProps = external
            ? { href: pr.html_url, target: '_blank', rel: 'noopener noreferrer' }
            : hasHandler
              ? { type: 'button', onClick: () => onOpenPull(pr.number) }
              : {};
          return (
            <RowTag
              key={pr.number}
              {...rowProps}
              data-testid={`epic-pull-${pr.number}`}
              className={`w-full flex items-center gap-3 px-5 py-3 text-left transition-colors ${
                clickable ? 'hover:bg-white/[0.03]' : 'cursor-default'
              }`}
            >
              <st.Icon size={15} className={`flex-shrink-0 ${st.cls.split(' ')[0]}`} />
              <span className="text-xs font-medium text-gray-400 tabular-nums">#{pr.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-gray-200">{pr.title}</span>
              <span
                className="flex-shrink-0 rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-300"
                title={
                  pr.relation === 'integration'
                    ? 'This PR ships the feature branch onward (its head is the feature branch).'
                    : 'This PR merges into the feature branch.'
                }
              >
                {relationLabel(pr.relation)}
              </span>
              <span
                className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.cls}`}
              >
                {st.label}
              </span>
              {external && <ExternalLink size={12} className="flex-shrink-0 text-gray-500" />}
            </RowTag>
          );
        })}
      </div>
    </section>
  );
}
