import { describe, expect, it } from 'vitest';
import {
  bustPreviewUrl,
  previewLoadUrl,
  previewTicketAllowed,
  withPreviewTicket,
} from './previewUrl';

describe('previewLoadUrl', () => {
  it('rewrites a loopback dev-server URL onto the Hub host the phone is using', () => {
    expect(previewLoadUrl('http://localhost:4173/', 'https://local.agenthub.com')).toBe(
      'http://local.agenthub.com:4173/',
    );
  });

  it('leaves localhost alone when the Hub itself is on this machine', () => {
    expect(previewLoadUrl('http://127.0.0.1:3000/app', 'http://127.0.0.1:3052')).toBe(
      'http://127.0.0.1:3000/app',
    );
  });

  it('joins a relative proxy path to the Hub origin', () => {
    expect(previewLoadUrl('/api/sessions/s1/preview/proxy/', 'https://hub.example')).toBe(
      'https://hub.example/api/sessions/s1/preview/proxy/',
    );
  });
});

describe('preview tickets', () => {
  const SID = '11111111-1111-1111-1111-111111111111';
  const OTHER = '22222222-2222-2222-2222-222222222222';
  const hubScope = { hubBase: 'https://hub.example', sessionId: SID };
  const subScope = {
    hubBase: 'https://hub.example',
    sessionId: SID,
    reportedUrl: `https://${SID}.preview.example/`,
  };

  it("allows this session's proxy path on the Hub and its preview subdomains", () => {
    expect(
      previewTicketAllowed(`https://hub.example/api/sessions/${SID}/preview/proxy/a?b=1`, hubScope),
    ).toBe(true);
    expect(previewTicketAllowed(`https://${SID}.preview.example/x`, subScope)).toBe(true);
    expect(previewTicketAllowed(`https://5173--${SID}.preview.example/`, subScope)).toBe(true);
  });

  it('never allows an unrelated host, even with a proxy-looking path', () => {
    const attacks = [
      `https://attacker.example/api/sessions/${SID}/preview/proxy/`,
      `https://hub.example.attacker.example/api/sessions/${SID}/preview/proxy/`,
      `http://hub.example/api/sessions/${SID}/preview/proxy/`,
      `https://hub.example/api/sessions/${OTHER}/preview/proxy/`,
      `https://hub.example/api/sessions/${SID}/preview/proxyx`,
      `https://hub.example/api/sessions/${SID}/other`,
      `https://${SID}.attacker.example/`,
      `https://${SID}.preview.example.attacker.example/`,
      `https://${OTHER}.preview.example/`,
      `http://${SID}.preview.example/`,
      `https://x.${SID}.preview.example/`,
      'javascript:alert(1)',
      'not a url',
    ];
    for (const url of attacks) {
      expect(previewTicketAllowed(url, subScope), url).toBe(false);
    }
    // A UUID subdomain alone is not trusted without a reported preview there.
    expect(previewTicketAllowed(`https://${SID}.preview.example/`, hubScope)).toBe(false);
  });

  it('never needs a ticket for a direct dev-server port', () => {
    expect(previewTicketAllowed('http://macserver.local:4173/', subScope)).toBe(false);
  });

  it('appends the ticket and a cache buster without dropping the path', () => {
    const ticketed = withPreviewTicket('https://hub.example/api/sessions/s1/preview/proxy/', 'abc');
    expect(ticketed).toContain('ticket=abc');
    expect(bustPreviewUrl(ticketed, 4)).toContain('_ah=4');
  });
});
