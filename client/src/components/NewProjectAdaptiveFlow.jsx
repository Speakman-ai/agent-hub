import { useCallback, useEffect, useRef, useState } from 'react';
import AdaptiveQuestionnaire from './AdaptiveQuestionnaire.jsx';
import ProvisioningStatus from './ProvisioningStatus.jsx';
import {
  provisionProject as defaultProvision,
  subscribeProvisioningEvents as defaultSubscribe,
} from '../utils/provisioningClient.js';

/**
 * NewProjectAdaptiveFlow — stitches the questionnaire to the live
 * provisioning status view.
 *
 * Two sub-views driven by local state:
 *   1. `questionnaire` — render <AdaptiveQuestionnaire />. On submit we
 *      POST the payload to the provisioning endpoint, open the event
 *      stream, and transition to...
 *   2. `provisioning` — render <ProvisioningStatus /> with the event
 *      buffer reduced in real time.
 *
 * The `provision` and `subscribe` deps are injectable so tests can
 * drive the flow without a real server.
 *
 * GitHub-integration detection:
 *   If the questionnaire payload's `integrations` array includes 'github'
 *   (or is the idk sentinel — defer to agent default), the ProvisioningStatus
 *   renders the full phase list with gh-* phases. If the user explicitly
 *   omitted GitHub, the gh-* phases are skipped and the UI surfaces a
 *   local-only scaffold.
 */
export default function NewProjectAdaptiveFlow({
  onClose,
  onProjectCreated,
  provision = defaultProvision,
  subscribe = defaultSubscribe,
}) {
  const [view, setView] = useState('questionnaire');
  const [events, setEvents] = useState([]);
  const [withGithub, setWithGithub] = useState(true);
  const [launchError, setLaunchError] = useState(null);
  const streamHandleRef = useRef(null);
  const currentPayloadRef = useRef(null);

  // Tear down the event stream on unmount so we don't leak sockets.
  useEffect(() => {
    return () => {
      streamHandleRef.current?.close?.();
    };
  }, []);

  const start = useCallback(
    async (payload) => {
      setLaunchError(null);
      setEvents([]);
      setWithGithub(inferWithGithub(payload));
      setView('provisioning');
      currentPayloadRef.current = payload;
      try {
        const { wsUrl } = await provision(payload);
        const handle = subscribe(wsUrl, {
          onEvent: (ev) => setEvents((prev) => [...prev, ev]),
          onClose: () => {
            // No-op — the terminal `done` event in the stream drives the
            // overall status. An unexpected close without a done event
            // leaves the UI mid-flight; a follow-up card will add a
            // watchdog timer.
          },
          onError: (err) => {
            setLaunchError(
              err instanceof Error ? err.message : 'Unknown provisioning stream error',
            );
          },
        });
        streamHandleRef.current = handle;
      } catch (err) {
        setLaunchError(err instanceof Error ? err.message : String(err));
        // Synthesize a failure event so ProvisioningStatus renders the
        // failure card rather than sitting stuck on "Waiting to start".
        setEvents([
          {
            type: 'done',
            error: {
              code: -2,
              message: err instanceof Error ? err.message : String(err),
            },
          },
        ]);
      }
    },
    [provision, subscribe],
  );

  const handleRetry = useCallback(() => {
    const payload = currentPayloadRef.current;
    streamHandleRef.current?.close?.();
    if (payload) start(payload);
  }, [start]);

  const handleClose = useCallback(() => {
    streamHandleRef.current?.close?.();
    onClose?.();
  }, [onClose]);

  const handleOpenRepo = useCallback(
    (repoUrl) => {
      onProjectCreated?.({ repoUrl });
    },
    [onProjectCreated],
  );

  if (view === 'questionnaire') {
    return <AdaptiveQuestionnaire onSubmit={start} onClose={onClose} />;
  }

  return (
    <div className="flex flex-col w-full h-full" data-testid="new-project-adaptive-flow">
      {launchError && !events.some((e) => e.type === 'done') && (
        <div
          className="shrink-0 bg-red-900/60 border-b border-red-700 text-red-100 text-sm px-4 py-2"
          data-testid="np-launch-error"
        >
          Failed to start provisioning: {launchError}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <ProvisioningStatus
          events={events}
          withGithub={withGithub}
          onRetry={handleRetry}
          onClose={handleClose}
          onOpenRepo={handleOpenRepo}
        />
      </div>
    </div>
  );
}

/**
 * Determine whether the ProvisioningStatus UI should render the gh-*
 * phases. `idk` means "defer to agent default" — we keep gh enabled so
 * the status row stays visible if the agent chooses to publish.
 */
export function inferWithGithub(payload) {
  if (!payload) return true;
  const { integrations } = payload;
  if (integrations === 'idk' || integrations == null) return true;
  if (Array.isArray(integrations)) return integrations.includes('github');
  return true;
}
