// Child process that extracts text from one untrusted upload and exits. All
// document parsing (every format, plain text included) happens here, never
// in the server: the parent watches this process's RSS, kills it past the
// memory limit or the time limit, and marks it as the kernel's preferred OOM
// victim. Plain JS so it runs under plain node and Electron's node mode.
import { extractDocumentText, TOO_LARGE } from './wiki-file-extract-core.mjs';

process.once('message', async (input) => {
  let reply;
  try {
    reply = { ok: true, ...(await extractDocumentText(input)) };
  } catch (err) {
    reply = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: err && err.code === TOO_LARGE ? TOO_LARGE : undefined,
    };
  }
  process.send(reply, () => process.exit(0));
});
