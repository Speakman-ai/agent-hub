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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.join(__dirname, 'default-skills', 'google');
const SCRIPTS = path.join(SKILL_DIR, 'scripts');
const AGENT_HUB_SKILLS_DIR = path.join(__dirname, 'default-skills', 'agent-hub');

const CAL = path.join(SCRIPTS, 'google-cal.sh');
const MAIL = path.join(SCRIPTS, 'google-mail.sh');
const SHEETS = path.join(SCRIPTS, 'google-sheets.sh');
const DRIVE = path.join(SCRIPTS, 'google-drive.sh');

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
    '[[ -n "$outfile" ]] && printf "%s" "${CURL_BODY:-{\\}}" > "$outfile"',
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
