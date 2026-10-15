/** Metadata of the system message written when a session ships its work. */
export function parseShipRequestedMetadata(metadataString: any) {
  if (metadataString == null) return null;
  let parsed;
  try {
    parsed = typeof metadataString === 'string' ? JSON.parse(metadataString) : metadataString;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.kind !== 'ship_requested') return null;
  return {
    kind: 'ship_requested',
    skillId: typeof parsed.skillId === 'string' ? parsed.skillId : 'create-ticket-and-pr',
    ...(parsed.auto === true ? { auto: true } : {}),
  };
}

/** Header + body copy for a `ship_requested` timeline card. */
export function shipRequestedCopy(meta: { auto?: boolean } | null) {
  if (meta?.auto) {
    return {
      title: 'Shipping automatically',
      body: 'Agent Hub is rebasing on the base branch, then committing, pushing, and opening or updating the pull request.',
    };
  }
  return {
    title: 'Ship requested',
    body: 'Agent Hub is committing, pushing, and opening or updating the pull request.',
  };
}
