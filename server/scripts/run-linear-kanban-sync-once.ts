#!/usr/bin/env -S npx tsx
/**
 * One-off runner for the native linear-kanban-sync (operator / smoke test).
 * Usage: cd server && npx tsx scripts/run-linear-kanban-sync-once.ts
 */
import { stmts } from '../db.js';
import config from '../config.js';
import { runLinearKanbanSync } from '../linear-kanban-sync.js';
import { SURVEYTRACKER_LINEAR_SYNC } from '../linear-kanban-sync-config.js';
import { resolveLinearApiKey } from '../linear-skill-auth-resolve.js';
import { mergeSkillCredentialSpawnEnv } from '../skill-credentials-spawn.js';
import { getOrgOwnerUserId } from '../session-ownership.js';
import { getProjects } from '../project-model.js';

const env = { ...process.env };
const project = getProjects().find((p) => p.id === 'surveytracker');
if (project) {
  const agentId = project.agents?.[0]?.id ?? 'agent-hub';
  mergeSkillCredentialSpawnEnv(env as NodeJS.ProcessEnv, {
    ownerId: getOrgOwnerUserId(),
    agentId,
    project,
  });
}
const { apiKey } = resolveLinearApiKey(env);
if (!apiKey) {
  console.error('LINEAR_API_KEY not configured');
  process.exit(2);
}

const result = await runLinearKanbanSync({
  stmts: stmts!,
  dataDir: config.dataDir,
  apiKey,
  config: SURVEYTRACKER_LINEAR_SYNC,
  log: (line) => console.log(line),
  deadlineMs: Date.now() + 45 * 60 * 1000,
});
console.log('\n' + result.summary);
process.exit(result.complete ? 0 : 1);
