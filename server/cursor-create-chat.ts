// `cursor-agent create-chat` with a hard timeout.
//
// Chat starts every new Cursor session by minting a chat id, then passes it as
// `--resume <id>` to the real spawn. That mint used to run through a bare
// `execFile` with no timeout, so when the CLI wedged — reproduced with an
// expired OAuth token, where the process sits in `S (sleeping)` and never
// writes to stdout — the awaiting turn never settled: no assistant message, no
// error, no `active_tasks` row, and the session showed as thinking forever.
// Only a server restart cleared it.
//
// A bounded exec turns that permanent hang into a normal turn error, which the
// caller already surfaces to the transcript.

import { execFile } from 'child_process';

/** How long `cursor-agent create-chat` may run before we give up on it. */
export const CURSOR_CREATE_CHAT_TIMEOUT_MS = 60_000;

export type CreateChatExecFile = typeof execFile;

export interface CreateCursorChatOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Injectable exec — tests override this instead of spawning a real CLI. */
  exec?: CreateChatExecFile;
}

/**
 * Mint a Cursor chat id. Rejects (rather than hanging) when the CLI produces
 * no id within `timeoutMs`.
 */
export function createCursorChatBounded(
  cursorBin: string,
  opts: CreateCursorChatOpts,
): Promise<string> {
  const timeout = opts.timeoutMs ?? CURSOR_CREATE_CHAT_TIMEOUT_MS;
  const exec = opts.exec ?? execFile;
  return new Promise((resolve, reject) => {
    exec(
      cursorBin,
      ['create-chat'],
      { cwd: opts.cwd, env: opts.env, timeout, killSignal: 'SIGKILL' },
      (err, stdout, stderr) => {
        const out = String(stdout ?? '');
        const errText = String(stderr ?? '');
        if (err) {
          // execFile reports a timeout kill as `killed` with the kill signal;
          // name it explicitly so the transcript says why the turn stopped.
          const killed = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
          if (killed) {
            reject(
              new Error(
                `cursor create-chat timed out after ${timeout}ms — the Cursor CLI stopped responding ` +
                  `(most often an expired login; re-authenticate under Account settings)`,
              ),
            );
            return;
          }
          reject(new Error(`cursor create-chat failed: ${errText || err.message}`));
          return;
        }
        const id = out.trim().split(/\s+/).pop();
        if (!id) {
          reject(new Error('cursor create-chat returned no id'));
          return;
        }
        resolve(id);
      },
    );
  });
}
