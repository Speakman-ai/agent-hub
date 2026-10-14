import { describe, it, expect, beforeEach } from 'vitest';
import {
  getHubAssistantUnread,
  isHubAssistantTranscriptVisible,
  noteHubAssistantTurnDone,
  clearHubAssistantUnread,
  resetHubAssistantUnreadForTests,
  selectHubAssistantDm,
  HUB_ASSISTANT_CHANNEL_ID,
  HUB_ASSISTANT_SCROLL_TESTID,
} from './hubAssistantChat';
import { getHubChatSession, resetHubChatSessionForTests } from './hubChatSession';

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

  it('opening the DM selects it and clears the badge', () => {
    noteHubAssistantTurnDone(false);
    selectHubAssistantDm();
    expect(getHubChatSession().selectedId).toBe(HUB_ASSISTANT_CHANNEL_ID);
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
