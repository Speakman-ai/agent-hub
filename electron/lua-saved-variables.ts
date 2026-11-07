/**
 * Parser for the World of Warcraft SavedVariables file format.
 *
 * The game writes each addon's saved globals as Lua assignments of literal
 * values (`AgentHubDB = { ["queue"] = { {...}, -- [1] }, }`). This reads that
 * subset without evaluating any Lua: strings, numbers, booleans, nil and
 * tables. Tables become plain objects; positional entries get the keys
 * "1", "2", ... the way Lua numbers them, and `luaList` reads them back.
 */

export type LuaValue = string | number | boolean | null | LuaTable;
export interface LuaTable {
  [key: string]: LuaValue;
}

const MAX_DEPTH = 32;

export class LuaParseError extends Error {}

export function parseSavedVariables(source: string): Record<string, LuaValue> {
  const p = new Parser(source);
  const out: Record<string, LuaValue> = {};
  p.skip();
  while (!p.done()) {
    const name = p.identifier();
    p.skip();
    p.expect('=');
    out[name] = p.value(0);
    p.skip();
    if (p.peek() === ';') {
      p.pos++;
      p.skip();
    }
  }
  return out;
}

/** Positional entries of a table (keys 1..n), in order. */
export function luaList(value: LuaValue | undefined): LuaValue[] {
  if (!value || typeof value !== 'object') return [];
  const out: LuaValue[] = [];
  for (let i = 1; Object.prototype.hasOwnProperty.call(value, String(i)); i++) {
    out.push(value[String(i)]);
  }
  return out;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  '"': '"',
  "'": "'",
  '\n': '\n',
};

class Parser {
  pos = 0;
  constructor(private readonly src: string) {}

  done() {
    return this.pos >= this.src.length;
  }

  peek() {
    return this.src[this.pos];
  }

  fail(msg: string): never {
    throw new LuaParseError(`${msg} at offset ${this.pos}`);
  }

  expect(ch: string) {
    if (this.src[this.pos] !== ch) this.fail(`expected '${ch}'`);
    this.pos++;
  }

  /** Skip whitespace and comments (`-- line` and `--[[ block ]]`). */
  skip() {
    for (;;) {
      while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
      if (!this.src.startsWith('--', this.pos)) return;
      if (this.src.startsWith('--[[', this.pos)) {
        const end = this.src.indexOf(']]', this.pos + 4);
        this.pos = end === -1 ? this.src.length : end + 2;
      } else {
        const end = this.src.indexOf('\n', this.pos);
        this.pos = end === -1 ? this.src.length : end + 1;
      }
    }
  }

  identifier(): string {
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.pos, this.pos + 256));
    if (!m) this.fail('expected identifier');
    this.pos += m[0].length;
    return m[0];
  }

  value(depth: number): LuaValue {
    this.skip();
    const ch = this.peek();
    if (ch === '{') return this.table(depth + 1);
    if (ch === '"' || ch === "'") return this.string();
    if (ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) return this.number();
    const word = this.identifier();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'nil') return null;
    return this.fail(`unexpected '${word}'`);
  }

  number(): number {
    const m = /^-?(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?|inf|nan)/.exec(
      this.src.slice(this.pos, this.pos + 64),
    );
    if (!m) this.fail('expected number');
    this.pos += m[0].length;
    const text = m[0];
    const neg = text.startsWith('-');
    const body = neg ? text.slice(1) : text;
    let n: number;
    if (/^0[xX]/.test(body)) n = parseInt(body, 16);
    else if (body === 'inf') n = Infinity;
    else if (body === 'nan') n = NaN;
    else n = Number(body);
    return neg ? -n : n;
  }

  string(): string {
    const quote = this.src[this.pos++];
    let out = '';
    while (!this.done()) {
      const ch = this.src[this.pos++];
      if (ch === quote) return out;
      if (ch === '\n') this.fail('unterminated string');
      if (ch !== '\\') {
        out += ch;
        continue;
      }
      const esc = this.src[this.pos++];
      if (esc === undefined) break;
      if (esc in SIMPLE_ESCAPES) {
        out += SIMPLE_ESCAPES[esc];
      } else if (esc === '\r') {
        if (this.src[this.pos] === '\n') this.pos++;
        out += '\n';
      } else if (esc >= '0' && esc <= '9') {
        const m = /^\d{0,2}/.exec(this.src.slice(this.pos, this.pos + 2))!;
        this.pos += m[0].length;
        out += String.fromCharCode(Number(esc + m[0]));
      } else if (esc === 'x') {
        const hex = this.src.slice(this.pos, this.pos + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) this.fail('bad \\x escape');
        this.pos += 2;
        out += String.fromCharCode(parseInt(hex, 16));
      } else if (esc === 'z') {
        while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
      } else {
        this.fail(`bad escape '\\${esc}'`);
      }
    }
    return this.fail('unterminated string');
  }

  table(depth: number): LuaTable {
    if (depth > MAX_DEPTH) this.fail('tables nested too deeply');
    this.expect('{');
    // Null prototype so a `["__proto__"]` key is stored as data.
    const out = Object.create(null) as LuaTable;
    let next = 1;
    for (;;) {
      this.skip();
      if (this.peek() === '}') {
        this.pos++;
        return out;
      }
      if (this.peek() === '[') {
        this.pos++;
        const key = this.value(depth);
        this.skip();
        this.expect(']');
        this.skip();
        this.expect('=');
        const v = this.value(depth);
        if (key !== null && typeof key !== 'object') out[String(key)] = v;
      } else {
        const save = this.pos;
        const m = /^[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/.exec(this.src.slice(this.pos, this.pos + 300));
        if (m && !['true', 'false', 'nil'].includes(m[0].split(/[\s=]/)[0])) {
          const key = this.identifier();
          this.skip();
          this.expect('=');
          out[key] = this.value(depth);
        } else {
          this.pos = save;
          out[String(next++)] = this.value(depth);
        }
      }
      this.skip();
      const sep = this.peek();
      if (sep === ',' || sep === ';') this.pos++;
      else if (sep !== '}') this.fail("expected ',' or '}'");
    }
  }
}
