/**
 * Type declarations for `benignStreamEvents.js`.
 *
 * The runtime source is intentionally plain JS so it can be consumed by the
 * web client (Vite), the mobile app (Metro/Expo), and the TypeScript server
 * without forcing a build step on the JS targets. This `.d.ts` file gives the
 * server's `tsc --noEmit` typecheck a declaration to import.
 */

export interface BenignStreamEventLike {
  type?: string;
  text?: string;
}

export const BENIGN_UNKNOWN_STREAM_TEXT: RegExp[];

export function isBenignUnknownStreamEvent(
  event: BenignStreamEventLike | null | undefined,
): boolean;

export function shouldSuppressStreamEvent(
  event: BenignStreamEventLike | null | undefined,
): boolean;
