/**
 * Edit state for the Server Agent settings form, shared by web and mobile.
 *
 * The draft belongs to one account. Async results (a load, a save) are only
 * applied when they still match the draft they were started for: a save
 * completion is matched by sequence number and account, and it only rewrites
 * fields the user has not edited since submitting. An account change drops
 * the draft and any save in flight, so a late result can never land in
 * another account's form.
 */
import type { ServerAgentSettings } from './serverAgentSettingsStore';

export interface ServerAgentDraftFields {
  name: string;
  instructions: string;
}

export interface ServerAgentDraftState extends ServerAgentDraftFields {
  /** Account the draft was loaded for; null when nothing is loaded. */
  owner: string | null;
  /** The save in flight: its sequence number and the values it submitted. */
  pending: ({ seq: number } & ServerAgentDraftFields) | null;
  /** Sequence of the last started save. */
  seq: number;
  status: { ok: boolean; text: string } | null;
}

export type ServerAgentDraftAction =
  | { type: 'load'; owner: string; settings: ServerAgentDraftFields }
  | { type: 'clear' }
  | { type: 'edit'; field: keyof ServerAgentDraftFields; value: string }
  | { type: 'saveStart' }
  | { type: 'saveDone'; seq: number; owner: string; saved: ServerAgentSettings }
  | { type: 'saveFailed'; seq: number; owner: string; message: string };

export const SERVER_AGENT_SAVED_TEXT = 'Saved. Applies from the next message.';

export const initialServerAgentDraft: ServerAgentDraftState = {
  owner: null,
  name: '',
  instructions: '',
  pending: null,
  seq: 0,
  status: null,
};

export function serverAgentDraftReducer(
  state: ServerAgentDraftState,
  action: ServerAgentDraftAction,
): ServerAgentDraftState {
  switch (action.type) {
    case 'load':
      if (state.owner === action.owner) return state;
      return {
        ...initialServerAgentDraft,
        seq: state.seq,
        owner: action.owner,
        name: action.settings.name,
        instructions: action.settings.instructions,
      };
    case 'clear':
      if (state.owner === null && !state.pending && !state.status && !state.name) return state;
      return { ...initialServerAgentDraft, seq: state.seq };
    case 'edit':
      if (state.owner === null) return state;
      return { ...state, [action.field]: action.value };
    case 'saveStart': {
      if (state.owner === null || state.pending) return state;
      const seq = state.seq + 1;
      return {
        ...state,
        seq,
        status: null,
        pending: { seq, name: state.name, instructions: state.instructions },
      };
    }
    case 'saveDone': {
      const { pending } = state;
      if (!pending || pending.seq !== action.seq || state.owner !== action.owner) return state;
      return {
        ...state,
        // Keep anything typed while the request was out.
        name: state.name === pending.name ? action.saved.name : state.name,
        instructions:
          state.instructions === pending.instructions
            ? action.saved.instructions
            : state.instructions,
        pending: null,
        status: { ok: true, text: SERVER_AGENT_SAVED_TEXT },
      };
    }
    case 'saveFailed': {
      const { pending } = state;
      if (!pending || pending.seq !== action.seq || state.owner !== action.owner) return state;
      return { ...state, pending: null, status: { ok: false, text: action.message } };
    }
    default:
      return state;
  }
}

/** The save the next `saveStart` will create, or null when one cannot start. */
export function nextServerAgentSave(
  state: ServerAgentDraftState,
): ({ seq: number; owner: string } & ServerAgentDraftFields) | null {
  if (state.owner === null || state.pending) return null;
  return {
    seq: state.seq + 1,
    owner: state.owner,
    name: state.name,
    instructions: state.instructions,
  };
}
