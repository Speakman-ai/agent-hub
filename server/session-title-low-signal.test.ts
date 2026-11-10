import { describe, expect, it, vi } from 'vitest';
import {
  generateLlmTitle,
  isLowSignalTitle,
  pickTurnSessionTitle,
  planTurnSessionTitle,
  scheduleTitleUpgrade,
  shouldRunCliTitleOnTurn,
} from './session-title.js';

const UUID = '92d3cc41-606c-42f1-9798-baf32245d1fa';
const PLACEHOLDER = 'Session 11/10/2026, 5:53:00 PM';

describe('isLowSignalTitle', () => {
  it.each([
    UUID,
    'f6210010-8f05-4b78-ae80-220f682ff276',
    `card ${UUID}`,
    'Cont',
    'continue',
    'fa5ffb1cf',
    'https://hub.example.com/sessions/abc',
    '/home/node/projects/x',
    '#1518',
    '(image attached)',
    'server/chat.ts server/session-title.ts',
    'client/src/App.tsx, mobile/src/App.tsx',
    'README.md CLAUDE.md',
    'C:\\repo\\a.ts D:\\b\\c.ts',
    'foo_bar baz_qux',
    'docs/修复登录.md',
    'key=value other=thing',
    'ryan@example.com bob@example.com',
    'Fix chat.ts',
    'feat(stats): v2.31.250',
    'go ahead',
    'Sounds good',
    'thank you',
    'Thanks!',
    'ok do that now',
    'looks good to me',
    'yes please',
    'keep going',
    'fix it',
    'try again',
    '修',
    'Привет',
    'New chat',
    'Untitled session',
    PLACEHOLDER,
    '',
  ])('treats %j as low-signal', (title) => {
    expect(isLowSignalTitle(title)).toBe(true);
  });

  it.each([
    'previews failing',
    'Ship X',
    'Fix login race in OAuth',
    'Defaced banner fix',
    'Fix crash in server/chat.ts',
    'Bump vite to 6.4.5',
    'Support OAuth2 and IPv6',
    "Don't drop well-known headers",
    '“Quoted” title text',
    '修复 登录 错误',
    '修复登录错误',
    'ログイン修正',
    '로그인 오류 수정',
    'Исправить вход',
    'إصلاح تسجيل الدخول',
    'แก้ไขการเข้าสู่ระบบ',
  ])('keeps %j', (title) => {
    expect(isLowSignalTitle(title)).toBe(false);
  });
});

describe('pickTurnSessionTitle with low-signal messages', () => {
  it.each(['Go ahead', 'Sounds good!', 'Thank you.', 'ok, do that now', 'Yes please'])(
    'does not name a session after the opener %j',
    (content) => {
      expect(
        pickTurnSessionTitle({ currentTitle: PLACEHOLDER, content, priorUserMessages: [] }),
      ).toBeNull();
    },
  );

  it('does not name a session after a first line of file paths', () => {
    expect(
      pickTurnSessionTitle({
        currentTitle: PLACEHOLDER,
        content: 'server/chat.ts server/session-title.ts\nboth crash on startup',
        priorUserMessages: [],
      }),
    ).toBeNull();
  });

  it('still names a session after a short topical opener', () => {
    expect(
      pickTurnSessionTitle({
        currentTitle: PLACEHOLDER,
        content: 'Fix login',
        priorUserMessages: [],
      })?.title,
    ).toBe('Fix login');
  });

  it('does not name a session after a pasted UUID', () => {
    expect(
      pickTurnSessionTitle({ currentTitle: PLACEHOLDER, content: UUID, priorUserMessages: [] }),
    ).toBeNull();
  });

  it('renames an auto UUID title once a real message arrives', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: UUID,
      currentTitleSource: 'auto',
      content: 'Add a week toggle to the stats chart',
      priorUserMessages: [UUID],
    });
    expect(pick?.title).toBe('Add a week toggle to the stats chart');
  });
});

describe('planTurnSessionTitle', () => {
  it('asks the model to name a placeholder session whose opener was an ID', () => {
    const plan = planTurnSessionTitle({
      currentTitle: PLACEHOLDER,
      currentTitleSource: null,
      content: UUID,
      priorUserMessages: [],
      modelAvailable: true,
    });
    expect(plan).toEqual({ write: null, upgradeFrom: PLACEHOLDER });
  });

  it('names the session from the opening message right away', () => {
    const plan = planTurnSessionTitle({
      currentTitle: PLACEHOLDER,
      content: 'Fix the login race',
      priorUserMessages: [],
      modelAvailable: true,
    });
    expect(plan.write?.title).toBe('Fix the login race');
    expect(plan.upgradeFrom).toBe('Fix the login race');
  });

  it('does not chase a later turn synchronously once the session has a real name', () => {
    const base = {
      currentTitle: 'Fix the login race',
      currentTitleSource: 'auto',
      content: 'At the top of this, show session history',
      priorUserMessages: ['Fix the login race'],
    };
    expect(planTurnSessionTitle({ ...base, modelAvailable: true })).toEqual({
      write: null,
      upgradeFrom: 'Fix the login race',
    });
    expect(planTurnSessionTitle({ ...base, modelAvailable: false })).toEqual({
      write: null,
      upgradeFrom: null,
    });
  });

  it('leaves manual names alone', () => {
    const plan = planTurnSessionTitle({
      currentTitle: 'Mine',
      currentTitleSource: 'manual',
      content: 'Fix the login race',
      priorUserMessages: [],
      modelAvailable: true,
    });
    expect(plan).toEqual({ write: null, upgradeFrom: null });
  });
});

describe('shouldRunCliTitleOnTurn', () => {
  it('runs on the first three turns and every fifth after', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 10].map(shouldRunCliTitleOnTurn)).toEqual([
      true,
      true,
      true,
      false,
      false,
      true,
      false,
      true,
    ]);
  });
});

describe('generateLlmTitle keyless fallback', () => {
  it('uses the completer when no API key is configured', async () => {
    const complete = vi.fn(async () => '"Stats page week toggle."\n');
    await expect(generateLlmTitle({ content: 'add a week toggle', complete })).resolves.toBe(
      'Stats page week toggle',
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('falls back to the completer when the keyed call fails', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 }));
    const complete = vi.fn(async () => 'Stats page week toggle');
    await expect(
      generateLlmTitle({ content: 'x', openaiApiKey: 'k', fetchImpl, complete }),
    ).resolves.toBe('Stats page week toggle');
  });

  it('rejects an ID-like model reply', async () => {
    await expect(
      generateLlmTitle({ content: 'x', complete: vi.fn(async () => UUID) }),
    ).resolves.toBeNull();
  });
});

describe('scheduleTitleUpgrade keyless', () => {
  it('upgrades with only a completer', async () => {
    const updateSessionName = vi.fn(() => true);
    const onUpgrade = vi.fn();
    const ok = await scheduleTitleUpgrade({
      sessionId: 's',
      heuristicTitle: PLACEHOLDER,
      content: UUID,
      config: {},
      complete: vi.fn(async () => 'Investigate failed preview boot'),
      getSessionName: () => PLACEHOLDER,
      getSessionTitleSource: () => 'auto',
      updateSessionName,
      onUpgrade,
    });
    expect(ok).toBe(true);
    expect(updateSessionName).toHaveBeenCalledWith(
      'Investigate failed preview boot',
      's',
      PLACEHOLDER,
    );
  });
});
