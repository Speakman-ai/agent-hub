import { describe, expect, it } from 'vitest';
import { DEFAULT_PROJECT_ICON, resolveProjectIcon } from './project-icons';

describe('project icons', () => {
  it('always uses the folder icon', () => {
    expect(DEFAULT_PROJECT_ICON).toBe('Folder');
    expect(resolveProjectIcon(null)).toBe('Folder');
    expect(resolveProjectIcon('   ')).toBe('Folder');
    expect(resolveProjectIcon('📁')).toBe('Folder');
    expect(resolveProjectIcon('Rocket')).toBe('Folder');
  });
});
