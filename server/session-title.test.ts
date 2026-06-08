import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_TITLE_ANTHROPIC_MODEL,
  deriveHeuristicTitle,
  generateLlmTitle,
  pickInitialSessionTitle,
  pickTurnSessionTitle,
  scheduleTitleUpgrade,
  shouldPersistTurnSessionTitlePick,
  titleSourceForPick,
  type LlmTitleOptions,
} from './session-title.js';

describe('deriveHeuristicTitle', () => {
  it('returns "New chat" for empty input', () => {
    expect(deriveHeuristicTitle('')).toBe('New chat');
    expect(deriveHeuristicTitle('   ')).toBe('New chat');
  });

  it('returns "New chat" for non-string input', () => {
    expect(deriveHeuristicTitle(undefined as unknown as string)).toBe('New chat');
    expect(deriveHeuristicTitle(null as unknown as string)).toBe('New chat');
  });

  it('strips conversational filler at the start', () => {
    expect(deriveHeuristicTitle('Hey, can you fix the login bug?')).toBe('Fix the login bug?');
    expect(deriveHeuristicTitle('Hi! Please help me migrate this script.')).toBe(
      'Migrate this script',
    );
    expect(deriveHeuristicTitle("Let's refactor the kanban routes")).toBe(
      'Refactor the kanban routes',
    );
    expect(deriveHeuristicTitle('I want to add a new endpoint for webhooks.')).toBe(
      'Add a new endpoint for webhooks',
    );
  });

  it('takes the first sentence only', () => {
    expect(deriveHeuristicTitle('Fix the bug. Also rewrite the docs. Also lunch.')).toBe(
      'Fix the bug',
    );
  });

  it('only reads the first line for multi-line input', () => {
    expect(deriveHeuristicTitle('Find the issue in the parser\n```js\nconst x = 1;\n```')).toBe(
      'Find the issue in the parser',
    );
  });

  it('preserves question marks', () => {
    expect(deriveHeuristicTitle('Why does my login fail with 401?')).toBe(
      'Why does my login fail with 401?',
    );
  });

  it('truncates at a word boundary, no trailing ellipsis', () => {
    const long =
      'Investigate the streaming WebSocket reconnect logic in chat.ts because messages get duplicated after a network blip';
    const out = deriveHeuristicTitle(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('...')).toBe(false);
    expect(out.endsWith(' ')).toBe(false);
    // Should land on a word boundary inside the first ~60 chars.
    expect(out.split(' ').length).toBeGreaterThan(3);
  });

  it('strips a trailing period but keeps `?` and `!`', () => {
    expect(deriveHeuristicTitle('Add a settings page.')).toBe('Add a settings page');
    expect(deriveHeuristicTitle('Is the build green?')).toBe('Is the build green?');
    expect(deriveHeuristicTitle('Ship it!')).toBe('Ship it!');
  });

  it('falls back to the raw text when filler eats the whole sentence', () => {
    const out = deriveHeuristicTitle('please');
    // After filler strip the candidate is empty; fall back to raw and capitalize.
    expect(out).toBe('Please');
  });

  it('handles inputs with no letters', () => {
    const out = deriveHeuristicTitle('?!?!?!');
    // No letters → bypass filler/case logic. Should still return something short.
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).not.toBe('');
  });

  it('does not re-case identifiers the user typed', () => {
    expect(deriveHeuristicTitle('camelCaseFunction is broken')).toBe('camelCaseFunction is broken');
    expect(deriveHeuristicTitle('PascalCaseThing failing')).toBe('PascalCaseThing failing');
    expect(deriveHeuristicTitle('api.test.ts is timing out')).toBe('api.test.ts is timing out');
  });

  it('strips leading quotes and Markdown chrome', () => {
    expect(deriveHeuristicTitle('> can you take a look at this?')).toBe('Take a look at this?');
    expect(deriveHeuristicTitle('"please update the readme"')).toBe('Update the readme');
  });

  it('caps very long single-word input at 60 chars without trailing space', () => {
    const long = 'a'.repeat(120);
    const out = deriveHeuristicTitle(long);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith(' ')).toBe(false);
  });

  it('handles a single short word', () => {
    expect(deriveHeuristicTitle('Bug')).toBe('Bug');
  });

  it('handles emoji-only inputs', () => {
    const out = deriveHeuristicTitle('🎉🎉🎉');
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).not.toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('pickInitialSessionTitle', () => {
  it('prefers the explicit hint over everything else', () => {
    const pick = pickInitialSessionTitle({
      content: 'fix the streaming reconnect bug',
      explicitTitle: 'Hook: investigate stream drop',
      linkedCardTitle: 'Card: streaming bug',
    });
    expect(pick).toEqual({
      title: 'Hook: investigate stream drop',
      source: 'hint',
      usedHeuristic: false,
    });
  });

  it('falls back to the linked card title when no hint is set', () => {
    const pick = pickInitialSessionTitle({
      content: 'lets get going',
      explicitTitle: null,
      linkedCardTitle: 'Rename session on first user message',
    });
    expect(pick).toEqual({
      title: 'Rename session on first user message',
      source: 'card',
      usedHeuristic: false,
    });
  });

  it('falls back to the heuristic when neither hint nor card is provided', () => {
    const pick = pickInitialSessionTitle({
      content: 'Hey can you fix the streaming reconnect bug',
    });
    expect(pick.source).toBe('heuristic');
    expect(pick.usedHeuristic).toBe(true);
    expect(pick.title).toBe('Fix the streaming reconnect bug');
  });

  it('treats whitespace-only hint / card values as missing', () => {
    const pick = pickInitialSessionTitle({
      content: 'investigate webhook replay errors',
      explicitTitle: '   ',
      linkedCardTitle: '\n\t',
    });
    expect(pick.source).toBe('heuristic');
    expect(pick.usedHeuristic).toBe(true);
    expect(pick.title).toBe('Investigate webhook replay errors');
  });

  it('always returns a non-empty title even for empty content', () => {
    const pick = pickInitialSessionTitle({ content: '' });
    expect(pick.title).toBe('New chat');
    expect(pick.source).toBe('heuristic');
    expect(pick.usedHeuristic).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('pickTurnSessionTitle', () => {
  it('renames a placeholder title on the first user message', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Session 6/8/2026, 3:39 AM',
      content: 'After each turn, rename sessions by subject',
      priorUserMessages: [],
    });

    expect(pick).toEqual({
      title: 'After each turn, rename sessions by subject',
      source: 'heuristic',
      usedHeuristic: true,
    });
  });

  it('renames an auto title on a follow-up user turn', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Investigate webhook replay errors',
      currentTitleSource: 'auto',
      content: 'Now can we fix the mobile preview refresh button?',
      priorUserMessages: ['Investigate webhook replay errors'],
    });

    expect(pick?.title).toBe('Fix the mobile preview refresh button?');
    expect(pick?.source).toBe('heuristic');
    expect(pick?.usedHeuristic).toBe(true);
  });

  it('does not rewrite an auto title to the same heuristic title', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Fix the mobile preview refresh button?',
      currentTitleSource: 'auto',
      content: 'Now can we fix the mobile preview refresh button?',
      priorUserMessages: ['Can we fix the mobile preview refresh button?'],
    });

    expect(pick).toBeNull();
  });

  it('keeps the current auto title for generic continuation prompts', () => {
    for (const content of ['ok', 'continue', 'what about tests?', 'fix it']) {
      expect(
        pickTurnSessionTitle({
          currentTitle: 'Fix the mobile preview refresh button?',
          currentTitleSource: 'auto',
          content,
          priorUserMessages: ['Can we fix the mobile preview refresh button?'],
        }),
      ).toBeNull();
    }
  });

  it('keeps renaming after an LLM-upgraded auto title', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Webhook Replay Failure Triage',
      currentTitleSource: 'auto',
      content: 'Switch the topic to the finalize checks panel',
      priorUserMessages: ['why are webhook replays failing today'],
    });

    expect(pick?.title).toBe('Switch the topic to the finalize checks panel');
  });

  it('does not infer legacy LLM-upgraded titles from fuzzy overlap', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Webhook Replay Failure Triage',
      currentTitleSource: null,
      content: 'Switch the topic to the finalize checks panel',
      priorUserMessages: ['why are webhook replays failing today'],
    });

    expect(pick).toBeNull();
  });

  it('keeps legacy auto titles working when title_source is absent', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Investigate webhook replay errors',
      currentTitleSource: null,
      content: 'Switch the topic to release notes',
      priorUserMessages: ['investigate webhook replay errors'],
    });

    expect(pick?.title).toBe('Switch the topic to release notes');
  });

  it('promotes auto titles to linked card titles on follow-up turns', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Investigate webhook replay errors',
      currentTitleSource: 'auto',
      content: 'Can we discuss something else?',
      priorUserMessages: ['investigate webhook replay errors'],
      linkedCardTitle: 'Rename session after each turn',
    });

    expect(pick).toEqual({
      title: 'Rename session after each turn',
      source: 'card',
      usedHeuristic: false,
    });
  });

  it('promotes same-text auto titles to linked card ownership', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Rename session after each turn',
      currentTitleSource: 'auto',
      content: 'Can we discuss something else?',
      priorUserMessages: ['rename session after each turn'],
      linkedCardTitle: 'Rename session after each turn',
    });

    expect(pick).toEqual({
      title: 'Rename session after each turn',
      source: 'card',
      usedHeuristic: false,
    });
    expect(shouldPersistTurnSessionTitlePick(pick, 'Rename session after each turn', 'auto')).toBe(
      true,
    );
  });

  it('does not promote unrelated legacy manual titles to linked card titles', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Pinned planning title',
      currentTitleSource: null,
      content: 'Can we discuss something else?',
      priorUserMessages: ['investigate webhook replay errors'],
      linkedCardTitle: 'Rename session after each turn',
    });

    expect(pick).toBeNull();
  });

  it('does not clobber titles with unknown ownership values', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Imported title',
      currentTitleSource: 'imported',
      content: 'Can we discuss something else?',
      priorUserMessages: ['investigate webhook replay errors'],
      explicitTitle: 'Hook title for this turn',
      linkedCardTitle: 'Rename session after each turn',
    });

    expect(pick).toBeNull();
  });

  it('honors hook-provided title hints on follow-up turns', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Investigate webhook replay errors',
      currentTitleSource: 'auto',
      content: 'raw content that should not become the title',
      priorUserMessages: ['investigate webhook replay errors'],
      explicitTitle: 'Hook title for this turn',
    });

    expect(pick).toEqual({
      title: 'Hook title for this turn',
      source: 'hint',
      usedHeuristic: false,
    });
  });

  it('persists same-text hook hints by changing ownership source', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Hook title for this turn',
      currentTitleSource: 'auto',
      content: 'raw content that should not become the title',
      priorUserMessages: ['old raw content'],
      explicitTitle: 'Hook title for this turn',
    });

    expect(pick).toEqual({
      title: 'Hook title for this turn',
      source: 'hint',
      usedHeuristic: false,
    });
    expect(shouldPersistTurnSessionTitlePick(pick, 'Hook title for this turn', 'auto')).toBe(true);
  });

  it('does not promote unrelated legacy manual titles to hook hints', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Pinned planning title',
      currentTitleSource: null,
      content: 'raw content that should not become the title',
      priorUserMessages: ['investigate webhook replay errors'],
      explicitTitle: 'Hook title for this turn',
    });

    expect(pick).toBeNull();
  });

  it('does not replace an existing hook-pinned title with a later hook hint', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Pinned hook title',
      currentTitleSource: 'hint',
      content: 'raw content that should not become the title',
      priorUserMessages: ['investigate webhook replay errors'],
      explicitTitle: 'Later hook title',
    });

    expect(pick).toBeNull();
  });

  it('does not treat unrelated legacy manual titles as auto-owned', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Pinned planning title',
      currentTitleSource: null,
      content: 'Switch the topic to release notes',
      priorUserMessages: ['investigate webhook replay errors'],
    });

    expect(pick).toBeNull();
  });

  it('does not treat overlapping legacy manual titles as auto-owned', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Webhook investigation',
      currentTitleSource: null,
      content: 'Switch the topic to release notes',
      priorUserMessages: ['why are webhook failures happening'],
    });

    expect(pick).toBeNull();
  });

  it('does not clobber legacy manual titles that summarize prior content', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Release Notes',
      currentTitleSource: null,
      content: 'Now rename each session after the current turn subject',
      priorUserMessages: ['Can we draft release notes for the new finalize workflow?'],
      explicitTitle: 'Hook title for this turn',
      linkedCardTitle: 'Rename session after each turn',
    });

    expect(pick).toBeNull();
  });

  it('does not treat manual Session-prefixed legacy titles as placeholders', () => {
    const pick = pickTurnSessionTitle({
      currentTitle: 'Session replay investigation',
      currentTitleSource: null,
      content: 'Switch the topic to release notes',
      priorUserMessages: ['old subject'],
      explicitTitle: 'Hook title for this turn',
      linkedCardTitle: 'Rename session after each turn',
    });

    expect(pick).toBeNull();
  });

  it('does not clobber manual, card, or hook titles', () => {
    for (const source of ['manual', 'card', 'hint']) {
      expect(
        pickTurnSessionTitle({
          currentTitle: 'Pinned title',
          currentTitleSource: source,
          content: 'rename this',
          priorUserMessages: ['old subject'],
        }),
      ).toBeNull();
    }
  });

  it('maps heuristic picks to the auto title source', () => {
    expect(titleSourceForPick('heuristic')).toBe('auto');
    expect(titleSourceForPick('card')).toBe('card');
    expect(titleSourceForPick('hint')).toBe('hint');
  });
});

// ---------------------------------------------------------------------------

describe('generateLlmTitle', () => {
  it('returns null when no API key is configured', async () => {
    const out = await generateLlmTitle({ content: 'Fix the bug' });
    expect(out).toBeNull();
  });

  it('returns null on empty content', async () => {
    const out = await generateLlmTitle({
      content: '',
      anthropicApiKey: 'sk-ant-test',
    });
    expect(out).toBeNull();
  });

  it('calls the Anthropic API and returns the cleaned text', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '  "Fix Streaming Reconnect Bug"  ' }],
      }),
    })) as unknown as typeof fetch;

    const out = await generateLlmTitle({
      content: 'Hey can you fix the streaming reconnect bug in chat.ts?',
      anthropicApiKey: 'sk-ant-test',
      fetchImpl,
    });

    expect(out).toBe('Fix Streaming Reconnect Bug');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
    const body = JSON.parse(init.body as string);
    // Pin to the shared default so the next Haiku bump touches the exported
    // constant (and `claude-auth.ts` etc.) in lockstep, not this test.
    expect(body.model).toBe(DEFAULT_TITLE_ANTHROPIC_MODEL);
    expect(body.model).toBe('claude-haiku-4-6');
    expect(body.messages[0].content).toContain('chat.ts');
  });

  it('falls back to OpenAI when no Anthropic key is set', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Investigate Webhook Replay Errors' } }],
      }),
    })) as unknown as typeof fetch;

    const out = await generateLlmTitle({
      content: 'why are webhook replays failing today',
      openaiApiKey: 'sk-test',
      fetchImpl,
    });

    expect(out).toBe('Investigate Webhook Replay Errors');
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('prefers Anthropic over OpenAI when both keys are present', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'A Title' }] }),
    })) as unknown as typeof fetch;

    await generateLlmTitle({
      content: 'task',
      anthropicApiKey: 'sk-ant',
      openaiApiKey: 'sk-oai',
      fetchImpl,
    });

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('returns null when the API responds non-ok', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    const out = await generateLlmTitle({
      content: 'anything',
      anthropicApiKey: 'sk-ant',
      fetchImpl,
    });
    expect(out).toBeNull();
  });

  it('returns null when the API throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const out = await generateLlmTitle({
      content: 'anything',
      anthropicApiKey: 'sk-ant',
      fetchImpl,
    });
    expect(out).toBeNull();
  });

  it('returns null when the response shape is unexpected', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ surprise: 'no content here' }),
    })) as unknown as typeof fetch;

    const out = await generateLlmTitle({
      content: 'x',
      anthropicApiKey: 'sk-ant',
      fetchImpl,
    });
    expect(out).toBeNull();
  });

  it('caps the title at 60 chars even if the model is verbose', async () => {
    const verbose =
      'A really really really really really really really really really long title that keeps going';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: verbose }] }),
    })) as unknown as typeof fetch;

    const out = await generateLlmTitle({
      content: 'x',
      anthropicApiKey: 'sk-ant',
      fetchImpl,
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(60);
  });

  it('does not split a surrogate-pair emoji at the byte boundary', async () => {
    // Construct a payload whose 4001th UTF-8 byte would land mid-emoji if we
    // sliced naively. The clip should drop the trailing emoji entirely rather
    // than emit a lone surrogate.
    const filler = 'a'.repeat(3998);
    const fourByteEmoji = '😀'; // U+1F600 — 4 bytes in UTF-8 (surrogate pair in UTF-16)
    const content = filler + fourByteEmoji + 'tail';
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'Title' }] }),
    })) as unknown as typeof fetch;

    await generateLlmTitle({ content, anthropicApiKey: 'sk-ant', fetchImpl });

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    const forwarded = body.messages[0].content;
    // No lone surrogates and no U+FFFD replacement chars sneak through.
    expect(forwarded).not.toMatch(/�/);
    for (let i = 0; i < forwarded.length; i++) {
      const code = forwarded.charCodeAt(i);
      const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
      const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
      if (isHighSurrogate) {
        const next = forwarded.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i += 1;
      } else {
        expect(isLowSurrogate).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe('scheduleTitleUpgrade', () => {
  function makeHarness(initialName: string, initialTitleSource: string | null = 'auto') {
    const store: { name: string | null; titleSource: string | null } = {
      name: initialName,
      titleSource: initialTitleSource,
    };
    const updateSessionName = vi.fn(
      (title: string, _id: string, expectedCurrentTitle: string): boolean => {
        if (store.name !== expectedCurrentTitle || store.titleSource !== 'auto') return false;
        store.name = title;
        store.titleSource = 'auto';
        return true;
      },
    );
    return {
      store,
      getSessionName: vi.fn((_id: string): string | null => store.name),
      getSessionTitleSource: vi.fn((_id: string): string | null => store.titleSource),
      updateSessionName,
      onUpgrade: vi.fn((_newTitle: string) => {}),
    };
  }

  it('renames + invokes onUpgrade when the LLM returns a different title and the name is unchanged', async () => {
    const h = makeHarness('Fix the bug');
    const generate = vi.fn(
      async (_opts: LlmTitleOptions): Promise<string | null> => 'Fix the streaming reconnect bug',
    );

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'Hey can you fix the streaming reconnect bug',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(h.updateSessionName).toHaveBeenCalledWith(
      'Fix the streaming reconnect bug',
      's1',
      'Fix the bug',
    );
    expect(h.onUpgrade).toHaveBeenCalledTimes(1);
    expect(h.onUpgrade).toHaveBeenCalledWith('Fix the streaming reconnect bug');
    expect(h.store.name).toBe('Fix the streaming reconnect bug');
  });

  it('renames when the title source is still auto-owned', async () => {
    const h = makeHarness('Fix the bug', 'auto');
    const generate = vi.fn(async () => 'Fix the streaming reconnect bug');

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'Hey can you fix the streaming reconnect bug',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      getSessionTitleSource: h.getSessionTitleSource,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(true);
    expect(h.updateSessionName).toHaveBeenCalledWith(
      'Fix the streaming reconnect bug',
      's1',
      'Fix the bug',
    );
    expect(h.store.titleSource).toBe('auto');
  });

  it('does not clobber a manual rename to the same heuristic title while the upgrade is pending', async () => {
    const h = makeHarness('Fix the bug', 'manual');
    const generate = vi.fn(async () => 'Fix the streaming reconnect bug');

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'Hey can you fix the streaming reconnect bug',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      getSessionTitleSource: h.getSessionTitleSource,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
    expect(h.store.name).toBe('Fix the bug');
    expect(h.store.titleSource).toBe('manual');
  });

  it('short-circuits and never calls the generator when no API key is configured', async () => {
    const h = makeHarness('Fix the bug');
    const generate = vi.fn(async () => 'X');

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: null, openaiApiKey: null },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
  });

  it('does not clobber a concurrent rename (TOCTOU guard)', async () => {
    const h = makeHarness('Fix the bug');
    // Simulate the user / another caller renaming the session between the
    // generator resolving and the upgrade attempting to write.
    h.getSessionName.mockImplementation(() => 'User renamed me');
    const generate = vi.fn(async () => 'Some LLM title');

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
  });

  it('does not rename when storage refuses the TOCTOU match', async () => {
    const h = makeHarness('Fix the bug');
    h.getSessionName.mockImplementation(() => null);
    const generate = vi.fn(async () => 'Some LLM title');

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
  });

  it('does not rename when the matching title is no longer auto-owned', async () => {
    const h = makeHarness('Fix the bug');
    const getSessionTitleSource = vi.fn((_id: string) => 'manual');
    const generate = vi.fn(async () => 'Some LLM title');

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      getSessionTitleSource,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(getSessionTitleSource).toHaveBeenCalledWith('s1');
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
  });

  it('does not broadcast when the guarded write loses a concurrent manual rename race', async () => {
    const h = makeHarness('Fix the bug', 'auto');
    const generate = vi.fn(async () => 'Some LLM title');
    h.updateSessionName.mockImplementation(
      (_title: string, _id: string, _expectedCurrentTitle: string): boolean => {
        h.store.titleSource = 'manual';
        return false;
      },
    );

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      getSessionTitleSource: h.getSessionTitleSource,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(h.updateSessionName).toHaveBeenCalledWith('Some LLM title', 's1', 'Fix the bug');
    expect(h.onUpgrade).not.toHaveBeenCalled();
    expect(h.store.titleSource).toBe('manual');
  });

  it('does not rename when the LLM returns null', async () => {
    const h = makeHarness('Fix the bug');
    const generate = vi.fn(async () => null);

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
  });

  it('does not rename when the LLM returns the identical heuristic title', async () => {
    const h = makeHarness('Fix the bug');
    const generate = vi.fn(async () => 'Fix the bug');

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
  });

  it('swallows generator exceptions and reports failure', async () => {
    const h = makeHarness('Fix the bug');
    const generate = vi.fn(async () => {
      throw new Error('boom');
    });

    const ok = await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Fix the bug',
      content: 'anything',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: null },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(ok).toBe(false);
    expect(h.updateSessionName).not.toHaveBeenCalled();
    expect(h.onUpgrade).not.toHaveBeenCalled();
  });

  it('forwards both API keys into the generator call', async () => {
    const h = makeHarness('Heuristic');
    const generate = vi.fn(async () => 'Upgraded');

    await scheduleTitleUpgrade({
      sessionId: 's1',
      heuristicTitle: 'Heuristic',
      content: 'topic',
      config: { anthropicApiKey: 'sk-ant', openaiApiKey: 'sk-oai' },
      getSessionName: h.getSessionName,
      updateSessionName: h.updateSessionName,
      onUpgrade: h.onUpgrade,
      generate,
    });

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'topic',
        anthropicApiKey: 'sk-ant',
        openaiApiKey: 'sk-oai',
      }),
    );
  });
});
