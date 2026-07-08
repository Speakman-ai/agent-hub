import { describe, it, expect } from 'vitest';
import {
    googlePaneState,
    calendarPaneState,
    mailPaneState,
    isGooglePaneReady,
    type DashboardGoogleLike,
} from './dashboardPanes';

describe('dashboardPanes gating (mobile parity)', () => {
    describe('googlePaneState', () => {
        it('is not-configured when the block is missing or the server has no OAuth app', () => {
            expect(googlePaneState(null, true)).toBe('not-configured');
            expect(googlePaneState(undefined, true)).toBe('not-configured');
            expect(googlePaneState({}, true)).toBe('not-configured');
            expect(googlePaneState({ configured: false, connected: true }, true)).toBe(
                'not-configured',
            );
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
                googlePaneState(
                    { configured: true, connected: true, reconnectRequired: true },
                    false,
                ),
            ).toBe('reconnect');
        });

        it('asks for scope when connected but the surface scope is not granted', () => {
            expect(googlePaneState({ configured: true, connected: true }, false)).toBe(
                'scope-required',
            );
        });

        it('is ready when configured, connected, fresh, and scope-granted', () => {
            expect(googlePaneState({ configured: true, connected: true }, true)).toBe('ready');
            expect(
                googlePaneState(
                    { configured: true, connected: true, reconnectRequired: false },
                    true,
                ),
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
});
