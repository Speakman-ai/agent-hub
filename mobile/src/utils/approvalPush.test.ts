import { describe, expect, it, vi } from 'vitest';
import {
  answerFromPushResponse,
  listenForNotificationResponses,
  registerApprovalPushCategory,
} from './approvalPush';

function response(actionIdentifier: string, data: Record<string, unknown>) {
  return { actionIdentifier, notification: { request: { identifier: 'n1', content: { data } } } };
}

describe('registerApprovalPushCategory', () => {
  it('registers Allow once / Deny that unlock and open the app', async () => {
    const setNotificationCategoryAsync = vi.fn().mockResolvedValue({});
    expect(await registerApprovalPushCategory({ setNotificationCategoryAsync })).toBe(true);
    expect(setNotificationCategoryAsync).toHaveBeenCalledWith('approval_requested', [
      {
        identifier: 'allow_once',
        buttonTitle: 'Allow once',
        options: {
          opensAppToForeground: true,
          isDestructive: false,
          isAuthenticationRequired: true,
        },
      },
      {
        identifier: 'deny',
        buttonTitle: 'Deny',
        options: {
          opensAppToForeground: true,
          isDestructive: true,
          isAuthenticationRequired: true,
        },
      },
    ]);
  });

  it('is a no-op without the native API and swallows failures', async () => {
    expect(await registerApprovalPushCategory({})).toBe(false);
    const failing = vi.fn().mockRejectedValue(new Error('nope'));
    expect(await registerApprovalPushCategory({ setNotificationCategoryAsync: failing })).toBe(
      false,
    );
  });
});

describe('answerFromPushResponse', () => {
  const data = { type: 'approval_requested', category: 'approval_requested', approvalId: 'ap1' };

  it('answers an Allow once press', async () => {
    const answer = vi.fn().mockResolvedValue({});
    const out = await answerFromPushResponse(response('allow_once', data), answer);
    expect(answer).toHaveBeenCalledWith('ap1', 'allow_once');
    expect(out).toEqual({ handled: true, approvalId: 'ap1', decision: 'allow_once', ok: true });
  });

  it('answers a Deny press on a foreground banner that nests the approval', async () => {
    const answer = vi.fn().mockResolvedValue({});
    await answerFromPushResponse(
      response('deny', {
        event: 'approval_requested',
        type: 'approval_requested',
        approval: { id: 'ap2' },
      }),
      answer,
    );
    expect(answer).toHaveBeenCalledWith('ap2', 'deny');
  });

  it('leaves plain taps and non-approval pushes to the router', async () => {
    const answer = vi.fn();
    expect(
      await answerFromPushResponse(
        response('expo.modules.notifications.actions.DEFAULT', data),
        answer,
      ),
    ).toEqual({ handled: false });
    expect(
      await answerFromPushResponse(response('deny', { type: 'awaiting_input' }), answer),
    ).toEqual({ handled: false });
    expect(await answerFromPushResponse(null, answer)).toEqual({ handled: false });
    expect(answer).not.toHaveBeenCalled();
  });

  it('treats 409 as settled and reports other failures', async () => {
    const conflict = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('already answered'), { status: 409 }));
    expect(await answerFromPushResponse(response('deny', data), conflict)).toMatchObject({
      handled: true,
      ok: true,
    });
    const down = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await answerFromPushResponse(response('deny', data), down)).toMatchObject({
      handled: true,
      ok: false,
      error: 'offline',
    });
  });
});

function press(id: string, action: string, approvalId: string) {
  return {
    actionIdentifier: action,
    notification: {
      request: {
        identifier: id,
        content: {
          data: { type: 'approval_requested', category: 'approval_requested', approvalId },
        },
      },
    },
  };
}

function fakeNotifications(last: unknown) {
  let listener: ((r: unknown) => void) | null = null;
  const remove = vi.fn();
  return {
    deliver: (r: unknown) => listener?.(r),
    hasListener: () => listener !== null,
    remove,
    api: {
      addNotificationResponseReceivedListener: vi.fn((cb: (r: unknown) => void) => {
        listener = cb;
        return { remove };
      }),
      getLastNotificationResponseAsync: vi.fn(async () => last),
      dismissNotificationAsync: vi.fn(async () => {}),
    },
  };
}

describe('listenForNotificationResponses', () => {
  it('answers a press delivered while the cold-start answer is still in flight', async () => {
    const cold = press('n1', 'allow_once', 'ap1');
    const n = fakeNotifications(cold);
    let finishFirst!: () => void;
    const answer = vi.fn((id: string) =>
      id === 'ap1'
        ? new Promise<void>((res) => {
            finishFirst = res;
          })
        : Promise.resolve(),
    );
    const handlers = { answer, route: vi.fn(), onAnswerFailed: vi.fn() };
    const { ready } = listenForNotificationResponses(n.api, handlers);
    // Listener exists before the cold-start snapshot is even read.
    expect(n.hasListener()).toBe(true);
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith('ap1', 'allow_once'));
    n.deliver(press('n2', 'deny', 'ap2'));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledWith('ap2', 'deny'));
    finishFirst();
    await ready;
    expect(n.api.dismissNotificationAsync).toHaveBeenCalledWith('n1');
    expect(n.api.dismissNotificationAsync).toHaveBeenCalledWith('n2');
    expect(handlers.route).not.toHaveBeenCalled();
  });

  it('dismisses the notification when the approval was already answered (409)', async () => {
    const n = fakeNotifications(null);
    const answer = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('already answered'), { status: 409 }));
    const handlers = { answer, route: vi.fn(), onAnswerFailed: vi.fn() };
    const { ready } = listenForNotificationResponses(n.api, handlers);
    await ready;
    n.deliver(press('n5', 'allow_once', 'ap5'));
    await vi.waitFor(() => expect(n.api.dismissNotificationAsync).toHaveBeenCalledWith('n5'));
    expect(handlers.onAnswerFailed).not.toHaveBeenCalled();
  });

  it('answers a press once when the listener and cold start both see it', async () => {
    const cold = press('n1', 'deny', 'ap1');
    const n = fakeNotifications(cold);
    let finish!: () => void;
    const answer = vi.fn(
      () =>
        new Promise<void>((res) => {
          finish = res;
        }),
    );
    const { ready } = listenForNotificationResponses(n.api, {
      answer,
      route: vi.fn(),
      onAnswerFailed: vi.fn(),
    });
    n.deliver(cold);
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(1));
    finish();
    await ready;
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('routes plain taps, reports failures and allows a retry', async () => {
    const n = fakeNotifications(null);
    const answer = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    const handlers = { answer, route: vi.fn(), onAnswerFailed: vi.fn() };
    const { ready, remove } = listenForNotificationResponses(n.api, handlers);
    await ready;
    n.deliver({
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: { request: { identifier: 'n3', content: { data: { sessionId: 's1' } } } },
    });
    await vi.waitFor(() => expect(handlers.route).toHaveBeenCalledWith({ sessionId: 's1' }));
    n.deliver(press('n4', 'deny', 'ap4'));
    await vi.waitFor(() => expect(handlers.onAnswerFailed).toHaveBeenCalledWith('offline'));
    // The approval is still pending, so its notification and buttons stay.
    expect(n.api.dismissNotificationAsync).not.toHaveBeenCalled();
    n.deliver(press('n4', 'deny', 'ap4'));
    await vi.waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(n.api.dismissNotificationAsync).toHaveBeenCalledWith('n4'));
    remove();
    expect(n.remove).toHaveBeenCalled();
  });
});
