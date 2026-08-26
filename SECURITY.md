# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Report vulnerabilities privately through GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
open the repository's **Security** tab and click **Report a vulnerability**.
This opens a private advisory visible only to you and the maintainers.

Include as much of the following as you can:

- A description of the issue and its impact.
- Steps to reproduce, or a proof-of-concept.
- Affected version(s) or commit SHA.
- Any suggested remediation.

You can expect an initial acknowledgement within **5 business days**. We will
keep you updated as we triage and fix the issue, and we will credit you in the
advisory unless you ask otherwise.

## Supported Versions

Agent Hub ships from `main` and cuts versioned releases (see the `version`
field in `package.json`). Security fixes land on `main` and are included in the
next release. Only the latest release line receives security updates.

| Version        | Supported          |
| -------------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |

Self-hosters should track the latest release (or `main`) to receive fixes.

## Threat Model — Read This Before You Deploy

Agent Hub is designed for a **single, trusted team operating its own
deployment**. This is a deliberate architectural choice, and it has direct
security consequences you must understand before exposing an instance to
anyone.

### Agents run a real shell as the server OS user

An Agent Hub agent is a CLI process (Claude Code, Cursor, Codex, Gemini) that
executes commands, reads and writes files, and runs git operations **as the
same OS user that runs the server process**, inside that user's environment and
filesystem. There is no per-session kernel-level sandbox. An agent can, by
design:

- Read and modify any file the server user can access.
- Run arbitrary shell commands with the server user's privileges.
- Reach any network destination the host can reach, including cloud metadata
  endpoints and internal services on the same network.
- Use any credentials injected into the session (git tokens, cloud profiles,
  skill API keys).

This is the intended capability model: the product's job is to let agents do
real engineering work. It is **not** a bug, and it is **not** something to
"lock down" with application-level checks alone.

### What this means for how you deploy

- **Only give access to people you trust to run code on the host.** Every user
  who can start a session can, transitively, run commands as the server user.
- **Do not run a shared instance as a public multi-tenant service.** The
  current architecture is not safe for mutually-distrusting tenants. True
  multi-tenant isolation would require per-session microVM/Firecracker-grade
  sandboxing (a separate guest kernel per session), which Agent Hub does not
  provide today.
- **Isolate the host.** Run the server as a dedicated, least-privileged OS user
  on a host (or VM/container) that contains only what that team is allowed to
  touch. Scope injected credentials to the minimum required. Segment the
  network so a compromised or misused session cannot pivot into unrelated
  infrastructure.
- **Terminate TLS and enforce auth at the edge.** Port 3051 is intended to be
  localhost-only behind a reverse proxy; the first `/api/auth/setup` creates the
  Owner account. Do not expose the raw port to untrusted networks.

If your use case requires isolating mutually-distrusting users on one
deployment, Agent Hub in its current source-available form is not the right fit.
Per-session isolation is not provided by the current release.

## Scope

In scope for a security report:

- Authentication or authorization bypass (accessing another org/user's data,
  privilege escalation across the Owner > Admin > User hierarchy).
- Injection, SSRF, or path-traversal flaws in the server or API.
- Secret/credential leakage (tokens, API keys, session data) to unauthorized
  callers.
- Vulnerabilities in the build, release, or update path.

Explicitly **out of scope** (these are documented design properties, not
vulnerabilities):

- An authenticated, trusted user causing an agent to run shell commands, read
  local files, or reach the network as the server user. That is the intended
  capability model described above.
- Lack of sandboxing between sessions of the same trusted team.
