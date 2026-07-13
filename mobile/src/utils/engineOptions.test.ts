// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { ENGINE_OPTIONS, ENGINE_MODELS, ENGINE_DEFAULT_MODELS, modelDisplay, } from './engineOptions';
describe('mobile engine picker constants', () => {
    it('exposes claude-code, cursor-agent, codex-cli, and grok-cli as engine options', () => {
        const ids = ENGINE_OPTIONS.map((e: any) => e.id);
        expect(ids).toEqual(['claude-code', 'cursor-agent', 'codex-cli', 'grok-cli']);
    });
    it('defaults grok-cli to grok-4.5 and lists it first', () => {
        // grok-4.5 (2026-07-08) now powers Grok Build upstream — it must be the
        // default and appear in the picker. Keep aligned with server/config.ts
        // engineValidModels['grok-cli'] and client TopBar.tsx.
        expect(ENGINE_DEFAULT_MODELS['grok-cli']).toBe('grok-4.5');
        const allowed = ENGINE_MODELS['grok-cli'].map((m: any) => m.id);
        expect(allowed[0]).toBe('grok-4.5');
        expect(allowed).toContain('grok-build');
        expect(allowed).toContain('grok-composer-2.5-fast');
    });
    it('does not list gemini-cli as an engine option', () => {
        const ids = ENGINE_OPTIONS.map((e: any) => e.id);
        expect(ids).not.toContain('gemini-cli');
    });
    it('lists codex-cli with the "Codex" label', () => {
        const codex = ENGINE_OPTIONS.find((e: any) => e.id === 'codex-cli');
        expect(codex).toBeTruthy();
        expect(codex.label).toBe('Codex');
    });
    it('defaults codex-cli to gpt-5.5', () => {
        expect(ENGINE_DEFAULT_MODELS['codex-cli']).toBe('gpt-5.5');
        const allowed = ENGINE_MODELS['codex-cli'].map((m: any) => m.id);
        expect(allowed).toContain('gpt-5.5');
        // Regression: gpt-5.6 and the deprecated gpt-5.3-codex must not be
        // selectable — both are rejected under ChatGPT OAuth.
        expect(allowed).not.toContain('gpt-5.6');
        expect(allowed).not.toContain('gpt-5.3-codex');
    });
    it('exposes only Codex models accepted under ChatGPT OAuth', () => {
        // Regression: prior allowlist included gpt-5, gpt-5-mini, gpt-5-codex,
        // gpt-5.2-codex, and gpt-5.1-codex-max — ALL of which the Codex backend
        // rejects with HTTP 400 when auth_mode=chatgpt. Keep this list aligned
        // with server/config.ts → engineValidModels['codex-cli'] and with the
        // ChatGPT allowlist in server/codex-auth.ts.
        const models = ENGINE_MODELS['codex-cli'].map((m: any) => m.id);
        expect(models).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.2']);
        expect(models).not.toContain('gpt-5.6');
        expect(models).not.toContain('gpt-5');
        expect(models).not.toContain('gpt-5-mini');
        expect(models).not.toContain('gpt-5-codex');
        expect(models).not.toContain('gpt-5.2-codex');
        expect(models).not.toContain('gpt-5.1-codex-max');
    });
    it('exposes claude-fable-5 first for claude-code with a Fable 5 label', () => {
        // Regression: Claude Fable 5 (claude-fable-5) is the flagship GA Claude Code
        // model. It must appear in the mobile picker and stay aligned with
        // server/config.ts and client TopBar.jsx.
        const models = ENGINE_MODELS['claude-code'];
        const ids = models.map((m: any) => m.id);
        expect(ids).toContain('claude-fable-5');
        expect(ids[0]).toBe('claude-fable-5');
        const fable = models.find((m: any) => m.id === 'claude-fable-5');
        expect(fable.label).toBe('Fable 5');
        expect(fable.short).toBe('Fable');
    });
    it('exposes claude-sonnet-5 as the selectable Sonnet and drops retired claude-sonnet-4-6', () => {
        // Regression: claude-sonnet-4-6 is retired from the server allowlist. It
        // must NOT be selectable in the mobile picker (offline fallback source),
        // otherwise a user could pick a model the backend rejects.
        const ids = ENGINE_MODELS['claude-code'].map((m: any) => m.id);
        expect(ids).toContain('claude-sonnet-5');
        expect(ids).not.toContain('claude-sonnet-4-6');
        const sonnet = ENGINE_MODELS['claude-code'].find((m: any) => m.id === 'claude-sonnet-5');
        expect(sonnet.label).toBe('Sonnet');
    });
    it('still labels the retired claude-sonnet-4-6 cleanly for historical sessions', () => {
        // The historical label lives in HISTORICAL_MODEL_LABELS (display metadata),
        // not in the selectable ENGINE_MODELS array, so old sessions/crons render
        // "Sonnet 4.6" instead of a title-cased id.
        const d = modelDisplay('claude-sonnet-4-6');
        expect(d.label).toBe('Sonnet 4.6');
        expect(d.short).toBe('Sonnet 4.6');
    });
    it('exposes only composer-2.5 as the model for cursor-agent', () => {
        const models = ENGINE_MODELS['cursor-agent'].map((m: any) => m.id);
        expect(models).toEqual(['composer-2.5']);
    });
    it('defaults cursor-agent to composer-2.5 (matches the TopBar list)', () => {
        // Regression: mobile's ENGINE_DEFAULT_MODELS previously set
        // cursor-agent → gpt-5.3-codex-high while TopBar only exposed composer-2.5,
        // causing the stored model to diverge from the displayed label on the
        // first engine switch. Keep the default aligned with the model list.
        expect(ENGINE_DEFAULT_MODELS['cursor-agent']).toBe('composer-2.5');
        const allowed = ENGINE_MODELS['cursor-agent'].map((m: any) => m.id);
        expect(allowed).toContain(ENGINE_DEFAULT_MODELS['cursor-agent']);
    });
    it('default model for every engine is present in its model list', () => {
        for (const engine of ENGINE_OPTIONS.map((e: any) => e.id)) {
            const allowed = (ENGINE_MODELS[engine] || []).map((m: any) => m.id);
            const def = ENGINE_DEFAULT_MODELS[engine];
            expect(allowed.includes(def), `default "${def}" for engine "${engine}" must be in ENGINE_MODELS`).toBe(true);
        }
    });
});
