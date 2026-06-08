/**
 * Zod schemas + OpenAPI registrations for the board / epics route group.
 *
 * This module is imported for two reasons:
 *
 *   1. `server/routes/board.ts` imports the exported request schemas and
 *      uses `safeParse(...)` to validate incoming bodies. The handler
 *      keeps all of its downstream logic (FK pre-flight, dedup, intake
 *      gating, prBaseBranch parsing, …) — only the ad-hoc
 *      `req.body as Record<string, unknown>` cast is replaced.
 *
 *   2. `server/openapi/generate.ts` walks `server/routes/*.ts` and
 *      imports every module to trigger the side-effect
 *      `registerPath` / `registerComponent` calls below. The board
 *      section of the generated `docs/api/openapi.yaml` comes out of
 *      this file.
 *
 * Design notes:
 *
 * - **Aliases.** Several routes historically accept both camelCase and
 *   snake_case body keys (`columnId` / `column_id`, `sessionId` /
 *   `session_id`, etc.). We document the canonical camelCase form in
 *   the OpenAPI spec and use a small `aliasPreprocess` helper to fold
 *   snake_case keys into their camelCase equivalents before validation.
 *   Either form on the wire produces an identical parsed object.
 *
 * - **Key presence vs explicit null.** PUT /board/cards/:id and PUT
 *   /board/epics/:id need to distinguish "key omitted" (preserve the
 *   existing value) from "key set to null" (clear the column). Zod
 *   gives us this for free: `.nullable().optional()` yields
 *   `string | null | undefined`, so the handler can check
 *   `parsed.epicId !== undefined` for presence and
 *   `parsed.epicId === null` for explicit clear.
 *
 * - **Response shapes.** Only the response shapes we want clients /
 *   docs to rely on are registered as named components
 *   (`#/components/schemas/...`). Request bodies are inlined in each
 *   `registerPath` call so the preprocess shim doesn't leak into the
 *   reusable schema namespace.
 */

import { z, registerPath, registerComponent } from '../openapi/registry.js';
import { FinalizeRunComponent } from './finalize.openapi.js';

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Merge snake_case keys into their camelCase equivalents before Zod
 * validation. Always camelCase-wins when both are present — the
 * camelCase form is canonical and what the OpenAPI doc advertises.
 */
function aliasPreprocess(aliases: Record<string, string>): (input: unknown) => unknown {
  return (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
    const obj = { ...(input as Record<string, unknown>) };
    for (const [camel, snake] of Object.entries(aliases)) {
      if (obj[camel] === undefined && obj[snake] !== undefined) {
        obj[camel] = obj[snake];
      }
    }
    return obj;
  };
}

// ─── Domain component schemas (response shapes) ──────────────────

const PrioritySchema = z.enum(['low', 'medium', 'high', 'urgent']);
const ReviewStatusSchema = z
  .enum(['awaiting_review', 'reviewing', 'approved', 'changes_requested'])
  .nullable();

export const KanbanBoardComponent = registerComponent(
  'KanbanBoard',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      name: z.string(),
      created_at: z.string(),
    })
    .openapi({ description: 'A project kanban board (one per project).' }),
);

export const KanbanColumnComponent = registerComponent(
  'KanbanColumn',
  z
    .object({
      id: z.string(),
      board_id: z.string(),
      name: z.string(),
      position: z.number().int(),
      color: z.string().nullable(),
      created_at: z.string(),
    })
    .openapi({ description: 'A column on a kanban board (To Do, In Progress, …).' }),
);

export const KanbanCardComponent = registerComponent(
  'KanbanCard',
  z
    .object({
      id: z.string(),
      column_id: z.string(),
      board_id: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      priority: PrioritySchema,
      assignee: z.string().nullable(),
      labels: z.string().nullable(),
      session_id: z.string().nullable(),
      github_issue_url: z.string().nullable(),
      pr_url: z.string().nullable(),
      review_status: ReviewStatusSchema,
      created_by: z.string().nullable(),
      position: z.number().int(),
      epic_id: z.string().nullable(),
      documented: z.number().int(),
      dispatched_by_autonomous: z.number().int(),
      assign_model: z.string().nullable().optional(),
      assign_engine: z.string().nullable().optional().openapi({
        description:
          'Optional engine override pinned at assign / update time. One of "claude-code", "cursor-agent", "gemini-cli", or "codex-cli". Overrides the assignee agent\'s shared engine at session spawn.',
      }),
      pr_base_branch: z.string().nullable().optional(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({ description: 'A kanban card (task / ticket).' }),
);

export const KanbanBlockerLinkComponent = registerComponent(
  'KanbanBlockerLink',
  z
    .object({
      id: z.string(),
      title: z.string(),
      column_id: z.string(),
      done: z.boolean(),
    })
    .openapi({
      description:
        'A blocker / blocked-by relationship view. `done` is derived from the referenced card\'s column ("Done"-ish columns resolve the link).',
    }),
);

export const KanbanCardEnrichedComponent = registerComponent(
  'KanbanCardEnriched',
  KanbanCardComponent.extend({
    blockers: z.array(KanbanBlockerLinkComponent),
    blocks: z.array(KanbanBlockerLinkComponent),
    finalize_run: FinalizeRunComponent.nullable().openapi({
      description:
        "Latest Finalize Code Changes run for this card's `session_id`, or `null` when the card has no session or the session has never triggered Finalize. Folded into the board payload so the per-card status badge in the client can render without a separate GET per card.",
    }),
  }).openapi({
    description:
      'A card with its blocker graph and latest finalize run attached (used by GET /board).',
  }),
);

export const KanbanEpicComponent = registerComponent(
  'KanbanEpic',
  z
    .object({
      id: z.string(),
      board_id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      color: z.string(),
      autonomous: z.number().int(),
      autonomous_interval: z.number().int(),
      autonomous_max_concurrent: z.number().int(),
      autonomous_model: z.string().nullable(),
      orchestration_budgets_json: z.string().nullable().optional(),
      pr_base_branch: z.string().nullable().optional(),
      position: z.number().int(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({ description: 'A kanban epic — a group of related cards.' }),
);

export const KanbanCardCommentComponent = registerComponent(
  'KanbanCardComment',
  z
    .object({
      id: z.string(),
      card_id: z.string(),
      author: z.string(),
      content: z.string(),
      created_at: z.string(),
    })
    .openapi({ description: 'A comment posted to a kanban card.' }),
);

export const BoardResponseComponent = registerComponent(
  'BoardResponse',
  z
    .object({
      board: KanbanBoardComponent,
      columns: z.array(KanbanColumnComponent),
      cards: z.array(KanbanCardEnrichedComponent),
      epics: z.array(KanbanEpicComponent),
    })
    .openapi({
      description:
        'Full board state: board metadata + columns + cards (with blocker graph) + epics.',
    }),
);

export const ErrorResponseComponent = registerComponent(
  'BoardErrorResponse',
  z
    .object({
      error: z.string(),
      details: z
        .array(
          z.object({
            path: z.array(z.union([z.string(), z.number()])),
            message: z.string(),
          }),
        )
        .optional(),
      path: z.array(z.string()).optional(),
    })
    .openapi({
      description:
        'Error envelope. `details` is populated for 400 schema-validation errors; `path` is populated for the 409 cycle error from the blocker endpoint.',
    }),
);

// ─── Request schemas ──────────────────────────────────────────────

export const CreateCardRequestSchema = z.preprocess(
  aliasPreprocess({
    columnId: 'column_id',
    sessionId: 'session_id',
    githubIssueUrl: 'github_issue_url',
    createdBy: 'created_by',
  }),
  z.object({
    title: z.string({ error: 'title is required' }).min(1, 'title is required'),
    columnId: z.string({ error: 'columnId is required' }).min(1, 'columnId is required'),
    description: z.string().nullable().optional(),
    priority: PrioritySchema.optional(),
    assignee: z.string().nullable().optional(),
    labels: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    githubIssueUrl: z.string().nullable().optional(),
    createdBy: z.string().nullable().optional(),
  }),
);

export const UpdateCardRequestSchema = z.preprocess(
  aliasPreprocess({
    sessionId: 'session_id',
    githubIssueUrl: 'github_issue_url',
    prUrl: 'pr_url',
    epicId: 'epic_id',
    assignModel: 'assign_model',
    assignEngine: 'assign_engine',
    prBaseBranch: 'pr_base_branch',
  }),
  z.object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priority: PrioritySchema.optional(),
    assignee: z.string().nullable().optional(),
    labels: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    githubIssueUrl: z.string().nullable().optional(),
    prUrl: z.string().nullable().optional(),
    epicId: z.string().nullable().optional(),
    assignModel: z.string().nullable().optional(),
    assignEngine: z.string().nullable().optional().openapi({
      description:
        'Optional engine override for the session spawn. One of "claude-code", "cursor-agent", "gemini-cli", or "codex-cli". When set, overrides the assignee agent\'s shared engine.',
    }),
    prBaseBranch: z.string().nullable().optional(),
  }),
);

export const MoveCardRequestSchema = z.object({
  columnId: z.string({ error: 'columnId is required' }).min(1, 'columnId is required'),
  position: z.number().int().optional(),
});

export const CreateCommentRequestSchema = z.object({
  author: z
    .string({ error: 'author and content are required' })
    .min(1, 'author and content are required'),
  content: z
    .string({ error: 'author and content are required' })
    .min(1, 'author and content are required'),
});

export const AddBlockerRequestSchema = z.object({
  blockedByCardId: z
    .string({ error: 'blockedByCardId is required' })
    .min(1, 'blockedByCardId is required'),
});

export const CreateColumnRequestSchema = z.object({
  name: z.string({ error: 'name is required' }).min(1, 'name is required'),
  color: z.string().nullable().optional(),
});

export const UpdateColumnRequestSchema = z.object({
  name: z.string().optional(),
  position: z.number().int().optional(),
  color: z.string().nullable().optional(),
});

export const CreateEpicRequestSchema = z.preprocess(
  aliasPreprocess({ prBaseBranch: 'pr_base_branch' }),
  z.object({
    name: z.string({ error: 'name is required' }).min(1, 'name is required'),
    description: z.string().nullable().optional(),
    color: z.string().optional(),
    prBaseBranch: z.string().nullable().optional(),
  }),
);

export const UpdateEpicRequestSchema = z.preprocess(
  aliasPreprocess({ prBaseBranch: 'pr_base_branch' }),
  z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    color: z.string().optional(),
    autonomous: z.number().int().optional(),
    autonomousInterval: z.number().int().optional(),
    autonomousMaxConcurrent: z.number().int().optional(),
    autonomousModel: z.string().nullable().optional(),
    // "Send It" override: when 1, autonomous-dispatched sessions for this epic
    // start at finalize_automation `merge` regardless of project auto-merge.
    // Constrained to 0 | 1 at the boundary — this flag forces auto-merge, so we
    // reject arbitrary integers rather than truthiness-coercing them later.
    autonomousSendIt: z
      .union([z.literal(0), z.literal(1)])
      .optional()
      .openapi({ type: 'integer', enum: [0, 1] }),
    // Free-form object that's later run through `sanitizeOrchestrationBudgetsPartial`
    // — Zod just gates the top-level shape (object/null/missing) so the
    // OpenAPI doc stays valid (`additionalProperties: { nullable: true }`
    // without a type triggers redocly's `nullable-type-sibling` rule).
    orchestrationBudgets: z.any().nullable().optional().openapi({
      type: 'object',
      description:
        'Optional partial overrides merged onto the project orchestrationBudgets at run time.',
    }),
    prBaseBranch: z.string().nullable().optional(),
  }),
);

export const LinkEpicRequestSchema = z.object({
  epicId: z.string().nullable().optional(),
});

export const AssignCardRequestSchema = z.object({
  agentId: z.string({ error: 'agentId is required' }).min(1, 'agentId is required'),
  model: z.string().nullable().optional(),
  engine: z.string().nullable().optional().openapi({
    description:
      'Optional engine override. One of "claude-code", "cursor-agent", "gemini-cli", or "codex-cli". When set, the spawned session uses this engine instead of the assignee agent\'s shared engine. Validated against the server\'s engineValidModels — unknown engines yield 400.',
  }),
});

// ─── OpenAPI path registrations ───────────────────────────────────
//
// Every route in board.ts that's listed in the migration card scope is
// declared here. Path params use OpenAPI `{name}` syntax; Express uses
// `:name` syntax — we translate at the registry boundary.

const projectIdParams = z.object({
  projectId: z.string().openapi({ description: 'Project ID (slug).' }),
});
const projectCardIdParams = projectIdParams.extend({
  cardId: z.string().openapi({ description: 'Kanban card UUID.' }),
});
const projectEpicIdParams = projectIdParams.extend({
  epicId: z.string().openapi({ description: 'Kanban epic UUID.' }),
});
const projectColumnIdParams = projectIdParams.extend({
  columnId: z.string().openapi({ description: 'Kanban column UUID.' }),
});
const blockerDeleteParams = projectCardIdParams.extend({
  blockedByCardId: z.string().openapi({ description: 'The blocker card UUID to remove.' }),
});
const commentDeleteParams = projectCardIdParams.extend({
  commentId: z.string().openapi({ description: 'Comment UUID.' }),
});

const jsonContent = <T extends z.ZodTypeAny>(schema: T) => ({
  'application/json': { schema },
});

const errorResponse = (description: string) => ({
  description,
  content: jsonContent(ErrorResponseComponent),
});

// GET /board
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board',
  tags: ['Board'],
  summary: 'Get full board state',
  description:
    'Returns the project board, all columns, all cards (with blocker graph attached), and all epics. Idempotently creates the board and the four default columns on first call.',
  request: { params: projectIdParams },
  responses: {
    200: { description: 'Board state.', content: jsonContent(BoardResponseComponent) },
    404: errorResponse('Project not found.'),
  },
});

// GET /board/cards
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/cards',
  tags: ['Board'],
  summary: 'List cards on a project board',
  request: { params: projectIdParams },
  responses: {
    200: { description: 'Array of cards.', content: jsonContent(z.array(KanbanCardComponent)) },
    404: errorResponse('Project not found.'),
  },
});

// POST /board/cards
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/cards',
  tags: ['Board'],
  summary: 'Create a kanban card',
  description:
    'Creates a card in the given column. When `sessionId` is omitted from the body, the server auto-links from `X-Agent-Hub-Session-Id` or a per-session spawn-creds API key (`spawn:<sessionId>`). Pass `sessionId: null` to opt out. Returns the existing card unchanged if (a) a card with the same case-insensitive title already exists on this board, or (b) `sessionId` is already linked to a card on this board.',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateCardRequestSchema) },
  },
  responses: {
    200: { description: 'Card.', content: jsonContent(KanbanCardComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Project or column not found.'),
  },
});

// PUT /board/cards/:cardId
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/cards/{cardId}',
  tags: ['Board'],
  summary: 'Update a kanban card',
  description:
    'Partial update. Fields omitted from the body keep their current value. Nullable fields can be cleared by sending `null` explicitly.',
  request: {
    params: projectCardIdParams,
    body: { content: jsonContent(UpdateCardRequestSchema) },
  },
  responses: {
    200: { description: 'Updated card.', content: jsonContent(KanbanCardComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Card, project, or referenced epic not found.'),
  },
});

// POST /board/cards/:cardId/move
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/cards/{cardId}/move',
  tags: ['Board'],
  summary: 'Move a card to another column / position',
  description:
    'Soft-enforced: blocker state does NOT gate the move. Clients should consult `blockers` on the GET /board response and warn before issuing the move.',
  request: {
    params: projectCardIdParams,
    body: { content: jsonContent(MoveCardRequestSchema) },
  },
  responses: {
    200: { description: 'Updated card.', content: jsonContent(KanbanCardComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse("Card not found, or target column not on this card's board."),
  },
});

// POST /board/cards/:cardId/assign
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/cards/{cardId}/assign',
  tags: ['Board'],
  summary: 'Assign a card to an agent and spawn a session',
  description:
    'Picks the agent, mints a new session linked to the card, optionally overrides the model (must be valid for the agent\'s engine), moves the card to "In Progress", and dispatches the agent with a task-context prompt.',
  request: {
    params: projectCardIdParams,
    body: { content: jsonContent(AssignCardRequestSchema) },
  },
  responses: {
    200: {
      description: 'Session id + updated card.',
      content: jsonContent(z.object({ sessionId: z.string(), card: KanbanCardComponent })),
    },
    400: errorResponse('Validation failed or model invalid for engine.'),
    404: errorResponse('Card, agent, or project not found.'),
  },
});

// GET /board/cards/:cardId/comments
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/cards/{cardId}/comments',
  tags: ['Board'],
  summary: 'List comments on a card',
  request: { params: projectCardIdParams },
  responses: {
    200: {
      description: 'Array of comments (oldest first).',
      content: jsonContent(z.array(KanbanCardCommentComponent)),
    },
  },
});

// POST /board/cards/:cardId/comments
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/cards/{cardId}/comments',
  tags: ['Board'],
  summary: 'Post a comment to a card',
  request: {
    params: projectCardIdParams,
    body: { content: jsonContent(CreateCommentRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated comment list.',
      content: jsonContent(z.array(KanbanCardCommentComponent)),
    },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Card not found.'),
  },
});

// DELETE /board/cards/:cardId/comments/:commentId
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/cards/{cardId}/comments/{commentId}',
  tags: ['Board'],
  summary: 'Delete a card comment',
  request: { params: commentDeleteParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
  },
});

// POST /board/cards/:cardId/blockers
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/cards/{cardId}/blockers',
  tags: ['Board'],
  summary: 'Declare that this card is blocked by another card',
  description:
    'Both cards must live on the same project board. Adding the edge is rejected when it would close a cycle (`409 cycle`, with `path` naming the cycle) or when the edge already exists (`409 duplicate`).',
  request: {
    params: projectCardIdParams,
    body: { content: jsonContent(AddBlockerRequestSchema) },
  },
  responses: {
    201: {
      description: 'New blocker link.',
      content: jsonContent(
        z.object({
          id: z.string(),
          card_id: z.string(),
          blocked_by_card_id: z.string(),
        }),
      ),
    },
    400: errorResponse('Validation failed or self-block attempted.'),
    404: errorResponse('Card not found (either side).'),
    409: errorResponse('Duplicate edge or cycle.'),
  },
});

// DELETE /board/cards/:cardId/blockers/:blockedByCardId
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/cards/{cardId}/blockers/{blockedByCardId}',
  tags: ['Board'],
  summary: 'Remove a blocker edge',
  request: { params: blockerDeleteParams },
  responses: {
    204: { description: 'Edge removed.' },
    404: errorResponse('Blocker link not found.'),
  },
});

// GET /board/epics
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/epics',
  tags: ['Board'],
  summary: 'List epics on a project board',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Array of epics.',
      content: jsonContent(z.array(KanbanEpicComponent)),
    },
  },
});

// POST /board/epics
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/epics',
  tags: ['Board'],
  summary: 'Create an epic',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateEpicRequestSchema) },
  },
  responses: {
    200: { description: 'New epic.', content: jsonContent(KanbanEpicComponent) },
    400: errorResponse('Validation failed.'),
  },
});

// PUT /board/epics/:epicId
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/epics/{epicId}',
  tags: ['Board'],
  summary: 'Update an epic',
  description:
    'Partial update. Setting `autonomous` to 1 on this epic clears the autonomous flag on any other autonomous epic on the same board (only one epic can be autonomous at a time).',
  request: {
    params: projectEpicIdParams,
    body: { content: jsonContent(UpdateEpicRequestSchema) },
  },
  responses: {
    200: { description: 'Updated epic.', content: jsonContent(KanbanEpicComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Epic not found.'),
  },
});

// DELETE /board/epics/:epicId
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/epics/{epicId}',
  tags: ['Board'],
  summary: 'Delete an epic',
  description: 'Unlinks every card that belonged to the epic, then removes the epic row.',
  request: { params: projectEpicIdParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
  },
});

// POST /board/cards/:cardId/epic (link / unlink)
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/cards/{cardId}/epic',
  tags: ['Board'],
  summary: 'Link or unlink a card to an epic',
  description:
    'Pass `{ epicId: "<id>" }` to link. Pass an empty body or `{ epicId: null }` to unlink.',
  request: {
    params: projectCardIdParams,
    body: { content: jsonContent(LinkEpicRequestSchema) },
  },
  responses: {
    200: { description: 'Updated card.', content: jsonContent(KanbanCardComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Card or epic not found.'),
  },
});

// Column CRUD (covered for completeness — the card scope hits the board
// section in the spec, and columns are part of that section).
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/columns',
  tags: ['Board'],
  summary: 'Create a column',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateColumnRequestSchema) },
  },
  responses: {
    200: {
      description: 'Updated columns list.',
      content: jsonContent(z.array(KanbanColumnComponent)),
    },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/columns/{columnId}',
  tags: ['Board'],
  summary: 'Update a column',
  request: {
    params: projectColumnIdParams,
    body: { content: jsonContent(UpdateColumnRequestSchema) },
  },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/columns/{columnId}',
  tags: ['Board'],
  summary: 'Delete a column',
  request: { params: projectColumnIdParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
  },
});
