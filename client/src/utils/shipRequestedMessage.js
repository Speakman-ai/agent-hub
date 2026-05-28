/** System message metadata when the operator clicks Create ticket & PR. */
export function parseShipRequestedMetadata(metadataString) {
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
