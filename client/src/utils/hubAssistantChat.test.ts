import { describe, it, expect, beforeEach } from 'vitest';
import {
  getHubAssistantUnread,
  isHubAssistantTranscriptVisible,
  noteHubAssistantTurnDone,
  clearHubAssistantUnread,
  resetHubAssistantUnreadForTests,
  HUB_ASSISTANT_SCROLL_TESTID,
  isHubAssistantSessionActive,
  hubAssistantSessionToRestore,
  shouldReplaceMissingActiveSession,
} from './hubAssistantChat';
import { resetHubChatSessionForTests } from './hubChatSession';

beforeEach(() => {
  resetHubAssistantUnreadForTests();
  resetHubChatSessionForTests();
  document.body.innerHTML = '';
});

describe('hub assistant unread', () => {
  it('counts a finished turn only when the transcript is off screen', () => {
    noteHubAssistantTurnDone(true);
    expect(getHubAssistantUnread()).toBe(0);
    noteHubAssistantTurnDone(false);
    noteHubAssistantTurnDone(false);
    expect(getHubAssistantUnread()).toBe(2);
    clearHubAssistantUnread();
    expect(getHubAssistantUnread()).toBe(0);
  });
});

describe('isHubAssistantTranscriptVisible', () => {
  it('is false when the transcript is not mounted', () => {
    expect(isHubAssistantTranscriptVisible()).toBe(false);
  });

  it('follows whether the transcript has a layout box', () => {
    const el = document.createElement('div');
    el.setAttribute('data-testid', HUB_ASSISTANT_SCROLL_TESTID);
    document.body.appendChild(el);
    // jsdom has no layout: an element inside display:none reports no rects.
    el.getClientRects = () => [] as unknown as DOMRectList;
    expect(isHubAssistantTranscriptVisible()).toBe(false);
    el.getClientRects = () => [{}] as unknown as DOMRectList;
    expect(isHubAssistantTranscriptVisible()).toBe(true);
  });
});

describe('hub assistant session isolation', () => {
  it('shows the transcript only while the Hub session is active', () => {
    expect(isHubAssistantSessionActive('hub-1', 'hub-1')).toBe(true);
    expect(isHubAssistantSessionActive('project-1', 'hub-1')).toBe(false);
    expect(isHubAssistantSessionActive('project-1', null)).toBe(false);
    expect(isHubAssistantSessionActive(null, null)).toBe(false);
  });

  it('re-selects the Hub session when a project session took over the DM', () => {
    expect(
      hubAssistantSessionToRestore({
        inChat: true,
        activeSessionId: 'project-1',
        hubSessionId: 'hub-1',
      }),
    ).toBe('hub-1');
    expect(
      hubAssistantSessionToRestore({ inChat: true, activeSessionId: null, hubSessionId: 'hub-1' }),
    ).toBe('hub-1');
    expect(
      hubAssistantSessionToRestore({
        inChat: true,
        activeSessionId: 'hub-1',
        hubSessionId: 'hub-1',
      }),
    ).toBeNull();
    expect(
      hubAssistantSessionToRestore({
        inChat: false,
        activeSessionId: 'project-1',
        hubSessionId: 'hub-1',
      }),
    ).toBeNull();
    expect(
      hubAssistantSessionToRestore({
        inChat: true,
        activeSessionId: 'project-1',
        hubSessionId: null,
      }),
    ).toBeNull();
  });

  it('keeps the Hub session when a project agent list refresh omits it', () => {
    expect(shouldReplaceMissingActiveSession('hub-1', ['project-1', 'project-2'], 'hub-1')).toBe(
      false,
    );
    expect(shouldReplaceMissingActiveSession('gone', ['project-1'], 'hub-1')).toBe(true);
    expect(shouldReplaceMissingActiveSession('project-1', ['project-1'], 'hub-1')).toBe(false);
    expect(shouldReplaceMissingActiveSession(null, ['project-1'], 'hub-1')).toBe(false);
  });
});
