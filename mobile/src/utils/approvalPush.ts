/**
 * Lock-screen Allow once / Deny for approval pushes. The category is
 * registered on the device once; the server tags approval pushes with the
 * same `categoryId`, and the response listener answers through the REST API.
 *
 * Native modules are injected so Vitest can exercise this without Expo.
 */
import {
  APPROVAL_PUSH_ACTIONS,
  APPROVAL_PUSH_CATEGORY,
  approvalIdFromNotification,
  pushActionDecision,
  type ApprovalDecision,
} from '@shared/utils/approvals';

interface CategoryNotifications {
  setNotificationCategoryAsync?: (
    identifier: string,
    actions: Array<{
      identifier: string;
      buttonTitle: string;
      options?: {
        opensAppToForeground?: boolean;
        isDestructive?: boolean;
        isAuthenticationRequired?: boolean;
      };
    }>,
  ) => Promise<unknown>;
}

export async function registerApprovalPushCategory(
  Notifications: CategoryNotifications,
): Promise<boolean> {
  if (typeof Notifications?.setNotificationCategoryAsync !== 'function') return false;
  try {
    await Notifications.setNotificationCategoryAsync(
      APPROVAL_PUSH_CATEGORY,
      APPROVAL_PUSH_ACTIONS.map((a) => ({
        identifier: a.identifier,
        buttonTitle: a.buttonTitle,
        // Open the app so the answer is sent from the foreground with the
        // signed-in session; unlock first so a locked phone can't approve.
        options: {
          opensAppToForeground: true,
          isDestructive: a.destructive,
          isAuthenticationRequired: true,
        },
      })),
    );
    return true;
  } catch {
    return false;
  }
}

export type PushApprovalOutcome =
  | { handled: false }
  | { handled: true; approvalId: string; decision: ApprovalDecision; ok: boolean; error?: string };

/**
 * If the response is an Allow once / Deny button press on an approval push,
 * send the answer. A plain tap returns `handled: false` so the caller routes
 * it like any other notification.
 */
export async function answerFromPushResponse(
  response: { actionIdentifier?: unknown; notification?: any } | null | undefined,
  answer: (
    approvalId: string,
    decision: ApprovalDecision,
    data: Record<string, unknown>,
  ) => Promise<unknown>,
): Promise<PushApprovalOutcome> {
  const decision = pushActionDecision(response?.actionIdentifier);
  if (!decision) return { handled: false };
  const data = response?.notification?.request?.content?.data ?? {};
  const approvalId = approvalIdFromNotification({ category: data.category, data });
  if (!approvalId) return { handled: false };
  try {
    await answer(approvalId, decision, data);
    return { handled: true, approvalId, decision, ok: true };
  } catch (err) {
    // 409 means it was already answered or expired; nothing more to do.
    const status = (err as { status?: number })?.status;
    return {
      handled: true,
      approvalId,
      decision,
      ok: status === 409,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface ResponseNotifications {
  addNotificationResponseReceivedListener?: (cb: (response: any) => void) => {
    remove?: () => void;
  };
  getLastNotificationResponseAsync?: () => Promise<any>;
  dismissNotificationAsync?: (identifier: string) => Promise<unknown>;
}

export interface NotificationResponseHandlers {
  /** `data` is the push payload, which names the server it came from. */
  answer: (
    approvalId: string,
    decision: ApprovalDecision,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
  /** A plain tap (or a press that isn't an approval answer): open what it points at. */
  route: (data: Record<string, unknown>) => void;
  onAnswerFailed: (message: string) => void;
}

function responseKey(response: any): string {
  return `${response?.notification?.request?.identifier ?? ''}|${response?.actionIdentifier ?? ''}`;
}

/**
 * Handle notification taps and approval button presses. The live listener
 * is installed before the cold-start response is read and answered, so a
 * press that arrives while that answer is in flight is never missed. Each
 * press is claimed before its request starts, so the cold-start snapshot and
 * the listener can't answer the same press twice.
 */
export function listenForNotificationResponses(
  Notifications: ResponseNotifications,
  handlers: NotificationResponseHandlers,
  claimed: Set<string> = new Set(),
): { ready: Promise<void>; remove: () => void } {
  let removed = false;

  const handle = async (response: any) => {
    if (removed || !response) return;
    const isPress = pushActionDecision(response.actionIdentifier) !== null;
    const key = responseKey(response);
    if (isPress) {
      if (claimed.has(key)) return;
      claimed.add(key);
    }
    const outcome = await answerFromPushResponse(response, handlers.answer);
    if (outcome.handled) {
      if (!outcome.ok) {
        // The approval is still pending: keep the notification and its
        // buttons, and let the user press again once the failure is reported.
        claimed.delete(key);
        handlers.onAnswerFailed(outcome.error ?? 'Try again in the app.');
        return;
      }
      const identifier = response.notification?.request?.identifier;
      if (identifier && typeof Notifications.dismissNotificationAsync === 'function') {
        Notifications.dismissNotificationAsync(identifier).catch(() => {});
      }
      return;
    }
    const data = response.notification?.request?.content?.data;
    if (!removed && data) handlers.route(data);
  };

  const subscription =
    typeof Notifications.addNotificationResponseReceivedListener === 'function'
      ? Notifications.addNotificationResponseReceivedListener((response) => {
          void handle(response);
        })
      : null;

  const ready = (async () => {
    if (typeof Notifications.getLastNotificationResponseAsync !== 'function') return;
    try {
      // Cold start: the app was launched from a notification.
      await handle(await Notifications.getLastNotificationResponseAsync());
    } catch {
      /* non-fatal: the live listener still covers later responses */
    }
  })();

  return {
    ready,
    remove: () => {
      removed = true;
      subscription?.remove?.();
    },
  };
}
