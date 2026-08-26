import { describe, it, expect } from 'vitest';
import { parseOptionsDeclaration, isValidOptionValue } from './skill-options-declaration.js';

describe('parseOptionsDeclaration', () => {
  it('returns empty (no error) for null/undefined', () => {
    expect(parseOptionsDeclaration(undefined)).toEqual({ options: [], error: null });
    expect(parseOptionsDeclaration(null)).toEqual({ options: [], error: null });
  });

  it('parses a full option with object choices and explicit default', () => {
    const parsed = parseOptionsDeclaration([
      {
        name: 'SURVEY_TRACKER_ENV',
        label: 'Environment',
        description: 'Which API to target',
        choices: [
          { value: 'dev', label: 'Development' },
          { value: 'prod', label: 'Production' },
        ],
        default: 'prod',
        required: true,
      },
    ]);
    expect(parsed.error).toBeNull();
    expect(parsed.options).toHaveLength(1);
    expect(parsed.options[0]).toMatchObject({
      name: 'SURVEY_TRACKER_ENV',
      label: 'Environment',
      default: 'prod',
      required: true,
    });
    expect(parsed.options[0]!.choices).toEqual([
      { value: 'dev', label: 'Development' },
      { value: 'prod', label: 'Production' },
    ]);
  });

  it('accepts bare-string choices as {value,label} shorthand', () => {
    const parsed = parseOptionsDeclaration([{ name: 'ENV', choices: ['dev', 'prod'] }]);
    expect(parsed.error).toBeNull();
    expect(parsed.options[0]!.choices).toEqual([
      { value: 'dev', label: 'dev' },
      { value: 'prod', label: 'prod' },
    ]);
  });

  it('defaults to the first choice when no default is declared', () => {
    const parsed = parseOptionsDeclaration([{ name: 'ENV', choices: ['dev', 'prod'] }]);
    expect(parsed.options[0]!.default).toBe('dev');
  });

  it('defaults required to false and label to name', () => {
    const parsed = parseOptionsDeclaration([{ name: 'ENV', choices: ['dev'] }]);
    expect(parsed.options[0]!.required).toBe(false);
    expect(parsed.options[0]!.label).toBe('ENV');
  });

  it('rejects a non-array', () => {
    expect(parseOptionsDeclaration('nope').error).toMatch(/must be an array/);
  });

  it('rejects a missing name', () => {
    expect(parseOptionsDeclaration([{ choices: ['a'] }]).error).toMatch(/missing name/);
  });

  it('rejects a non-POSIX env var name', () => {
    expect(parseOptionsDeclaration([{ name: 'bad-name', choices: ['a'] }]).error).toMatch(
      /POSIX env var/,
    );
  });

  it('rejects duplicate option names', () => {
    const parsed = parseOptionsDeclaration([
      { name: 'ENV', choices: ['a'] },
      { name: 'ENV', choices: ['b'] },
    ]);
    expect(parsed.error).toMatch(/duplicate option name/);
  });

  it('rejects an empty or missing choices array', () => {
    expect(parseOptionsDeclaration([{ name: 'ENV' }]).error).toMatch(/non-empty choices/);
    expect(parseOptionsDeclaration([{ name: 'ENV', choices: [] }]).error).toMatch(
      /non-empty choices/,
    );
  });

  it('rejects duplicate choice values', () => {
    expect(parseOptionsDeclaration([{ name: 'ENV', choices: ['dev', 'dev'] }]).error).toMatch(
      /duplicate choice value/,
    );
  });

  it('rejects an explicit default that is not one of the choices', () => {
    expect(
      parseOptionsDeclaration([{ name: 'ENV', choices: ['dev', 'prod'], default: 'staging' }])
        .error,
    ).toMatch(/is not one of its choices/);
  });
});

describe('isValidOptionValue', () => {
  const spec = parseOptionsDeclaration([{ name: 'ENV', choices: ['dev', 'prod'] }]).options[0]!;

  it('accepts a declared choice', () => {
    expect(isValidOptionValue(spec, 'dev')).toBe(true);
    expect(isValidOptionValue(spec, 'prod')).toBe(true);
  });

  it('rejects an undeclared value, undefined, or non-string', () => {
    expect(isValidOptionValue(spec, 'staging')).toBe(false);
    expect(isValidOptionValue(spec, undefined)).toBe(false);
    expect(isValidOptionValue(spec, 3)).toBe(false);
  });
});
