/**
 * Zod schemas + OpenAPI registration for replay playlists
 * (`server/routes/replay-playlists.ts`).
 *
 * Named, project-scoped groups of saved replay captures, plus playlist-level
 * extended retention (reuses the per-session two-tier model from card 1369).
 */
import { z, registerPath, registerComponent } from '../openapi/registry.js';

const ErrorResponse = registerComponent(
  'ReplayPlaylistErrorResponse',
  z.object({ error: z.string() }).openapi({ description: 'Error envelope.' }),
);

const playlistObject = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  extendedRetention: z
    .boolean()
    .openapi({ description: 'Whether the whole playlist is flagged for extended retention.' }),
  retainedUntil: z.string().nullable().openapi({
    description:
      'Absolute SQLite-UTC instant the playlist (and its members) are retained until, or null when on the default window.',
  }),
  retentionFlaggedAt: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  updatedAt: z.string(),
});

const PlaylistView = registerComponent(
  'ReplayPlaylist',
  playlistObject.openapi({ description: 'A named group of saved replay captures.' }),
);

const PlaylistItemView = registerComponent(
  'ReplayPlaylistItem',
  z
    .object({
      replayId: z.string(),
      position: z.number().int().nonnegative(),
      addedAt: z.string(),
      createdAt: z.string(),
      durationMs: z.number().int().nonnegative(),
      eventCount: z.number().int().nonnegative(),
      size: z.number().int().nonnegative(),
      supportTicketId: z.string().nullable(),
      cardId: z.string().nullable(),
      retainedUntil: z.string().nullable(),
      retentionFlaggedAt: z.string().nullable(),
      eventsUrl: z.string(),
    })
    .openapi({ description: 'A playlist membership joined to its capture metadata.' }),
);

const PlaylistWithItems = registerComponent(
  'ReplayPlaylistWithItems',
  playlistObject.extend({ items: z.array(PlaylistItemView) }).openapi({
    description: 'A playlist plus its ordered member captures.',
  }),
);

const AddPlaylistItemResponse = registerComponent(
  'AddReplayPlaylistItemResponse',
  playlistObject
    .extend({
      added: z.boolean().openapi({
        description:
          'true when a new membership row was inserted; false when the capture was already a member (idempotent no-op).',
      }),
      items: z.array(PlaylistItemView),
    })
    .openapi({
      description: 'A playlist with its items plus whether the capture was newly added.',
    }),
);

const CreatePlaylistRequest = registerComponent(
  'CreateReplayPlaylistRequest',
  z
    .object({
      name: z.string().openapi({ description: 'Playlist name (1–200 chars, trimmed).' }),
      description: z.string().nullable().optional(),
    })
    .openapi({ description: 'Body for creating a playlist.' }),
);

const UpdatePlaylistRequest = registerComponent(
  'UpdateReplayPlaylistRequest',
  z
    .object({
      name: z.string().optional().openapi({ description: 'New name (1–200 chars).' }),
      description: z.string().nullable().optional(),
    })
    .openapi({ description: 'Partial update; omitted fields are unchanged.' }),
);

const AddPlaylistItemRequest = registerComponent(
  'AddReplayPlaylistItemRequest',
  z
    .object({
      replayId: z
        .string()
        .openapi({ description: 'Id of a saved capture attributed to this project.' }),
    })
    .openapi({ description: 'Body for adding a capture to a playlist.' }),
);

const RetentionRequest = registerComponent(
  'ReplayPlaylistRetentionRequest',
  z
    .object({
      extend: z.boolean().openapi({
        description:
          'true flags the playlist and every member capture for extended retention; false clears the playlist-level flag (members keep their own retained_until).',
      }),
    })
    .openapi({ description: 'Body for flagging a playlist for extended retention.' }),
);

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const projectParam = z.object({ projectId: z.string() });
const playlistParams = z.object({ projectId: z.string(), playlistId: z.string() });
const itemParams = z.object({
  projectId: z.string(),
  playlistId: z.string(),
  replayId: z.string(),
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/replay-playlists',
  tags: ['Replays'],
  summary: 'List replay playlists for a project',
  request: { params: projectParam },
  responses: {
    200: {
      description: 'The project’s playlists (with member counts).',
      content: jsonContent(z.object({ playlists: z.array(PlaylistView) })),
    },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/replay-playlists',
  tags: ['Replays'],
  summary: 'Create a replay playlist',
  request: { params: projectParam, body: { content: jsonContent(CreatePlaylistRequest) } },
  responses: {
    201: { description: 'The created playlist.', content: jsonContent(PlaylistView) },
    400: { description: 'Invalid name.', content: jsonContent(ErrorResponse) },
    404: { description: 'Project not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/replay-playlists/{playlistId}',
  tags: ['Replays'],
  summary: 'Get one playlist with its member captures',
  request: { params: playlistParams },
  responses: {
    200: { description: 'The playlist and its items.', content: jsonContent(PlaylistWithItems) },
    404: {
      description: 'Project or playlist not found (cross-project playlists are masked as 404).',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'patch',
  path: '/api/projects/{projectId}/replay-playlists/{playlistId}',
  tags: ['Replays'],
  summary: 'Rename or update a playlist',
  request: { params: playlistParams, body: { content: jsonContent(UpdatePlaylistRequest) } },
  responses: {
    200: { description: 'The updated playlist.', content: jsonContent(PlaylistView) },
    400: { description: 'Invalid name.', content: jsonContent(ErrorResponse) },
    404: { description: 'Project or playlist not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/replay-playlists/{playlistId}',
  tags: ['Replays'],
  summary: 'Delete a playlist',
  description:
    'Removes the playlist and its membership rows (cascade). Member captures are not deleted or un-flagged.',
  request: { params: playlistParams },
  responses: {
    204: { description: 'Deleted.' },
    404: { description: 'Project or playlist not found.', content: jsonContent(ErrorResponse) },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/replay-playlists/{playlistId}/items',
  tags: ['Replays'],
  summary: 'Add a saved capture to a playlist',
  description:
    'Adds a project-owned capture to the playlist (idempotent). If the playlist is flagged for extended retention, the new member inherits the flag. A capture that is unattributed or owned by another project is masked as 404.',
  request: { params: playlistParams, body: { content: jsonContent(AddPlaylistItemRequest) } },
  responses: {
    201: {
      description: 'Capture added (added=true).',
      content: jsonContent(AddPlaylistItemResponse),
    },
    200: {
      description: 'Capture already present (idempotent no-op, added=false).',
      content: jsonContent(AddPlaylistItemResponse),
    },
    400: { description: 'Missing replayId.', content: jsonContent(ErrorResponse) },
    404: {
      description: 'Project, playlist, or replay not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/replay-playlists/{playlistId}/items/{replayId}',
  tags: ['Replays'],
  summary: 'Remove a capture from a playlist',
  request: { params: itemParams },
  responses: {
    204: { description: 'Removed.' },
    404: {
      description: 'Project, playlist, or playlist item not found.',
      content: jsonContent(ErrorResponse),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/replay-playlists/{playlistId}/retention',
  tags: ['Replays'],
  summary: 'Flag or unflag a playlist for extended retention',
  description:
    'extend=true stamps an absolute retained_until (enable-time + the tenant’s extension window) on the playlist and every member capture’s session_replays row; extend=false clears only the playlist-level flag (members keep their retained_until).',
  request: { params: playlistParams, body: { content: jsonContent(RetentionRequest) } },
  responses: {
    200: { description: 'The updated playlist.', content: jsonContent(PlaylistView) },
    400: { description: 'Body must be { extend: boolean }.', content: jsonContent(ErrorResponse) },
    404: { description: 'Project or playlist not found.', content: jsonContent(ErrorResponse) },
  },
});
