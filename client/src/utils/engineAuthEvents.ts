/** Dispatched when per-user engine credentials change (OAuth login/logout, API key). */
export const ENGINE_AUTH_CHANGED = 'agent-hub:engine-auth-changed';

export function notifyEngineAuthChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(ENGINE_AUTH_CHANGED));
  }
}
