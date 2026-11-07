import { describe, it, expect } from 'vitest';
import { LuaParseError, luaList, parseSavedVariables } from './lua-saved-variables.js';

describe('parseSavedVariables', () => {
  it('reads the layout WoW writes, including positional entries and index comments', () => {
    const src = [
      'AgentHubDB = {',
      '["defaultAgent"] = "agent-hub-dev",',
      '["queue"] = {',
      '{',
      '["id"] = "a",',
      '["createdAt"] = 1794082000,',
      '["sent"] = true,',
      '}, -- [1]',
      '},',
      '}',
      'OtherGlobal = nil',
    ].join('\n');
    const vars = parseSavedVariables(src);
    const db = vars.AgentHubDB as Record<string, unknown>;
    expect(db.defaultAgent).toBe('agent-hub-dev');
    expect(luaList(db.queue as never)).toEqual([
      expect.objectContaining({ id: 'a', createdAt: 1794082000, sent: true }),
    ]);
    expect(vars.OtherGlobal).toBeNull();
  });

  it('decodes string escapes', () => {
    const vars = parseSavedVariables(
      'X = "q\\"uote \\\\ back\\nline \\65\\066 \\x43 tab\\t"\nY = \'single\'\nZ = "cont\\\nnext"',
    );
    expect(vars.X).toBe('q"uote \\ back\nline AB C tab\t');
    expect(vars.Y).toBe('single');
    expect(vars.Z).toBe('cont\nnext');
  });

  it('handles numbers, bare keys, semicolons and block comments', () => {
    const vars = parseSavedVariables(
      '--[[ header ]]\nT = { a = -1.5; b = 0x10, 2e3, [7] = false }',
    );
    expect(vars.T).toEqual({ a: -1.5, b: 16, '1': 2000, '7': false });
  });

  it('stores a __proto__ key as data without touching prototypes', () => {
    const vars = parseSavedVariables('T = { ["__proto__"] = { polluted = true } }');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(vars.T as object)).toEqual(['__proto__']);
  });

  it('rejects code that is not a literal', () => {
    expect(() => parseSavedVariables('X = os.execute("rm -rf /")')).toThrow(LuaParseError);
    expect(() => parseSavedVariables('X = "unterminated')).toThrow(LuaParseError);
    expect(() => parseSavedVariables('X = ' + '{'.repeat(40) + '}'.repeat(40))).toThrow(
      /nested too deeply/,
    );
  });
});
