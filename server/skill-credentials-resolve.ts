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
   * Canonical project skill dirs. Each `{skillsDir}/{skillId}` is tried before
   * bundled defaults — same layout as `GET /api/agents/:agentId/skills/:skillId`.
   */
  projectSkillsDirs?: readonly string[];
  /** Legacy workspace roots. Each `{ahw}/skills/{skillId}` is tried as a fallback. */
  projectWorkspaces?: readonly string[];
}

/**
 * Read SKILL.md under `{skillsDir}/{skillId}` (directory + SKILL.md, or legacy flat .md path).
 */
function tryParseCredentialsFromSkillsDir(
  skillsDir: string,
  skillId: string,
): ParsedCredentials | null {
  const root = skillsDir.trim();
  if (!root) return null;
  const skillPath = path.join(root, skillId);
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
 * loaded project skill stores (when provided), bundled default-skills dir, then
 * the central skill_registry row contents.
 */
export function readCredentialsSchemaForSkill(
  skillId: string,
  opts?: ReadCredentialsSchemaOptions,
): ParsedCredentials {
  const projectSkillsDirs = [
    ...(opts?.projectSkillsDirs ?? []),
    ...(opts?.projectWorkspaces ?? []).map((ahw) => path.join(ahw, 'skills')),
  ];
  for (const skillsDir of projectSkillsDirs) {
    const fromProject = tryParseCredentialsFromSkillsDir(skillsDir, skillId);
    if (fromProject === null) continue;
    // Workspace copy exists but omits `credentials:` (or `credentials: []`); keep
    // scanning so bundled defaults / registry still apply (stub dirs must not
    // shadow GH_TOKEN and similar bundled declarations).
    if (fromProject.credentials.length === 0 && fromProject.error === null) continue;
    return fromProject;
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
