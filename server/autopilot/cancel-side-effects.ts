import type { ActiveChatProcess } from '../active-chat-process.js';
import {
  cancelDeployment,
  DeploymentCancelError,
  type CancelDeploymentInput,
  type DeployOrchestratorDeps,
} from '../deploy/deploy-orchestrator.js';
import { abortFinalizeRunInProcess } from '../finalize/run-abort-registry.js';
import { cancelSessionChatRun } from '../session-chat-cancel.js';
import type { BroadcastFn, DeploymentRow } from '../types.js';
import type { AutopilotCancelFailure, AutopilotCancelRefs } from './types.js';

export interface AutopilotSideEffectCancelDeps {
  activeProcesses: Map<string, ActiveChatProcess>;
  broadcast?: BroadcastFn;
  cancelDeployment?: (
    input: CancelDeploymentInput,
    deps: Pick<DeployOrchestratorDeps, 'broadcast'>,
  ) => DeploymentRow;
}

function failure(
  kind: AutopilotCancelFailure['kind'],
  id: string,
  err: unknown,
): AutopilotCancelFailure {
  return {
    kind,
    id,
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Cancel every side effect referenced by an Autopilot operation.
 * Attempts every ref even if one fails, then returns the failures so the
 * controller can keep those operations cancellable.
 */
export function cancelAutopilotSideEffects(
  refs: AutopilotCancelRefs,
  deps: AutopilotSideEffectCancelDeps,
): AutopilotCancelFailure[] {
  const failures: AutopilotCancelFailure[] = [];
  for (const sessionId of refs.sessionIds) {
    try {
      cancelSessionChatRun({ sessionId, activeProcesses: deps.activeProcesses });
    } catch (err) {
      console.warn(
        `[autopilot] session cancel failed session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failures.push(failure('session', sessionId, err));
    }
  }
  for (const finalizeRunId of refs.finalizeRunIds) {
    try {
      abortFinalizeRunInProcess(finalizeRunId);
    } catch (err) {
      console.warn(
        `[autopilot] finalize cancel failed run=${finalizeRunId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failures.push(failure('finalize', finalizeRunId, err));
    }
  }
  const broadcast = deps.broadcast ?? (() => undefined);
  const cancelOwnedDeployment = deps.cancelDeployment ?? cancelDeployment;
  for (const deploymentId of refs.deploymentIds) {
    try {
      cancelOwnedDeployment({ deploymentId, reason: 'Autopilot run stopped' }, { broadcast });
    } catch (err) {
      if (err instanceof DeploymentCancelError && err.reason === 'already_terminal') {
        continue;
      }
      if (err instanceof DeploymentCancelError && err.reason === 'not_found') {
        continue;
      }
      console.warn(
        `[autopilot] deployment cancel failed deployment=${deploymentId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failures.push(failure('deployment', deploymentId, err));
    }
  }
  return failures;
}
