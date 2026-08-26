import type { SkillCredentialSpec } from './skillCredentialForm';

export type SkillAuthenticationPreset = 'api-key' | 'username-password';

/**
 * Build a stable POSIX env-var prefix from a skill slug. The declaration is
 * written into SKILL.md, so agents can discover the exact names at runtime.
 */
export function skillAuthenticationEnvPrefix(skillId: string): string {
  const normalized = String(skillId || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'SKILL';
}

/** Credential declarations for the two common external-service auth shapes. */
export function buildSkillAuthenticationPreset(
  skillId: string,
  preset: SkillAuthenticationPreset,
): SkillCredentialSpec[] {
  const prefix = skillAuthenticationEnvPrefix(skillId);
  if (preset === 'username-password') {
    return [
      {
        name: `${prefix}_USERNAME`,
        label: 'Username',
        type: 'string',
        required: true,
      },
      {
        name: `${prefix}_PASSWORD`,
        label: 'Password',
        type: 'secret',
        required: true,
      },
    ];
  }
  return [
    {
      name: `${prefix}_API_KEY`,
      label: 'API key',
      type: 'secret',
      required: true,
    },
  ];
}
