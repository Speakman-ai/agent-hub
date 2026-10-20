# The `computer` tool — your persistent Linux desktop

The `computer` tool is switched on per session: the **Computer** switch in
the chat top bar (web) or the engine/model sheet (mobile), stored as
`sessions.computer_tool_enabled` and set with
`PUT /api/sessions/{sessionId}/computer-tool` (`{"enabled": true | false | null}`).
A session that never set it uses the agent's default (Settings → Agents,
`computerToolEnabled`), which is off. With it on, the agent drives a Linux desktop the
Hub runs for it. The host executes the ops, so every engine (Claude Code,
Cursor, Codex, Gemini, Grok) uses the same `<agenthub:react>` shape:

```
<agenthub:react>{"actions":[{"tool":"computer","op":"screenshot"}]}</agenthub:react>
```

(Emit the block as a naked tag in a real reply, never inside a code fence.)

## The desktop

- One computer per (Server, session owner, agent, project), shared by all of
  that user's sessions with the agent. Files, downloads and app logins in the
  home directory survive between sessions. A project with the same id on two
  Servers gets two separate computers and browser logins. Computers and
  logins saved before Servers were separated stay with the default Server.
- Organization agents get their own computer per (Server, session owner,
  organization, agent). The organization's hidden workspace stands in for
  the project, so two users, two organizations, two agents or the same
  organization on two Servers never share files or logins, and renaming the
  agent keeps its desktop. The Organization Assistant starts with Computer
  on; custom agents start off, and a template never turns it on. The agent's
  tool scope must include Computer, and an archived or disabled agent, an
  archived organization or a removed member cannot use it.
- Debian + Xvfb + openbox + Chromium, screen fixed at **1280x800**, origin
  top-left. Coordinates are screenshot pixels.
- Boots on first use (can take a minute), stops after 30 idle minutes, and
  resumes on the next op. It runs in a container or a Firecracker microVM;
  the ops behave the same on both.

## Ops

| op                       | operands                                                                                                      | result                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `screenshot`             | none                                                                                                          | PNG saved on the Hub; observation gives the absolute path and width x height. Read the path with your file-reading tool. |
| `click` / `double_click` | `x`, `y`, optional `button` (`left`, `middle`, `right`)                                                       |                                                                                                                          |
| `type`                   | `text` (max 10000 chars)                                                                                      | Types into the focused window.                                                                                           |
| `key`                    | `combo`, xdotool key names: `ctrl+l`, `Return`, `ctrl+shift+t`; space-separate a sequence (`ctrl+a Delete`)   |                                                                                                                          |
| `scroll`                 | `x`, `y`, `direction` (`up`, `down`, `left`, `right`), optional `amount` 1-50 (default 3)                     |                                                                                                                          |
| `drag`                   | `x`, `y` (start), `toX`, `toY` (end)                                                                          | Left-button drag.                                                                                                        |
| `wait`                   | `ms` (0-30000, default 1000)                                                                                  | Host-side pause; does not boot the desktop.                                                                              |
| `cursor_position`        | none                                                                                                          | Current pointer coordinates.                                                                                             |
| `exec`                   | `command` (run by `bash -lc` as the desktop user), optional `timeoutMs` (max 600000), optional absolute `cwd` | Exit code plus stdout/stderr (each clipped to the last 8000 chars).                                                      |

Aliases accepted: `key` for `combo`, `timeout_ms` for `timeoutMs`. Invalid
operands (off-screen coordinates, unknown key names, unknown ops) reject the
whole ReAct block as malformed before anything runs.

## Working pattern

1. `screenshot`, then read the image.
2. Act (`click`, `type`, `key`, ...) using coordinates from that image.
3. `screenshot` again to confirm the result. Input ops do not return an image.

Ask for an `approval` before sending, submitting, deleting, purchasing or
publishing anything from the desktop. You may type the user's own passwords
and 2FA codes to sign in; collect them with an `agenthub:credential-request`
card (never plain chat) and never echo them back.

## Saved logins

The desktop Chromium keeps a password manager in its persistent profile,
local to this computer (sync and leak checks are off by policy), so a site
that signs you out does not need the user again:

1. The first time a site needs a password, ask the user to sign in through
   the **Agent browser** pane and click **Save** when Chromium offers to save
   the password (and tick "remember this device" if the site offers it).
   If the user would rather give you the credentials, sign in yourself and
   click **Save** the same way.
2. On later logins, when the site signs you out, open its login page.
   Chromium fills the saved username and password; if it does not, click the
   username field and pick the saved account from Chromium's dropdown. Then
   submit the form yourself.
3. If the saved password is rejected, ask the user to sign in again through
   the pane and click **Update** when Chromium offers it.

Never echo a saved password back into chat, logs or files. A shell command
can read any file, the saved passwords included, and nothing in its text
says which files it reaches, so every `exec` waits for the human's approval,
every time, and the answer is never remembered (a `desktop:shell` Block
policy refuses it outright). Prefer clicks and typing, and batch shell work
into few commands. Signing in with autofill is clicks and keystrokes, not
`exec`, so it is not held up by this.

## Failure observations

- **Computer tool disabled**: the tool is off for this session. Ask the user
  to switch it on for the session; do not retry.
- **No owning user or project**: the session has no owner, so there is no
  computer to use.
- **Computer tool not authorized**: an organization agent's scope excludes
  Computer, or its access changed mid-turn. Do not retry; the remaining
  actions in the block were skipped.
- **The desktop op failed: ...**: the runtime is unavailable on this host
  (for example `desktopRuntime: firecracker` without KVM), the desktop could
  not start, or the op itself failed. The message says which.
