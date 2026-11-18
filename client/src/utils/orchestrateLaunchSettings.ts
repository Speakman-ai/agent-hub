/**
 * Web wiring for the shared Orchestrate launch store: localStorage, plus
 * storage events so a cancel or settings change in another tab reaches this one.
 */
import { useSyncExternalStore } from 'react';
import { createOrchestrateLaunchStore } from '@shared/utils/orchestrateLaunchSettings';

export {
  ORCHESTRATE_AUTO_START_SECONDS,
  type OrchestrateLaunchSettings,
} from '@shared/utils/orchestrateLaunchSettings';

const store = createOrchestrateLaunchStore({
  storage: {
    getItem: (key) => globalThis.localStorage?.getItem(key) ?? null,
    setItem: (key, value) => globalThis.localStorage?.setItem(key, value),
  },
  useSyncExternalStore,
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => store.handleOrchestrateStorageEvent(event.key));
}

export const {
  getOrchestrateLaunchSettings,
  setOrchestrateLaunchSettings,
  subscribeOrchestrateLaunchSettings,
  useOrchestrateLaunchSettings,
  setOrchestrateSessionActive,
  isOrchestrateSessionActive,
  useOrchestrateSessionActive,
  orchestrateAutoStartDeadline,
  orchestrateAutoStartRemaining,
  subscribeOrchestrateAutoStart,
  cancelOrchestrateAutoStart,
  isOrchestrateAutoStartCancelled,
  useOrchestrateAutoStartCancelled,
  markOrchestrateAutoStartFired,
  releaseOrchestrateAutoStart,
  handleOrchestrateStorageEvent,
  resetOrchestrateLaunchStateForTests,
} = store;
