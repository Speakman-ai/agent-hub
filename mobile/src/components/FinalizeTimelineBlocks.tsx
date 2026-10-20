/**
 * Chat-timeline cards for Finalize system messages and the post-turn change
 * summary. Ports `client/src/components/finalize/blocks/*` so these messages
 * render as structured cards instead of the raw-text system fallback.
 *
 * Metadata parsing is shared with web (`@shared/utils/finalizeTimeline`,
 * `@shared/utils/turnChangeSummary`); only the presentation lives here.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Linking, Platform } from 'react-native';
import AppIcon from './AppIcon';
import FinalizeChecksCard from './FinalizeChecksCard';
import { colors } from '../theme/colors';
import { relativeTime } from '../utils/time';
import { prNumberFromUrl, parseNativePrUrl } from '../utils/prFormatting';
import { describePrFailureCode, parsePrFailedMetadata, shortSha } from '@shared/utils/prMessage';
import {
  describeFinalizeRebaseReloop,
  isFinalizeStepOutputMessage,
  parseFinalizeTimelineKind,
  parseFinalizeTimelineMetadata,
  parseFinalizeChecksRoundMetadata,
  parseFinalizeFixDispatchMetadata,
  parseFinalizeReadyToPushMetadata,
  parseFinalizeRebaseMetadata,
  parseFinalizeReviewRoundMetadata,
  parseFinalizeRunStartedMetadata,
  parseFinalizeRunSummaryMetadata,
  parseFinalizeTerminalMetadata,
} from '@shared/utils/finalizeTimeline';
import { parseTurnChangeSummaryMetadata } from '@shared/utils/turnChangeSummary';
import { describeFinalizeFailureReason } from '@shared/utils/finalizeFailureReason';
import { followUpsEmptyStateMessage, NO_COMMITS_MESSAGE } from '@shared/utils/finalizeSummaryCopy';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

const TONES = {
  indigo: { bg: 'rgba(30, 27, 75, 0.3)', border: 'rgba(67, 56, 202, 0.4)', text: colors.indigo300 },
  emerald: {
    bg: 'rgba(2, 44, 34, 0.25)',
    border: 'rgba(4, 120, 87, 0.4)',
    text: colors.emerald300,
  },
  red: { bg: 'rgba(69, 10, 10, 0.2)', border: 'rgba(185, 28, 28, 0.4)', text: '#fca5a5' },
  amber: { bg: 'rgba(69, 26, 3, 0.2)', border: 'rgba(180, 83, 9, 0.4)', text: '#fcd34d' },
  slate: { bg: 'rgba(15, 23, 42, 0.5)', border: 'rgba(51, 65, 85, 0.6)', text: colors.gray200 },
} as const;

type Tone = keyof typeof TONES;

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatAnchor(start: any, end: any) {
  if (start == null) return 'file-level';
  if (end == null || end === start) return `L${start}`;
  return `L${start}-${end}`;
}

function Card({ tone, testID, children, createdAt }: any) {
  const t = TONES[tone as Tone];
  return (
    <View style={styles.container} testID={testID}>
      <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.border }]}>
        {children}
        {createdAt ? <Text style={styles.timestamp}>{relativeTime(createdAt)}</Text> : null}
      </View>
    </View>
  );
}

function HeaderRow({ icon, iconColor, title, titleColor, right }: any) {
  return (
    <View style={styles.headerRow}>
      {icon ? <AppIcon name={icon} size={16} color={iconColor} /> : null}
      <Text style={[styles.title, { color: titleColor }]} numberOfLines={2}>
        {title}
      </Text>
      {right ? <View style={styles.headerRight}>{right}</View> : null}
    </View>
  );
}

function Sha({ sha }: any) {
  return <Text style={styles.sha}>{shortSha(sha)}</Text>;
}

function VerdictPill({ verdict, approvedLabel = 'Approved' }: any) {
  const approved = verdict === 'approved';
  return (
    <View
      style={[styles.pill, approved ? styles.pillApproved : styles.pillChanges]}
      testID="finalize-verdict-pill"
    >
      <AppIcon
        name={approved ? 'checkmark-circle' : 'alert-circle'}
        size={12}
        color={approved ? colors.emerald300 : TONES.amber.text}
      />
      <Text style={[styles.pillText, { color: approved ? colors.emerald300 : TONES.amber.text }]}>
        {approved ? approvedLabel : 'Changes requested'}
      </Text>
    </View>
  );
}

function Section({ icon, title, count, highlighted = false, testID, children }: any) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <View style={[styles.section, highlighted && styles.sectionHighlighted]} testID={testID}>
      <TouchableOpacity
        style={styles.sectionHeader}
        onPress={() => setCollapsed((c) => !c)}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
      >
        <AppIcon
          name={collapsed ? 'chevron-forward' : 'chevron-down'}
          size={14}
          color={colors.gray500}
        />
        <AppIcon name={icon} size={14} color={colors.gray500} />
        <Text style={styles.sectionTitle}>{title}</Text>
        {count != null ? <Text style={styles.sectionCount}>{count}</Text> : null}
      </TouchableOpacity>
      {!collapsed ? <View style={styles.sectionBody}>{children}</View> : null}
    </View>
  );
}

function describeTriggerSource(source: any) {
  switch (source) {
    case 'ui_button':
      return 'UI button';
    case 'agent_block':
      return 'agent block';
    default:
      return source ? String(source).replace(/_/g, ' ') : 'unknown';
  }
}

export function FinalizeRunStartedBlock({ message }: any) {
  const meta = parseFinalizeRunStartedMetadata(message.metadata);
  if (!meta) return null;
  return (
    <Card tone="indigo" testID="finalize-run-started-block" createdAt={message.created_at}>
      <HeaderRow
        icon="git-merge-outline"
        iconColor={colors.indigo400}
        title="Runner started"
        titleColor={TONES.indigo.text}
      />
      <Text style={styles.sub}>
        Trigger: {describeTriggerSource(meta.triggerSource)}
        {meta.headSha ? ' · ' : ''}
        {meta.headSha ? <Sha sha={meta.headSha} /> : null}
      </Text>
    </Card>
  );
}

export function FinalizeRebaseBlock({ message }: any) {
  const meta = parseFinalizeRebaseMetadata(message.metadata);
  if (!meta) return null;
  const roundLabel = meta.round > 0 ? `Rebase · round ${meta.round}` : 'Rebase';
  const reloopNote = describeFinalizeRebaseReloop(meta);
  const tone: Tone = meta.ok ? 'emerald' : 'red';
  return (
    <Card tone={tone} testID="finalize-rebase-block" createdAt={message.created_at}>
      <HeaderRow
        icon={meta.ok ? 'checkmark-circle' : 'close-circle'}
        iconColor={TONES[tone].text}
        title={`${roundLabel}: ${meta.ok ? 'completed' : 'failed'}${
          meta.conflict ? ' (conflicts resolved)' : ''
        }`}
        titleColor={TONES[tone].text}
      />
      {meta.headSha ? (
        <Text style={styles.sub}>
          HEAD <Sha sha={meta.headSha} />
        </Text>
      ) : null}
      {!meta.ok && meta.detail ? <Text style={styles.subRed}>{meta.detail}</Text> : null}
      {reloopNote ? (
        <Text style={styles.subAmber} testID="finalize-rebase-reloop">
          {reloopNote}
        </Text>
      ) : null}
    </Card>
  );
}

export function FinalizeReviewRoundBlock({ message }: any) {
  const meta = useMemo(
    () => parseFinalizeReviewRoundMetadata(message.metadata),
    [message.metadata],
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const grouped = useMemo(() => {
    const map = new Map<string, any[]>();
    (meta?.threads ?? []).forEach((thread: any) => {
      const filePath = thread.file_path ?? thread.filePath ?? '(unknown)';
      const list = map.get(filePath) ?? [];
      list.push(thread);
      map.set(filePath, list);
    });
    return map;
  }, [meta?.threads]);
  if (!meta) return null;
  const toggle = (filePath: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  const roundLabel = meta.round > 0 ? `Review · round ${meta.round}` : 'Review';
  return (
    <Card tone="slate" testID="finalize-review-round-block" createdAt={message.created_at}>
      <HeaderRow
        title={roundLabel}
        titleColor={colors.gray200}
        right={meta.verdict ? <VerdictPill verdict={meta.verdict} /> : null}
      />
      <Text style={styles.muted}>{plural(meta.threads.length, 'finding')}</Text>
      {meta.threads.length === 0 ? (
        <Text style={styles.muted}>No findings on this pass.</Text>
      ) : (
        Array.from(grouped.entries()).map(([filePath, threads]) => {
          const isCollapsed = collapsed.has(filePath);
          return (
            <View key={filePath} style={styles.section} testID="finalize-review-file-group">
              <TouchableOpacity
                style={styles.sectionHeader}
                onPress={() => toggle(filePath)}
                accessibilityRole="button"
                accessibilityState={{ expanded: !isCollapsed }}
              >
                <AppIcon
                  name={isCollapsed ? 'chevron-forward' : 'chevron-down'}
                  size={14}
                  color={colors.gray500}
                />
                <AppIcon name="document-text-outline" size={14} color={colors.gray500} />
                <Text style={[styles.sectionTitle, styles.mono]} numberOfLines={1}>
                  {filePath}
                </Text>
                <Text style={styles.sectionCount}>{plural(threads.length, 'note')}</Text>
              </TouchableOpacity>
              {!isCollapsed
                ? threads.map((t: any, i: number) => (
                    <View
                      key={t.id ?? `${filePath}-${i}`}
                      style={styles.thread}
                      testID="finalize-review-thread"
                    >
                      <Text style={styles.anchor}>
                        {formatAnchor(t.line_start ?? t.lineStart, t.line_end ?? t.lineEnd)}
                      </Text>
                      <Text style={styles.body} selectable>
                        {t.body}
                      </Text>
                    </View>
                  ))
                : null}
            </View>
          );
        })
      )}
    </Card>
  );
}

export function FinalizeChecksRoundBlock({ message }: any) {
  const meta = parseFinalizeChecksRoundMetadata(message.metadata);
  if (!meta) return null;
  if (meta.steps.length === 0) {
    const roundLabel = meta.round > 0 ? `Checks · round ${meta.round}` : 'Checks';
    return (
      <Card tone="slate" testID="finalize-checks-round-block" createdAt={message.created_at}>
        <HeaderRow title={roundLabel} titleColor={colors.gray200} />
        <Text style={styles.muted}>No CI steps ran on this pass.</Text>
      </Card>
    );
  }
  return (
    <View style={styles.container} testID="finalize-checks-round-block">
      <View style={styles.checksWrap}>
        <FinalizeChecksCard steps={meta.steps} round={meta.round} />
        {message.created_at ? (
          <Text style={styles.timestamp}>{relativeTime(message.created_at)}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function FinalizeReadyToPushBlock({ message, hosted = false }: any) {
  const meta = parseFinalizeReadyToPushMetadata(message.metadata);
  if (!meta) return null;
  // Messages written before host stamping default to 'github' in the parser;
  // the live project state wins for those.
  const isHub = meta.hostStamped ? meta.host === 'agenthub' : hosted;
  return (
    <Card tone="emerald" testID="finalize-ready-to-push-block" createdAt={message.created_at}>
      <HeaderRow
        icon="cloud-upload-outline"
        iconColor={colors.emerald400}
        title={`Ready to push to ${isHub ? 'Agent Hub' : 'GitHub'}`}
        titleColor={TONES.emerald.text}
      />
      {meta.validatedHeadSha ? (
        <Text style={styles.sub}>
          Validated <Sha sha={meta.validatedHeadSha} />
        </Text>
      ) : null}
    </Card>
  );
}

export function FinalizeFixDispatchBlock({ message }: any) {
  const meta = parseFinalizeFixDispatchMetadata(message.metadata);
  if (!meta) return null;
  const parts: string[] = [];
  if (meta.failedStepName) parts.push(`CI: ${meta.failedStepName} failed`);
  if (meta.reviewerVerdict === 'changes_requested') {
    parts.push(
      meta.reviewerThreadCount > 0
        ? `Review: ${plural(meta.reviewerThreadCount, 'finding')}`
        : 'Review: changes requested',
    );
  }
  return (
    <Card tone="amber" testID="finalize-fix-dispatch-block" createdAt={message.created_at}>
      <HeaderRow
        icon="hammer-outline"
        iconColor={colors.amber400}
        title="Fix round dispatched"
        titleColor={TONES.amber.text}
      />
      {parts.length > 0 ? <Text style={styles.subAmber}>{parts.join(' · ')}</Text> : null}
      {message.content ? (
        <Text style={[styles.body, styles.spaced]} selectable>
          {message.content}
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * The run found no CI config and is going review-only. Amber, not green, so a
 * passing run is not read as "the tests passed".
 */
export function FinalizeCiAbsentBlock({ message }: any) {
  const meta = parseFinalizeTimelineMetadata(message.metadata);
  if (!meta || meta.kind !== 'finalize_ci_absent') return null;
  const round = typeof meta.round === 'number' ? meta.round : 0;
  const content = typeof message.content === 'string' ? message.content : '';
  return (
    <Card tone="amber" testID="finalize-ci-absent-block" createdAt={message.created_at}>
      <HeaderRow
        icon="alert-circle"
        iconColor={TONES.amber.text}
        title={round > 0 ? `No checks · round ${round}` : 'No checks'}
        titleColor={TONES.amber.text}
      />
      <Text style={styles.subAmber} selectable>
        {content ||
          'No CI config for this project, so Finalize is running review-only with no checks.'}
      </Text>
    </Card>
  );
}

export function FinalizeReviewNoticeBlock({ message }: any) {
  const content = typeof message?.content === 'string' ? message.content : '';
  return (
    <Card tone="amber" testID="finalize-review-notice-block" createdAt={message?.created_at}>
      <HeaderRow
        icon="alert-circle"
        iconColor={TONES.amber.text}
        title="Finalize paused"
        titleColor={TONES.amber.text}
      />
      {content ? (
        <Text style={styles.subAmber} selectable>
          {content}
        </Text>
      ) : null}
    </Card>
  );
}

function terminalLabel(status: any, failureReason: any, hostLabel: string) {
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
      return 'Stalled: no response';
    default:
      return failureReason ? `Failed (${failureReason})` : `Ended (${status})`;
  }
}

export function FinalizeTerminalBlock({ message, hosted = false, onOpenPrDetail }: any) {
  const meta = parseFinalizeTerminalMetadata(message.metadata);
  if (!meta) return null;
  // A push that skipped review + checks is a success, but flagged amber so the
  // operator sees that tests and review never ran.
  const bypassedPush = meta.status === 'pushed' && meta.bypassedGates;
  const isSuccess = !bypassedPush && (meta.status === 'pushed' || meta.status === 'ready_to_push');
  const isWarn = bypassedPush || meta.status === 'stalled_no_response';
  const tone: Tone = isSuccess ? 'emerald' : isWarn ? 'amber' : 'red';
  const icon = isSuccess ? 'checkmark-circle' : isWarn ? 'alert-circle' : 'close-circle';
  const prUrl = meta.status === 'pushed' ? meta.prUrl : null;
  const isExternal = prUrl ? /^https?:\/\//i.test(prUrl) : false;
  const nativeTarget = prUrl && !isExternal ? parseNativePrUrl(prUrl) : null;
  const prNumber = prUrl ? prNumberFromUrl(prUrl) : null;
  const hostLabel = prUrl ? (isExternal ? 'GitHub' : 'Agent Hub') : hosted ? 'Agent Hub' : 'GitHub';
  const failureExplanation =
    !isSuccess && !bypassedPush ? describeFinalizeFailureReason(meta.failureReason) : null;
  const openPr = () => {
    if (!prUrl) return;
    if (isExternal) {
      Linking.openURL(prUrl).catch(() => {});
    } else if (nativeTarget && typeof onOpenPrDetail === 'function') {
      onOpenPrDetail(nativeTarget.projectId, nativeTarget.number);
    }
  };
  const canOpen = isExternal || (nativeTarget && typeof onOpenPrDetail === 'function');
  return (
    <Card tone={tone} testID="finalize-terminal-block" createdAt={message.created_at}>
      <HeaderRow
        icon={icon}
        iconColor={TONES[tone].text}
        title={
          bypassedPush
            ? `Pushed to ${hostLabel} without tests or review`
            : terminalLabel(meta.status, meta.failureReason, hostLabel)
        }
        titleColor={TONES[tone].text}
      />
      {bypassedPush ? (
        <Text style={styles.subAmber}>Review and checks did not both pass before this push.</Text>
      ) : null}
      {failureExplanation ? (
        <Text style={styles.subRed} testID="finalize-terminal-explanation">
          {failureExplanation}
        </Text>
      ) : null}
      {prUrl ? (
        <TouchableOpacity
          onPress={openPr}
          disabled={!canOpen}
          accessibilityRole="link"
          style={styles.prRow}
          testID="finalize-terminal-pr-link"
        >
          <AppIcon name="git-pull-request" size={14} color={TONES[tone].text} />
          <Text
            style={[
              styles.prLink,
              { color: TONES[tone].text },
              !canOpen && { textDecorationLine: 'none' },
            ]}
          >
            {prNumber ? `View PR #${prNumber}` : 'View pull request'}
          </Text>
        </TouchableOpacity>
      ) : null}
    </Card>
  );
}

function ManualTestingList({ steps, testID }: any) {
  if (!steps.length) {
    return (
      <Text style={styles.muted}>No manual testing steps were generated for this change.</Text>
    );
  }
  return steps.map((step: string, i: number) => (
    <View key={`${i}-${step}`} style={styles.listRow} testID={testID}>
      <Text style={styles.bullet}>•</Text>
      <Text style={styles.body} selectable>
        {step}
      </Text>
    </View>
  ));
}

export function FinalizeRunSummaryBlock({ message }: any) {
  const meta = useMemo(() => parseFinalizeRunSummaryMetadata(message.metadata), [message.metadata]);
  if (!meta) return null;
  const roundsWithFindings = meta.reviewRounds.filter((r: any) => r.findings.length > 0);
  const followUps = meta.followUps ?? [];
  const diffParts: React.ReactNode[] = [];
  if (meta.filesChanged != null) {
    diffParts.push(
      <Text key="files" style={styles.muted}>
        {plural(meta.filesChanged, 'file')}
      </Text>,
    );
  }
  if (meta.insertions != null) {
    diffParts.push(
      <Text key="add" style={[styles.mono, { color: colors.emerald400 }]}>
        +{meta.insertions}
      </Text>,
    );
  }
  if (meta.deletions != null) {
    diffParts.push(
      <Text key="del" style={[styles.mono, { color: colors.rose400 }]}>
        -{meta.deletions}
      </Text>,
    );
  }
  return (
    <Card tone="slate" testID="finalize-run-summary-block" createdAt={message.created_at}>
      <HeaderRow
        title="Finalize summary"
        titleColor={colors.gray200}
        right={
          meta.finalVerdict ? (
            <VerdictPill verdict={meta.finalVerdict} approvedLabel="Review approved" />
          ) : null
        }
      />
      {meta.summary ? (
        <Text style={[styles.body, styles.spaced]} selectable testID="finalize-summary-prose">
          {meta.summary}
        </Text>
      ) : null}

      <Section
        icon="checkmark-circle"
        title="Follow-ups"
        count={followUps.length || null}
        highlighted={followUps.length > 0}
        testID="finalize-summary-follow-ups"
      >
        {followUps.length ? (
          followUps.map((step: string, i: number) => (
            <View key={`${i}-${step}`} style={styles.listRow}>
              <Text style={[styles.bullet, { color: colors.amber400 }]}>{i + 1}.</Text>
              <Text style={styles.body} selectable>
                {step}
              </Text>
            </View>
          ))
        ) : (
          <Text style={styles.muted}>{followUpsEmptyStateMessage(meta.summarySource)}</Text>
        )}
      </Section>

      <Section
        icon="git-commit-outline"
        title="What changed"
        count={meta.commits.length ? plural(meta.commits.length, 'commit') : null}
        testID="finalize-summary-changes"
      >
        {diffParts.length ? <View style={styles.diffRow}>{diffParts}</View> : null}
        {meta.commits.length ? (
          <>
            {meta.commits.map((subject: string, i: number) => (
              <View key={`${i}-${subject}`} style={styles.listRow}>
                <Text style={styles.bullet}>·</Text>
                <Text style={styles.body}>{subject}</Text>
              </View>
            ))}
            {meta.truncatedCommits > 0 ? (
              <Text style={styles.muted}>…and {plural(meta.truncatedCommits, 'more commit')}</Text>
            ) : null}
          </>
        ) : (
          <Text style={styles.muted}>{NO_COMMITS_MESSAGE}</Text>
        )}
      </Section>

      <Section
        icon="chatbubble-outline"
        title="What the reviewer pointed out"
        count={meta.reviewRounds.length ? plural(meta.totalFindings, 'finding') : null}
        testID="finalize-summary-review"
      >
        {meta.reviewNotes ? (
          <Text style={[styles.body, styles.spaced]} selectable>
            {meta.reviewNotes}
          </Text>
        ) : null}
        {meta.reviewRounds.length === 0 ? (
          <Text style={styles.muted}>No review rounds recorded for this run.</Text>
        ) : roundsWithFindings.length === 0 ? (
          <Text style={styles.muted}>
            The reviewer raised nothing across {plural(meta.reviewRounds.length, 'round')}.
          </Text>
        ) : (
          roundsWithFindings.map((round: any) => (
            <View
              key={round.round}
              style={styles.roundGroup}
              testID="finalize-summary-review-round"
            >
              <Text style={styles.roundLabel}>
                Round {round.round} ·{' '}
                {round.verdict === 'approved' ? 'approved' : 'changes requested'}
              </Text>
              {round.findings.map((finding: any, i: number) => (
                <View
                  key={`${finding.filePath}-${i}`}
                  style={styles.finding}
                  testID="finalize-summary-finding"
                >
                  <Text style={styles.anchor}>
                    {finding.filePath} {formatAnchor(finding.lineStart, finding.lineEnd)}
                  </Text>
                  <Text style={styles.body} selectable>
                    {finding.body}
                  </Text>
                </View>
              ))}
              {round.truncatedFindings > 0 ? (
                <Text style={styles.muted}>
                  …and {plural(round.truncatedFindings, 'more finding')}
                </Text>
              ) : null}
            </View>
          ))
        )}
      </Section>

      <Section
        icon="flask-outline"
        title="Manual testing to perform"
        count={meta.manualTesting.length || null}
        testID="finalize-summary-manual-testing"
      >
        <ManualTestingList steps={meta.manualTesting} testID="finalize-summary-manual-step" />
      </Section>
    </Card>
  );
}

export function TurnChangeSummaryBlock({ message }: any) {
  const meta = useMemo(() => parseTurnChangeSummaryMetadata(message.metadata), [message.metadata]);
  if (!meta) return null;
  return (
    <Card tone="slate" testID="turn-change-summary-block" createdAt={message.created_at}>
      <HeaderRow title="Change summary" titleColor={colors.gray200} />
      {meta.summary ? (
        <Text style={[styles.body, styles.spaced]} selectable testID="turn-change-summary-prose">
          {meta.summary}
        </Text>
      ) : null}
      <Section
        icon="flask-outline"
        title="Manual testing to perform"
        count={meta.manualTesting.length || null}
        testID="turn-change-summary-manual-testing"
      >
        <ManualTestingList steps={meta.manualTesting} testID="turn-change-summary-manual-step" />
      </Section>
    </Card>
  );
}

export function SystemPrFailedMessage({ message }: any) {
  const meta = parsePrFailedMetadata(message.metadata);
  if (!meta) return null;
  return (
    <Card tone="red" testID="system-pr-failed-block" createdAt={message.created_at}>
      <HeaderRow
        icon="alert-circle"
        iconColor={colors.red400}
        title={describePrFailureCode(meta.code)}
        titleColor={TONES.red.text}
        right={<Text style={[styles.mono, { color: TONES.red.text }]}>{meta.code}</Text>}
      />
      <Text style={[styles.body, { color: 'rgba(254, 226, 226, 0.8)' }]} selectable>
        {meta.error}
      </Text>
      {meta.branch ? (
        <Text style={styles.sub}>
          Branch: <Text style={styles.mono}>{meta.branch}</Text>
        </Text>
      ) : null}
      {meta.cardTitle ? <Text style={styles.sub}>Card: {meta.cardTitle}</Text> : null}
      <Text style={styles.subRed}>
        Your work is still on the local branch. Fetch and rebase onto the remote branch, then push
        again or create the PR.
      </Text>
    </Card>
  );
}

/**
 * Pick the card for a system message. Returns `undefined` when the message is
 * not a Finalize / change-summary / PR-failed event so the caller can fall back
 * to its own system renderers; `null` means "render nothing" (step output is
 * streamed into the checks card, never shown as its own row).
 */
export function renderTimelineSystemMessage(
  message: any,
  { hosted = false, onOpenPrDetail }: { hosted?: boolean; onOpenPrDetail?: any } = {},
): React.ReactElement | null | undefined {
  if (isFinalizeStepOutputMessage(message.metadata)) return null;
  if (parseTurnChangeSummaryMetadata(message.metadata)) {
    return <TurnChangeSummaryBlock message={message} />;
  }
  switch (parseFinalizeTimelineKind(message.metadata)) {
    case 'finalize_run_started':
      return <FinalizeRunStartedBlock message={message} />;
    case 'finalize_rebase_result':
      return <FinalizeRebaseBlock message={message} />;
    case 'finalize_review_round':
      return <FinalizeReviewRoundBlock message={message} />;
    case 'finalize_ci_absent':
      return <FinalizeCiAbsentBlock message={message} />;
    case 'finalize_checks_round':
      return <FinalizeChecksRoundBlock message={message} />;
    case 'finalize_ready_to_push':
      return <FinalizeReadyToPushBlock message={message} hosted={hosted} />;
    case 'finalize_run_summary':
      return <FinalizeRunSummaryBlock message={message} />;
    case 'finalize_run_terminal':
      return (
        <FinalizeTerminalBlock message={message} hosted={hosted} onOpenPrDetail={onOpenPrDetail} />
      );
    case 'finalize_fix_dispatch':
      return <FinalizeFixDispatchBlock message={message} />;
    case 'finalize_review_stalled':
    case 'finalize_review_not_converging':
      return <FinalizeReviewNoticeBlock message={message} />;
    default:
      break;
  }
  if (parsePrFailedMetadata(message.metadata)) return <SystemPrFailedMessage message={message} />;
  return undefined;
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', marginBottom: 12, paddingHorizontal: 12 },
  card: {
    width: '95%',
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  checksWrap: { width: '95%' },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  headerRight: { marginLeft: 'auto' },
  title: { fontSize: 13, fontWeight: '600', flexShrink: 1 },
  sub: { fontSize: 12, color: colors.gray400, marginTop: 2 },
  subRed: { fontSize: 12, color: 'rgba(254, 202, 202, 0.8)', marginTop: 4 },
  subAmber: { fontSize: 12, color: 'rgba(253, 230, 138, 0.8)', marginTop: 4 },
  muted: { fontSize: 12, color: colors.gray500, marginBottom: 4 },
  body: { fontSize: 12, color: colors.gray300, lineHeight: 17, flexShrink: 1 },
  spaced: { marginTop: 4, marginBottom: 8 },
  mono: { fontFamily: MONO, fontSize: 11 },
  sha: { fontFamily: MONO, fontSize: 11, color: colors.gray400 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  pillApproved: { backgroundColor: 'rgba(6, 78, 59, 0.4)' },
  pillChanges: { backgroundColor: 'rgba(120, 53, 15, 0.4)' },
  pillText: { fontSize: 10, fontWeight: '600' },
  section: {
    borderWidth: 1,
    borderColor: colors.gray700,
    borderRadius: 6,
    backgroundColor: 'rgba(30, 41, 59, 0.4)',
    marginTop: 8,
    overflow: 'hidden',
  },
  sectionHighlighted: {
    borderColor: 'rgba(180, 83, 9, 0.7)',
    backgroundColor: 'rgba(69, 26, 3, 0.2)',
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sectionTitle: { fontSize: 12, fontWeight: '500', color: colors.gray200, flexShrink: 1 },
  sectionCount: { marginLeft: 'auto', fontSize: 10, color: colors.gray500 },
  sectionBody: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  thread: {
    borderTopWidth: 1,
    borderTopColor: colors.gray700,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  anchor: { fontFamily: MONO, fontSize: 10, color: colors.gray500, marginBottom: 2 },
  listRow: { flexDirection: 'row', gap: 6, marginBottom: 4 },
  bullet: { fontSize: 12, color: colors.gray500, lineHeight: 17 },
  diffRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  roundGroup: { marginBottom: 8 },
  roundLabel: { fontSize: 11, fontWeight: '500', color: colors.gray400, marginBottom: 4 },
  finding: {
    backgroundColor: 'rgba(2, 6, 23, 0.4)',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 4,
  },
  prRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  prLink: { fontSize: 13, fontWeight: '600', textDecorationLine: 'underline' },
  timestamp: { fontSize: 10, color: colors.gray600, marginTop: 6 },
});
