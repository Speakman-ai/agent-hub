/**
 * Mobile wiring for the shared Orchestrate launch store: AsyncStorage. Saved
 * settings arrive after the first read, and a card counts as blocked until
 * saved cancels have loaded.
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createOrchestrateLaunchStore } from '@shared/utils/orchestrateLaunchSettings';

export {
  ORCHESTRATE_AUTO_START_SECONDS,
  type OrchestrateLaunchSettings,
} from '@shared/utils/orchestrateLaunchSettings';

const store = createOrchestrateLaunchStore({
  storage: {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
  },
  useSyncExternalStore,
});

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
  resetOrchestrateLaunchStateForTests,
} = store;
