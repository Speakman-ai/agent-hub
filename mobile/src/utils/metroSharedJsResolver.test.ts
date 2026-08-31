// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { sharedJsFallbackSpecifier } from '../../metro-shared-js-resolver.cjs';

// Metro (unlike tsc/Vite) does not remap ".js" ESM specifiers to their ".ts"
// source. shared/ uses ".js" specifiers on relative sibling imports, which
// broke the native iOS bundle. This helper drives the Metro resolver fallback.
const sharedRoot = '/repo/shared';

describe('sharedJsFallbackSpecifier', () => {
  it('strips ".js" for a relative sibling import inside shared', () => {
    expect(
      sharedJsFallbackSpecifier(
        './captureTodo.js',
        '/repo/shared/utils/captureCard.ts',
        sharedRoot,
      ),
    ).toBe('./captureTodo');
  });

  it('strips ".js" for a parent-relative import inside shared', () => {
    expect(
      sharedJsFallbackSpecifier('../types/session.js', '/repo/shared/utils/index.ts', sharedRoot),
    ).toBe('../types/session');
  });

  it('returns null for extensionless relative imports (Metro resolves these already)', () => {
    expect(
      sharedJsFallbackSpecifier('./captureTodo', '/repo/shared/utils/captureCard.ts', sharedRoot),
    ).toBeNull();
  });

  it('returns null for non-".js" relative imports', () => {
    expect(
      sharedJsFallbackSpecifier('./styles.css', '/repo/shared/utils/x.ts', sharedRoot),
    ).toBeNull();
  });

  it('returns null for bare package specifiers ending in .js', () => {
    expect(
      sharedJsFallbackSpecifier('some-pkg/index.js', '/repo/shared/utils/x.ts', sharedRoot),
    ).toBeNull();
  });

  it('returns null when the import does not originate inside shared', () => {
    expect(
      sharedJsFallbackSpecifier('./foo.js', '/repo/mobile/src/utils/foo.ts', sharedRoot),
    ).toBeNull();
  });

  it('does not treat a sibling dir with a shared-prefixed name as shared', () => {
    expect(sharedJsFallbackSpecifier('./foo.js', '/repo/shared-extra/x.ts', sharedRoot)).toBeNull();
  });

  it('returns null for non-string / empty inputs', () => {
    expect(sharedJsFallbackSpecifier(undefined, '/repo/shared/utils/x.ts', sharedRoot)).toBeNull();
    expect(sharedJsFallbackSpecifier('./foo.js', undefined, sharedRoot)).toBeNull();
    expect(sharedJsFallbackSpecifier('./foo.js', '/repo/shared/utils/x.ts', '')).toBeNull();
  });
});
