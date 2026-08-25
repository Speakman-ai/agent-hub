import type { UseLogTailOptions } from '@shared/hooks/useLogTail';

/**
 * The subset of `useLogTail` options a parent may forward down to the Live
 * view. `getWsUrl` is excluded on purpose: it is the web platform seam and
 * `LiveLogsView` always supplies it, so no caller (including tests injecting a
 * fake socket) can accidentally point the tail at another host.
 */
export type LogTailOverrides = Omit<UseLogTailOptions, 'getWsUrl'>;
