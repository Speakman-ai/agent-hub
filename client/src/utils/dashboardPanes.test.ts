import { describe, it, expect } from 'vitest';
import {
  googlePaneState,
  calendarPaneState,
  mailPaneState,
  isGooglePaneReady,
  paneAccountNotices,
  paneAccountNoticeText,
  type DashboardGoogleLike,
} from './dashboardPanes';

describe('dashboardPanes gating', () => {
  describe('googlePaneState', () => {
    it('is not-configured when the block is missing or the server has no OAuth app', () => {
      expect(googlePaneState(null, true)).toBe('not-configured');
      expect(googlePaneState(undefined, true)).toBe('not-configured');
      expect(googlePaneState({}, true)).toBe('not-configured');
      expect(googlePaneState({ configured: false, connected: true }, true)).toBe('not-configured');
    });

    it('asks to connect when configured but the user has not linked Google', () => {
      expect(googlePaneState({ configured: true, connected: false }, true)).toBe('connect');
      // scope granted is irrelevant while disconnected
      expect(googlePaneState({ configured: true, connected: false }, false)).toBe('connect');
    });

    it('asks to reconnect when the token is stale, before checking scope', () => {
      expect(
        googlePaneState({ configured: true, connected: true, reconnectRequired: true }, true),
      ).toBe('reconnect');
      expect(
        googlePaneState({ configured: true, connected: true, reconnectRequired: true }, false),
      ).toBe('reconnect');
    });

    it('asks for scope when connected but the surface scope is not granted', () => {
      expect(googlePaneState({ configured: true, connected: true }, false)).toBe('scope-required');
    });

    it('is ready when configured, connected, fresh, and scope-granted', () => {
      expect(googlePaneState({ configured: true, connected: true }, true)).toBe('ready');
      expect(
        googlePaneState({ configured: true, connected: true, reconnectRequired: false }, true),
      ).toBe('ready');
    });
  });

  describe('calendarPaneState / mailPaneState', () => {
    const base: DashboardGoogleLike = {
      configured: true,
      connected: true,
      reconnectRequired: false,
    };

    it('reads each surface scope independently from the payload', () => {
      const google: DashboardGoogleLike = {
        ...base,
        calendar: { scopeGranted: true },
        mail: { scopeGranted: false },
      };
      expect(calendarPaneState(google)).toBe('ready');
      expect(mailPaneState(google)).toBe('scope-required');
    });

    it('treats a missing surface sub-block as scope-not-granted', () => {
      expect(calendarPaneState(base)).toBe('scope-required');
      expect(mailPaneState(base)).toBe('scope-required');
      expect(calendarPaneState({ ...base, calendar: null })).toBe('scope-required');
    });

    it('propagates connect/not-configured regardless of surface scope', () => {
      expect(calendarPaneState({ configured: false, calendar: { scopeGranted: true } })).toBe(
        'not-configured',
      );
      expect(
        mailPaneState({ configured: true, connected: false, mail: { scopeGranted: true } }),
      ).toBe('connect');
    });
  });

  describe('isGooglePaneReady', () => {
    it('is true only for the ready state', () => {
      expect(isGooglePaneReady('ready')).toBe(true);
      for (const s of ['not-configured', 'connect', 'reconnect', 'scope-required'] as const) {
        expect(isGooglePaneReady(s)).toBe(false);
      }
    });
  });

  describe('multi-account gating', () => {
    const google: DashboardGoogleLike = {
      configured: true,
      connected: true,
      reconnectRequired: false,
      calendar: { scopeGranted: false },
      mail: { scopeGranted: false },
      accounts: [
        { accountId: 'a', email: 'a@x.com', reconnectRequired: true, calendarScopeGranted: true },
        {
          accountId: 'b',
          email: 'b@x.com',
          calendarScopeGranted: true,
          mailScopeGranted: false,
          calendarError: null,
        },
        {
          accountId: 'c',
          email: 'c@x.com',
          calendarScopeGranted: true,
          mailScopeGranted: true,
          calendarError: 'quota',
        },
      ],
    };

    it('is ready when any usable account holds the surface scope', () => {
      expect(calendarPaneState(google)).toBe('ready');
      expect(mailPaneState(google)).toBe('ready');
      expect(
        mailPaneState({ ...google, accounts: google.accounts!.filter((a) => a.accountId !== 'c') }),
      ).toBe('scope-required');
    });

    it('lists the accounts a live pane is leaving out', () => {
      const notices = paneAccountNotices(google, 'calendar');
      expect(notices.map((n) => [n.accountId, n.reason])).toEqual([
        ['a', 'reconnect'],
        ['c', 'error'],
      ]);
      expect(paneAccountNoticeText(notices[1], 'calendar')).toBe('c@x.com: quota');
      expect(paneAccountNotices(google, 'mail').map((n) => n.reason)).toEqual([
        'reconnect',
        'scope-required',
      ]);
    });
  });
});
