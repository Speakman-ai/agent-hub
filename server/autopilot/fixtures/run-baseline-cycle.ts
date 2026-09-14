/**
 * Disposable local Autopilot fixture. Not a Vitest file: Vitest must never
 * launch a real agent CLI, and this runner is the outside-Vitest validation
 * that drives the todo app through live adapter wiring.
 *
 * Default: real createChatHandler + startFinalizeRunBackground (stub worker,
 * Hub-hosted Finalize through review, native merge, and cycle reconcile).
 *
 *   npx tsx server/autopilot/fixtures/run-baseline-cycle.ts
 *   npx tsx server/autopilot/fixtures/run-baseline-cycle.ts --deterministic
 *
 * Isolates AGENT_HUB_DATA_DIR under os.tmpdir() before importing server
 * modules so it cannot open the production database.
 */
import { mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';

function isolateFixtureEnv(): { dataDir: string; fixtureRepo: string } {
  const dataDir = path.join(os.tmpdir(), `autopilot-fixture-${randomUUID()}`);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  process.env.AGENT_HUB_DATA_DIR = dataDir;
  process.env.AGENT_HUB_PROJECTS_DIR = path.join(dataDir, 'projects');
  process.env.AGENT_HUB_TEST_MODE = '1';
  process.env.AGENT_HUB_DISABLE_PUSH_CI = '1';
  process.env.AGENT_HUB_DISABLE_INITIAL_BUILD = '1';
  process.env.AGENT_HUB_DISABLE_AUTO_REVIEW = '1';
  process.env.AGENT_HUB_DISABLE_FORCE_RM_DOCKER = '1';
  process.env.AGENT_HUB_DISABLE_PREVIEW_LIMITS = '1';
  delete process.env.AGENT_HUB_API_KEY;
  return { dataDir, fixtureRepo: path.join(dataDir, 'todo-app') };
}

const isolated = isolateFixtureEnv();
const deterministic = process.argv.includes('--deterministic');

const { initOrgsDb, setOrgsDbPathForTests } = await import('../../orgs.js');
setOrgsDbPathForTests(path.join(isolated.dataDir, 'orgs.db'));
initOrgsDb();

try {
  if (deterministic) {
    const { runLiveBaselineCycle } = await import('./baseline-cycle.js');
    const result = await runLiveBaselineCycle({ fixtureRepo: isolated.fixtureRepo });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: 'deterministic',
          runId: result.runId,
          cardId: result.cardId,
          epicId: result.epicId,
          sessionId: result.sessionId,
          finalizeRunId: result.finalizeRunId,
          baselineSha: result.baselineSha,
          mergedSha: result.mergedSha,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const { runIntegratedBaselineCycle } = await import('./integrated-cycle.js');
    const result = await runIntegratedBaselineCycle({ fixtureRepo: isolated.fixtureRepo });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          mode: 'integrated',
          runId: result.runId,
          cardId: result.cardId,
          epicId: result.epicId,
          sessionId: result.sessionId,
          finalizeRunId: result.finalizeRunId,
          baselineSha: result.baselineSha,
          implementedSha: result.implementedSha,
          finalizeHeadSha: result.finalizeHeadSha,
          finalizeStatus: result.finalizeStatus,
          mergedSha: result.mergedSha,
        },
        null,
        2,
      )}\n`,
    );
  }
} catch (err) {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
} finally {
  rmSync(isolated.dataDir, { recursive: true, force: true });
}
