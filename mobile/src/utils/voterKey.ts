// Mobile adapter for the Customer Support Voting tab. The pure logic lives in
// shared/ (SPEC-3); this module injects the mobile platform seam — an
// asynchronous per-device voter token backed by AsyncStorage.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { VOTER_KEY_STORAGE, randomToken } from '@shared/utils/voting';

// In-memory mirror so a single app session reuses one token even before/without
// a successful AsyncStorage write (private-mode / storage-unavailable fallback).
let memoryToken: string | null = null;

/**
 * Read the per-device voter token, minting and persisting one on first use.
 * Async because AsyncStorage is async. Falls back to an in-memory token when
 * storage is unavailable so voting still works for the session.
 */
export async function getVoterKey(): Promise<string> {
  if (memoryToken) return memoryToken;
  try {
    const existing = await AsyncStorage.getItem(VOTER_KEY_STORAGE);
    if (existing && existing.trim()) {
      memoryToken = existing;
      return existing;
    }
    const minted = randomToken();
    memoryToken = minted;
    await AsyncStorage.setItem(VOTER_KEY_STORAGE, minted);
    return minted;
  } catch {
    if (!memoryToken) memoryToken = randomToken();
    return memoryToken;
  }
}

// Test-only reset of the in-memory mirror so each case starts clean.
export function _resetVoterKeyMemory() {
  memoryToken = null;
}
