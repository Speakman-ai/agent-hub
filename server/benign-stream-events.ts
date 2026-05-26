import type { StreamEvent } from './types.js';
import {
  isBenignUnknownStreamEvent,
  shouldSuppressStreamEvent,
} from '../shared/utils/benignStreamEvents.js';

export { isBenignUnknownStreamEvent, shouldSuppressStreamEvent };

/**
 * Belt-and-suspenders for legacy `unknown` rows whose text matches
 * {@link BENIGN_UNKNOWN_STREAM_TEXT}. Parser-level `[]` is the primary gate for
 * new turns; this does **not** drop unrecognized `unknown` events.
 */
export function shouldPersistStreamEvent(event: StreamEvent): boolean {
  return !shouldSuppressStreamEvent(event);
}
