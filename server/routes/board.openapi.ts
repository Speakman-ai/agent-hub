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
import { CARD_SOURCE_TYPES } from '../source-provenance.js';

/** Capture-provenance source enum for cards (spec CAPTURE-PROVENANCE). */
const CardSourceType = z.enum([...CARD_SOURCE_TYPES]);

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
const EpicStateSchema = z.enum(['not_started', 'in_progress', 'done']);
const LinkedSupportTicketComponent = registerComponent(
  'KanbanCardLinkedSupportTicket',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      type: z.enum(['bug', 'question', 'feature_request', 'incident', 'other']),
      severity: z.enum(['critical', 'high', 'medium', 'low']),
      status: z.enum(['new', 'investigating', 'converted', 'closed', 'duplicate', 'wont_do']),
      subject: z.string(),
      reporter: z.string().nullable(),
      reporter_email: z.string().nullable().openapi({
        description: 'Reporter email for privileged callers; masked for non-privileged callers.',
      }),
      reporter_email_masked: z.boolean().openapi({
        description: 'True when reporter_email is present but masked for this response.',
      }),
      converted_card_id: z.string().nullable(),
      release_state: z
        .enum(['fixed_pending_release', 'released_to_prod', 'customer_notified'])
        .nullable(),
      fixed_at: z.string().nullable(),
      released_to_prod_at: z.string().nullable(),
      release_deployment_id: z.string().nullable(),
      customer_notified_at: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({
      description:
        'Safe support-ticket metadata attached to a converted kanban card. The full ticket body and raw reporter contact stay on the support-ticket record.',
    }),
);

export const KanbanBoardComponent = registerComponent(
  'KanbanBoard',
  z
    .object({
      id: z.string(),
      project_id: z.string(),
      name: z.string(),
      card_seq: z.number().int().openapi({
        description:
          'Monotonic per-board counter backing card short ids. Only ever incremented, so a deleted card never frees its number.',
      }),
      card_prefix: z.string().openapi({
        description:
          'Persisted alphabetic prefix for human card ids, e.g. "AH". Frozen at board creation from the immutable project slug, so renaming a project never rewrites existing card ids. The full label is `${card_prefix}-${card.short_id}` ("AH-123"). Always present and non-null on the GET /board board payload (the server backfills/derives it).',
      }),
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

export const KanbanAssignableUserComponent = registerComponent(
  'KanbanAssignableUser',
  z
    .object({
      id: z.string(),
      username: z.string(),
    })
    .openapi({ description: 'A user that can be assigned as a kanban lead user.' }),
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
      assigned_user_id: z.string().nullable().optional(),
      labels: z.string().nullable(),
      session_id: z.string().nullable(),
      github_issue_url: z.string().nullable(),
      support_ticket_id: z.string().nullable().optional().openapi({
        description:
          'Durable id of the support ticket this card was converted from, when present. Used by release workflows instead of scraping card text.',
      }),
      customer_report_id: z.string().nullable().optional().openapi({
        description:
          'Durable id of the source customer report. For support-ticket intake this matches support_ticket_id.',
      }),
      linked_support_ticket: LinkedSupportTicketComponent.nullable().optional().openapi({
        description:
          'Safe linked support-ticket metadata for converted cards. reporter_email is role-gated/masked.',
      }),
      source_type: CardSourceType.nullable().optional().openapi({
        description:
          'Capture provenance (spec CAPTURE-PROVENANCE): the origin this card was captured from. `todo` means it was promoted from a personal todo; `email`/`calendar` a direct dashboard capture; `manual`/null a card with no tracked origin.',
      }),
      source_id: z.string().nullable().optional().openapi({
        description:
          'Opaque id of the capture origin (Gmail message id, Calendar event id, or todo id). NULL when untracked.',
      }),
      source_meta: z.record(z.string(), z.unknown()).nullable().optional().openapi({
        description:
          'Parsed JSON deep-link blob preserving a pointer back to the capture origin so the dashboard can reopen it.',
      }),
      pr_url: z.string().nullable(),
      review_status: ReviewStatusSchema,
      created_by: z.string().nullable(),
      short_id: z.number().int().nullable().openapi({
        description:
          'Human-readable per-board sequence number (the "123" in "AH-123"). Assigned on insert; null only on legacy rows before backfill. Pair with the board `card_prefix` to build the display label.',
      }),
      position: z.number().int(),
      epic_id: z.string().nullable(),
      phase_id: z.string().nullable().optional(),
      card_kind: z.enum(['task', 'spike']).optional().openapi({
        description:
          '`task` (default) or `spike` — spike cards resolve epic spec decisions via scoping sessions.',
      }),
      documented: z.number().int(),
      dispatched_by_autonomous: z.number().int(),
      orphaned_at: z.string().nullable().optional().openapi({
        description:
          'Legacy marker written by older Hub versions when a card lost its working session. Restoring the session clears it.',
      }),
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
      state: EpicStateSchema.nullable().openapi({
        description:
          'Derived lifecycle from linked cards. `null` means the epic has no linked cards. `not_started` means linked cards exist but none have left To Do/backlog yet, `in_progress` means at least one linked card has started or completed but not every linked card is Done, and `done` means every linked card is in a Done-ish column.',
      }),
      labels: z.string().nullable().optional(),
      assigned_user_id: z.string().nullable().optional(),
      color: z.string(),
      autonomous: z.number().int(),
      autonomous_interval: z.number().int(),
      autonomous_max_concurrent: z.number().int(),
      autonomous_model: z.string().nullable(),
      orchestration_budgets_json: z.string().nullable().optional(),
      pr_base_branch: z.string().nullable().optional(),
      scheduled_start_cron: z.string().nullable().optional().openapi({
        description:
          "node-cron expression for the optional scheduled epic start (interpreted in scheduled_start_timezone). When it fires, the epic's phases start left-to-right honoring each phase's auto-dispatch arming.",
      }),
      scheduled_start_timezone: z.string().nullable().optional().openapi({
        description:
          'IANA timezone the scheduled-start cron is interpreted in. Null = server default.',
      }),
      scheduled_start_enabled: z.number().int().optional().openapi({
        description:
          'Operator on/off switch for the scheduled start (1 = enabled). A disabled schedule is retained.',
      }),
      scheduled_start_enabled_by: z.string().nullable().optional().openapi({
        description: 'User id the scheduled sweep spawns under (credential owner).',
      }),
      position: z.number().int(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({
      description:
        'A kanban feature. The wire shape keeps the existing epic field names for compatibility.',
    }),
);

export const KanbanCardTemplateComponent = registerComponent(
  'KanbanCardTemplate',
  z
    .object({
      id: z.string(),
      name: z.string(),
      title: z.string(),
      description: z.string(),
      priority: PrioritySchema,
      labels: z.string(),
      epicId: z.string(),
      updatedAt: z.string(),
    })
    .openapi({
      description:
        'Reusable defaults for new kanban cards (title, description, priority, labels, epic).',
    }),
);

export const KanbanPhaseComponent = registerComponent(
  'KanbanPhase',
  z
    .object({
      id: z.string(),
      epic_id: z.string(),
      board_id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      position: z.number().int(),
      autonomous: z.number().int(),
      autonomous_interval: z.number().int(),
      autonomous_max_concurrent: z.number().int(),
      autonomous_model: z.string().nullable(),
      autonomous_enabled_by: z.string().nullable().optional(),
      autonomous_send_it: z.number().int().optional(),
      autonomous_running: z.number().int().optional(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({ description: 'A phase within an epic — groups related tickets for a feature run.' }),
);

export const KanbanEpicSpecItemComponent = registerComponent(
  'KanbanEpicSpecItem',
  z
    .object({
      id: z.string(),
      epic_id: z.string(),
      board_id: z.string(),
      phase_id: z.string().nullable(),
      tag: z.string(),
      title: z.string(),
      decision: z.string().nullable(),
      status: z.enum(['open', 'chosen', 'deferred']),
      position: z.number().int(),
      spike_card_id: z.string().nullable(),
      resolved_session_id: z.string().nullable(),
      created_at: z.string(),
      updated_at: z.string(),
    })
    .openapi({
      description:
        'An architecture decision for an epic. Open items have a linked spike ticket; spike sessions lock the decision.',
    }),
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

export const CardReplayComponent = registerComponent(
  'CardReplay',
  z
    .object({
      replayId: z.string(),
      durationMs: z.number(),
      eventCount: z.number(),
      createdAt: z.string(),
    })
    .openapi({
      description:
        'Pointer to the session replay attributed to a kanban card. The events are fetched from the per-replay playback endpoints under /api/replays/:id.',
    }),
);

export const BoardResponseComponent = registerComponent(
  'BoardResponse',
  z
    .object({
      board: KanbanBoardComponent,
      columns: z.array(KanbanColumnComponent),
      cards: z.array(KanbanCardEnrichedComponent),
      epics: z.array(KanbanEpicComponent),
      phases: z.array(KanbanPhaseComponent).optional().openapi({
        description: 'All phases on the board, ordered by position within their epic.',
      }),
      specItems: z.array(KanbanEpicSpecItemComponent).optional().openapi({
        description: 'Architecture spec decisions for epics — resolved via spike tickets/sessions.',
      }),
      counts: z.record(z.string(), z.number().int()).openapi({
        description:
          'Total card count per column, keyed by column id (`{ [columnId]: total }`). Always present. Lets a client decide whether a column has more cards than the page in `cards` and fetch the rest via GET /board/columns/:columnId/cards.',
      }),
      cursors: z.record(z.string(), z.string().nullable()).optional().openapi({
        description:
          'Per-column next-page cursor, keyed by column id (`{ [columnId]: nextCursor|null }`). Present on the bounded default and `?limit=N` responses; absent on the `?limit=all` full-board response. A non-null value is the opaque keyset cursor to pass as `cursor` to GET /board/columns/:columnId/cards for the next page; null means the first page is the last page. Lets a client seed per-column infinite scroll from this one request without reconstructing the opaque cursor.',
      }),
      cardTemplates: z.array(KanbanCardTemplateComponent).optional().openapi({
        description: 'Reusable card templates for this board.',
      }),
      availableLabels: z.array(z.string()).optional().openapi({
        description:
          'Distinct card labels across the full board, even when `cards` is paginated. Used to render complete label filter facets without draining every card page first.',
      }),
      assignableUsers: z.array(KanbanAssignableUserComponent).optional().openapi({
        description: 'Users in the request org who can be assigned as kanban lead users.',
      }),
    })
    .openapi({
      description:
        'Board state: board metadata + columns + cards (with blocker graph) + epics + per-column counts. Bounded by default — `cards` carries only the first page per column (ordered by position, id) plus a `cursors` map, so the default response does not serialize the whole board. `?limit=N` sets the page size; `?limit=all` returns every card unpaged (no `cursors`).',
    }),
);

export const PaginatedColumnCardsComponent = registerComponent(
  'PaginatedColumnCards',
  z
    .object({
      cards: z.array(KanbanCardEnrichedComponent),
      nextCursor: z.string().nullable().openapi({
        description:
          'Opaque keyset cursor for the next page, or null on the final page. Echo it back as the `cursor` query param to fetch the following page.',
      }),
      total: z.number().int().openapi({ description: 'Total card count in this column.' }),
    })
    .openapi({
      description: "One keyset-paginated page of a column's cards (with blocker graph attached).",
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

/**
 * Capture-provenance source ref accepted on card create/convert (spec
 * CAPTURE-PROVENANCE). Mirrors the todo capture shape so a card can be stamped
 * with the Gmail message / Calendar event / todo it was captured from, with a
 * deep link preserved in `sourceMeta`.
 */
export const CardSourceRefSchema = z.object({
  sourceType: CardSourceType,
  sourceId: z.string().nullable().optional(),
  sourceMeta: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const CreateCardRequestSchema = z.preprocess(
  aliasPreprocess({
    columnId: 'column_id',
    sessionId: 'session_id',
    githubIssueUrl: 'github_issue_url',
    createdBy: 'created_by',
    epicId: 'epic_id',
    phaseId: 'phase_id',
  }),
  z.object({
    title: z.string({ error: 'title is required' }).min(1, 'title is required'),
    columnId: z.string({ error: 'columnId is required' }).min(1, 'columnId is required'),
    description: z.string().nullable().optional(),
    priority: PrioritySchema.optional(),
    assignee: z.string().nullable().optional(),
    assignedUserId: z.string().nullable().optional(),
    labels: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional().openapi({
      description:
        'Session to link the card to. Defaults to the caller session (X-Agent-Hub-Session-Id header / spawn creds) when omitted. If that session already owns a card on this board, the create is deduplicated and the existing card is returned with an `X-Agent-Hub-Card-Deduplicated: session` response header. Pass `null` explicitly to opt out and force a new, unlinked card.',
    }),
    githubIssueUrl: z.string().nullable().optional(),
    createdBy: z.string().nullable().optional(),
    epicId: z.string().nullable().optional(),
    phaseId: z.string().nullable().optional(),
    source: CardSourceRefSchema.optional().openapi({
      description:
        'Optional capture provenance stamped on the new card (spec CAPTURE-PROVENANCE). Records the Gmail message / Calendar event / todo the card was captured from; `sourceMeta` preserves a deep link back to it.',
    }),
  }),
);

export const UpdateCardRequestSchema = z.preprocess(
  aliasPreprocess({
    sessionId: 'session_id',
    githubIssueUrl: 'github_issue_url',
    prUrl: 'pr_url',
    epicId: 'epic_id',
    phaseId: 'phase_id',
    assignModel: 'assign_model',
    assignEngine: 'assign_engine',
    prBaseBranch: 'pr_base_branch',
    assignedUserId: 'assigned_user_id',
  }),
  z.object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    priority: PrioritySchema.optional(),
    assignee: z.string().nullable().optional(),
    assignedUserId: z.string().nullable().optional(),
    labels: z.string().nullable().optional(),
    sessionId: z.string().nullable().optional(),
    githubIssueUrl: z.string().nullable().optional(),
    prUrl: z.string().nullable().optional(),
    epicId: z.string().nullable().optional(),
    phaseId: z.string().nullable().optional(),
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
  force: z
    .boolean()
    .optional()
    .openapi({
      description:
        'Operator escape hatch: bypass the premature-Done guard. Moves into a Done ' +
        'column are rejected with 409 while the linked session is Finalize-gated ' +
        'and has not pushed yet — Done is written on merge by the platform.',
    }),
});

export const CreateCommentRequestSchema = z.preprocess(
  // Accept `body` as an alias for `content` — a common caller stumble, since
  // most REST comment APIs name the field `body`. `content` still wins if both
  // are present.
  aliasPreprocess({ content: 'body' }),
  z.object({
    author: z
      .string({ error: 'author and content are required' })
      .min(1, 'author and content are required'),
    content: z
      .string({ error: 'author and content are required' })
      .min(1, 'author and content are required')
      .openapi({ description: 'Comment text. Alias: `body`.' }),
  }),
);

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

export const ReorderColumnsRequestSchema = z.object({
  columnIds: z
    .array(z.string().min(1, 'column id is required'))
    .min(1, 'columnIds is required')
    .openapi({
      description:
        'All column ids for the board in the desired order. The server rewrites positions atomically to 0..N-1.',
    }),
});

export const CreateEpicRequestSchema = z.preprocess(
  aliasPreprocess({ prBaseBranch: 'pr_base_branch' }),
  z.object({
    name: z.string({ error: 'name is required' }).min(1, 'name is required'),
    description: z.string().nullable().optional(),
    labels: z.string().nullable().optional(),
    assignedUserId: z.string().nullable().optional(),
    color: z.string().optional(),
    prBaseBranch: z.string().nullable().optional(),
  }),
);

export const UpdateEpicRequestSchema = z.preprocess(
  aliasPreprocess({ prBaseBranch: 'pr_base_branch' }),
  z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    labels: z.string().nullable().optional(),
    assignedUserId: z.string().nullable().optional(),
    color: z.string().optional(),
    autonomous: z.number().int().optional(),
    autonomousInterval: z.number().int().optional(),
    autonomousMaxConcurrent: z.number().int().optional(),
    autonomousModel: z.string().nullable().optional(),
    // "Auto Merge" override: when 1, autonomous-dispatched sessions for this epic
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

export const CreateCardTemplateRequestSchema = z.object({
  name: z.string({ error: 'name is required' }).min(1, 'name is required'),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  priority: PrioritySchema.optional(),
  labels: z.string().nullable().optional(),
  epicId: z.string().nullable().optional(),
});

export const UpdateCardTemplateRequestSchema = z.object({
  name: z.string().min(1).optional(),
  title: z.string().optional(),
  description: z.string().nullable().optional(),
  priority: PrioritySchema.optional(),
  labels: z.string().nullable().optional(),
  epicId: z.string().nullable().optional(),
});

export const CreatePhaseRequestSchema = z.preprocess(
  aliasPreprocess({ epicId: 'epic_id', autonomousModel: 'autonomous_model' }),
  z.object({
    epicId: z.string({ error: 'epicId is required' }).min(1, 'epicId is required'),
    name: z.string({ error: 'name is required' }).min(1, 'name is required'),
    description: z.string().nullable().optional(),
    agentId: z.string().min(1).optional().openapi({
      description:
        'Optional agent whose effective default model seeds autonomousModel when autonomousModel is omitted.',
    }),
    autonomousModel: z.string().nullable().optional().openapi({
      description:
        'Optional phase autonomous model. Omit to seed from the selected agent and session owner when agentId is supplied; otherwise the phase model remains unset. Pass null to leave the phase model unset.',
    }),
  }),
);

export const UpdatePhaseRequestSchema = z.preprocess(
  aliasPreprocess({
    autonomousInterval: 'autonomous_interval',
    autonomousMaxConcurrent: 'autonomous_max_concurrent',
    autonomousModel: 'autonomous_model',
    autonomousSendIt: 'autonomous_send_it',
  }),
  z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    autonomous: z.number().int().optional(),
    autonomousInterval: z.number().int().optional(),
    autonomousMaxConcurrent: z.number().int().optional(),
    autonomousModel: z.string().nullable().optional(),
    autonomousSendIt: z
      .union([z.literal(0), z.literal(1)])
      .optional()
      .openapi({
        type: 'integer',
        enum: [0, 1],
      }),
  }),
);

export const ReorderPhasesRequestSchema = z.preprocess(
  aliasPreprocess({
    epicId: 'epic_id',
    phaseIds: 'phase_ids',
    sortByDependencies: 'sort_by_dependencies',
  }),
  z.object({
    epicId: z.string({ error: 'epicId is required' }).min(1, 'epicId is required'),
    phaseIds: z
      .array(z.string().min(1, 'phase id is required'))
      .min(1, 'phaseIds must not be empty')
      .optional()
      .openapi({
        description:
          'All phase ids for the epic in the desired order. The server rewrites positions atomically to 0..N-1. Provide this OR sortByDependencies, not both.',
      }),
    sortByDependencies: z.boolean().optional().openapi({
      description:
        "When true, the server derives the order from the epic's card blocker graph (prerequisites first) and rewrites positions. Returns 409 `cycle` if the phase dependency graph has a loop. Provide this OR phaseIds, not both.",
    }),
  }),
);

export const SetEpicStartScheduleRequestSchema = z.preprocess(
  aliasPreprocess({ timezone: 'timezone' }),
  z.object({
    cron: z
      .string({ error: 'cron is required' })
      .min(1, 'cron is required')
      .max(200, 'cron must be 200 characters or fewer')
      .openapi({
        description:
          "node-cron expression for when the epic's phases start (interpreted in `timezone`). Validated server-side.",
        example: '0 9 * * 1',
      }),
    timezone: z.string().nullable().optional().openapi({
      description:
        'IANA timezone the cron is interpreted in (e.g. "America/New_York"). Null / omitted = server scheduler default (local server time).',
      example: 'America/New_York',
    }),
    enabled: z.boolean().optional().openapi({
      description:
        'Operator on/off switch. Defaults to true. A disabled schedule is retained (a pause, not a delete) and never fires.',
    }),
  }),
);

export const CreateSpecItemRequestSchema = z.preprocess(
  aliasPreprocess({ epicId: 'epic_id', phaseId: 'phase_id', createSpikeCard: 'create_spike_card' }),
  z.object({
    epicId: z.string({ error: 'epicId is required' }).min(1, 'epicId is required'),
    tag: z.string({ error: 'tag is required' }).min(1, 'tag is required'),
    title: z.string({ error: 'title is required' }).min(1, 'title is required'),
    decision: z.string().nullable().optional(),
    phaseId: z.string().nullable().optional(),
    // Allow creating an already-decided item directly (the spike/scoping
    // instructions tell agents to write a decision + `status: "chosen"` in one
    // call). `chosen` requires a non-empty `decision`; the handler 400s
    // otherwise. Defaults to `open`.
    status: z.enum(['open', 'chosen', 'deferred']).optional().openapi({
      description: 'Initial status. `chosen` requires a non-empty `decision`; defaults to `open`.',
    }),
    createSpikeCard: z.boolean().optional().openapi({
      description:
        'When true, also create a legacy spike kanban ticket linked to this spec item. Default false — use Decide for me or write the decision directly.',
    }),
  }),
);

export const UpdateSpecItemRequestSchema = z.preprocess(
  aliasPreprocess({ phaseId: 'phase_id', resolvedSessionId: 'resolved_session_id' }),
  z.object({
    tag: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    decision: z.string().nullable().optional(),
    status: z.enum(['open', 'chosen', 'deferred']).optional(),
    phaseId: z.string().nullable().optional(),
    position: z.number().int().optional(),
    resolvedSessionId: z.string().nullable().optional(),
  }),
);

/**
 * Upper bound for free-text assignment notes / card comments captured at
 * assign / support-ticket-convert time. These strings are persisted as card
 * comments AND injected into the spawned agent's task-context prompt, so an
 * unbounded value would create oversized DB rows and very large prompts. 4000
 * chars comfortably fits a paragraph of instructions while capping the blast
 * radius. Shared by the convert schema (support-tickets.openapi.ts).
 */
export const MAX_ASSIGNMENT_COMMENT_LEN = 4000;

export const AssignCardRequestSchema = z.object({
  agentId: z.string({ error: 'agentId is required' }).min(1, 'agentId is required'),
  model: z.string().nullable().optional(),
  engine: z.string().nullable().optional().openapi({
    description:
      'Optional engine override. One of "claude-code", "cursor-agent", "gemini-cli", or "codex-cli". When set, the spawned session uses this engine instead of the assignee agent\'s shared engine. Validated against the server\'s engineValidModels — unknown engines yield 400.',
  }),
  autoMerge: z.boolean().nullable().optional().openapi({
    description:
      'Per-card auto-merge override. true → the spawned session runs at "Auto Merge" (build/review/test/push + GitHub auto-merge); false → "Build and Push" (no auto-merge). Persisted on the card. When omitted, falls back to the card\'s stored preference (e.g. carried over from a converted support ticket), then the project\'s githubWorkflow.autoMerge default.',
  }),
  comment: z
    .string()
    .max(
      MAX_ASSIGNMENT_COMMENT_LEN,
      `comment must be ${MAX_ASSIGNMENT_COMMENT_LEN} characters or fewer`,
    )
    .nullable()
    .optional()
    .openapi({
      description: `Optional assignment note (max ${MAX_ASSIGNMENT_COMMENT_LEN} characters). Recorded as a comment on the card and prepended to the agent's task context so the assignee sees the instructions.`,
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
const projectCardTemplateIdParams = projectIdParams.extend({
  templateId: z.string().openapi({ description: 'Kanban card template UUID.' }),
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
const projectPhaseIdParams = projectIdParams.extend({
  phaseId: z.string().openapi({ description: 'Kanban phase UUID.' }),
});
const projectSpecItemIdParams = projectIdParams.extend({
  specItemId: z.string().openapi({ description: 'Epic spec item UUID.' }),
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
    'Returns the project board, columns, cards (with blocker graph attached), epics, and a `counts` map of total cards per column. Idempotently creates the board and the default columns on first call. Bounded by default: `cards` carries only the first page per column (keyset-ordered by position, id), with a `cursors` map to resume paging — so the default response never serializes the whole board. Pass `?limit=N` to set the page size, or `?limit=all` to opt into the full unpaged board.',
  request: {
    params: projectIdParams,
    query: z.object({
      limit: z.string().optional().openapi({
        description:
          'Per-column page size. Omitted → the default page size (50). A number N (1–200; out-of-range clamped) → first N cards per column, with a `cursors` map. The literal `all` → the full unpaged board (no `cursors`); its heavy card read is served off the event loop via the async reader pool.',
      }),
    }),
  },
  responses: {
    200: { description: 'Board state.', content: jsonContent(BoardResponseComponent) },
    404: errorResponse('Project not found.'),
  },
});

// GET /board/columns/:columnId/cards
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/columns/{columnId}/cards',
  tags: ['Board'],
  summary: "List one keyset-paginated page of a column's cards",
  description:
    "Returns a page of the column's cards ordered by (position, id), enriched with the blocker graph and latest finalize run, plus an opaque `nextCursor` (null on the last page) and the column `total`. Keyset pagination resumes strictly after the supplied `cursor`, so it is stable under mid-scroll reordering.",
  request: {
    params: projectColumnIdParams,
    query: z.object({
      limit: z.string().optional().openapi({
        description: 'Page size (default 50, clamped to 1–200).',
      }),
      cursor: z.string().optional().openapi({
        description: "Opaque cursor from a prior response's `nextCursor`. Omit for the first page.",
      }),
    }),
  },
  responses: {
    200: {
      description: 'One page of cards.',
      content: jsonContent(PaginatedColumnCardsComponent),
    },
    400: errorResponse('Invalid cursor.'),
    404: errorResponse('Project or column not found.'),
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

// GET /board/cards/:cardId/replay
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/cards/{cardId}/replay',
  tags: ['Board'],
  summary: 'Get the session replay attributed to a card',
  description:
    'Returns a pointer to the rrweb session replay linked to the card (via session_replays.card_id, e.g. carried over when a bug support ticket was converted). The client uses `replayId` to drive the sandboxed rrweb-player playback surface against /api/replays/:id. 404 when the card has no replay.',
  request: { params: projectCardIdParams },
  responses: {
    200: { description: 'Replay pointer.', content: jsonContent(CardReplayComponent) },
    404: errorResponse('Project, card, or replay not found.'),
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
    409: errorResponse(
      'Premature Done move rejected: the linked session is Finalize-gated and has ' +
        'not pushed yet. Done is written on merge; pass `force: true` to override.',
    ),
    422: errorResponse(
      'Done-state contract violation: a [Spec]/[Partial]-titled card cannot move to ' +
        'Done without a comment listing the follow-up card IDs covering the unmet ' +
        'acceptance criteria. Pass `force: true` to override.',
    ),
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
  summary: 'List features on a project board',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Array of features.',
      content: jsonContent(z.array(KanbanEpicComponent)),
    },
  },
});

// GET /board/epics/:epicId/pulls
const EpicPullSummary = z
  .object({
    number: z.number(),
    title: z.string(),
    state: z.string().openapi({ description: "'open' or 'closed'." }),
    merged: z.boolean(),
    draft: z.boolean(),
    html_url: z.string().nullable(),
    head: z.string().nullable(),
    base: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    merged_at: z.string().nullable(),
    closed_at: z.string().nullable(),
    relation: z.enum(['targets', 'integration']).openapi({
      description:
        '`targets` = PR merges into the epic feature branch; `integration` = PR ships the feature branch (its head) onward.',
    }),
  })
  .openapi('EpicPullSummary');

const EpicPullsResponse = z
  .object({
    epicId: z.string(),
    featureBranch: z.string().nullable(),
    source: z.enum(['agenthub', 'github']),
    pulls: z.array(EpicPullSummary),
  })
  .openapi('EpicPullsResponse');

registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/epics/{epicId}/pulls',
  tags: ['Board'],
  summary: "List pull requests related to a feature's branch",
  description:
    "Native (Agent Hub-hosted) PRs whose base branch merges into, or whose head branch ships, the epic's `pr_base_branch`. GitHub-repo projects return an empty list with `source: 'github'`.",
  request: { params: projectEpicIdParams },
  responses: {
    200: {
      description: 'Related pull requests for the feature branch.',
      content: jsonContent(EpicPullsResponse),
    },
    404: errorResponse('Project or feature not found.'),
  },
});

// POST /board/epics
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/epics',
  tags: ['Board'],
  summary: 'Create a feature',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateEpicRequestSchema) },
  },
  responses: {
    200: { description: 'New feature.', content: jsonContent(KanbanEpicComponent) },
    400: errorResponse('Validation failed.'),
  },
});

// PUT /board/epics/:epicId
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/epics/{epicId}',
  tags: ['Board'],
  summary: 'Update a feature',
  description:
    'Partial update. Setting `autonomous` to 1 on this epic clears the autonomous flag on any other autonomous epic on the same board (only one epic can be autonomous at a time).',
  request: {
    params: projectEpicIdParams,
    body: { content: jsonContent(UpdateEpicRequestSchema) },
  },
  responses: {
    200: { description: 'Updated feature.', content: jsonContent(KanbanEpicComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Feature not found.'),
  },
});

// DELETE /board/epics/:epicId
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/epics/{epicId}',
  tags: ['Board'],
  summary: 'Delete a feature',
  description: 'Unlinks every card that belonged to the feature, then removes the epic row.',
  request: { params: projectEpicIdParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
  },
});

// POST /board/epics/:epicId/assign-lead-to-cards
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/epics/{epicId}/assign-lead-to-cards',
  tags: ['Board'],
  summary: 'Assign epic lead user to all epic cards',
  description:
    'Sets `assigned_user_id` on every card linked to the epic to the epic’s current lead user. Callable by the lead user, or in local bundled mode.',
  request: { params: projectEpicIdParams },
  responses: {
    200: {
      description: 'Bulk assignment result.',
      content: jsonContent(z.object({ updatedCount: z.number().int().nonnegative() })),
    },
    400: errorResponse('Epic has no lead user.'),
    403: errorResponse('Caller is not the epic lead user.'),
    404: errorResponse('Epic not found.'),
  },
});

// GET /board/card-templates
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/card-templates',
  tags: ['Board'],
  summary: 'List card templates',
  description: 'Reusable defaults for creating kanban cards on this board.',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'Templates for the board.',
      content: jsonContent(z.array(KanbanCardTemplateComponent)),
    },
  },
});

// POST /board/card-templates
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/card-templates',
  tags: ['Board'],
  summary: 'Create a card template',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateCardTemplateRequestSchema) },
  },
  responses: {
    200: { description: 'Created template.', content: jsonContent(KanbanCardTemplateComponent) },
    400: errorResponse('Validation failed.'),
  },
});

// PUT /board/card-templates/:templateId
registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/card-templates/{templateId}',
  tags: ['Board'],
  summary: 'Update a card template',
  request: {
    params: projectCardTemplateIdParams,
    body: { content: jsonContent(UpdateCardTemplateRequestSchema) },
  },
  responses: {
    200: { description: 'Updated template.', content: jsonContent(KanbanCardTemplateComponent) },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Template not found.'),
  },
});

// DELETE /board/card-templates/:templateId
registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/card-templates/{templateId}',
  tags: ['Board'],
  summary: 'Delete a card template',
  request: { params: projectCardTemplateIdParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    404: errorResponse('Template not found.'),
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

export const DecideForMeRequestSchema = z.object({
  agentId: z.string().min(1).optional().openapi({
    description: 'Agent to run the research session. Defaults to the project lead.',
  }),
});

export const ScopeEpicRequestSchema = z.object({
  agentId: z.string().min(1).optional().openapi({
    description: 'Agent to run the scoping session. Defaults to the project lead.',
  }),
});

export const ScopeFromNotesRequestSchema = z.object({
  content: z.string().min(1).openapi({
    description:
      'The note content to scope — a whole note or a single heading-scoped block of markdown.',
  }),
  title: z.string().optional().openapi({
    description: 'Human label for the session (e.g. the note title or heading text).',
  }),
  agentId: z.string().min(1).optional().openapi({
    description: 'Agent to run the scoping session. Defaults to the project lead.',
  }),
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/scope-from-notes',
  tags: ['Board'],
  summary: 'Open a scoping-mode session seeded with note content',
  request: {
    params: z.object({ projectId: z.string() }),
    body: { content: jsonContent(ScopeFromNotesRequestSchema) },
  },
  responses: {
    200: {
      description: 'Scoping session created and seeded with the note content.',
      content: jsonContent(
        z.object({
          sessionId: z.string(),
          agentId: z.string(),
        }),
      ),
    },
    400: errorResponse('No agent available or agent does not belong to this project.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('Project not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/epics/{epicId}/scope',
  tags: ['Board'],
  summary: 'Open a scoping-mode session pre-linked to an epic',
  request: {
    params: z.object({
      projectId: z.string(),
      epicId: z.string(),
    }),
    body: { content: jsonContent(ScopeEpicRequestSchema) },
  },
  responses: {
    200: {
      description: 'Scoping session created and linked to the epic.',
      content: jsonContent(
        z.object({
          sessionId: z.string(),
          agentId: z.string(),
        }),
      ),
    },
    400: errorResponse('No agent available or agent does not belong to this project.'),
    401: errorResponse('Authentication required.'),
    404: errorResponse('Epic not found.'),
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
  method: 'post',
  path: '/api/projects/{projectId}/board/columns/reorder',
  tags: ['Board'],
  summary: 'Reorder columns atomically',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(ReorderColumnsRequestSchema) },
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

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/spec-items/{specItemId}/decide-for-me',
  tags: ['Board'],
  summary: 'Research and lock a spec decision via agent session',
  request: {
    params: z.object({
      projectId: z.string(),
      specItemId: z.string(),
    }),
    body: { content: jsonContent(DecideForMeRequestSchema) },
  },
  responses: {
    200: {
      description: 'Scoping session started.',
      content: jsonContent(
        z.object({
          sessionId: z.string(),
          agentId: z.string(),
          specItem: KanbanEpicSpecItemComponent,
        }),
      ),
    },
    400: errorResponse('Spec item already locked or validation failed.'),
    404: errorResponse('Spec item not found.'),
  },
});

// ── Phases ──────────────────────────────────────────────────────────────
registerPath({
  method: 'get',
  path: '/api/projects/{projectId}/board/phases',
  tags: ['Board'],
  summary: 'List phases on the board',
  request: { params: projectIdParams },
  responses: {
    200: {
      description: 'All phases on the board, ordered by position within their epic.',
      content: jsonContent(z.array(KanbanPhaseComponent)),
    },
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/phases',
  tags: ['Board'],
  summary: 'Create a phase under an epic',
  request: { params: projectIdParams, body: { content: jsonContent(CreatePhaseRequestSchema) } },
  responses: {
    200: { description: 'The created phase.', content: jsonContent(KanbanPhaseComponent) },
    404: errorResponse('Epic not found on this board.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/phases/{phaseId}',
  tags: ['Board'],
  summary: 'Update a phase (incl. autonomous settings)',
  request: {
    params: projectPhaseIdParams,
    body: { content: jsonContent(UpdatePhaseRequestSchema) },
  },
  responses: {
    200: { description: 'The updated phase.', content: jsonContent(KanbanPhaseComponent) },
    404: errorResponse('Phase not found on this project board.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/phases/{phaseId}',
  tags: ['Board'],
  summary: 'Delete a phase (unlinks its cards)',
  request: { params: projectPhaseIdParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    404: errorResponse('Phase not found on this project board.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/phases/{phaseId}/run',
  tags: ['Board'],
  summary: 'Start autonomous dispatch for a phase',
  request: { params: projectPhaseIdParams },
  responses: {
    200: { description: 'The phase, now running.', content: jsonContent(KanbanPhaseComponent) },
    400: errorResponse('Phase could not be started.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/phases/{phaseId}/stop',
  tags: ['Board'],
  summary: 'Stop autonomous dispatch for a phase',
  request: { params: projectPhaseIdParams },
  responses: {
    200: { description: 'The phase, now stopped.', content: jsonContent(KanbanPhaseComponent) },
    400: errorResponse('Phase could not be stopped.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/phases/reorder',
  tags: ['Board'],
  summary: 'Reorder an epic’s phases (explicit order or auto topological sort)',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(ReorderPhasesRequestSchema) },
  },
  responses: {
    200: {
      description: "The epic's phases in their new order.",
      content: jsonContent(z.array(KanbanPhaseComponent)),
    },
    400: errorResponse('Validation failed.'),
    404: errorResponse('Project or epic not found.'),
    409: errorResponse('Phase dependency graph has a cycle (auto sort only).'),
  },
});

// ── Epic-level start + scheduled start ──────────────────────────────────
const StartEpicResultSchema = z
  .object({
    outcome: z
      .enum(['started', 'already_running', 'stopped_disabled', 'all_complete', 'no_phases'])
      .openapi({
        description:
          '`started`: the leftmost phase with work was armed and kicked off (the completion cascade advances rightward from there). `already_running`: that phase was already running. `stopped_disabled`: the leftmost phase with work has auto-dispatch off, so the sweep halted there without starting it. `all_complete`: every phase is Done. `no_phases`: the epic has no phases.',
      }),
    phaseId: z.string().optional(),
    phaseName: z.string().optional(),
  })
  .openapi({ description: 'Outcome of an epic-level start sweep.' });

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/epics/{epicId}/run',
  tags: ['Board'],
  summary: "Start an epic's phases left-to-right (honoring per-phase auto-dispatch)",
  request: { params: projectEpicIdParams },
  responses: {
    200: { description: 'Sweep outcome.', content: jsonContent(StartEpicResultSchema) },
    400: errorResponse('Epic could not be started (e.g. no resolvable owner).'),
    404: errorResponse('Project or epic not found on this board.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/epics/{epicId}/start-schedule',
  tags: ['Board'],
  summary: "Set or update the epic's scheduled start (cron + timezone)",
  request: {
    params: projectEpicIdParams,
    body: { content: jsonContent(SetEpicStartScheduleRequestSchema) },
  },
  responses: {
    200: {
      description: 'The epic with its updated schedule.',
      content: jsonContent(KanbanEpicComponent),
    },
    400: errorResponse('Validation failed (invalid cron / timezone, or no resolvable owner).'),
    404: errorResponse('Epic not found on this project board.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/epics/{epicId}/start-schedule',
  tags: ['Board'],
  summary: "Clear the epic's scheduled start",
  request: { params: projectEpicIdParams },
  responses: {
    200: {
      description: 'The epic with its schedule cleared.',
      content: jsonContent(KanbanEpicComponent),
    },
    404: errorResponse('Epic not found on this project board.'),
  },
});

// ── Spec items ──────────────────────────────────────────────────────────
registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/spec-items',
  tags: ['Board'],
  summary: 'Create an epic spec item (optionally already chosen)',
  request: {
    params: projectIdParams,
    body: { content: jsonContent(CreateSpecItemRequestSchema) },
  },
  responses: {
    200: {
      description: 'The created spec item.',
      content: jsonContent(KanbanEpicSpecItemComponent),
    },
    400: errorResponse('Validation failed (e.g. chosen without a decision, or a foreign phase).'),
    404: errorResponse('Epic not found on this board.'),
  },
});

registerPath({
  method: 'put',
  path: '/api/projects/{projectId}/board/spec-items/{specItemId}',
  tags: ['Board'],
  summary: 'Update an epic spec item',
  request: {
    params: projectSpecItemIdParams,
    body: { content: jsonContent(UpdateSpecItemRequestSchema) },
  },
  responses: {
    200: {
      description: 'The updated spec item.',
      content: jsonContent(KanbanEpicSpecItemComponent),
    },
    400: errorResponse('Validation failed (e.g. chosen without a decision, or a foreign phase).'),
    404: errorResponse('Spec item not found.'),
  },
});

registerPath({
  method: 'post',
  path: '/api/projects/{projectId}/board/spec-items/{specItemId}/spike',
  tags: ['Board'],
  summary: 'Create (or return) the spike card for a spec item',
  request: { params: projectSpecItemIdParams },
  responses: {
    200: {
      description: 'The spec item and its linked spike card.',
      content: jsonContent(
        z.object({ specItem: KanbanEpicSpecItemComponent, spikeCard: KanbanCardComponent }),
      ),
    },
    404: errorResponse('Spec item not found.'),
    500: errorResponse('Failed to create the spike card.'),
  },
});

registerPath({
  method: 'delete',
  path: '/api/projects/{projectId}/board/spec-items/{specItemId}',
  tags: ['Board'],
  summary: 'Delete an epic spec item',
  request: { params: projectSpecItemIdParams },
  responses: {
    200: {
      description: 'Acknowledgment.',
      content: jsonContent(z.object({ ok: z.literal(true) })),
    },
    404: errorResponse('Spec item not found.'),
  },
});
