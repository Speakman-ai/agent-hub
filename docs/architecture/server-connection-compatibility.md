# Server connections and legacy organization identifiers

A **Server** is the existing connection and data-isolation boundary. It may be a
local partition or a remote connection, rather than a physical machine. The
legacy `org` vocabulary in storage, authentication and old clients still means
this Server boundary. It must never be reused for business organizations.

## Connection API

The following operations share handlers, membership checks and storage:

| Server API                     | Legacy API                  | Behavior                                                         |
| ------------------------------ | --------------------------- | ---------------------------------------------------------------- |
| `GET /api/servers`             | `GET /api/orgs`             | List saved connections                                           |
| `GET /api/servers/:id`         | `GET /api/orgs/:id`         | Read one connection                                              |
| `POST /api/servers`            | `POST /api/orgs`            | Create a connection; authenticated creator gets Owner membership |
| `PUT /api/servers/:id`         | `PUT /api/orgs/:id`         | Update connection settings, preserving the ID                    |
| `DELETE /api/servers/:id`      | `DELETE /api/orgs/:id`      | Target Owner can delete; cannot delete the last connection       |
| `GET /api/servers/:id/members` | `GET /api/orgs/:id/members` | Target Admin/Owner can list members                              |
| `POST /api/servers/:id/switch` | `POST /api/orgs/:id/switch` | Target member activates the existing partition                   |
| `POST /api/server/switch`      | `POST /api/org/switch`      | Switch by body ID                                                |

Connection records retain `id`, `name`, `mode`, `color`, and `position`. Server
responses adapt `remote_url`, `api_key`, `created_at`, and `updated_at` to
`remoteUrl`, `apiKey`, `createdAt`, and `updatedAt`. Create/update requests use
camelCase fields on both APIs. Member and switch responses use `serverId` on the
new API and `orgId` on the legacy API. The new body-switch request is
`{ "serverId": "existing-id" }`; the old request remains `{ "orgId": "existing-id" }`.

New write requests are Zod-validated. The Server body-switch endpoint requires a
saved connection; it returns 404 for an unknown ID. Legacy input handling and
response shapes remain unchanged. Global API-key, local bundled mode and no-auth
behavior continue through the existing auth and route checks. This change does
not add new role restrictions to legacy connection reads or updates.

Switches use the same database initialization, project reload and scheduler
lifecycle. Switching to the already-active ID is a no-op. The WebSocket event
remains `org_switched` with `orgId` and `dataDir`, so old web/mobile/Electron
listeners keep working. A remote bookmark's client-generated ID is not
necessarily a partition ID on its destination server; connecting to that URL
remains a client operation. The `active` alias on the legacy dashboard/Todo APIs
continues resolving the destination's active partition.

Implementation: `server/routes/orgs.ts`, `server/server-connections.ts` and
`server/routes/orgs.openapi.ts`. The generated API contract is
`docs/api/openapi.yaml`.

## Compatibility inventory

| Surface                  | Existing source/contract                                                                                | Scope and preservation rule                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Partition registry       | `server/orgs.ts`: `orgs.db`, `orgs`, `active_org.org_id`                                                | Keep database/table names, IDs, positions and active selection. Default uses `config.dataDir`; other partitions use `~/.agent-hub/orgs/<id>`.                                   |
| Server membership        | `server/memberships-store.ts`, `memberships.org_id`                                                     | Owner/Admin/User remain Server roles. New organization membership must be separate.                                                                                             |
| Auth and JWT             | `server/auth.ts`, `server/users-store.ts`, `server/auth-store.ts`                                       | Keep JWT claims, signing material, user IDs and credential versions. The middleware resolves `authOrgId` and role from current legacy Server membership. No forced sign-in.     |
| Shared Todos             | `server/routes/org-todos.ts`, `server/org-todos-store.ts`, `org_todos.org_id`, `/api/orgs/:orgId/todos` | The shared list belongs to the Server and is editable by its members. Keep `orgId` payloads and `org_todo_update` events. Do not transfer this list to a business organization. |
| Hub dashboard            | `server/routes/dashboard.ts`, `/api/orgs/:id/dashboard`                                                 | Existing Server-wide dashboard; `active` resolves to the active partition. Non-active partitions still return 409. Project visibility rules stay in place.                      |
| Invites/member settings  | `server/routes/auth.ts`, `/api/auth/invites`, `/api/auth/users`, `server/invites-store.ts`              | Existing invitations and membership settings remain Server-wide. Preserve `invites.org_id`, invite tokens, `orgId`/`orgName` response fields and acceptance links.              |
| Web saved connections    | `client/src/utils/orgs.ts`                                                                              | Keep `agent-hub-remote-orgs`, `agent-hub-active-org`, bookmark IDs, URLs and old `/api/orgs` calls.                                                                             |
| Web login/config         | `client/src/utils/auth.ts`, `client/src/utils/config.ts`                                                | Keep `agent-hub-jwt`, `agent-hub-connection` and origin-scoped login behavior.                                                                                                  |
| Mobile saved connections | `mobile/src/utils/orgs.ts`                                                                              | Keep AsyncStorage `agent-hub-orgs`, its `orgs` array, `activeOrgId`, IDs and URLs.                                                                                              |
| Mobile saved logins      | `mobile/src/utils/auth.ts`                                                                              | Keep `agent-hub-jwt` and `agent-hub-jwt-by-origin`; switches restore the destination's login.                                                                                   |
| Push/deep-link routing   | `mobile/src/utils/pushRegistrar.ts`, `shared/utils/pushServerTag.ts`                                    | Keep saved connection identities and per-origin registration/auth state. Preserve `hubServerUrl` notification tags and destination routing.                                     |
| Electron connections     | `electron/main.ts`, `electron/preload.cjs`                                                              | Keep `remote-orgs.json`, `active-org.json`, `connection.json`, `auth-token.json`, `activeOrgId` and existing `*-org*` IPC names.                                                |

## Organization boundary and rollout

`/api/organizations` is reserved for the new optional business grouping concept.
Its persistence uses separate `business_organizations`,
`business_organization_projects`, and `business_organization_members` tables with
an explicit `server_id` referencing the legacy partition. A project link must
not change its existing ownership, ID or data directory. This API addition
creates no business organization, does not reassign projects and runs no
connection or client-storage migration.

The same-phase UI terminology card
`f651d834-d2f4-4adb-8c67-50dafb44be53` owns visible connection and Server-wide
labels across web, mobile and Electron. It should use this inventory while
preserving the compatibility identifiers above. Later organization phases must
not start until both Server terminology phase cards are Done.

## Verification

`server/routes/orgs.phase3.test.ts` exercises both APIs against the same real
membership/auth stores and covers CRUD adapters, saved legacy records reopened
from `orgs.db`, an existing JWT across partition changes, unchanged project
files/auth records/schema, validation, API-key/no-auth access, and the legacy
switch event/no-op contract. `server/test/orgs-switch.test.ts` exercises both
route families through the production application wiring. Existing web
connection, mobile login/push and Electron remote-auth tests guard the client
contracts that remain readable during rollout.
