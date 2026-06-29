import type {
  AppConfig,
  DeploymentReleaseItemDetailRow,
  DeploymentRow,
  SupportTicketReleaseState,
} from './types.js';
import {
  buildFactBoundedReleaseDigestPrompt,
  getReleaseNotificationSettings,
} from './release-notification-settings.js';
import { deriveSupportTicketReleaseState } from './support-tickets-store.js';
import { getDeployment, listDeploymentReleaseItemsWithContext } from './deploy/deployment-store.js';
import { runModelOnlyReleaseDigest } from './release-digest-model.js';
import { clipUtf8StringToMaxBytes } from './utf8-clip.js';

export const RELEASE_DIGEST_ITEM_LIMIT = 100;
export const RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES = 1_500;
export const RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES = 300;
export const RELEASE_DIGEST_LABEL_LIMIT = 20;
export const RELEASE_DIGEST_LABEL_MAX_BYTES = 80;

const TRUNCATED_SUFFIX = '...[truncated]';
const REDACTED_EMAIL = '[redacted email]';
const REDACTED_SECRET = '[redacted secret]';
const AUTHORIZATION_BEARER_RE = /\bauthorization\b\s*[:=]\s*bearer\s+[^\s,;]+/gi;
const SENSITIVE_KEY_VALUE_RE =
  /\b(api[_-]?key|authorization|bearer|client[_-]?secret|password|secret|token)\b\s*[:=]\s*([^\s,;]+)/gi;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export const EMPTY_RELEASE_DIGEST_MARKDOWN = [
  '## Release digest',
  '',
  'No customer-facing release items were included in this production deployment.',
].join('\n');

export interface ReleaseDigestFact {
  card: {
    id: string;
    shortId: number | null;
    title: string;
    description: string | null;
    labels: string[];
    priority: string | null;
    status: string | null;
  };
  supportTicket: {
    id: string;
    subject: string | null;
    summary: string | null;
    status: string | null;
    type: string | null;
    releaseState: SupportTicketReleaseState | null;
  } | null;
}

export interface ReleaseDigestGroup {
  key: 'support-ticket-resolutions' | 'product-changes' | 'other-customer-visible-changes';
  label: string;
  itemIndexes: number[];
}

export interface ReleaseDigestGenerationPrompt {
  prompt: string;
  facts: {
    deployment: {
      id: string;
      projectId: string;
      environment: string;
      ref: string;
      status: string;
      completedAt: string | null;
    };
    releaseItems: ReleaseDigestFact[];
    groups: ReleaseDigestGroup[];
    factLimits: {
      maxReleaseItems: number;
      originalIncludedReleaseItemCount: number;
      excludedReleaseItemCount: number;
      omittedReleaseItemCount: number;
      maxTextFieldBytes: number;
      maxShortFieldBytes: number;
      maxLabels: number;
      maxLabelBytes: number;
    };
  };
  settings: {
    isDefault: boolean;
    updatedAt: string | null;
  };
}

export type ReleaseDigestRunner = (input: {
  prompt: string;
  cfg: AppConfig;
  userId?: string | null;
  fetchImpl?: typeof fetch;
}) => Promise<string>;

const defaultRunner: ReleaseDigestRunner = ({ prompt, cfg, fetchImpl }) =>
  runModelOnlyReleaseDigest({ prompt, cfg, fetchImpl });

function parseCardLabels(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
}

function redactSensitiveText(value: string): string {
  return value
    .replace(AUTHORIZATION_BEARER_RE, 'authorization=[redacted secret]')
    .replace(SENSITIVE_KEY_VALUE_RE, (_match, key: string) => `${key}=${REDACTED_SECRET}`)
    .replace(EMAIL_RE, REDACTED_EMAIL);
}

function clipFactString(raw: string | null, maxBytes: number): string | null {
  const value = raw ? redactSensitiveText(raw).trim() : null;
  if (!value) return null;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const budget = Math.max(0, maxBytes - TRUNCATED_SUFFIX.length);
  return `${clipUtf8StringToMaxBytes(value, budget)}${TRUNCATED_SUFFIX}`;
}

function clipRequiredFactString(raw: string, maxBytes: number): string {
  return clipFactString(raw, maxBytes) ?? '';
}

function itemFact(row: DeploymentReleaseItemDetailRow): ReleaseDigestFact {
  return {
    card: {
      id: row.card_id,
      shortId: row.card_short_id,
      title: clipRequiredFactString(row.card_title, RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES),
      description: clipFactString(row.card_description, RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES),
      labels: parseCardLabels(row.card_labels)
        .slice(0, RELEASE_DIGEST_LABEL_LIMIT)
        .map((label) => clipRequiredFactString(label, RELEASE_DIGEST_LABEL_MAX_BYTES)),
      priority: row.card_priority,
      status: clipFactString(row.card_column_name, RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES),
    },
    supportTicket:
      row.support_ticket_id === null
        ? null
        : {
            id: row.support_ticket_id,
            subject: clipFactString(
              row.support_ticket_subject,
              RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES,
            ),
            summary: clipFactString(
              row.support_ticket_summary,
              RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES,
            ),
            status: clipFactString(row.support_ticket_status, RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES),
            type: clipFactString(row.support_ticket_type, RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES),
            releaseState: deriveSupportTicketReleaseState({
              fixed_at: row.support_ticket_fixed_at,
              released_to_prod_at: row.support_ticket_released_to_prod_at,
              customer_notified_at: row.support_ticket_customer_notified_at,
            }),
          },
  };
}

function classifyFact(fact: ReleaseDigestFact): ReleaseDigestGroup['key'] {
  if (fact.supportTicket) return 'support-ticket-resolutions';
  const labels = new Set(fact.card.labels.map((label) => label.toLowerCase()));
  if (
    labels.has('feature') ||
    labels.has('features') ||
    labels.has('product') ||
    labels.has('customer-facing') ||
    labels.has('improvement')
  ) {
    return 'product-changes';
  }
  return 'other-customer-visible-changes';
}

function buildFactGroups(facts: ReleaseDigestFact[]): ReleaseDigestGroup[] {
  const labels = {
    'support-ticket-resolutions': 'Support-ticket resolutions',
    'product-changes': 'Product changes',
    'other-customer-visible-changes': 'Other customer-visible changes',
  } satisfies Record<ReleaseDigestGroup['key'], string>;
  const groups = new Map<ReleaseDigestGroup['key'], number[]>();
  facts.forEach((fact, index) => {
    const key = classifyFact(fact);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return (Object.keys(labels) as ReleaseDigestGroup['key'][])
    .map((key) => ({ key, label: labels[key], itemIndexes: groups.get(key) ?? [] }))
    .filter((group) => group.itemIndexes.length > 0);
}

export function sanitizeReleaseDigestMarkdown(markdown: string): string {
  return redactSensitiveText(markdown).trim();
}

export function buildDeploymentReleaseDigestGenerationPrompt(args: {
  projectId: string;
  deployment: DeploymentRow;
  releaseItems: DeploymentReleaseItemDetailRow[];
}): ReleaseDigestGenerationPrompt {
  const settings = getReleaseNotificationSettings(args.projectId);
  const includedItems = args.releaseItems.filter((item) => item.inclusion_status === 'included');
  const excludedItems = args.releaseItems.filter((item) => item.inclusion_status === 'excluded');
  const boundedItems = includedItems.slice(0, RELEASE_DIGEST_ITEM_LIMIT);
  const releaseItemFacts = boundedItems.map(itemFact);
  const facts = {
    deployment: {
      id: args.deployment.id,
      projectId: args.deployment.project_id,
      environment: clipRequiredFactString(
        args.deployment.environment,
        RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES,
      ),
      ref: clipRequiredFactString(args.deployment.ref, RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES),
      status: args.deployment.status,
      completedAt: args.deployment.completed_at,
    },
    releaseItems: releaseItemFacts,
    groups: buildFactGroups(releaseItemFacts),
    factLimits: {
      maxReleaseItems: RELEASE_DIGEST_ITEM_LIMIT,
      originalIncludedReleaseItemCount: includedItems.length,
      excludedReleaseItemCount: excludedItems.length,
      omittedReleaseItemCount: Math.max(0, includedItems.length - boundedItems.length),
      maxTextFieldBytes: RELEASE_DIGEST_TEXT_FIELD_MAX_BYTES,
      maxShortFieldBytes: RELEASE_DIGEST_SHORT_FIELD_MAX_BYTES,
      maxLabels: RELEASE_DIGEST_LABEL_LIMIT,
      maxLabelBytes: RELEASE_DIGEST_LABEL_MAX_BYTES,
    },
  };

  const prompt = [
    buildFactBoundedReleaseDigestPrompt(settings.releaseDigestPrompt),
    '',
    'Generate the release digest from this JSON facts object only:',
    JSON.stringify(facts, null, 2),
    '',
    'Return a customer-facing markdown email body. Do not include a code fence.',
  ].join('\n');

  return {
    prompt,
    facts,
    settings: {
      isDefault: settings.isDefault,
      updatedAt: settings.updatedAt,
    },
  };
}

export async function generateDeploymentReleaseDigest(args: {
  projectId: string;
  deploymentId: string;
  cfg: AppConfig;
  userId?: string | null;
  runner?: ReleaseDigestRunner;
  fetchImpl?: typeof fetch;
}): Promise<ReleaseDigestGenerationPrompt & { digestMarkdown: string }> {
  const deployment = getDeployment(args.deploymentId);
  if (!deployment || deployment.project_id !== args.projectId) {
    throw new Error('Deployment not found');
  }
  const generation = buildDeploymentReleaseDigestGenerationPrompt({
    projectId: args.projectId,
    deployment,
    releaseItems: listDeploymentReleaseItemsWithContext(deployment.id),
  });
  if (generation.facts.releaseItems.length === 0) {
    return { ...generation, digestMarkdown: EMPTY_RELEASE_DIGEST_MARKDOWN };
  }
  const runner = args.runner ?? defaultRunner;
  const digestMarkdown = sanitizeReleaseDigestMarkdown(
    await runner({
      prompt: generation.prompt,
      cfg: args.cfg,
      userId: args.userId ?? null,
      fetchImpl: args.fetchImpl,
    }),
  );
  if (!digestMarkdown) {
    throw new Error('Release digest generation returned an empty response after redaction.');
  }
  return { ...generation, digestMarkdown };
}
