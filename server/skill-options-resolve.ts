import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { fileURLToPath } from 'url';
import { getStmts } from './db.js';
import { parseOptionsDeclaration, type ParsedOptions } from './skill-options-declaration.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL_ROOT = path.join(__dirname, 'default-skills');

export interface ReadOptionsSchemaOptions {
  /**
   * Canonical project skill dirs. Each `{skillsDir}/{skillId}` is tried before
   * bundled defaults — same layout / precedence as
   * `readCredentialsSchemaForSkill`.
   */
  projectSkillsDirs?: readonly string[];
  /** Legacy workspace roots. Each `{ahw}/skills/{skillId}` is tried as a fallback. */
  projectWorkspaces?: readonly string[];
}

export function extractOptionsFromSkillContent(content: string): ParsedOptions {
  const { data } = matter(content || '');
  return parseOptionsDeclaration(data.options);
}

function tryParseOptionsFromSkillsDir(skillsDir: string, skillId: string): ParsedOptions | null {
  const root = skillsDir.trim();
  if (!root) return null;
  const skillPath = path.join(root, skillId);
  if (!existsSync(skillPath)) return null;
  try {
    if (statSync(skillPath).isDirectory()) {
      const skillMd = path.join(skillPath, 'SKILL.md');
      if (!existsSync(skillMd)) return null;
      return extractOptionsFromSkillContent(readFileSync(skillMd, 'utf8'));
    }
    return extractOptionsFromSkillContent(readFileSync(skillPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Parse the `options` declaration for a skill id, with the same tier precedence
 * as credentials: loaded project skill stores (when provided), bundled
 * default-skills dir, then the central skill_registry row contents.
 */
export function readOptionsSchemaForSkill(
  skillId: string,
  opts?: ReadOptionsSchemaOptions,
): ParsedOptions {
  const projectSkillsDirs = [
    ...(opts?.projectSkillsDirs ?? []),
    ...(opts?.projectWorkspaces ?? []).map((ahw) => path.join(ahw, 'skills')),
  ];
  for (const skillsDir of projectSkillsDirs) {
    const fromProject = tryParseOptionsFromSkillsDir(skillsDir, skillId);
    if (fromProject === null) continue;
    // Workspace copy exists but omits `options:`; keep scanning so bundled
    // defaults / registry still apply (stub dirs must not shadow declarations).
    if (fromProject.options.length === 0 && fromProject.error === null) continue;
    return fromProject;
  }

  const defaultPath = path.join(DEFAULT_SKILL_ROOT, skillId, 'SKILL.md');
  if (existsSync(defaultPath)) {
    return extractOptionsFromSkillContent(readFileSync(defaultPath, 'utf8'));
  }

  let content: string | undefined;
  try {
    const row = getStmts().getSkillRegistryItem.get(skillId) as { content?: string } | undefined;
    content = row?.content;
  } catch {
    content = undefined;
  }
  if (content?.trim()) {
    return extractOptionsFromSkillContent(content);
  }

  return { options: [], error: null };
}
