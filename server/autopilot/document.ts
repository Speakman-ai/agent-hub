/**
 * Autopilot cycle documentation: structured records, a readable project
 * journal, wiki/runbook pages, redacted evidence artifacts, and the
 * structured handoff that reconstructs the next session from saved records.
 *
 * Documentation is a Hub-owned stage. It retries without merge or deploy.
 * Journal and wiki writes are idempotent: pages are rebuilt from persisted
 * cycle records, so a retry cannot duplicate entries. Successful behavior,
 * proposals, and failures are labeled as distinct kinds.
 */

import { createHash } from 'crypto';
import { REDACTION_PLACEHOLDER, buildRedactionConfig, redactText } from '../logs/log-redaction.js';
import type { AutopilotCycleRecord, AutopilotUsage } from './types.js';
import { parseCycleVerification } from './evaluate.js';

export const AUTOPILOT_CYCLE_RECORD_VERSION = 1 as const;

export const AUTOPILOT_JOURNAL_SLUG = 'autopilot-journal';
export const AUTOPILOT_JOURNAL_TITLE = 'Autopilot journal';
export const AUTOPILOT_RUNBOOK_SLUG = 'autopilot-runbook';
export const AUTOPILOT_RUNBOOK_TITLE = 'Autopilot runbook';

/** Distinguishes shipped behavior from proposals and failed attempts. */
export type AutopilotRecordKind = 'success' | 'proposal' | 'failure';

export interface AutopilotCycleLinks {
  cardId: string | null;
  sessionId: string | null;
  testedCommitSha: string | null;
  finalizeRunId: string | null;
  deploymentId: string | null;
  deploymentOrigin: string | null;
}

export interface AutopilotCycleEvidenceRef {
  kind: 'screenshot' | 'trace' | 'api' | 'report';
  path?: string | null;
  artifactId?: string | null;
  criterionId?: string | null;
  /** Stable per-cycle identity used to reuse uploads on documentation retry. */
  key?: string | null;
}

export interface AutopilotFailedAttempt {
  operationId: string;
  reason: string;
  detail?: string;
}

export interface AutopilotStructuredCycleRecord {
  version: typeof AUTOPILOT_CYCLE_RECORD_VERSION;
  kind: AutopilotRecordKind;
  runId: string;
  cycleId: string;
  cycleNumber: number;
  briefRevision: number;
  specRevision: number | null;
  expectedBenefit: string;
  actualChange: string;
  decisions: { key: string; decision: string }[];
  links: AutopilotCycleLinks;
  evidence: AutopilotCycleEvidenceRef[];
  usage: AutopilotUsage;
  outcome: string;
  nextAction: string;
  journalSlug: string;
  wikiSlugs: string[];
  artifactIds: string[];
  /** Maps a stable artifact key to the published id so retries skip completed uploads. */
  publishedByKey: Record<string, string>;
  redactions: number;
  documentedAt: string;
  failedAttempts: AutopilotFailedAttempt[];
}

export interface AutopilotDocumentSpec {
  acceptanceJourneys: { action: string; expectedResult: string }[];
  nonGoals: string[];
  specDecisions: { key: string; decision: string }[];
  storageRecovery?: string | null;
}

export interface AutopilotSessionHandoff {
  briefRevision: number;
  specRevision: number | null;
  lastVerifiedSha: string | null;
  lastDeploymentId: string | null;
  lastSuccessfulCycle: AutopilotStructuredCycleRecord | null;
  records: AutopilotStructuredCycleRecord[];
  acceptanceJourneys: AutopilotDocumentSpec['acceptanceJourneys'];
  nonGoals: string[];
  specDecisions: AutopilotDocumentSpec['specDecisions'];
  storageRecovery: string | null;
}

export interface AutopilotJournalPage {
  slug: string;
  title: string;
  content: string;
  category: 'general' | 'architecture';
}

export interface AutopilotEvidenceArtifact {
  /** Stable identity within a cycle (`record.json`, `screenshot:baseline-1`, …). */
  key: string;
  filename: string;
  contentType: string;
  body: Buffer | string;
}

export interface AutopilotDocumentPort {
  /**
   * Idempotent wiki/journal write. Callers rebuild full page bodies from
   * saved cycle records so a retry overwrites the same slugs in place.
   */
  writePages(input: {
    projectId: string;
    runId: string;
    cycleId: string;
    pages: AutopilotJournalPage[];
  }): Promise<void>;
  /**
   * Publish one redacted evidence blob. `key` is a stable cycle-scoped
   * identity: retries with the same cycleId+key must reuse the same artifact
   * id instead of minting another random one.
   */
  publishArtifact(input: {
    sessionId: string;
    cycleId: string;
    key: string;
    filename: string;
    contentType: string;
    body: Buffer | string;
  }): Promise<{ artifactId: string }>;
}

/** Keys whose entire value is dropped. Intentionally excludes sessionId. */
const SECRET_KEY =
  /^(authorization|cookie|pass(word|wd|phrase)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|credential|connection[-_]?string|dsn)$/i;

const DEFAULT_REDACTION = buildRedactionConfig();

export function kindLabel(kind: AutopilotRecordKind): string {
  if (kind === 'success') return 'successful behavior';
  if (kind === 'proposal') return 'proposal';
  return 'failure';
}

export function parseCycleDocumentation(raw: unknown): AutopilotStructuredCycleRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== AUTOPILOT_CYCLE_RECORD_VERSION) return null;
  if (obj.kind !== 'success' && obj.kind !== 'proposal' && obj.kind !== 'failure') return null;
  if (typeof obj.runId !== 'string' || typeof obj.cycleId !== 'string') return null;
  if (typeof obj.cycleNumber !== 'number' || typeof obj.briefRevision !== 'number') return null;
  if (typeof obj.expectedBenefit !== 'string' || typeof obj.actualChange !== 'string') return null;
  if (typeof obj.outcome !== 'string' || typeof obj.nextAction !== 'string') return null;
  if (typeof obj.documentedAt !== 'string') return null;
  const linksRaw =
    obj.links && typeof obj.links === 'object' ? (obj.links as Record<string, unknown>) : {};
  const usageRaw =
    obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : {};
  const decisions = Array.isArray(obj.decisions)
    ? obj.decisions
        .map((row) => {
          const d = (row ?? {}) as Record<string, unknown>;
          return typeof d.key === 'string' && typeof d.decision === 'string'
            ? { key: d.key, decision: d.decision }
            : null;
        })
        .filter((d): d is { key: string; decision: string } => !!d)
    : [];
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence
        .map((row) => parseEvidenceRef(row))
        .filter((e): e is AutopilotCycleEvidenceRef => !!e)
    : [];
  const failedAttempts = Array.isArray(obj.failedAttempts)
    ? obj.failedAttempts
        .map((row): AutopilotFailedAttempt | null => {
          const a = (row ?? {}) as Record<string, unknown>;
          if (typeof a.operationId !== 'string' || typeof a.reason !== 'string') return null;
          const attempt: AutopilotFailedAttempt = {
            operationId: a.operationId,
            reason: a.reason,
          };
          if (typeof a.detail === 'string') attempt.detail = a.detail;
          return attempt;
        })
        .filter((a): a is AutopilotFailedAttempt => a !== null)
    : [];
  return {
    version: AUTOPILOT_CYCLE_RECORD_VERSION,
    kind: obj.kind,
    runId: obj.runId,
    cycleId: obj.cycleId,
    cycleNumber: obj.cycleNumber,
    briefRevision: obj.briefRevision,
    specRevision: typeof obj.specRevision === 'number' ? obj.specRevision : null,
    expectedBenefit: obj.expectedBenefit,
    actualChange: obj.actualChange,
    decisions,
    links: {
      cardId: stringOrNull(linksRaw.cardId),
      sessionId: stringOrNull(linksRaw.sessionId),
      testedCommitSha: stringOrNull(linksRaw.testedCommitSha),
      finalizeRunId: stringOrNull(linksRaw.finalizeRunId),
      deploymentId: stringOrNull(linksRaw.deploymentId),
      deploymentOrigin: stringOrNull(linksRaw.deploymentOrigin),
    },
    evidence,
    usage: {
      wallTimeMs: typeof usageRaw.wallTimeMs === 'number' ? usageRaw.wallTimeMs : 0,
      costUsd: typeof usageRaw.costUsd === 'number' ? usageRaw.costUsd : null,
      costAvailable: usageRaw.costAvailable === true,
    },
    outcome: obj.outcome,
    nextAction: obj.nextAction,
    journalSlug: typeof obj.journalSlug === 'string' ? obj.journalSlug : AUTOPILOT_JOURNAL_SLUG,
    wikiSlugs: Array.isArray(obj.wikiSlugs)
      ? obj.wikiSlugs.filter((s): s is string => typeof s === 'string')
      : [AUTOPILOT_JOURNAL_SLUG, AUTOPILOT_RUNBOOK_SLUG],
    artifactIds: Array.isArray(obj.artifactIds)
      ? obj.artifactIds.filter((s): s is string => typeof s === 'string')
      : [],
    publishedByKey: parsePublishedByKey(obj.publishedByKey),
    redactions: typeof obj.redactions === 'number' ? obj.redactions : 0,
    documentedAt: obj.documentedAt,
    failedAttempts,
  };
}

function parseEvidenceRef(row: unknown): AutopilotCycleEvidenceRef | null {
  if (!row || typeof row !== 'object') return null;
  const e = row as Record<string, unknown>;
  if (e.kind !== 'screenshot' && e.kind !== 'trace' && e.kind !== 'api' && e.kind !== 'report') {
    return null;
  }
  return {
    kind: e.kind,
    path: typeof e.path === 'string' ? e.path : null,
    artifactId: typeof e.artifactId === 'string' ? e.artifactId : null,
    criterionId: typeof e.criterionId === 'string' ? e.criterionId : null,
    key: typeof e.key === 'string' && e.key.trim() ? e.key : null,
  };
}

function parsePublishedByKey(raw: unknown): Record<string, string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) out[key] = value;
    }
    if (Object.keys(out).length > 0) return out;
  }
  return {};
}

/**
 * Deterministic artifact id for a cycle-scoped evidence key. Documentation
 * retries reuse this id instead of inserting another random blob.
 */
export function stableAutopilotArtifactId(cycleId: string, key: string): string {
  const digest = createHash('sha256').update(`autopilot-artifact:${cycleId}:${key}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(
    20,
    32,
  )}`;
}

/** Cache and retry identity: the same key on two cycles must not collide. */
export function autopilotPublicationIdentity(cycleId: string, key: string): string {
  return `${cycleId}::${key}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export interface BuildCycleRecordInput {
  runId: string;
  cycle: AutopilotCycleRecord;
  spec: AutopilotDocumentSpec | null;
  usage: AutopilotUsage;
  origin: string | null;
  failedAttempts: AutopilotFailedAttempt[];
  documentedAt: string;
}

export function classifyCycleKind(cycle: AutopilotCycleRecord): AutopilotRecordKind {
  const judgement = parseCycleVerification(cycle.verification).judgement;
  if (judgement?.ok) return 'success';
  if (cycle.status === 'failed' || cycle.status === 'cancelled') return 'failure';
  if (judgement && judgement.ok === false && judgement.recover) return 'failure';
  if (cycle.selectedImprovement) return 'proposal';
  return 'failure';
}

export function describeDeliveredDelta(
  cycle: AutopilotCycleRecord,
  spec: AutopilotDocumentSpec | null,
): string {
  const selected = cycle.selectedImprovement?.trim();
  if (selected) return selected;
  const journeys = spec?.acceptanceJourneys ?? [];
  if (journeys.length === 0) return '';
  const summary = journeys
    .map((j) => `when a user ${j.action}, then ${j.expectedResult}`)
    .join('; ');
  return cycle.cycleNumber === 1 ? `Baseline: ${summary}.` : `${summary}.`;
}

/**
 * Concrete delivered-behavior summary. Merge and verification claims come from
 * recorded SHA / judgement, never inferred from SHA presence alone.
 */
export function describeActualChange(input: {
  cycle: AutopilotCycleRecord;
  spec: AutopilotDocumentSpec | null;
  origin: string | null;
}): string {
  const { cycle, spec, origin } = input;
  const verification = parseCycleVerification(cycle.verification);
  const sha = cycle.testedCommitSha?.trim() || null;
  const delivered = describeDeliveredDelta(cycle, spec);
  const parts: string[] = [];
  if (delivered) parts.push(delivered);
  if (sha) {
    parts.push(`Merged ${sha}${cycle.cardId ? ` on card ${cycle.cardId}` : ''}.`);
  } else if (!delivered) {
    parts.push(cycle.outcome?.trim() || 'No merged SHA was recorded.');
  } else {
    parts.push('No merged SHA was recorded.');
  }
  if (verification.judgement?.ok === true) {
    parts.push(`Verified at ${origin ?? 'the experiment target'}.`);
  } else if (verification.judgement && verification.judgement.ok === false) {
    parts.push(`Not verified (${verification.judgement.reason}).`);
  }
  return parts.join(' ');
}

export function buildStructuredCycleRecord(
  input: BuildCycleRecordInput,
): AutopilotStructuredCycleRecord {
  const { cycle, spec, usage, origin, failedAttempts, documentedAt } = input;
  const kind = classifyCycleKind(cycle);
  const verification = parseCycleVerification(cycle.verification);
  const sha = cycle.testedCommitSha?.trim() || null;
  const expectedBenefit =
    cycle.selectedImprovement?.trim() ||
    (cycle.cycleNumber === 1
      ? 'Establish the locked baseline and verify it on the experiment target.'
      : 'Complete the selected cycle change.');
  const actualChange = describeActualChange({ cycle, spec, origin });
  const evidence = collectEvidenceRefs(verification);
  const outcome =
    verification.judgement?.ok === true
      ? 'verified'
      : verification.judgement && verification.judgement.ok === false
        ? verification.judgement.reason
        : (cycle.outcome ?? kind);
  return {
    version: AUTOPILOT_CYCLE_RECORD_VERSION,
    kind,
    runId: input.runId,
    cycleId: cycle.id,
    cycleNumber: cycle.cycleNumber,
    briefRevision: cycle.briefRevision,
    specRevision: cycle.specRevision,
    expectedBenefit,
    actualChange,
    decisions: spec?.specDecisions ?? [],
    links: {
      cardId: cycle.cardId,
      sessionId: cycle.sessionId,
      testedCommitSha: sha,
      finalizeRunId: cycle.finalizeRunId,
      deploymentId: cycle.deploymentId,
      deploymentOrigin: origin,
    },
    evidence,
    usage: {
      wallTimeMs: usage.wallTimeMs,
      costUsd: usage.costUsd,
      costAvailable: usage.costAvailable,
    },
    outcome,
    nextAction: kind === 'success' ? 'selecting-next' : 'pause-or-repair',
    journalSlug: AUTOPILOT_JOURNAL_SLUG,
    wikiSlugs: [AUTOPILOT_JOURNAL_SLUG, AUTOPILOT_RUNBOOK_SLUG],
    artifactIds: [],
    publishedByKey: {},
    redactions: 0,
    documentedAt,
    failedAttempts,
  };
}

function collectEvidenceRefs(
  verification: ReturnType<typeof parseCycleVerification>,
): AutopilotCycleEvidenceRef[] {
  const refs: AutopilotCycleEvidenceRef[] = [];
  const criteria = verification.evidence?.criteria ?? [];
  refs.push({ kind: 'report', path: null, criterionId: null, key: 'record.json' });
  for (const c of criteria) {
    if (c.screenshotPath) {
      refs.push({
        kind: 'screenshot',
        path: c.screenshotPath,
        criterionId: c.criterionId,
        key: `screenshot:${c.criterionId}`,
      });
    }
    if (c.tracePath) {
      refs.push({
        kind: 'trace',
        path: c.tracePath,
        criterionId: c.criterionId,
        key: `trace:${c.criterionId}`,
      });
    }
    if (c.apiCheck) {
      refs.push({ kind: 'api', criterionId: c.criterionId, key: `api:${c.criterionId}` });
    }
  }
  if (verification.hubEvidence || verification.evidence) {
    refs.push({ kind: 'report', path: null, criterionId: null, key: 'evaluation.json' });
  }
  return refs;
}

/**
 * Strip secrets from a structured Autopilot record before persistence.
 * Session ids and SHAs stay; credential-shaped keys and values do not.
 */
export function redactAutopilotValue(value: unknown): { value: unknown; redactions: number } {
  return redactValue(value, 0);
}

function redactValue(value: unknown, depth: number): { value: unknown; redactions: number } {
  if (depth > 32) return { value: REDACTION_PLACEHOLDER, redactions: 0 };
  if (typeof value === 'string') {
    return redactText(value, DEFAULT_REDACTION);
  }
  if (Array.isArray(value)) {
    let redactions = 0;
    const out = value.map((item) => {
      const r = redactValue(item, depth + 1);
      redactions += r.redactions;
      return r.value;
    });
    return { value: out, redactions };
  }
  if (value && typeof value === 'object') {
    let redactions = 0;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) {
        out[key] = REDACTION_PLACEHOLDER;
        redactions += 1;
        continue;
      }
      const r = redactValue(v, depth + 1);
      out[key] = r.value;
      redactions += r.redactions;
    }
    return { value: out, redactions };
  }
  return { value, redactions: 0 };
}

export function redactCycleRecord(
  record: AutopilotStructuredCycleRecord,
): AutopilotStructuredCycleRecord {
  const { value, redactions } = redactAutopilotValue(record);
  const parsed = parseCycleDocumentation(value);
  if (!parsed) {
    return { ...record, redactions: record.redactions + redactions };
  }
  return { ...parsed, redactions: parsed.redactions + redactions };
}

export function renderJournalMarkdown(records: AutopilotStructuredCycleRecord[]): string {
  const lines = [
    `# ${AUTOPILOT_JOURNAL_TITLE}`,
    '',
    'Rebuilt from saved cycle records. Successful behavior, proposals, and failures are labeled separately. A proposal or failed attempt is not current verified behavior.',
    '',
  ];
  if (records.length === 0) {
    lines.push('_No Autopilot cycles have been documented yet._');
    return lines.join('\n');
  }
  for (const record of records) {
    lines.push(
      `## Run ${record.runId.slice(0, 8)} cycle ${record.cycleNumber} (${kindLabel(record.kind)})`,
    );
    lines.push('');
    lines.push(`- **Kind:** ${kindLabel(record.kind)}`);
    lines.push(`- **Outcome:** ${record.outcome}`);
    lines.push(`- **Expected benefit:** ${record.expectedBenefit}`);
    lines.push(`- **Actual change:** ${record.actualChange}`);
    lines.push(`- **Brief revision:** ${record.briefRevision}`);
    lines.push(`- **Spec revision:** ${record.specRevision ?? 'none'}`);
    lines.push(`- **SHA:** ${record.links.testedCommitSha ?? 'none'}`);
    lines.push(`- **Deployment:** ${record.links.deploymentId ?? 'none'}`);
    lines.push(`- **Origin:** ${record.links.deploymentOrigin ?? 'none'}`);
    lines.push(`- **Card:** ${record.links.cardId ?? 'none'}`);
    lines.push(`- **Session:** ${record.links.sessionId ?? 'none'}`);
    lines.push(`- **Finalize:** ${record.links.finalizeRunId ?? 'none'}`);
    lines.push(
      `- **Usage:** wall ${record.usage.wallTimeMs}ms, cost ${
        record.usage.costAvailable ? String(record.usage.costUsd) : 'unavailable'
      }`,
    );
    lines.push(`- **Next action:** ${record.nextAction}`);
    if (record.decisions.length > 0) {
      lines.push('- **Decisions:**');
      for (const d of record.decisions) {
        lines.push(`  - ${d.key}: ${d.decision}`);
      }
    }
    if (record.failedAttempts.length > 0) {
      lines.push('- **Failed attempts (not verified behavior):**');
      for (const attempt of record.failedAttempts) {
        lines.push(`  - ${attempt.reason}${attempt.detail ? `: ${attempt.detail}` : ''}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function recordMatchesLastKnownGood(
  record: AutopilotStructuredCycleRecord,
  lastVerifiedSha: string | null,
  lastDeploymentId: string | null,
): boolean {
  const sha = lastVerifiedSha?.trim() || null;
  const deploymentId = lastDeploymentId?.trim() || null;
  if (!sha || !deploymentId || record.kind !== 'success') return false;
  return record.links.testedCommitSha === sha && record.links.deploymentId === deploymentId;
}

export function currentVerifiedRecord(input: {
  lastVerifiedSha: string | null;
  lastDeploymentId: string | null;
  records: AutopilotStructuredCycleRecord[];
}): AutopilotStructuredCycleRecord | null {
  const matches = input.records.filter((record) =>
    recordMatchesLastKnownGood(record, input.lastVerifiedSha, input.lastDeploymentId),
  );
  return matches[matches.length - 1] ?? null;
}

export function renderRunbookMarkdown(input: {
  lastVerifiedSha: string | null;
  lastDeploymentId: string | null;
  origin: string | null;
  records: AutopilotStructuredCycleRecord[];
}): string {
  const current = currentVerifiedRecord(input);
  const earlierSuccesses = input.records.filter(
    (record) => record.kind === 'success' && record !== current,
  );
  const others = input.records.filter((r) => r.kind !== 'success');
  const lines = [
    `# ${AUTOPILOT_RUNBOOK_TITLE}`,
    '',
    'Current last-known-good is the recorded verified SHA and deployment. Successful cycles that do not match those pointers are history, not the running product.',
    '',
    `- **Last verified SHA:** ${input.lastVerifiedSha ?? 'none'}`,
    `- **Last verified deployment:** ${input.lastDeploymentId ?? 'none'}`,
    `- **Origin:** ${input.origin ?? 'none'}`,
    '',
  ];
  if (current) {
    lines.push('## Current verified behavior');
    lines.push('');
    lines.push(current.actualChange);
    lines.push('');
    if (current.decisions.length > 0) {
      lines.push('Locked decisions:');
      for (const d of current.decisions) {
        lines.push(`- ${d.key}: ${d.decision}`);
      }
      lines.push('');
    }
  } else {
    lines.push('_No verified cycle yet._');
    lines.push('');
  }
  if (earlierSuccesses.length > 0) {
    lines.push('## Earlier successes');
    lines.push('');
    for (const record of earlierSuccesses) {
      lines.push(
        `- Run ${record.runId.slice(0, 8)} cycle ${record.cycleNumber}: ${record.actualChange}`,
      );
    }
    lines.push('');
  }
  if (others.length > 0) {
    lines.push('## Proposals and failures');
    lines.push('');
    for (const record of others) {
      lines.push(
        `- Run ${record.runId.slice(0, 8)} cycle ${record.cycleNumber} (${kindLabel(record.kind)}): ${record.outcome}. ${record.actualChange}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function buildDocumentationPages(input: {
  lastVerifiedSha: string | null;
  lastDeploymentId: string | null;
  origin: string | null;
  records: AutopilotStructuredCycleRecord[];
}): AutopilotJournalPage[] {
  return [
    {
      slug: AUTOPILOT_JOURNAL_SLUG,
      title: AUTOPILOT_JOURNAL_TITLE,
      content: renderJournalMarkdown(input.records),
      category: 'general',
    },
    {
      slug: AUTOPILOT_RUNBOOK_SLUG,
      title: AUTOPILOT_RUNBOOK_TITLE,
      content: renderRunbookMarkdown(input),
      category: 'architecture',
    },
  ];
}

/**
 * Rebuild the next session's structured handoff from persisted cycle
 * documentation. Empty or malformed records are skipped so a crash mid-write
 * cannot poison reconstruction.
 */
export function reconstructHandoff(input: {
  cycles: AutopilotCycleRecord[];
  spec: AutopilotDocumentSpec | null;
  lastVerifiedSha: string | null;
  lastDeploymentId: string | null;
}): AutopilotSessionHandoff {
  const records = input.cycles
    .map((c) => parseCycleDocumentation(c.documentation))
    .filter((r): r is AutopilotStructuredCycleRecord => !!r);
  const lastSuccessfulCycle = currentVerifiedRecord({
    lastVerifiedSha: input.lastVerifiedSha,
    lastDeploymentId: input.lastDeploymentId,
    records,
  });
  const latest = records[records.length - 1] ?? null;
  return {
    briefRevision: lastSuccessfulCycle?.briefRevision ?? latest?.briefRevision ?? 0,
    specRevision: lastSuccessfulCycle?.specRevision ?? latest?.specRevision ?? null,
    lastVerifiedSha: input.lastVerifiedSha,
    lastDeploymentId: input.lastDeploymentId,
    lastSuccessfulCycle,
    records,
    acceptanceJourneys: input.spec?.acceptanceJourneys ?? [],
    nonGoals: input.spec?.nonGoals ?? [],
    specDecisions: input.spec?.specDecisions ?? lastSuccessfulCycle?.decisions ?? [],
    storageRecovery: input.spec?.storageRecovery ?? null,
  };
}

export function renderHandoffPrompt(handoff: AutopilotSessionHandoff): string {
  const lines = [
    'Reconstruct this session from saved Autopilot cycle records. Do not treat proposals or failures as current verified behavior.',
    '',
    `Last verified SHA: ${handoff.lastVerifiedSha ?? 'none'}`,
    `Last verified deployment: ${handoff.lastDeploymentId ?? 'none'}`,
    `Brief revision: ${handoff.briefRevision}`,
    `Spec revision: ${handoff.specRevision ?? 'none'}`,
    '',
  ];
  if (handoff.lastSuccessfulCycle) {
    lines.push('Last successful behavior:');
    lines.push(`- ${handoff.lastSuccessfulCycle.actualChange}`);
    lines.push(`- Expected benefit was: ${handoff.lastSuccessfulCycle.expectedBenefit}`);
    lines.push('');
  }
  if (handoff.records.length > 0) {
    lines.push('Prior cycle records:');
    for (const record of handoff.records) {
      lines.push(
        `- Run ${record.runId.slice(0, 8)} cycle ${record.cycleNumber} [${kindLabel(record.kind)}]: ${record.outcome}; ${record.actualChange}`,
      );
    }
    lines.push('');
  }
  if (handoff.acceptanceJourneys.length > 0) {
    lines.push('Acceptance journeys (must still hold):');
    for (const j of handoff.acceptanceJourneys) {
      lines.push(`- When a user ${j.action}, then ${j.expectedResult}.`);
    }
    lines.push('');
  }
  if (handoff.nonGoals.length > 0) {
    lines.push('Non-goals:');
    for (const n of handoff.nonGoals) lines.push(`- ${n}`);
    lines.push('');
  }
  if (handoff.specDecisions.length > 0) {
    lines.push('Locked spec decisions:');
    for (const d of handoff.specDecisions) lines.push(`- ${d.key}: ${d.decision}`);
    lines.push('');
  }
  if (handoff.storageRecovery) {
    lines.push(`Storage recovery contract: ${handoff.storageRecovery}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function createMemoryDocumentPort(opts?: {
  failPages?: () => boolean;
  failArtifact?: (input: { cycleId: string; key: string; attempt: number }) => boolean;
}): AutopilotDocumentPort & {
  pages: AutopilotJournalPage[];
  artifacts: AutopilotEvidenceArtifact[];
  pageWrites: number;
  artifactPublishes: number;
  publishCounts: Record<string, number>;
} {
  const pages: AutopilotJournalPage[] = [];
  const artifacts: AutopilotEvidenceArtifact[] = [];
  const publishedByIdentity: Record<string, string> = {};
  const port = {
    pages,
    artifacts,
    pageWrites: 0,
    artifactPublishes: 0,
    publishCounts: {} as Record<string, number>,
    writePages: async (input: {
      projectId: string;
      runId: string;
      cycleId: string;
      pages: AutopilotJournalPage[];
    }) => {
      if (opts?.failPages?.()) {
        throw new Error('journal write failed');
      }
      port.pageWrites += 1;
      pages.splice(0, pages.length, ...input.pages);
    },
    publishArtifact: async (input: {
      sessionId: string;
      cycleId: string;
      key: string;
      filename: string;
      contentType: string;
      body: Buffer | string;
    }) => {
      const identity = autopilotPublicationIdentity(input.cycleId, input.key);
      const attempt = (port.publishCounts[identity] ?? 0) + 1;
      port.publishCounts[identity] = attempt;
      if (opts?.failArtifact?.({ cycleId: input.cycleId, key: input.key, attempt })) {
        throw new Error(`artifact publish failed: ${input.key}`);
      }
      const existing = publishedByIdentity[identity];
      if (existing) return { artifactId: existing };
      const artifactId = stableAutopilotArtifactId(input.cycleId, input.key);
      publishedByIdentity[identity] = artifactId;
      port.artifactPublishes += 1;
      artifacts.push({
        key: input.key,
        filename: input.filename,
        contentType: input.contentType,
        body: input.body,
      });
      return { artifactId };
    },
  };
  return port;
}
