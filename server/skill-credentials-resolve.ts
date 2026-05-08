import { readFileSync, existsSync, statSync } from 'fs';
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

export interface ReadCredentialsSchemaOptions {
  /**
   * Project agent-workspace dirs (`project.ahw`). Each `{ahw}/skills/{skillId}` is
   * tried before bundled defaults — same layout as `GET /api/agents/:agentId/skills/:skillId`.
   */
  projectWorkspaces?: readonly string[];
}

/**
 * Read SKILL.md under `{ahw}/skills/{skillId}` (directory + SKILL.md, or legacy flat .md path).
 */
function tryParseCredentialsFromProjectWorkspace(
  ahw: string,
  skillId: string,
): ParsedCredentials | null {
  const root = ahw.trim();
  if (!root) return null;
  const skillPath = path.join(root, 'skills', skillId);
  if (!existsSync(skillPath)) return null;
  try {
    if (statSync(skillPath).isDirectory()) {
      const skillMd = path.join(skillPath, 'SKILL.md');
      if (!existsSync(skillMd)) return null;
      const raw = readFileSync(skillMd, 'utf8');
      return extractCredentialsFromSkillContent(raw);
    }
    const raw = readFileSync(skillPath, 'utf8');
    return extractCredentialsFromSkillContent(raw);
  } catch {
    return null;
  }
}

/**
 * Parse `credentials` declaration for a skill id:
 * loaded project workspaces (when provided), bundled default-skills dir, then
 * the central skill_registry row contents.
 */
export function readCredentialsSchemaForSkill(
  skillId: string,
  opts?: ReadCredentialsSchemaOptions,
): ParsedCredentials {
  for (const ahw of opts?.projectWorkspaces ?? []) {
    const fromProject = tryParseCredentialsFromProjectWorkspace(ahw, skillId);
    if (fromProject !== null) return fromProject;
  }

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
