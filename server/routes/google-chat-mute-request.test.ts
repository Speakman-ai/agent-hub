/**
 * The Google mirror of a Hub mute, run through the real googleapis Chat client
 * (no googleapis mock) so the test sees the request the client actually
 * builds. A fake auth client captures it instead of sending it.
 */
import { describe, it, expect } from 'vitest';
import { google } from 'googleapis';
import { patchSpaceMuteSetting } from './google-chat.js';

function capturingChat() {
  const sent: any[] = [];
  const auth = {
    getUniverseDomain: async () => 'googleapis.com',
    request: async (opts: any) => {
      sent.push(opts);
      return { data: {}, status: 200, headers: {}, config: opts };
    },
  };
  return { chat: google.chat({ version: 'v1', auth: auth as any }), sent };
}

describe('patchSpaceMuteSetting', () => {
  it.each([
    [true, 'MUTED'],
    [false, 'UNMUTED'],
  ] as const)('muted=%s sends a PATCH with muteSetting %s', async (muted, setting) => {
    const { chat, sent } = capturingChat();
    await patchSpaceMuteSetting(chat, 'AAA', muted);

    expect(sent).toHaveLength(1);
    const req = sent[0];
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe(
      'https://chat.googleapis.com/v1/users/me/spaces/AAA/spaceNotificationSetting',
    );
    // gaxios appends `params` to the URL as the query string.
    expect(req.params).toEqual({ updateMask: 'muteSetting' });
    const body = typeof req.data === 'string' ? JSON.parse(req.data) : req.data;
    expect(body).toEqual({
      name: 'users/me/spaces/AAA/spaceNotificationSetting',
      muteSetting: setting,
    });
  });

  it('the client rejects the REST reference key without `name`', async () => {
    const { chat, sent } = capturingChat();
    await expect(
      chat.users.spaces.spaceNotificationSetting.patch({
        'spaceNotificationSetting.name': 'users/me/spaces/AAA/spaceNotificationSetting',
        updateMask: 'muteSetting',
        requestBody: { muteSetting: 'MUTED' },
      } as any),
    ).rejects.toThrow(/Missing required parameters: name/);
    expect(sent).toHaveLength(0);
  });
});
