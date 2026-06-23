import { CheckCircle2, XCircle, AlertTriangle, GitPullRequest } from 'lucide-react';
import { parseFinalizeTerminalMetadata } from '../../../utils/finalizeTimeline';
import { describeFinalizeFailureReason } from '../../../utils/finalizeFailureReason';
import { prNumberFromUrl } from '../../../utils/prFormatting';
import { relativeTime } from '../../../utils/time';

function labelForStatus(status: any, failureReason: any, hostLabel: any) {
  switch (status) {
    case 'pushed':
      return `Pushed to ${hostLabel}`;
    case 'cancelled':
      return 'Cancelled';
    case 'ready_to_push':
      return 'Ready to push';
    case 'timed_out':
      return 'Timed out';
    case 'stalled_no_response':
      return 'Stalled — no response';
    default:
      return failureReason ? `Failed (${failureReason})` : `Ended (${status})`;
  }
}

export default function FinalizeTerminalBlock({ message, hosted = false }: any) {
  const meta = parseFinalizeTerminalMetadata(message.metadata);
  if (!meta) return null;

  // A push that skipped the review + checks gate is a success state but worth
  // flagging — render it amber, not green, so the operator sees that tests and
  // review never ran.
  const bypassedPush = meta.status === 'pushed' && meta.bypassedGates;
  const isSuccess = !bypassedPush && (meta.status === 'pushed' || meta.status === 'ready_to_push');
  const isWarn = bypassedPush || meta.status === 'stalled_no_response';
  const Icon = isSuccess ? CheckCircle2 : isWarn ? AlertTriangle : XCircle;
  const tone = isSuccess ? 'text-emerald-300' : isWarn ? 'text-amber-300' : 'text-red-300';
  const border = isSuccess
    ? 'border-emerald-700/40 bg-emerald-950/20'
    : isWarn
      ? 'border-amber-700/40 bg-amber-950/20'
      : 'border-red-700/40 bg-red-950/20';

  const prUrl = meta.status === 'pushed' ? meta.prUrl : null;
  const prNumber = prUrl ? prNumberFromUrl(prUrl) : null;
  // Native PR URLs are in-app client routes (no http origin) — the push
  // landed on the Hub, not GitHub. When there's no PR URL to infer from
  // (failures, old messages), fall back to the live project state.
  const hostLabel = prUrl
    ? /^https?:\/\//i.test(prUrl)
      ? 'GitHub'
      : 'Agent Hub'
    : hosted
      ? 'Agent Hub'
      : 'GitHub';
  const linkTone = isWarn
    ? 'text-amber-300 hover:text-amber-200'
    : 'text-emerald-300 hover:text-emerald-200';

  // For a failure, pair the bare reason code (`Failed (fix_no_progress)`) with a
  // plain-English explanation so the run does not read as "it just stopped".
  // Skip it for the bypassed-push warning, which already has its own sub-line.
  const failureExplanation =
    !isSuccess && !bypassedPush ? describeFinalizeFailureReason(meta.failureReason) : null;

  return (
    <div className="flex justify-center mb-4" data-testid="finalize-terminal-block">
      <div className={`max-w-[95%] sm:max-w-[80%] w-full border rounded-xl px-4 py-3 ${border}`}>
        <div className="flex items-center gap-2">
          <Icon className={`w-4 h-4 shrink-0 ${tone}`} />
          <p className={`text-sm font-medium ${tone}`}>
            {bypassedPush
              ? `Pushed to ${hostLabel} without tests or review`
              : labelForStatus(meta.status, meta.failureReason, hostLabel)}
          </p>
        </div>
        {bypassedPush ? (
          <p className="text-[12px] text-amber-200/70 mt-1">
            Review and checks did not both pass before this push.
          </p>
        ) : null}
        {failureExplanation ? (
          <p
            className="text-[12px] text-red-200/70 mt-1"
            data-testid="finalize-terminal-explanation"
          >
            {failureExplanation}
          </p>
        ) : null}
        {prUrl ? (
          /^https?:\/\//i.test(prUrl) ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`mt-1.5 inline-flex items-center gap-1 text-sm font-medium underline ${linkTone}`}
              data-testid="finalize-terminal-pr-link"
            >
              <GitPullRequest className="w-3.5 h-3.5 shrink-0" />
              {prNumber ? `View PR #${prNumber}` : 'View pull request'}
            </a>
          ) : (
            /* Agent Hub-native PR — a relative client route, not an external
               page. Shown as a labelled chip; the Pull Requests page is the
               in-app navigation surface. */
            <span
              className={`mt-1.5 inline-flex items-center gap-1 text-sm font-medium ${linkTone}`}
              data-testid="finalize-terminal-pr-link"
              title={prUrl}
            >
              <GitPullRequest className="w-3.5 h-3.5 shrink-0" />
              {prNumber ? `PR #${prNumber} (Pull Requests page)` : 'Pull request created'}
            </span>
          )
        ) : null}
        {message.created_at ? (
          <div className="text-[11px] text-gray-600 mt-1.5">{relativeTime(message.created_at)}</div>
        ) : null}
      </div>
    </div>
  );
}
