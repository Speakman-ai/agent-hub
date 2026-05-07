import { readFileSync, existsSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { fileURLToPath } from 'url';
import { getStmts } from './db.js';
import {
  parseCredentialsDeclaration,
  type SkillCredentialSpec,
  type ParsedCredentials,
} from './skill-credentials-declaration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_ROOT = path.join(__dirname, 'default-skills');

/**
 * Parse `credentials` declaration for a skill id: bundled default first, then
 * the central skill_registry row contents.
 */
export function readCredentialsSchemaForSkill(skillId: string): ParsedCredentials {
  const defaultPath = path.join(DEFAULT_SKILL_ROOT, skillId, 'SKILL.md');
  if (existsSync(defaultPath)) {
    const raw = readFileSync(defaultPath, 'utf8');
    const { data } = matter(raw);
    return parseCredentialsDeclaration(data.credentials);
  }

  let content: string | undefined;
  try {
    const row = getStmts().getSkillRegistryItem.get(skillId) as { content?: string } | undefined;
    content = row?.content;
  } catch {
    content = undefined;
  }
  if (content?.trim()) {
    const { data } = matter(content);
    return parseCredentialsDeclaration(data.credentials);
  }

  return { credentials: [], error: null };
}

/**
 * Extract and validate `credentials` frontmatter from arbitrary SKILL.md body
 * (registry import / POST routes). Returns error string on failure.
 */
export function extractCredentialsFromSkillContent(content: string): {
  credentials: SkillCredentialSpec[];
  error: string | null;
} {
  const { data } = matter(content || '');
  const parsed = parseCredentialsDeclaration(data.credentials);
  return { credentials: parsed.credentials, error: parsed.error };
}
