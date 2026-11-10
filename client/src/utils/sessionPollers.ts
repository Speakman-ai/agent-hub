/** Window event App.tsx re-dispatches for each `session_poller_updated` WS message. */
export const SESSION_POLLER_WS_EVENT = 'agenthub:session-poller-updated';

export {
  checkPollerForm,
  formatPollerClock,
  type PollerFormCheck,
  type PollerFormValues,
} from '@shared/utils/sessionPoller';
