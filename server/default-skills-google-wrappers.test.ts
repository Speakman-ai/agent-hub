/**
 * Smoke tests for the bundled `google` skill wrappers
 * (`default-skills/google/scripts/{google-cal,google-mail,google-sheets}.sh`).
 *
 * The proxy is mocked: a `curl` stub on PATH records each request (method, URL,
 * headers, body) and returns a canned status + body driven by env vars. We
 * assert the wrappers hit the correct `/api/google/*` path, send the Hub
 * `x-api-key` and the `X-Agent-Hub-Session-Id` header (so the proxy can resolve
 * the SESSION OWNER), shape request bodies correctly, and surface a clear
 * "not linked" message when the owner has no Google connection.
 *
 * No real network, no real `claude`/CLI, no real Google call.
 */
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { compareRfc3339 } from '../shared/utils/rfc3339.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, 'default-skills', 'google');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');
const AGENT_HUB_SKILLS_DIR = path.join(__dirname, 'default-skills', 'agent-hub');

const CAL = path.join(SCRIPTS, 'google-cal.sh');
const MAIL = path.join(SCRIPTS, 'google-mail.sh');
const SHEETS = path.join(SCRIPTS, 'google-sheets.sh');
const DRIVE = path.join(SCRIPTS, 'google-drive.sh');
const CHAT = path.join(SCRIPTS, 'google-chat.sh');

let stubDir = '';
let curlLog = '';
let stubbedPath = '';

beforeAll(() => {
  stubDir = mkdtempSync(path.join(os.tmpdir(), 'google-wrap-'));
  curlLog = path.join(stubDir, 'curl.log');
  // curl stub: parses the flags the wrappers use, records the request, writes
  // ${CURL_BODY} to the -o file and prints ${CURL_STATUS} (the wrappers read it
  // via `-w '%{http_code}'`, which we ignore and just echo at the end).
  const curlStub = [
    '#!/usr/bin/env bash',
    'method="GET"; outfile=""; data=""; data_arg=""; data_source="literal"; url=""; hdrs=""',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    -X) method="$2"; shift 2 ;;',
    '    -o) outfile="$2"; shift 2 ;;',
    '    -d|--data|--data-raw|--data-binary)',
    '      data_arg="$2"',
    '      if [[ "$data_arg" == @* ]]; then',
    '        data_source="file"',
    '        data="$(cat "${data_arg#@}")"',
    '      else',
    '        data_source="literal"',
    '        data="$data_arg"',
    '      fi',
    '      shift 2',
    '      ;;',
    '    -H) hdrs+="$2"$\'\\n\'; shift 2 ;;',
    '    -w) shift 2 ;;',
    '    -sS|-s|-S|-Ss) shift ;;',
    '    http://*|https://*) url="$1"; shift ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '{',
    '  echo "=== REQUEST ==="',
    '  echo "METHOD=$method"',
    '  echo "URL=$url"',
    '  echo "DATA_SOURCE=$data_source"',
    '  echo "DATA_ARG=$data_arg"',
    '  echo "DATA_BEGIN"',
    '  printf "%s" "$data"',
    '  echo',
    '  echo "DATA_END"',
    '  echo "HEADERS<<"',
    '  printf "%s" "$hdrs"',
    '  echo ">>"',
    '} >> "$CURL_LOG"',
    '# Simulate a transport failure exactly as real curl does with',
    '# -w %{http_code}: write an empty body, print "000", exit non-zero.',
    'if [[ -n "${CURL_EXIT:-}" && "${CURL_EXIT}" != "0" ]]; then',
    '  [[ -n "$outfile" ]] && : > "$outfile"',
    '  printf "%s" "${CURL_STATUS:-000}"',
    '  exit "${CURL_EXIT}"',
    'fi',
    '# CURL_BODY_FILE serves bodies too large for an env var (128 KiB cap on Linux).',
    'if [[ -n "${CURL_BODY_FILE:-}" ]]; then',
    '  [[ -n "$outfile" ]] && cat "$CURL_BODY_FILE" > "$outfile"',
    'else',
    '  [[ -n "$outfile" ]] && printf "%s" "${CURL_BODY:-{\\}}" > "$outfile"',
    'fi',
    'printf "%s" "${CURL_STATUS:-200}"',
    'exit 0',
  ].join('\n');
  const curlPath = path.join(stubDir, 'curl');
  writeFileSync(curlPath, curlStub, { mode: 0o755 });
  chmodSync(curlPath, 0o755);
  stubbedPath = `${stubDir}:${process.env.PATH || ''}`;
});

afterAll(() => {
  if (stubDir && existsSync(stubDir)) rmSync(stubDir, { recursive: true, force: true });
});

beforeEach(() => {
  if (existsSync(curlLog)) rmSync(curlLog);
});

interface RunOpts {
  status?: string;
  body?: string;
  /** Non-zero → the curl stub simulates a transport failure with this exit code. */
  curlExit?: string;
  /** Serve the response body from this file instead of the CURL_BODY env var. */
  bodyFile?: string;
}

function run(script: string, args: string[], opts: RunOpts = {}) {
  const res = spawnSync('bash', [script, ...args], {
    encoding: 'utf-8',
    env: {
      PATH: stubbedPath,
      HOME: stubDir,
      AGENT_HUB_URL: 'http://hub.test',
      AGENT_HUB_API_KEY: 'test-api-key',
      AGENT_HUB_SESSION_ID: 'sess-owner-1',
      AGENT_HUB_SKILLS_DIR,
      CURL_LOG: curlLog,
      CURL_STATUS: opts.status ?? '200',
      CURL_BODY: opts.body ?? '{"ok":true}',
      ...(opts.curlExit ? { CURL_EXIT: opts.curlExit } : {}),
      ...(opts.bodyFile ? { CURL_BODY_FILE: opts.bodyFile } : {}),
    },
  });
  const log = existsSync(curlLog) ? readFileSync(curlLog, 'utf-8') : '';
  return { ...res, log };
}

/** Extract the request body the wrapper sent (may be multi-line pretty JSON). */
function requestBody(log: string): unknown {
  const begin = log.indexOf('DATA_BEGIN\n');
  const end = log.indexOf('\nDATA_END');
  if (begin === -1 || end === -1) throw new Error('no DATA block in curl log');
  const raw = log.slice(begin + 'DATA_BEGIN\n'.length, end);
  return JSON.parse(raw);
}

/**
 * Decode the query params of the logged request URL. Assert on DECODED values,
 * not raw percent-encoding: jq's `@uri` leaves sub-delims like `!` literal on
 * jq 1.6 but encodes them (`%21`) on jq 1.7+, so a raw-string match is
 * jq-version-fragile across dev machines vs CI. `URLSearchParams` normalizes
 * both encodings back to the same decoded value.
 */
function queryParams(log: string): URLSearchParams {
  const line = log.split('\n').find((l) => l.startsWith('URL='));
  if (!line) throw new Error('no URL line in curl log');
  const q = line.slice('URL='.length).split('?')[1] ?? '';
  return new URLSearchParams(q);
}

describe('google-cal.sh', () => {
  it('list → GET /calendar/events with required time window + auth/session headers', () => {
    const r = run(CAL, [
      'list',
      '--from',
      '2026-06-30T00:00:00Z',
      '--to',
      '2026-07-01T00:00:00Z',
      '--q',
      'sync up',
      '--max',
      '10',
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"ok":true');
    expect(r.log).toContain('METHOD=GET');
    expect(r.log).toContain('URL=http://hub.test/api/google/calendar/events?');
    const qp = queryParams(r.log);
    expect(qp.get('timeMin')).toBe('2026-06-30T00:00:00Z');
    expect(qp.get('timeMax')).toBe('2026-07-01T00:00:00Z');
    expect(qp.get('q')).toBe('sync up');
    expect(qp.get('maxResults')).toBe('10');
    expect(r.log).toContain('x-api-key: test-api-key');
    expect(r.log).toContain('X-Agent-Hub-Session-Id: sess-owner-1');
  });

  it('list without --from exits 2 (usage error)', () => {
    const r = run(CAL, ['list', '--to', '2026-07-01T00:00:00Z']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('missing required argument: --from');
  });

  it('create → POST /calendar/events with a shaped event body', () => {
    const r = run(CAL, [
      'create',
      '--summary',
      'Launch review',
      '--start',
      '2026-06-30T10:00:00Z',
      '--end',
      '2026-06-30T11:00:00Z',
      '--attendee',
      'a@example.com',
      '--attendee',
      'b@example.com',
      '--calendar',
      'work@example.com',
    ]);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=POST');
    expect(r.log).toContain('URL=http://hub.test/api/google/calendar/events');
    const body = requestBody(r.log) as any;
    expect(body.calendarId).toBe('work@example.com');
    expect(body.event.summary).toBe('Launch review');
    expect(body.event.start).toEqual({ dateTime: '2026-06-30T10:00:00Z' });
    expect(body.event.end).toEqual({ dateTime: '2026-06-30T11:00:00Z' });
    expect(body.event.attendees).toEqual([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
  });
});

describe('google-mail.sh', () => {
  it('threads → GET /gmail/threads with query + labels', () => {
    const r = run(MAIL, ['threads', '--q', 'is:unread', '--label', 'INBOX', '--max', '5']);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=GET');
    expect(r.log).toContain('URL=http://hub.test/api/google/gmail/threads?');
    const qp = queryParams(r.log);
    expect(qp.get('q')).toBe('is:unread');
    expect(qp.get('labelIds')).toBe('INBOX');
    expect(qp.get('maxResults')).toBe('5');
  });

  it('send → POST /gmail/messages with to[] + subject + text', () => {
    const r = run(MAIL, [
      'send',
      '--to',
      'x@example.com',
      '--to',
      'y@example.com',
      '--subject',
      'Hi there',
      '--text',
      'Body line.',
    ]);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=POST');
    expect(r.log).toContain('URL=http://hub.test/api/google/gmail/messages');
    const body = requestBody(r.log) as any;
    expect(body.to).toEqual(['x@example.com', 'y@example.com']);
    expect(body.subject).toBe('Hi there');
    expect(body.text).toBe('Body line.');
  });

  it('send streams a request body larger than the 128 KiB argument limit through a file', () => {
    // Each quote and newline doubles when JSON-escaped: a 100 KiB argument
    // becomes a ~200 KiB request body.
    const html = '"\n'.repeat(50 * 1024);
    const r = run(MAIL, ['send', '--to', 'x@example.com', '--subject', 'Big', '--html', html]);
    expect(r.stderr).not.toMatch(/Argument list too long/);
    expect(r.status).toBe(0);
    expect(r.log).toContain('DATA_SOURCE=file');
    expect((requestBody(r.log) as any).html).toBe(html);
  });

  it('send without a body part exits 2', () => {
    const r = run(MAIL, ['send', '--to', 'x@example.com', '--subject', 'No body']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('one of --text or --html is required');
  });
});

describe('google-sheets.sh', () => {
  it('values → GET /sheets/:id/values with range', () => {
    const r = run(SHEETS, ['values', 'sheet-123', '--range', 'Sheet1!A1:C10']);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=GET');
    expect(r.log).toContain('URL=http://hub.test/api/google/sheets/sheet-123/values?');
    // Decode: `!` may be sent literal (jq 1.6) or `%21` (jq 1.7+) — both valid.
    expect(queryParams(r.log).get('range')).toBe('Sheet1!A1:C10');
  });

  it('append → POST /sheets/:id/values/append with a value matrix', () => {
    const r = run(SHEETS, [
      'append',
      'sheet-123',
      '--range',
      'Sheet1!A1',
      '--values',
      '[["Name","Score"],["Alice",42]]',
      '--input-option',
      'USER_ENTERED',
    ]);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=POST');
    expect(r.log).toContain('URL=http://hub.test/api/google/sheets/sheet-123/values/append');
    const body = requestBody(r.log) as any;
    expect(body.range).toBe('Sheet1!A1');
    expect(body.values).toEqual([
      ['Name', 'Score'],
      ['Alice', 42],
    ]);
    expect(body.valueInputOption).toBe('USER_ENTERED');
  });

  it('append rejects a non-matrix --values (exit 2)', () => {
    const r = run(SHEETS, ['append', 'sheet-123', '--range', 'Sheet1!A1', '--values', '"oops"']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('row-major matrix');
  });

  it('append rejects --values whose rows are not all arrays (exit 2)', () => {
    const r = run(SHEETS, [
      'append',
      'sheet-123',
      '--range',
      'Sheet1!A1',
      '--values',
      '[["ok"],"bad"]',
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('row-major matrix');
    expect(r.log).toBe(''); // never reached the proxy
  });

  it('append rejects --values with a non-primitive cell (exit 2)', () => {
    const r = run(SHEETS, [
      'append',
      'sheet-123',
      '--range',
      'Sheet1!A1',
      '--values',
      '[["ok",{"x":1}]]',
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('primitive');
    expect(r.log).toBe('');
  });

  it('update rejects an object row in --values (exit 2)', () => {
    const r = run(SHEETS, [
      'update',
      'sheet-123',
      '--range',
      'Sheet1!A1:B2',
      '--values',
      '[["ok"],{"x":1}]',
    ]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('row-major matrix');
    expect(r.log).toBe('');
  });

  it('append accepts a matrix with mixed primitive cells (string/number/boolean/null)', () => {
    const r = run(SHEETS, [
      'append',
      'sheet-123',
      '--range',
      'Sheet1!A1',
      '--values',
      '[["a",1],["b",true],["c",null]]',
    ]);
    expect(r.status).toBe(0);
    const body = requestBody(r.log) as any;
    expect(body.values).toEqual([
      ['a', 1],
      ['b', true],
      ['c', null],
    ]);
  });
});

describe('google-drive.sh', () => {
  it('list → GET /drive/files with query params', () => {
    const r = run(DRIVE, [
      'list',
      '--q',
      "mimeType = 'application/pdf'",
      '--page-size',
      '25',
      '--order-by',
      'modifiedTime desc',
    ]);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=GET');
    expect(r.log).toContain('URL=http://hub.test/api/google/drive/files?');
    const qp = queryParams(r.log);
    expect(qp.get('q')).toBe("mimeType = 'application/pdf'");
    expect(qp.get('pageSize')).toBe('25');
    expect(qp.get('orderBy')).toBe('modifiedTime desc');
  });

  it('list --drive-id → scopes the search to one shared drive', () => {
    const r = run(DRIVE, ['list', '--drive-id', '0ASharedX']);
    expect(r.status).toBe(0);
    expect(queryParams(r.log).get('driveId')).toBe('0ASharedX');
  });

  it('usage lists every list flag', () => {
    const r = run(DRIVE, ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--drive-id');
    expect(r.stdout).toContain('--order-by');
    expect(r.stdout).toContain('--as-doc');
  });

  it('save → POST /drive/files with base64 file content', () => {
    const file = path.join(stubDir, 'report.txt');
    writeFileSync(file, 'hello drive\n');

    const r = run(DRIVE, [
      'save',
      '--file',
      file,
      '--name',
      'Report.txt',
      '--mime-type',
      'text/plain',
      '--description',
      'Generated by Agent Hub',
    ]);

    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=POST');
    expect(r.log).toContain('URL=http://hub.test/api/google/drive/files');
    expect(r.log).toContain('DATA_SOURCE=file');
    expect(r.log).toContain('DATA_ARG=@');
    const body = requestBody(r.log) as any;
    expect(body).toMatchObject({
      name: 'Report.txt',
      mimeType: 'text/plain',
      description: 'Generated by Agent Hub',
      base64Content: Buffer.from('hello drive\n').toString('base64'),
    });
  });

  it('save --as-doc requests Google Docs conversion', () => {
    const file = path.join(stubDir, 'notes.txt');
    writeFileSync(file, 'meeting notes');

    const r = run(DRIVE, ['save', '--file', file, '--as-doc', '--mime-type', 'text/plain']);

    expect(r.status).toBe(0);
    const body = requestBody(r.log) as any;
    expect(body.targetMimeType).toBe('application/vnd.google-apps.document');
  });

  it('save rejects a missing local file before calling the proxy', () => {
    const r = run(DRIVE, ['save', '--file', path.join(stubDir, 'missing.txt')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('readable file');
    expect(r.log).toBe('');
  });

  it('save rejects files larger than the small-upload limit before calling the proxy', () => {
    const file = path.join(stubDir, 'too-large.bin');
    writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1));

    const r = run(DRIVE, ['save', '--file', file]);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('uploads are limited');
    expect(r.log).toBe('');
  });
});

describe('google-chat.sh', () => {
  it('spaces → GET /chat/spaces with page size', () => {
    const r = run(CHAT, ['spaces', '--max', '20']);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=GET');
    expect(r.log).toContain('URL=http://hub.test/api/google/chat/spaces?');
    expect(queryParams(r.log).get('pageSize')).toBe('20');
    expect(r.log).toContain('X-Agent-Hub-Session-Id: sess-owner-1');
  });

  it('messages accepts a spaces/ resource name and forwards thread + order', () => {
    const r = run(CHAT, ['messages', 'spaces/AAA', '--thread', 'spaces/AAA/threads/T1', '--asc']);
    expect(r.status).toBe(0);
    expect(r.log).toContain('URL=http://hub.test/api/google/chat/spaces/AAA/messages?');
    const qp = queryParams(r.log);
    expect(qp.get('threadName')).toBe('spaces/AAA/threads/T1');
    expect(qp.get('order')).toBe('asc');
  });

  it('send → POST a thread reply with text', () => {
    const r = run(CHAT, [
      'send',
      'AAA',
      '--text',
      'Done, staging is reset.',
      '--thread',
      'spaces/AAA/threads/T1',
    ]);
    expect(r.status).toBe(0);
    expect(r.log).toContain('METHOD=POST');
    expect(r.log).toContain('URL=http://hub.test/api/google/chat/spaces/AAA/messages');
    expect(requestBody(r.log)).toEqual({
      text: 'Done, staging is reset.',
      threadName: 'spaces/AAA/threads/T1',
    });
  });

  it('rejects a space id with path characters before calling the proxy', () => {
    const r = run(CHAT, ['messages', '../users']);
    expect(r.status).toBe(2);
    expect(r.log).toBe('');
  });

  it('send without --text exits 2', () => {
    const r = run(CHAT, ['send', 'AAA']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--text is required');
  });

  it('explains a missing Chat scope', () => {
    const r = run(CHAT, ['spaces'], {
      status: '403',
      body: '{"error":"scope","code":"google_chat_scope_required"}',
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('Google Chat access has not been granted');
  });

  it('sender-stats samples each space and reports the missing displayName rate', () => {
    // The curl stub answers every request with this body, so it doubles as the
    // spaces page and each space's messages page.
    const body = JSON.stringify({
      spaces: [
        { id: 'AAA', spaceType: 'SPACE' },
        { id: 'BBB', spaceType: 'DIRECT_MESSAGE' },
        { id: null, spaceType: 'SPACE' },
      ],
      messages: [
        {
          createTime: '2026-10-08T10:00:03Z',
          deleted: false,
          sender: { type: 'HUMAN', displayName: 'Ana' },
        },
        {
          createTime: '2026-10-08T10:00:02Z',
          deleted: false,
          sender: { type: 'HUMAN', displayName: null },
        },
        {
          createTime: '2026-10-08T10:00:01Z',
          deleted: false,
          sender: { type: 'BOT', displayName: '' },
        },
        { createTime: '2026-10-08T10:00:00Z', deleted: true, sender: null },
      ],
    });
    const r = run(CHAT, ['sender-stats', '--spaces', '5', '--max', '50'], { body });
    expect(r.status).toBe(0);
    const urls = readFileSync(curlLog, 'utf-8')
      .split('\n')
      .filter((l) => l.startsWith('URL='));
    expect(urls).toEqual([
      'URL=http://hub.test/api/google/chat/spaces?pageSize=5',
      'URL=http://hub.test/api/google/chat/spaces/AAA/messages?pageSize=50',
      'URL=http://hub.test/api/google/chat/spaces/BBB/messages?pageSize=50',
    ]);
    const stats = JSON.parse(r.stdout);
    expect(stats.spacesSampled).toBe(2);
    expect(stats.total).toEqual({ messages: 6, missingDisplayName: 4, rate: 0.667 });
    expect(stats.bySenderType.HUMAN).toEqual({ messages: 4, missingDisplayName: 2, rate: 0.5 });
    expect(stats.bySenderType.BOT).toEqual({ messages: 2, missingDisplayName: 2, rate: 1 });
    expect(stats.bySpaceType.DIRECT_MESSAGE.messages).toBe(3);
    expect(stats.spaces[0]).toEqual({
      space: 'AAA',
      spaceType: 'SPACE',
      messages: 3,
      newestFirst: true,
    });
  });

  it('sender-stats flags a page that came back oldest first', () => {
    const body = JSON.stringify({
      spaces: [{ id: 'AAA', spaceType: 'SPACE' }],
      messages: [
        { createTime: '2026-10-08T10:00:00Z', sender: { type: 'HUMAN', displayName: 'Ana' } },
        { createTime: '2026-10-08T10:00:05Z', sender: { type: 'HUMAN', displayName: 'Bo' } },
      ],
    });
    const r = run(CHAT, ['sender-stats'], { body });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).spaces[0].newestFirst).toBe(false);
  });

  it('sender-stats compares createTime chronologically, not as strings', () => {
    const stats = (times: string[]) => {
      const body = JSON.stringify({
        spaces: [{ id: 'AAA', spaceType: 'SPACE' }],
        messages: times.map((createTime) => ({
          createTime,
          sender: { type: 'HUMAN', displayName: 'Ana' },
        })),
      });
      const r = run(CHAT, ['sender-stats'], { body });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout).spaces[0].newestFirst;
    };
    // Mixed fractional precision: "Z" sorts after "." as a string.
    expect(stats(['2026-10-08T10:00:00.100Z', '2026-10-08T10:00:00Z'])).toBe(true);
    expect(stats(['2026-10-08T10:00:00Z', '2026-10-08T10:00:00.100Z'])).toBe(false);
    // Sub-millisecond digits and offsets: 11:00:00+01:00 is 10:00:00Z.
    expect(stats(['2026-10-08T10:00:00.000000200Z', '2026-10-08T11:00:00.0000001+01:00'])).toBe(
      true,
    );
    expect(stats(['2026-10-08T09:00:00-02:00', '2026-10-08T10:59:59Z'])).toBe(true);
    expect(stats(['2026-10-08T10:00:00Z', 'yesterday'])).toBeNull();
  });

  it('sender-stats reports ordering as unverifiable when createTime is missing', () => {
    const newestFirst = (messages: Array<Record<string, unknown>>) => {
      const body = JSON.stringify({ spaces: [{ id: 'AAA', spaceType: 'SPACE' }], messages });
      const r = run(CHAT, ['sender-stats'], { body });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout).spaces[0].newestFirst;
    };
    const sender = { type: 'HUMAN', displayName: 'Ana' };
    // Every message lacks a timestamp.
    expect(newestFirst([{ sender }, { createTime: null, sender }])).toBeNull();
    // Valid timestamps mixed with missing or non-string ones.
    expect(
      newestFirst([
        { createTime: '2026-10-08T10:00:01Z', sender },
        { sender },
        { createTime: '2026-10-08T10:00:00Z', sender },
      ]),
    ).toBeNull();
    expect(
      newestFirst([
        { createTime: '2026-10-08T10:00:01Z', sender },
        { createTime: 12345, sender },
      ]),
    ).toBeNull();
    // An empty page has no order to check.
    expect(newestFirst([])).toBeNull();
  });

  it('usage prints the whole header, including the jq requirement', () => {
    const r = run(CHAT, ['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('sender-stats [--spaces N] [--max M]');
    expect(r.stdout).toContain('send and sender-stats need `jq`');
  });

  it('sender-stats handles a messages page larger than the 128 KiB argument limit', () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      createTime: `2026-10-08T10:${String(59 - (i % 60)).padStart(2, '0')}:00.${String(999 - i).padStart(3, '0')}Z`,
      text: 'x'.repeat(2048),
      sender: { type: 'HUMAN', displayName: i % 4 === 0 ? null : 'Ana' },
    }));
    // Sort newest first so the page is a valid descending one.
    messages.sort((a, b) => (a.createTime < b.createTime ? 1 : -1));
    const bodyFile = path.join(stubDir, 'big-page.json');
    writeFileSync(
      bodyFile,
      JSON.stringify({ spaces: [{ id: 'AAA', spaceType: 'SPACE' }], messages }),
    );
    expect(readFileSync(bodyFile).length).toBeGreaterThan(128 * 1024);

    const r = run(CHAT, ['sender-stats'], { bodyFile });
    expect(r.stderr).not.toMatch(/Argument list too long/);
    expect(r.status).toBe(0);
    const stats = JSON.parse(r.stdout);
    expect(stats.total).toEqual({ messages: 100, missingDisplayName: 25, rate: 0.25 });
    expect(stats.spaces[0].newestFirst).toBe(true);
  });

  it('sender-stats reports impossible dates as unverifiable instead of aborting', () => {
    const newestFirst = (createTimes: string[]) => {
      const body = JSON.stringify({
        spaces: [{ id: 'AAA', spaceType: 'SPACE' }],
        messages: createTimes.map((createTime) => ({
          createTime,
          sender: { type: 'HUMAN', displayName: 'Ana' },
        })),
      });
      const r = run(CHAT, ['sender-stats'], { body });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout).spaces[0].newestFirst;
    };
    for (const bad of [
      '2026-13-08T10:00:00Z',
      '2026-02-30T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-10-08T24:00:00Z',
      '2026-10-08T23:59:60Z',
      '2026-10-08T10:00:00+24:00',
    ]) {
      expect(newestFirst(['2027-01-01T00:00:00Z', bad]), bad).toBeNull();
    }
    expect(newestFirst(['2024-02-29T00:00:01Z', '2024-02-29T00:00:00Z'])).toBe(true);
  });

  it('sender-stats orders timestamps exactly like the shared RFC 3339 helper', () => {
    const offsets = ['Z', '+05:30', '-08:00', '+23:59', '-23:59', '+00:00'];
    const times: string[] = [];
    for (const year of [1, 1899, 1969, 1970, 2000, 2024, 2100, 9999]) {
      for (let month = 1; month <= 12; month += 1) {
        const offset = offsets[(year + month) % offsets.length];
        const pad = (n: number, w = 2) => String(n).padStart(w, '0');
        times.push(
          `${pad(year, 4)}-${pad(month)}-${pad(((month * 7) % 28) + 1)}T0${month % 10}:30:00.${pad(month, 3)}${offset}`,
        );
      }
    }
    const desc = [...times].sort((a, b) => compareRfc3339(b, a));
    const page = (createTimes: string[]) =>
      JSON.stringify({
        spaces: [{ id: 'AAA', spaceType: 'SPACE' }],
        messages: createTimes.map((createTime) => ({ createTime, sender: { type: 'HUMAN' } })),
      });
    const ordered = run(CHAT, ['sender-stats'], { body: page(desc) });
    expect(JSON.parse(ordered.stdout).spaces[0].newestFirst).toBe(true);
    const reversed = run(CHAT, ['sender-stats'], { body: page([...desc].reverse()) });
    expect(JSON.parse(reversed.stdout).spaces[0].newestFirst).toBe(false);
  });

  it('sender-stats rejects a non-numeric --max before calling the proxy', () => {
    const r = run(CHAT, ['sender-stats', '--max', 'lots']);
    expect(r.status).toBe(2);
    expect(existsSync(curlLog)).toBe(false);
  });

  it('relays Chat setup errors with the fix-it link', () => {
    const r = run(CHAT, ['spaces'], {
      status: '403',
      body: '{"error":"The Google Chat API is turned off.","code":"google_chat_api_disabled","helpUrl":"https://console.cloud.google.com/apis/library/chat.googleapis.com"}',
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('Google Chat is not set up: The Google Chat API is turned off.');
    expect(r.stderr).toContain(
      'fix it here: https://console.cloud.google.com/apis/library/chat.googleapis.com',
    );
  });
});

describe('not-linked / error mapping', () => {
  it('surfaces a clear "not linked → Settings → Account → Google" message on google_not_connected', () => {
    const r = run(CAL, ['list', '--from', '2026-06-30T00:00:00Z', '--to', '2026-07-01T00:00:00Z'], {
      status: '401',
      body: '{"error":"Google account is not connected","code":"google_not_connected"}',
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('has not linked a Google account');
    expect(r.stderr).toContain('Settings → Account → Google');
  });

  it('explains an unconfigured OAuth app', () => {
    const r = run(MAIL, ['threads'], {
      status: '503',
      body: '{"error":"Google OAuth is not configured on this server","code":"google_oauth_not_configured"}',
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('Google OAuth is not configured');
  });

  it('explains a missing surface scope', () => {
    const r = run(SHEETS, ['get', 'sheet-123'], {
      status: '403',
      body: '{"error":"scope","code":"google_sheets_scope_required"}',
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('Google Sheets access has not been granted');
  });

  it('returns exit 7 (not 3) when the Hub is unreachable — curl prints 000 AND exits non-zero', () => {
    // Reproduces the connection-failure case: curl writes `000` for
    // %{http_code} and exits 7. The wrapper must report unreachable (exit 7),
    // not fall through to the generic proxy-error path (exit 3).
    const r = run(CAL, ['list', '--from', '2026-06-30T00:00:00Z', '--to', '2026-07-01T00:00:00Z'], {
      status: '000',
      curlExit: '7',
    });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain('could not reach the Hub');
    // Must NOT be misreported as a proxy error.
    expect(r.stderr).not.toContain('request failed (HTTP');
  });

  it('still returns exit 7 for a timeout-style curl exit (28)', () => {
    const r = run(MAIL, ['threads'], { status: '000', curlExit: '28' });
    expect(r.status).toBe(7);
    expect(r.stderr).toContain('could not reach the Hub');
  });
});
