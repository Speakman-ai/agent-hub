/**
 * Runs one PR environment through bring-up and into the hold phase in a real
 * Node process, with an in-memory Hub and docker. Prints `ready` once the ready
 * report lands and `heartbeat` on every heartbeat. The fleet agent died here:
 * with nothing ref'd after bring-up, Node exited right after the ready report.
 */
import { runAgentEnvironment } from '../runner-agent-environment.js';

void runAgentEnvironment({
  jobId: 'job-hold',
  spec: {
    orgId: 'o',
    projectId: 'p',
    runId: 'prenv-hold',
    jobId: 'pr-1',
    matrixKey: 'environment',
    image: 'runner:img',
    composeProjectName: 'pr-1',
    env: {},
    kind: 'environment',
    environment: {
      composeProject: 'pr-1',
      composeFile: 'compose.yml',
      service: 'web',
      port: 8000,
      health: '/',
      steps: [],
    },
  },
  workspaceDir: '/nonexistent',
  transport: {
    postLogs: async () => {},
    postFinish: async () => {},
    heartbeat: async () => {
      console.log('heartbeat');
      return { gone: false };
    },
    postEnvironment: async (_id, report) => {
      if (report.status === 'ready') console.log('ready');
      return { gone: false };
    },
  },
  docker: {
    startContainer: async () => {},
    execStep: async (_name, run, _env, onLog) => {
      if (run.startsWith('curl')) onLog('stdout', '200');
      return 0;
    },
    hostPort: async () => 32801,
    isRunning: async () => true,
    stopContainer: async () => {},
  },
  clearJobWorktreeDest: async () => {},
  resolveHost: async () => '10.0.0.1',
  checkSpot: async () => false,
  sleep: async () => {},
  heartbeatMs: 50,
  logFlushMs: 50,
  livenessMs: 50,
  spotProbeMs: 50,
});
