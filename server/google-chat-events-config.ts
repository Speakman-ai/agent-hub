import type { GoogleChatEventsConfig } from './types.js';

/** Path of the Pub/Sub push endpoint, relative to the Hub's public base. */
export const GOOGLE_CHAT_EVENTS_PUSH_PATH = '/api/google/chat/events/push';

const TOPIC_RE = /^projects\/[^/\s]+\/topics\/[^/\s]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

function pick(env: NodeJS.ProcessEnv, envKey: string, fileValue: unknown): string | null {
  return str(env[envKey]) ?? str(fileValue);
}

/**
 * Resolve Chat push settings from env (`AGENT_HUB_GOOGLE_CHAT_PUBSUB_TOPIC`,
 * `AGENT_HUB_GOOGLE_CHAT_PUSH_SERVICE_ACCOUNT`, `AGENT_HUB_GOOGLE_CHAT_PUSH_AUDIENCE`)
 * or the `googleChatEvents` block in config.json.
 *
 * The audience defaults to `<publicUrl>/api/google/chat/events/push`, which is
 * also the URL the Pub/Sub push subscription should target. Returns null when
 * any piece is missing or malformed: without a verifiable push endpoint the
 * Hub must not create subscriptions whose events it would have to reject.
 */
export function resolveGoogleChatEventsConfig(
  fileConfig: Record<string, unknown>,
  publicUrl: string | null,
  env: NodeJS.ProcessEnv = process.env,
): GoogleChatEventsConfig | null {
  const block = (fileConfig.googleChatEvents ?? {}) as Record<string, unknown>;
  const pubsubTopic = pick(env, 'AGENT_HUB_GOOGLE_CHAT_PUBSUB_TOPIC', block.pubsubTopic);
  const pushServiceAccountEmail = pick(
    env,
    'AGENT_HUB_GOOGLE_CHAT_PUSH_SERVICE_ACCOUNT',
    block.pushServiceAccountEmail,
  );
  let pushAudience = pick(env, 'AGENT_HUB_GOOGLE_CHAT_PUSH_AUDIENCE', block.pushAudience);
  if (!pushAudience && str(publicUrl)) {
    pushAudience = `${str(publicUrl)!.replace(/\/+$/, '')}${GOOGLE_CHAT_EVENTS_PUSH_PATH}`;
  }
  if (!pubsubTopic || !pushServiceAccountEmail || !pushAudience) return null;
  if (!TOPIC_RE.test(pubsubTopic)) {
    console.warn(
      `[google-chat-events] Ignoring googleChatEvents: pubsubTopic must look like projects/<project>/topics/<topic>`,
    );
    return null;
  }
  if (!EMAIL_RE.test(pushServiceAccountEmail)) {
    console.warn('[google-chat-events] Ignoring googleChatEvents: invalid pushServiceAccountEmail');
    return null;
  }
  if (!/^https:\/\//.test(pushAudience)) {
    console.warn('[google-chat-events] Ignoring googleChatEvents: push audience must be https');
    return null;
  }
  return { pubsubTopic, pushAudience, pushServiceAccountEmail };
}
