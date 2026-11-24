/**
 * Mobile wiring for the shared Orchestrate launch client: the server holds the
 * settings, countdowns and cancels; this only mirrors and calls it.
 */
import { useSyncExternalStore } from 'react';
import { createOrchestrateLaunchClient } from '@shared/utils/orchestrateLaunchClient';
import { api } from '../utils/api';

export const orchestrateLaunch = createOrchestrateLaunchClient({ api, useSyncExternalStore });

export const setOrchestrateSessionActive = orchestrateLaunch.setSessionActive;
export const useOrchestrateSessionActive = orchestrateLaunch.useSessionActive;
