import { readFileSync } from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Regression: slash-command skills (/skillId) used to embed a legacy
 * `<skill name="...">` blob in the user message. CLIs ignore that shape;
 * the real injection path is loadSkillByName → enriched system prompt
 * (same as <agenthub:skill>).
 */
describe('slash-command skill injection wiring', () => {
  it('chat handler injects via loadSkillByName (reason slash-command), not legacy <skill> XML', () => {
    const chatSrc = readFileSync(path.join(__dirname, 'chat.ts'), 'utf-8');
    expect(chatSrc).not.toMatch(/<skill name="\$\{/);
    expect(chatSrc).not.toMatch(/`<skill name="/);
    expect(chatSrc).toContain("reason: 'slash-command'");
    expect(chatSrc).toContain('if (slashSkillSuffix) enrichedPrompt += slashSkillSuffix');
  });
});
