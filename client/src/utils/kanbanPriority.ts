/** Priority levels treated as "high priority" for toggle and filter semantics. */
export const HIGH_PRIORITY_LEVELS = new Set(['high', 'urgent']);

export function isHighPriority(priority: string | null | undefined): boolean {
  return HIGH_PRIORITY_LEVELS.has(String(priority || 'medium').toLowerCase());
}

/** Toggle between marked-high (high) and default (medium). */
export function toggleHighPriorityValue(priority: string | null | undefined): 'high' | 'medium' {
  return isHighPriority(priority) ? 'medium' : 'high';
}
