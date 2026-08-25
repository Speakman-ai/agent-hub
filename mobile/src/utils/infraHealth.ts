/**
 * AWS Health timeline helpers for the mobile Infrastructure screen.
 *
 * The peer of `client/src/components/infra/InfraHealthTimeline.tsx`. That file
 * inlines all of this as JSX ternaries and Tailwind class maps; here it has to
 * be values, because React Native styles are objects rather than class strings
 * and the mobile test environment is `node` with no renderer. Hoisting the
 * decisions out is the same move `infraResources.ts` already makes, and it is
 * what makes the parity claims below testable at all.
 *
 * What must not drift from web:
 *
 *   - **The two empty states.** "Ingest was never wired up" and "wired up and
 *     genuinely quiet" look identical if you render one blank slate, and they
 *     ask for opposite actions — go create a rule versus go enjoy the calm. The
 *     server distinguishes them with `ingestConfigured`; {@link healthEmptyState}
 *     is the single place that turns that flag into words on either surface.
 *   - **`source` is exactly `aws.health`.** AWS event patterns do not wildcard,
 *     so an operator who writes `aws.health*` gets a rule that matches nothing,
 *     forever, silently. The setup copy hands over the literal rather than
 *     describing it.
 *   - **Newest first on the event's own clock.** {@link healthEventClock} falls
 *     back to `receivedAt` only when AWS omitted `startTime`; ordering by
 *     arrival instead would shuffle a backfilled incident to the top.
 *
 * What differs on purpose: the description is truncated by *characters* here
 * rather than by CSS `line-clamp`. RN's `numberOfLines` clips at paint time and
 * cannot tell the component whether it actually clipped, so the "Show more"
 * affordance would either always show or always hide. Cutting the string is
 * deterministic, and it is the only version of this that a node-environment
 * test can observe.
 */

import { formatAge } from './infraResources';

/**
 * AWS Health severity, as classified server-side from the event type category.
 * Mirrors the infra alert severity vocabulary so both surfaces colour alike.
 */
export type InfraHealthSeverity = 'critical' | 'warning' | 'info';

/** AWS Health lifecycle status. Null when AWS omitted it from the payload. */
export type InfraHealthStatusCode = 'open' | 'closed' | 'upcoming' | null;

export interface InfraHealthAffectedEntityWire {
  entityValue: string;
  status?: string | null;
  lastUpdatedMs?: number | null;
}

/** One stored AWS Health event (server `serializeInfraHealthEvent`). */
export interface InfraHealthEventWire {
  id: string;
  projectId: string;
  eventArn: string;
  communicationId: string | null;
  region: string | null;
  deliveryRegion: string | null;
  detailType: string | null;
  service: string | null;
  eventTypeCode: string | null;
  eventTypeCategory: string | null;
  eventScopeCode: string | null;
  statusCode: InfraHealthStatusCode;
  severity: InfraHealthSeverity;
  startTime: number | null;
  endTime: number | null;
  lastUpdated: number | null;
  description: string | null;
  affectedEntities: InfraHealthAffectedEntityWire[];
  affectedEntityCount: number;
  /**
   * True when AWS delivered this copy to the account's *backup* Region rather
   * than the Region the event is about. AWS deliberately fans account-specific
   * events out to a second Region, so a duplicate-looking row is expected.
   */
  backupEvent: boolean;
  page: number | null;
  totalPages: number | null;
  eventTime: number | null;
  receivedAt: number;
}

export interface InfraHealthEventsResponse {
  events: InfraHealthEventWire[];
  total: number;
  /**
   * Whether a live ingest token exists. Distinguishes "the EventBridge rule was
   * never wired up" from "wired up and nothing has happened", which are very
   * different operator next-actions.
   */
  ingestConfigured: boolean;
}

/** Non-secret ingest credential metadata. Never carries the token itself. */
export interface InfraHealthIngestTokenInfoWire {
  projectId: string;
  tokenPrefix: string;
  createdAt: number;
  rotatedAt: number | null;
  revokedAt: number | null;
  lastUsedAt: number | null;
}

export interface InfraHealthIngestResponse {
  token: InfraHealthIngestTokenInfoWire | null;
  ingestPath: string;
  eventPattern: Record<string, readonly string[]>;
}

export interface InfraHealthIngestMintResponse {
  /** Plaintext credential. Returned exactly once and never readable again. */
  token: string;
  info: InfraHealthIngestTokenInfoWire;
  ingestPath: string;
  eventPattern: Record<string, readonly string[]>;
}

export interface InfraHealthIngestRevokeResponse {
  revoked: boolean;
  token: InfraHealthIngestTokenInfoWire | null;
}

/** How many events the phone asks the server for. Deep history lives in AWS. */
export const HEALTH_EVENT_LIMIT = 50;

/**
 * How many the phone actually draws. Lower than web's full list for the same
 * reason `QUOTA_VISIBLE_ROWS` is: the rows are taller here and this panel sits
 * on top of two more sections. The cut is stated in words by
 * {@link healthTruncationNote} rather than applied silently.
 */
export const HEALTH_VISIBLE_ROWS = 10;

/**
 * Descriptions longer than this get an expand affordance.
 *
 * Matches the web `CLAMP_CHARS`, so the same event offers "Show more" on both
 * surfaces. AWS Health descriptions routinely run to several paragraphs.
 */
export const HEALTH_CLAMP_CHARS = 140;

/** Web-identical severity labels. */
const SEVERITY_LABEL: Record<InfraHealthSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
};

/**
 * Normalize whatever arrived in `severity` to one of the three known values.
 *
 * Defensive rather than trusting the wire type: this panel renders events AWS
 * authored and the server classified, and a future category the classifier does
 * not recognise must degrade to the quietest colour instead of rendering an
 * uncoloured row or crashing a style lookup.
 */
export function normalizeHealthSeverity(severity: unknown): InfraHealthSeverity {
  return severity === 'critical' || severity === 'warning' ? severity : 'info';
}

/** Display label for a severity ("Critical" / "Warning" / "Info"). */
export function healthSeverityLabel(severity: unknown): string {
  return SEVERITY_LABEL[normalizeHealthSeverity(severity)];
}

/**
 * The status pill's text, or null when AWS sent no status.
 *
 * Uppercased here rather than via a `textTransform` style so the string a test
 * asserts is the string the operator reads.
 */
export function formatHealthStatus(statusCode: unknown): string | null {
  if (typeof statusCode !== 'string') return null;
  const trimmed = statusCode.trim();
  return trimmed ? trimmed.toUpperCase() : null;
}

/** Newest first, on the event's own clock, falling back to when we received it. */
export function healthEventClock(
  event: Pick<InfraHealthEventWire, 'startTime' | 'receivedAt'>,
): number {
  return event.startTime ?? event.receivedAt;
}

/** Newest-first ordering. Non-mutating: the response array is not ours to sort. */
export function sortHealthEvents<T extends Pick<InfraHealthEventWire, 'startTime' | 'receivedAt'>>(
  events: readonly T[] | null | undefined,
): T[] {
  if (!Array.isArray(events)) return [];
  return [...events].sort((a, b) => healthEventClock(b) - healthEventClock(a));
}

/**
 * The bold part of a row's title.
 *
 * `service` is absent on account-wide events (an abuse notice names no service),
 * and an empty bold slot reads as a rendering bug rather than as "this is about
 * the account".
 */
export function healthEventService(event: Pick<InfraHealthEventWire, 'service'>): string {
  return event.service || 'AWS';
}

/**
 * The machine-readable half of a row's title, in the same fallback order web
 * uses: the specific type code, then the coarser detail type, then a literal.
 */
export function healthEventTypeCode(
  event: Pick<InfraHealthEventWire, 'eventTypeCode' | 'detailType'>,
): string {
  return event.eventTypeCode || event.detailType || 'AWS Health Event';
}

/** "3 affected resources", or null when AWS named none. Singular is not "1 resources". */
export function affectedEntityLabel(count: unknown): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) return null;
  return `${count} affected ${count === 1 ? 'resource' : 'resources'}`;
}

/** The meta line under a row: Region, relative time, entity count, backup marker. */
export function healthEventMetaLine(event: InfraHealthEventWire, nowMs: number): string {
  const parts = [
    event.region || null,
    formatAge(healthEventClock(event), nowMs),
    affectedEntityLabel(event.affectedEntityCount),
    // Not a duplicate and not a bug: AWS deliberately fans account-specific
    // events out to a backup Region as well as the event's own, so the same
    // incident legitimately arrives twice from two delivery Regions. Saying so
    // is cheaper than an operator chasing a phantom double-page.
    event.backupEvent ? 'backup Region' : null,
  ];
  return parts.filter((part): part is string => Boolean(part)).join(' · ');
}

export interface TruncatedDescription {
  /** What to render right now. */
  text: string;
  /** Whether `text` is shorter than the source, i.e. whether to offer "Show more". */
  truncated: boolean;
}

/**
 * The description as it should currently render.
 *
 * Cuts on a word boundary when one is available in the last quarter of the
 * budget, so the visible text does not end mid-identifier — AWS descriptions are
 * dense with ARNs and instance ids, and a hard slice through one reads as a
 * different resource than the one named.
 *
 * `expanded` is threaded through rather than left to the caller so the "is there
 * more?" answer and the text always come from the same computation; a caller
 * that recomputed the flag separately is how the toggle ends up offered on a
 * description that has nothing further to show.
 */
export function truncateHealthDescription(
  description: string | null | undefined,
  expanded: boolean,
  limit: number = HEALTH_CLAMP_CHARS,
): TruncatedDescription {
  const full = typeof description === 'string' ? description : '';
  if (expanded || full.length <= limit) return { text: full, truncated: false };
  const slice = full.slice(0, limit);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > limit * 0.75 ? slice.slice(0, lastSpace) : slice;
  return { text: `${cut.trimEnd()}…`, truncated: true };
}

/** Whether a description is long enough to be worth an expand toggle at all. */
export function isHealthDescriptionClampable(
  description: string | null | undefined,
  limit: number = HEALTH_CLAMP_CHARS,
): boolean {
  return typeof description === 'string' && description.length > limit;
}

export type HealthEmptyKind = 'not-configured' | 'quiet';

export interface HealthEmptyState {
  kind: HealthEmptyKind;
  title: string;
  body: string;
  testID: string;
}

/**
 * Which empty state to draw, and what it says.
 *
 * The whole reason this is a function and not one hardcoded blank slate. A
 * project with no rule and a project with a rule and a quiet week both render
 * zero rows, and the operator's next action is opposite in each case. Getting
 * this wrong is silent: the panel looks fine and the operator concludes AWS has
 * nothing to report, while the ingest endpoint has never once been called.
 */
export function healthEmptyState(ingestConfigured: boolean): HealthEmptyState {
  if (!ingestConfigured) {
    return {
      kind: 'not-configured',
      title: 'AWS Health ingest not configured',
      body: 'Nothing has been wired up to deliver AWS Health events to Agent Hub yet. Create an ingest token below, then add the EventBridge rule it describes in the AWS account you want covered.',
      testID: 'infra-health-not-configured',
    };
  }
  return {
    kind: 'quiet',
    title: 'No AWS Health events received yet.',
    body: 'Ingest is configured, so this means AWS has not published anything affecting this account.',
    testID: 'infra-health-empty',
  };
}

/**
 * What the phone says about the events it did not draw, or null when it drew
 * them all.
 *
 * Same contract as `quotaTruncationNote`: the list is sorted newest-first, so an
 * operator who cannot see it was cut would read the oldest visible row as the
 * oldest event on record.
 */
export function healthTruncationNote(shown: number, total: number): string | null {
  const hidden = total - shown;
  if (hidden <= 0) return null;
  return `${hidden} older event${hidden === 1 ? '' : 's'} not shown. The list is newest-first; full history is in the AWS Health console.`;
}

/** True while a mintable credential exists and has not been revoked. */
export function isIngestTokenLive(
  token: InfraHealthIngestTokenInfoWire | null | undefined,
): boolean {
  return Boolean(token && !token.revokedAt);
}

/** Label for the mint button. Rotating and creating are the same call. */
export function ingestActionLabel(
  token: InfraHealthIngestTokenInfoWire | null | undefined,
): string {
  return isIngestTokenLive(token) ? 'Rotate ingest token' : 'Create ingest token';
}

/**
 * The non-secret one-liner under the buttons: prefix, plus whether the
 * credential has ever actually been used.
 *
 * "Never used" is the diagnostic that matters. A token that exists but has never
 * been presented is the signature of an EventBridge rule that was created with a
 * wildcarded `source` and therefore matches nothing.
 */
export function ingestTokenSummary(
  token: InfraHealthIngestTokenInfoWire | null | undefined,
  nowMs: number,
): string | null {
  if (!token) return null;
  const prefix = `${token.tokenPrefix}…`;
  if (token.revokedAt) return `${prefix} · revoked`;
  if (token.lastUsedAt) return `${prefix} · last used ${formatAge(token.lastUsedAt, nowMs)}`;
  return `${prefix} · never used`;
}

/**
 * The absolute URL the operator points their EventBridge API destination at.
 *
 * Joins defensively because both halves come from different places — the base
 * from the phone's saved connection config, the path from the server — and a
 * `//` in the middle produces a URL that 404s with no hint as to why.
 */
export function healthIngestUrl(serverBase: string | null | undefined, ingestPath: string): string {
  const base = (serverBase || '').replace(/\/+$/, '');
  const path = ingestPath.startsWith('/') ? ingestPath : `/${ingestPath}`;
  return `${base}${path}`;
}

/** The rule pattern, pretty-printed for the copy button. */
export function formatEventPattern(
  pattern: Record<string, readonly string[]> | null | undefined,
): string {
  if (!pattern) return '';
  return JSON.stringify(pattern, null, 2);
}

/**
 * The one-shot warning shown beside a freshly minted credential.
 *
 * Exported so a test can hold the wording to the promise the server makes: the
 * token is hashed on mint and there is no read-back route, so "shown only once"
 * is a literal description of the API and not a UI convention.
 */
export const TOKEN_ONCE_WARNING =
  'Copy this now — it is shown only once and can never be read back. Lost it? There is no recovery path: mint a new one and update the EventBridge target.';

/**
 * The setup instructions. Held here rather than inline in JSX so the
 * `aws.health` literal — the single most consequential string in this feature —
 * is somewhere a test can assert on.
 */
export const INGEST_SETUP_NOTE =
  'Agent Hub cannot create this rule for you — it lives in your AWS account. Add an EventBridge rule on the default bus whose source is exactly aws.health (a wildcard such as aws.health* never matches) and point it at the URL below via an API destination. Send the token as an Authorization: Bearer header, or as x-agenthub-health-token if a proxy in front of the endpoint eats the standard one.';
