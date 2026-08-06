/**
 * The scope tag filter (`infra_scopes.tag_filter_json`) — one parser, two
 * consumers, deliberately.
 *
 * A scope's tag filter is part of the operator's allowlist (decision
 * INFRA-SCOPE), and it has to mean the same thing at both ends of the pipeline:
 *
 *   - **Inventory sync** pushes it into `DescribeInstances` as EC2 `Filter`
 *     structures, so AWS applies it server-side and only matching resources are
 *     ever written to `infra_resources`.
 *   - **The metric collector** re-applies it to the stored rows, because
 *     inventory rows are never deleted and a *narrowed* filter would otherwise
 *     keep billing `GetMetricData` for resources the operator just excluded —
 *     for as long as those rows stay fresh. Two scopes on the same region and
 *     service under different profiles have the same problem in the other
 *     direction: each would collect the union of both filters.
 *
 * The two must agree exactly, so the matching implemented here mirrors EC2's
 * own published filter semantics rather than a convenient approximation:
 *
 *   - Values and keys are **case-sensitive**.
 *   - `*` matches zero or more characters; `?` matches **zero or one**
 *     character — not exactly one. AWS's own example: over `prod`, `prods`,
 *     `production`, the pattern `prod*` matches all three and `prod?` matches
 *     `prod` and `prods`.
 *   - A backslash escapes the next character, so `\*` and `\?` are literals.
 *   - Values within one key are ORed; keys are ANDed.
 *
 * Getting `?` wrong (the natural guess is "exactly one") would make the
 * collector disagree with the describe call that populated inventory, which is
 * the precise failure this shared module exists to prevent.
 */

/** One `tag:Key` clause: the key, and the accepted value patterns (ORed). */
export interface InfraTagFilterClause {
  key: string;
  values: string[];
}

/** A parsed filter with its value patterns compiled once, not once per resource. */
export interface CompiledInfraTagFilter {
  clauses: Array<{ key: string; patterns: RegExp[] }>;
}

/**
 * Parse `tag_filter_json` into clauses.
 *
 * Stored format is `{"Key": ["v1","v2"]}` — a map of tag key to accepted
 * values, ANDed across keys and ORed within one, which is exactly EC2's own
 * filter semantics. A bare string is accepted as a single value.
 *
 * Throws on anything it cannot parse, and that direction is load-bearing in
 * both callers: inventory sync turns the throw into a skipped scope, and so
 * does the collector. Degrading a broken filter to "no filter" would silently
 * widen the allowlist to every resource in the region, turning an operator
 * typo into unbounded describe traffic and a billed metric sweep nobody opted
 * into.
 */
export function parseInfraTagFilter(tagFilterJson: string | null): InfraTagFilterClause[] {
  if (tagFilterJson === null || tagFilterJson.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(tagFilterJson);
  } catch (err) {
    throw new Error(`tag_filter_json is not valid JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('tag_filter_json must be a JSON object of tag key -> value(s)');
  }

  const clauses: InfraTagFilterClause[] = [];
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (key === '') throw new Error('tag_filter_json contains an empty tag key');
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.length === 0) {
      throw new Error(`tag_filter_json key "${key}" has no values`);
    }
    for (const value of values) {
      if (typeof value !== 'string') {
        throw new Error(`tag_filter_json key "${key}" has a non-string value`);
      }
    }
    clauses.push({ key, values: values as string[] });
  }
  return clauses;
}

const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExpChar(ch: string): string {
  return ch.replace(REGEXP_METACHARACTERS, '\\$&');
}

/**
 * Compile one EC2 filter value pattern into an anchored RegExp.
 *
 * `s` flag so `.` spans newlines: a tag value may legitimately contain one, and
 * `*` is documented as "zero or more characters" with no exception carved out
 * for line breaks.
 */
export function compileTagFilterValue(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\' && i + 1 < pattern.length) {
      // Escaped literal. A trailing lone backslash falls through to the default
      // branch below and is treated as a literal backslash.
      source += escapeRegExpChar(pattern[i + 1]);
      i += 1;
    } else if (ch === '*') {
      source += '.*';
    } else if (ch === '?') {
      // Zero or one, per AWS. `.` would be the intuitive translation and the
      // wrong one.
      source += '.?';
    } else {
      source += escapeRegExpChar(ch);
    }
  }
  return new RegExp(`^${source}$`, 's');
}

/** Parse and compile in one step. Throws on a malformed filter. */
export function compileInfraTagFilter(tagFilterJson: string | null): CompiledInfraTagFilter {
  return {
    clauses: parseInfraTagFilter(tagFilterJson).map((clause) => ({
      key: clause.key,
      patterns: clause.values.map(compileTagFilterValue),
    })),
  };
}

/** Whether the filter constrains anything at all. */
export function isEmptyInfraTagFilter(filter: CompiledInfraTagFilter): boolean {
  return filter.clauses.length === 0;
}

/** A stored AWS tag, as `infra_resources.tags_json` holds it. */
interface StoredTag {
  Key?: string;
  Value?: string;
}

function parseStoredTags(tagsJson: string | null): StoredTag[] {
  if (!tagsJson) return [];
  try {
    const parsed: unknown = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? (parsed as StoredTag[]) : [];
  } catch {
    // Our own column, so this should not happen — but a row we cannot read is
    // a row we cannot prove is in scope, and the fail-closed direction is to
    // exclude it rather than bill for it.
    return [];
  }
}

/**
 * Whether a resource's stored tags satisfy the filter.
 *
 * Keys are ANDed, values within a key ORed — EC2's semantics. A resource with
 * no tags satisfies only the empty filter, which is why an untagged instance
 * drops out of a tag-scoped allowlist rather than being collected by default.
 */
export function matchesInfraTagFilter(
  tagsJson: string | null,
  filter: CompiledInfraTagFilter,
): boolean {
  if (isEmptyInfraTagFilter(filter)) return true;
  const tags = parseStoredTags(tagsJson);
  if (tags.length === 0) return false;

  return filter.clauses.every((clause) =>
    tags.some(
      (tag) =>
        // Exact, case-sensitive key match: EC2 filter names are case-sensitive,
        // and a looser match here would collect resources the describe call
        // never returned.
        tag.Key === clause.key &&
        typeof tag.Value === 'string' &&
        clause.patterns.some((pattern) => pattern.test(tag.Value as string)),
    ),
  );
}
