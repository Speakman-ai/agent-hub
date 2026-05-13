// Filter operations marked `x-internal: true` out of an OpenAPI 3.x document.
//
// Used by `.github/workflows/api-docs.yml` to strip internal routes before
// publishing the spec to GitHub Pages. The function is pure — it does NOT
// touch the filesystem and does NOT parse YAML — so the unit test exercises
// it with plain JS objects. The thin CLI wrapper at
// `scripts/build-openapi-public.ts` handles file I/O.

type Json = Record<string, unknown>;

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace']);

/**
 * Returns a deep-cloned copy of `spec` with any operation flagged
 * `x-internal: true` removed. If every operation on a path is internal, the
 * whole path entry is dropped so the published doc doesn't list empty paths.
 *
 * Marker rules:
 * - Operation-level `x-internal: true` removes that single operation.
 * - Path-level `x-internal: true` removes every operation on that path.
 * - Operations tagged with any tag in `internalTags` (default: `["internal"]`)
 *   are treated the same as operation-level `x-internal: true`. This is a
 *   convenience for spec authors who prefer tags over vendor extensions.
 *
 * Counters returned alongside the filtered spec let the workflow log how
 * many operations were dropped — useful when a misplaced marker hides a
 * route by accident.
 */
export interface FilterResult {
  spec: Json;
  removedOperations: number;
  removedPaths: number;
}

export interface FilterOptions {
  internalTags?: string[];
}

export function filterInternalOperations(
  input: unknown,
  options: FilterOptions = {},
): FilterResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('filterInternalOperations: spec must be a plain object');
  }
  const spec = structuredClone(input) as Json;
  const internalTagSet = new Set(
    (options.internalTags ?? ['internal']).map((t) => t.toLowerCase()),
  );

  const paths = spec.paths;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    return { spec, removedOperations: 0, removedPaths: 0 };
  }

  let removedOperations = 0;
  let removedPaths = 0;
  const filteredPaths: Json = {};

  for (const [pathKey, pathItemRaw] of Object.entries(paths as Json)) {
    if (!pathItemRaw || typeof pathItemRaw !== 'object' || Array.isArray(pathItemRaw)) {
      filteredPaths[pathKey] = pathItemRaw;
      continue;
    }
    const pathItem = pathItemRaw as Json;

    // Path-level marker: drop every operation under this path.
    if (pathItem['x-internal'] === true) {
      removedPaths += 1;
      removedOperations += countOperations(pathItem);
      continue;
    }

    const keptEntries: [string, unknown][] = [];
    for (const [key, value] of Object.entries(pathItem)) {
      const lower = key.toLowerCase();
      if (HTTP_METHODS.has(lower)) {
        if (isInternalOperation(value, internalTagSet)) {
          removedOperations += 1;
          continue;
        }
      }
      keptEntries.push([key, value]);
    }

    // If only non-operation keys (parameters/summary/description/etc.) remain
    // after filtering, the path entry is meaningless to consumers — drop it.
    const hasOperation = keptEntries.some(([k]) => HTTP_METHODS.has(k.toLowerCase()));
    if (!hasOperation) {
      removedPaths += 1;
      continue;
    }

    filteredPaths[pathKey] = Object.fromEntries(keptEntries);
  }

  spec.paths = filteredPaths;
  return { spec, removedOperations, removedPaths };
}

function countOperations(pathItem: Json): number {
  let n = 0;
  for (const key of Object.keys(pathItem)) {
    if (HTTP_METHODS.has(key.toLowerCase())) n += 1;
  }
  return n;
}

function isInternalOperation(op: unknown, internalTagSet: Set<string>): boolean {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return false;
  const operation = op as Json;
  if (operation['x-internal'] === true) return true;
  const tags = operation.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (typeof tag === 'string' && internalTagSet.has(tag.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}
