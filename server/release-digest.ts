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
    factLimits: {
      maxReleaseItems: number;
      originalIncludedReleaseItemCount: number;
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

function clipFactString(raw: string | null, maxBytes: number): string | null {
  const value = raw?.trim();
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

export function buildDeploymentReleaseDigestGenerationPrompt(args: {
  projectId: string;
  deployment: DeploymentRow;
  releaseItems: DeploymentReleaseItemDetailRow[];
}): ReleaseDigestGenerationPrompt {
  const settings = getReleaseNotificationSettings(args.projectId);
  const includedItems = args.releaseItems.filter((item) => item.inclusion_status === 'included');
  const boundedItems = includedItems.slice(0, RELEASE_DIGEST_ITEM_LIMIT);
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
    releaseItems: boundedItems.map(itemFact),
    factLimits: {
      maxReleaseItems: RELEASE_DIGEST_ITEM_LIMIT,
      originalIncludedReleaseItemCount: includedItems.length,
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
  const runner = args.runner ?? defaultRunner;
  const digestMarkdown = (
    await runner({
      prompt: generation.prompt,
      cfg: args.cfg,
      userId: args.userId ?? null,
      fetchImpl: args.fetchImpl,
    })
  ).trim();
  return { ...generation, digestMarkdown };
}
