/**
 * Starter context files written into a project's data dir the first time it
 * has agents (`ensureContextFiles` in project-model.ts). Users edit them
 * afterwards; existing files are never overwritten.
 */

/** How the seeded QA agent fits next to the dev agents, for AGENTS.md / SOUL.md. */
function qaAgentSection(projectName: string): string {
  return `## QA agent

${projectName} QA (role \`qa\`) is seeded with the project. It drafts QA plans with you on the **QA** page, then runs approved plans against a target URL: the \`browser\` tool for public sites, the \`preview\` tool for this project's dev preview or a loopback host. Each case gets a screenshot and a verdict.

- It is read-only on code: no worktree, no commits, no Finalize.
- A failing case becomes a \`qa-finding\` card assigned to the project's dev agent, which opens the fix session.
- A human approves each plan before it can run, and signs it off once the latest run passes.
- Autonomous dispatch and background agents never pick the QA agent.
`;
}

export function buildStarterContextFiles(projectName: string): Record<string, string> {
  return {
    'AGENTS.md': `# AGENTS.md - ${projectName}\n\nThis folder is home. Treat it that way.\n\n## Session Startup\n\n1. Read \`SOUL.md\` — this is who you are\n2. Read \`USER.md\` — this is who you're helping\n3. Read \`memory/YYYY-MM-DD.md\` (today + yesterday) for recent context\n4. If in a main session: Also read \`MEMORY.md\`\n\n${qaAgentSection(projectName)}`,
    'SOUL.md': `# SOUL.md - ${projectName}\n\n## Identity\n\nDescribe what this project is, its architecture, and its principles here.\n\n## Quality\n\nShipped work is validated against the running app by the project's QA agent: plans are approved by a human, findings go back to dev agents as cards, and a plan is done only after a passing run and a human sign-off.\n`,
    'USER.md': `# USER.md\n\n- **Name**: (your name)\n- **Timezone**: (your timezone)\n- **GitHub**: (your handle)\n\nAdd preferences and context about yourself here.\n`,
    'TOOLS.md': `# TOOLS.md - ${projectName}\n\nDocument project-specific tools, CLI commands, deployment steps, and integrations here.\n`,
    'MEMORY.md': `# MEMORY.md - ${projectName}\n\nLong-term memory for key decisions, preferences, and known issues.\n`,
  };
}
