# Servers and organizations: concepts, access and rollout

This page describes how Servers and organizations relate, who can see what, how
organization agents and their Computers behave, what the upgrade preserves, and how to
disable or roll back. Connection-level compatibility details (routes, storage keys, Electron
files) live in [server-connection-compatibility.md](server-connection-compatibility.md).

## Two concepts

**Server.** The existing connection and data-isolation boundary: a local data partition or a
saved remote connection. Everything that used to be called an "org" in storage, auth and old
clients is a Server: `orgs.db`'s `orgs` table, `memberships.org_id`, the JWT's active org,
`/api/orgs`, the per-partition data directory, saved logins, push registration keys and deep
links. `/api/servers` is an alias of `/api/orgs`; both stay supported. Server roles are
Owner, Admin and User. In a browser the Server is the origin you sign in to; Electron and
mobile can switch between saved Servers.

**Organization.** An optional grouping of projects inside one Server, created explicitly by a
person. A project can belong to no organization, one, or several on the same Server. Adding a
project creates a link; it never moves, copies or re-owns the project, its agents, board,
wiki or repository. Organization roles are Owner, Admin and Member, stored separately from
Server roles. Organizations live under `/api/organizations` and in the shared `orgs.db`:
`business_organizations`, `business_organization_projects` (unique on
`server_id, organization_id, project_id`), `business_organization_members` and
`business_organization_archived_members`, each keyed by `server_id`.

Out of scope for this release, and future work: organizations that span Servers, nested
organizations, marketing / CRM / accounting or other business-operations integrations, shared
credential vaults and scheduled business automation. No organization agent runs on a
schedule.

## Who can see and do what

| Actor                                    | Can                                                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization Owner / Admin               | Rename and archive the organization, manage members, link and unlink projects they can access themselves, create, edit, disable and archive organization agents |
| Organization Member                      | View the organization, chat with its active agents, dispatch through an agent that has the dispatch tool                                                        |
| Server Owner / Admin who is not a member | Administer the organization; never read a member's private chats or private projects                                                                            |
| Server user who is not a member          | Nothing: organization routes answer 404, with no names or counts                                                                                                |

Effective project visibility is always an intersection:

```
organization links  ∩  the agent's configured project scope  ∩  the session owner's project ACL
```

Organization membership never grants project access. Private projects and projects with an
assignment ACL stay limited to their existing members, whatever organization they are linked
to. A Member of an organization that links a restricted project they can't access sees the
organization without that project, in the portfolio, context tools, search, WebSocket events,
prompt enrichment and dispatch. Authorization is checked again on every read, event, prompt and
dispatch, not cached from an earlier check.

Organization agent processes do not get the global `AGENT_HUB_API_KEY`. Each turn gets a
capability token bound to (Server, organization, user, session) that expires after 15 minutes
and can be renewed while access holds. It permits only the organization's read and dispatch
routes for authorized linked projects and the session's own tools; Server admin, config and
credential APIs answer 403. Removing a member, unlinking a project, losing project access or
narrowing an agent's tools or scope revokes the capability and stops the running turn; the next
turn starts with fresh context. The spawned CLI environment is reduced to an allowlist and runs
under the user's per-user HOME. This is credential isolation, not a filesystem sandbox.

## Organization agents

Each new organization starts with one **Organization Assistant**: stable ID, editable name,
instructions and model, all tools, access to all linked projects the chatting user can access,
and Computer on by default. Its default purpose is tracking priorities, summarizing linked
projects, dispatching project agents and following up on them.

There is no fixed executive roster. Owners and Admins add any number of agents from scratch or
from an optional starter template: CEO, Finance, Operations, Technical Lead, Marketing. A
template fills in a name and starting instructions once. It grants no tools, projects,
Computer or authority, and a later template version never rewrites an agent made from an
earlier one. Every agent, the Assistant included, uses the same model: name, instructions,
model, tool permissions, project scope (all linked, an explicit subset, or none), enabled or
archived, and a Computer preference. New custom agents start with read access only, all linked
projects and Computer off. A title such as "CEO" carries no permissions.

Agents can be renamed, disabled or archived, including the Assistant. Archiving stops new chats
and dispatch and keeps each person's existing conversations as read-only history. Startup
repair never recreates an archived or removed Assistant; an organization with no active agents
shows an **Add agent** action.

Organization agents run in a hidden workspace per organization (`workspaceKind:
"organization"`, ID derived from the Server and organization IDs). It is not a user project:
it never appears in project lists, can't be linked to an organization, and is excluded from dev
dispatch, repository worktrees and Finalize. Chats belong to the person who started them and
use that person's CLI login.

**Dispatch.** An organization agent (or a member, from their own organization chat) can start
a task on an eligible project agent in a linked project. The target is an ordinary project
session owned by the acting user, under the project's own lifecycle, concurrency limit
(`AGENT_HUB_ORG_DISPATCH_MAX_ACTIVE_PER_AGENT`, default 1) and manual Finalize level. Requests
record the organization, organization agent, initiating chat, acting user, target and
idempotency key; an identical retry returns the same target session. A busy target queues the
request; queued requests are re-authorized when they run. Unlinking a project stops further
reads and dispatch, and accepted target sessions stay with their owner.

## Computer isolation

Every organization agent can have the Computer tool, configured per agent. The Assistant starts
with it on; custom agents start without it, and a template never turns it on. Each chat can
turn Computer off or back to the agent default.

A desktop is keyed by (Server data partition, session owner, organization workspace, agent,
backend). Two users, two organizations, two agents, or the same organization ID on two Servers
never share a disk, browser profile or saved login. Renaming an agent keeps its desktop.
Creating an organization or agent never boots a desktop; it starts on first use and follows the
existing idle shutdown, retention, approval and credential-request rules. Disabled or archived
agents, archived organizations and removed members can't start Computer operations. When no
desktop backend is available the chat says so and keeps working. Computer access grants no
financial or publishing authority.

## Upgrade: what is preserved

Upgrading creates no organization, links no project and moves no data. It preserves:

- Server IDs, names, colors, positions and the active selection in `orgs.db`, and each
  partition's data directory.
- Users, Server memberships and roles, JWT claims and signing material, so nobody is signed out.
- Project IDs, ownership, visibility, assignment ACLs, agents, boards, wikis and sessions.
- Server-wide shared Todos, the Hub dashboard, invites and member settings (relabeled as
  Server-wide, still keyed by `org_id`).
- Saved connections and logins on web (`agent-hub-remote-orgs`, `agent-hub-active-org`,
  `agent-hub-jwt`), mobile (`agent-hub-orgs`, `agent-hub-jwt-by-origin`) and Electron
  (`remote-orgs.json`, `active-org.json`, `auth-token.json`), push registrations and deep links.
- Project Computers and saved browser logins. Ones created before Server scoping stay with the
  default Server.

Schema changes are additive and no table that existed before organizations is altered. The
`business_organization_*` tables are new in `orgs.db`; `organization_workflow_sessions` and
`organization_dispatch_requests` are new in each Server's `agent-hub.db`. The only `ALTER
TABLE` adds `link_id` to `business_organization_projects`, which is itself new.

## Disable and roll back

There is no global switch. To stop organization activity without a deploy:

- **One agent:** clear **Enabled** or archive it. Disabling is reversible from the agent editor;
  an archived agent can be restored from **Archived agents**.
- **One project:** unlink it. Its sessions, board and data are untouched; relinking restores
  access.
- **One organization:** archive it. Members lose access, dispatch and Computer stop, and chat
  history stays with its owners. There is no unarchive action.
- **Dispatch only:** remove the **Dispatch project agents** tool from the organization's agents.

To roll back to a build without organizations:

1. Back up `orgs.db` and each Server's `projects.json`.
2. Archive or leave organizations as they are; the older build ignores the new `orgs.db` tables.
3. Remove the entries with `"workspaceKind": "organization"` from each Server's
   `projects.json`. Older builds classify every `kind: "system"` project as the Hub, and these
   hidden workspaces are stored with that kind.
4. Deploy the older build. Projects, Servers, logins and sessions are unchanged.

To roll forward again, restore the backed-up `projects.json` entries before starting the new
build. Workspace IDs are derived from the Server and organization IDs, so the restored entries
reconnect to their agents' chats, dispatch history and Computers, and keep the Assistant's
archived state.

## Verification

| Layer   | Test                                                                                 | What it covers                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web E2E | `npm run test:e2e:organizations` (`e2e/organizations/organization-workflow.spec.ts`) | The full flow in a browser against a real Hub with fake agent CLIs, including the scoped agent's own capability being refused out-of-scope reads, dispatch and Server admin APIs, and a Hub restart |
| Server  | `server/test/organization-acceptance.test.ts`                                        | The same journey through the HTTP routes                                                                                                                                                            |
| Server  | `server/test/organization-upgrade-isolation.test.ts`                                 | Legacy upgrade, live revocation, cross-Server isolation, no resurrection                                                                                                                            |
| Mobile  | `mobile/src/components/OrganizationsPanel.workflow.test.tsx`                         | The flow through the mobile panel, including Server switching and a restricted member                                                                                                               |

The organization E2E runs separately from `npm run test:e2e` because it needs signed-in users.
It starts its own Hub with an allowlisted environment, a temporary data directory and HOME, and
points every agent CLI at `e2e/organizations/fake-agent-cli.sh`.
