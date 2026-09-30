/**
 * Summarize a dictated note transcript with the caller's default model.
 *
 * "Default model" is the caller's Hub engine/model pick (the same per-user
 * choice the Hub assistant and Daily Summary run on). The run goes through
 * `resolveOneShotEngine` (pre-flight: skip engines that aren't authenticated)
 * and `runOneShotPromptWithFailover` (post-flight: switch engines on quota,
 * auth, or upstream errors), the same failover chain sessions use.
 */
import { HUB_ASSISTANT_AGENT_ID } from '../shared/utils/hub.js';
import { resolveOneShotEngine, NoEnginesAvailableError } from './engine-resolver.js';
import { runOneShotPromptWithFailover, type OneShotFailoverOutcome } from './one-shot-failover.js';
import { resolveSessionCliSpawnEnv } from './per-user-cli-spawn.js';
import { resolveHubEngineAndModel } from './hub-assistant.js';
import { hubWorkspaceCwd } from './hub-daily-summary.js';
import type { AppConfig } from './types.js';

const SUMMARIZE_TIMEOUT_MS = 90_000;
/** Whisper caps uploads at 25 MB (~2.5 h of speech); this bounds the prompt well past that. */
export const MAX_VOICE_TRANSCRIPT_CHARS = 200_000;

const SYSTEM_PROMPT = [
  'You summarize a voice memo the user dictated into a note.',
  'Use ONLY what the transcript says. Do not add facts, advice, or commentary.',
  'Write as the user, the way they would jot the note themselves.',
  'Keep every concrete detail that matters later: names, numbers, dates, decisions, and action items.',
  'Drop filler words, false starts, and repetition.',
  'Format the reply as GitHub-flavored Markdown:',
  '- First line: a one-sentence gist in **bold**.',
  '- Then the key points as a "- " bullet list (skip the list for a memo that is only one point).',
  '- Then any action items as a task list: "- [ ] ...".',
  'Do not add a heading, preamble, code fences, or HTML tags.',
].join('\n');

export interface SummarizeVoiceTranscriptInput {
  userId: string;
  transcript: string;
  config: AppConfig;
  resolveEngine?: typeof resolveOneShotEngine;
  runFailover?: (
    input: Parameters<typeof runOneShotPromptWithFailover>[0],
    cfg: AppConfig,
  ) => Promise<OneShotFailoverOutcome>;
  cwd?: string;
}

export interface VoiceTranscriptSummary {
  summary: string;
  engine: string;
  model: string;
}

/**
 * Normalize model output to plain Markdown: unwrap a whole-reply code fence,
 * drop a leading "Summary" label, and strip HTML tags (the note wraps the
 * transcript in `<details>`, so stray tags in the summary would corrupt it).
 */
export function cleanVoiceSummaryOutput(raw: string): string {
  let text = (raw || '').replace(/\r\n/g, '\n').trim();
  const fenced = text.match(/^```[a-z]*\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(?:#+\s*)?(?:\*\*)?summary:?(?:\*\*)?:?\s*\n+/i, '');
  text = text.replace(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export async function summarizeVoiceTranscript(
  input: SummarizeVoiceTranscriptInput,
): Promise<VoiceTranscriptSummary> {
  const transcript = input.transcript.trim();
  const resolveEngine = input.resolveEngine ?? resolveOneShotEngine;
  const runFailover = input.runFailover ?? runOneShotPromptWithFailover;
  const { config, userId } = input;
  const pick = resolveHubEngineAndModel(config, userId);
  const resolved = await resolveEngine(config, {
    userId,
    agentId: HUB_ASSISTANT_AGENT_ID,
    preferred: pick.engine,
    preferredModel: pick.model,
  });
  const outcome = await runFailover(
    {
      engine: resolved.engine,
      model: resolved.model,
      prompt: `Summarize this voice memo transcript:\n\n<transcript>\n${transcript}\n</transcript>`,
      systemPrompt: SYSTEM_PROMPT,
      cwd: input.cwd ?? hubWorkspaceCwd(),
      timeoutMs: SUMMARIZE_TIMEOUT_MS,
      userId,
      agentId: HUB_ASSISTANT_AGENT_ID,
      buildEnv: (engine) =>
        resolveSessionCliSpawnEnv({ cfg: config, ownerId: userId, credsOwnerId: userId, engine }),
      scope: 'voice-note-summary',
      claudePermissionMode: 'bypassPermissions',
    },
    config,
  );
  const summary = cleanVoiceSummaryOutput(outcome.output);
  if (!summary || (outcome.detailed.code !== 0 && outcome.detailed.code !== null)) {
    throw new Error(outcome.detailed.stderr?.trim() || 'Voice note summary failed');
  }
  return { summary, engine: outcome.engine, model: outcome.model };
}

export { NoEnginesAvailableError };
