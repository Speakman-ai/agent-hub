import type { StreamEvent } from './types.js';
import {
  isBenignUnknownStreamEvent,
  shouldSuppressStreamEvent,
} from '../shared/utils/benignStreamEvents.js';

export { isBenignUnknownStreamEvent, shouldSuppressStreamEvent };

export function shouldPersistStreamEvent(event: StreamEvent): boolean {
  return !shouldSuppressStreamEvent(event);
}
