/**
 * Built-in Hub workflow drafts (V1.1 template library).
 * Step prompts may use <<<n>>> where n is the 0-based index of a prior step; those
 * tokens become {{steps.<uuid>.output}} when a template is instantiated.
 */

/** @typedef {{ id: string, label: string, description: string, draft: { name: string, defaultPayload: object, steps: { title: string, role_prompt: string, on_failure?: string, timeout_ms?: number|null }[] } }} WorkflowTemplateSeed */

/** @type {WorkflowTemplateSeed[]} */
export const WORKFLOW_TEMPLATE_CATALOG = [
  {
    id: 'dev-review',
    label: 'Dev Review',
    description:
      'Technical review, security/reliability pass, and a concise ship checklist for PR-style work.',
    draft: {
      name: 'Dev Review',
      defaultPayload: {
        prTitle: '',
        prUrl: '',
        branch: '',
        scopeSummary: 'Short note on what changed and risk areas reviewers should focus on.',
      },
      steps: [
        {
          title: 'Technical & design review',
          role_prompt: `You are the first step in a Dev Review Hub workflow.

Use the merged trigger payload (default + per-run JSON). Key fields may include prTitle, prUrl, branch, scopeSummary — reference {{trigger.payload}} and dot paths like {{trigger.payload.prUrl}} when present.

Tasks:
- Summarize what changed and the intent of the PR or change set.
- Call out architecture, API contracts, data model, and test coverage gaps.
- Note any unclear behavior, missing edge cases, or debt introduced.

End with a short "Review summary" bullet list suitable for the next reviewer.`,
          on_failure: 'abort',
        },
        {
          title: 'Security & reliability pass',
          role_prompt: `You are the second step. Build on the prior technical review:

<<<0>>>

Focus on security, privacy, and operational reliability:
- AuthZ/authN boundaries, secrets, injection surfaces, dependency risk
- Error handling, retries, idempotency, observability hooks
- Performance hot paths if evident from the prior summary

Output a "Risk table": rows with Severity (Low/Med/High), Area, Finding, and Suggested mitigation.`,
          on_failure: 'abort',
        },
        {
          title: 'Ship checklist & recommendation',
          role_prompt: `You are the final reviewer. You have:

Technical review:
<<<0>>>

Security / reliability pass:
<<<1>>>

Produce:
1. A merge recommendation: **Approve**, **Approve with nits**, **Request changes**, or **Block** (one line, bold the label).
2. A numbered ship checklist (max 8 items) the author should tick before merge.
3. If blocking or requesting changes, the single most important follow-up first.

Keep the tone constructive and specific.`,
          on_failure: 'abort',
        },
      ],
    },
  },
  {
    id: 'content',
    label: 'Content',
    description:
      'Outline, draft, and tighten a piece of content from a brief in the trigger payload.',
    draft: {
      name: 'Content pipeline',
      defaultPayload: {
        topic: '',
        audience: '',
        tone: 'Professional, concise',
        length: '800–1200 words',
        mustInclude: [],
      },
      steps: [
        {
          title: 'Brief & outline',
          role_prompt: `You are the content strategist step. Read {{trigger.payload}} (topic, audience, tone, length, mustInclude, etc.).

Deliver:
- Restated goal in one sentence
- Reader takeaway (one sentence)
- Section-level outline (H2/H3) with 1-line purpose per section
- Open questions or assumptions if the brief is thin

Do not draft full prose yet — outline only.`,
          on_failure: 'abort',
        },
        {
          title: 'First draft',
          role_prompt: `Write the first full draft following this approved outline:

<<<0>>>

Honor {{trigger.payload.tone}}, {{trigger.payload.length}}, and any {{trigger.payload.mustInclude}} items. If the brief is incomplete, state reasonable assumptions in a short "Assumptions" preface then proceed.`,
          on_failure: 'abort',
        },
        {
          title: 'Edit & polish',
          role_prompt: `Edit the draft below for clarity, voice, and structure. Preserve factual intent.

Outline / brief context:
<<<0>>>

Draft to refine:
<<<1>>>

Return:
1. The revised body (ready to publish as markdown).
2. Three alternate titles (pick one primary at the top).
3. A brief "Editor's notes" list (max 5 bullets) on what you changed and why.`,
          on_failure: 'abort',
        },
      ],
    },
  },
  {
    id: 'onboarding',
    label: 'Onboarding',
    description:
      'Welcome packet, access checklist, and a concrete starter task for a new teammate.',
    draft: {
      name: 'New hire onboarding',
      defaultPayload: {
        newHireName: '',
        role: '',
        manager: '',
        startDate: '',
        team: '',
        primaryRepo: '',
      },
      steps: [
        {
          title: 'Welcome packet',
          role_prompt: `Create a friendly welcome packet for a new teammate using {{trigger.payload}} (newHireName, role, manager, startDate, team, primaryRepo, etc.).

Include:
- Personalized greeting
- First-week goals (3–5 bullets)
- Who to meet (roles, not names, unless provided)
- Links placeholders like [Handbook], [Org chart] the HR/lead can replace

Tone: warm, practical, not corporate-speak heavy.`,
          on_failure: 'abort',
        },
        {
          title: 'Environment & access checklist',
          role_prompt: `From the welcome context below, produce a checklist the new hire (or buddy) can tick off.

<<<0>>>

Cover: machine setup, repo access, Hub/agents if relevant, chat channels, calendar, security training, and any role-specific tools. Use markdown checkboxes (- [ ]). Group by "Day 1", "Week 1".`,
          on_failure: 'abort',
        },
        {
          title: 'Starter task',
          role_prompt: `Define one concrete starter task using:

Welcome packet:
<<<0>>>

Access checklist themes:
<<<1>>>

Output:
- Task title
- Why it matters (2 sentences)
- Step-by-step instructions (numbered)
- Acceptance criteria (bullet list)
- Estimated time and who can unblock if stuck (default to manager from payload if present)`,
          on_failure: 'abort',
        },
      ],
    },
  },
];

export function getWorkflowTemplateMetaList() {
  return WORKFLOW_TEMPLATE_CATALOG.map(({ id, label, description }: any) => ({
    id,
    label,
    description,
  }));
}

/**
 * Same shape as the workflow builder empty state.
 */
export function blankWorkflowDraft() {
  return {
    name: 'New workflow',
    trigger_type: 'manual',
    default_payload_str: '{\n  \n}',
    steps: [],
    cron_mode: 'off',
    cron_expr: '',
    webhook_enabled: false,
    kanban_trigger_column_id: '',
  };
}

/**
 * @param {string} templateId
 * @param {string} defaultAgentId
 * @param {{ generateId?: () => string }} [opts]
 */
export function instantiateWorkflowTemplate(templateId: any, defaultAgentId: any, opts: any = {}) {
  const seed = WORKFLOW_TEMPLATE_CATALOG.find((s: any) => s.id === templateId);
  if (!seed) {
    throw new Error(`Unknown workflow template: ${templateId}`);
  }
  const generateId =
    typeof opts.generateId === 'function' ? opts.generateId : () => crypto.randomUUID();
  const { draft } = seed;
  const rawSteps = Array.isArray(draft.steps) ? draft.steps : [];
  const n = rawSteps.length;
  const ids = Array.from({ length: n }, () => generateId());

  /** @param {string} text */
  function expandRefs(text: any) {
    let out = String(text);
    for (let i = 0; i < n; i += 1) {
      const token = `<<<${i}>>>`;
      const repl = `{{steps.${ids[i]}.output}}`;
      out = out.split(token).join(repl);
    }
    if (/<<<(\d+)>>>/.test(out)) {
      throw new Error(`Template ${templateId} has unresolved step reference placeholders`);
    }
    return out;
  }

  const steps = rawSteps.map((s: any, i: any) => ({
    id: ids[i],
    agent_id: String(defaultAgentId || ''),
    step_project_id: '',
    title: expandRefs(s.title),
    role_prompt: expandRefs(s.role_prompt),
    step_order: i,
    timeout_ms: s.timeout_ms != null ? s.timeout_ms : null,
    on_failure: s.on_failure || 'abort',
  }));

  let default_payload_str = '{}';
  try {
    default_payload_str = JSON.stringify(draft.defaultPayload ?? {}, null, 2);
  } catch {
    default_payload_str = '{}';
  }

  return {
    name: String(draft.name || seed.label),
    trigger_type: 'manual',
    default_payload_str,
    steps,
    cron_mode: 'off',
    cron_expr: '',
    webhook_enabled: false,
    kanban_trigger_column_id: '',
  };
}
