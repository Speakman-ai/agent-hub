/**
 * Runner-agent side of an agent desktop job (`spec.kind === 'desktop'`).
 *
 * The fleet box is not the same machine twice, so the home travels through
 * the Hub: restore the last snapshot into a fresh volume, run the desktop
 * image on it, report the control endpoint, hold until the Hub cancels the
 * row (heartbeat 410) or the container dies, then snapshot the volume back
 * and finish. A home that failed to restore is never uploaded, so a broken
 * download can't overwrite the good snapshot with an empty home.
 *
 * Finishing the job is what tells the Hub the desktop is gone (see
 * desktop/desktop-fleet-contract.ts), so teardown never treats an attempt as
 * done: the container is removed, the home snapshotted and its upload
 * accepted (or explicitly discarded by the Hub) before the job finishes, each
 * retried until it succeeds. Until then the volume and the snapshot file stay
 * on this box as the recoverable copy, and heartbeats continue so the Hub
 * keeps holding the desktop's slot. The Hub never frees that slot on silence
 * alone. If the runner can't reach the Hub for DESKTOP_RUNNER_SELF_STOP_MS it
 * still stops the desktop itself, so a partitioned runner doesn't keep one
 * running nobody can use.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { mkdir, mkdtemp, readdir, rm } from 'fs/promises';
import { execFile } from 'child_process';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';
import { deliverCritical } from './runner-agent.js';
import { sleepUnlessAborted } from './abortable-sleep.js';
import {
  isNoSuchContainerError,
  resolveAdvertiseHost,
  type EnvironmentTransport,
} from './runner-agent-environment.js';
import { parseDockerPortOutput } from './runner-environment.js';
import { noopTaskProtection, type TaskProtection } from './ecs-task-protection.js';
import { DESKTOP_CONTROL_PORT } from '../desktop/desktop-control-client.js';
import { DESKTOP_RUNNER_SELF_STOP_MS } from '../desktop/desktop-fleet-contract.js';
import {
  buildDesktopHomeTarArgv,
  buildDesktopRunArgv,
  type DesktopContainerLimits,
} from '../desktop/desktop-container-args.js';

const execFileAsync = promisify(execFile);

export interface DesktopTransport extends EnvironmentTransport {
  /** Fetch the last home snapshot to `destPath`. False when there is none. */
  downloadDesktopHome(jobId: string, destPath: string): Promise<boolean>;
  /**
   * Upload the home snapshot. `accepted`: the Hub stored it. `discarded`: the
   * Hub answered 410 (the computer moved past this run or was deleted), so it
   * will never be wanted. `rejected`: the Hub refused it for good (413), so
   * resending the same file can't succeed. Throws on anything else so
   * delivery is retried.
   */
  uploadDesktopHome(jobId: string, filePath: string): Promise<DesktopHomeUpload>;
  /** Tell the Hub where a rejected home is kept. Throws so delivery is retried. */
  reportDesktopHomeRejected(jobId: string, detail: string): Promise<void>;
  /** The Hub's decision for a parked, refused home. Throws so it is asked again. */
  getDesktopHomeDecision(jobId: string): Promise<'hold' | 'retry' | 'discard'>;
}

export type DesktopHomeUpload =
  | { outcome: 'accepted' }
  | { outcome: 'discarded' }
  | { outcome: 'rejected'; detail: string };

export interface DesktopAgentDocker {
  createVolume(name: string): Promise<void>;
  /** Idempotent; throws when the volume could not be removed (e.g. still in use). */
  removeVolume(name: string): Promise<void>;
  /** Untar `file` into the volume. */
  restoreHome(volume: string, image: string, file: string): Promise<void>;
  /** Tar the volume into `file`. */
  snapshotHome(volume: string, image: string, file: string): Promise<void>;
  startDesktop(argv: string[], token: string): Promise<void>;
  isRunning(name: string): Promise<boolean | null>;
  hostPort(name: string, containerPort: number): Promise<number>;
  /** Graceful stop, then remove. Idempotent; throws when the container is still there. */
  removeContainer(name: string): Promise<void>;
}

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/**
 * Run docker with its stdin fed from a file and/or its stdout written to one.
 * Every stream is part of the result: a failed read, a failed write (ENOSPC)
 * or an early stdin close rejects, and kills the child, instead of escaping
 * as an unhandled stream error. Exported for tests.
 */
export async function runDocker(
  args: string[],
  io: { stdinFile?: string; stdoutFile?: string; env?: NodeJS.ProcessEnv },
  spawnImpl: SpawnFn = spawn,
): Promise<void> {
  const child = spawnImpl('docker', args, {
    stdio: [io.stdinFile ? 'pipe' : 'ignore', io.stdoutFile ? 'pipe' : 'ignore', 'pipe'],
    env: io.env ? { ...process.env, ...io.env } : process.env,
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4096);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code: number | null) => resolve(code));
  });
  // Observed here so a spawn error can't surface as an unhandled rejection
  // while the transfers are still being awaited.
  const exitOutcome = exited.then(
    (code) => ({ code, err: null as Error | null }),
    (err: Error) => ({ code: null, err }),
  );
  const transfers: Promise<void>[] = [];
  if (io.stdinFile) {
    if (!child.stdin) throw new Error('docker child has no stdin');
    transfers.push(pipeline(createReadStream(io.stdinFile), child.stdin));
  }
  if (io.stdoutFile) {
    if (!child.stdout) throw new Error('docker child has no stdout');
    transfers.push(pipeline(child.stdout, createWriteStream(io.stdoutFile)));
  }
  const detail = () => (stderr.trim() ? `: ${stderr.trim()}` : '');
  try {
    await Promise.all(transfers);
  } catch (streamErr) {
    child.kill('SIGKILL');
    const { err: spawnErr } = await exitOutcome;
    if (spawnErr) throw spawnErr;
    throw new Error(`docker ${args[0]} stream failed: ${(streamErr as Error).message}${detail()}`);
  }
  const { code, err } = await exitOutcome;
  if (err) throw err;
  if (code !== 0) throw new Error(`docker ${args[0]} exited ${code}${detail()}`);
}

/** The run was stopped (by the Hub or the contact watchdog) during startup. */
class RunStopped extends Error {
  constructor() {
    super('stopped');
    this.name = 'RunStopped';
  }
}

/** Settle with `p`, or reject with RunStopped as soon as `signal` aborts. */
function raceStop<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RunStopped());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RunStopped());
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Retry a teardown step until it succeeds, backing off to `capMs`. There is
 * deliberately no attempt limit: giving up would report the desktop gone (or
 * its home saved) when it isn't.
 */
async function untilDone<T>(
  what: string,
  fn: () => Promise<T>,
  firstDelayMs: number,
  capMs: number,
): Promise<T> {
  let delay = firstDelayMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(
        `[runner-agent] ${what} failed (attempt ${attempt}): ${(err as Error).message}; retrying in ${delay}ms`,
      );
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, capMs);
    }
  }
}

export function realDesktopAgentDocker(spawnImpl: SpawnFn = spawn): DesktopAgentDocker {
  return {
    async createVolume(name) {
      await execFileAsync('docker', ['volume', 'create', name]);
    },
    async removeVolume(name) {
      try {
        await execFileAsync('docker', ['volume', 'rm', name]);
      } catch (err) {
        if (!/no such volume/i.test(String((err as { stderr?: unknown }).stderr ?? ''))) throw err;
      }
    },
    restoreHome(volume, image, file) {
      return runDocker(
        buildDesktopHomeTarArgv({ volume, image, mode: 'restore' }).slice(1),
        { stdinFile: file },
        spawnImpl,
      );
    },
    snapshotHome(volume, image, file) {
      return runDocker(
        buildDesktopHomeTarArgv({ volume, image, mode: 'snapshot' }).slice(1),
        { stdoutFile: file },
        spawnImpl,
      );
    },
    async startDesktop(argv, token) {
      await execFileAsync(argv[0], argv.slice(1), {
        env: { ...process.env, DESKTOP_CONTROL_TOKEN: token },
      });
    },
    async isRunning(name) {
      try {
        const { stdout } = await execFileAsync('docker', [
          'inspect',
          '-f',
          '{{.State.Running}}',
          name,
        ]);
        return stdout.trim() === 'true';
      } catch (err) {
        if (isNoSuchContainerError(err)) return null;
        throw err;
      }
    },
    async hostPort(name, containerPort) {
      const { stdout } = await execFileAsync('docker', ['port', name, String(containerPort)]);
      const port = parseDockerPortOutput(stdout);
      if (!port) throw new Error(`no host port published for ${name}:${containerPort}`);
      return port;
    },
    async removeContainer(name) {
      // A clean stop lets Chromium flush its profile before the snapshot. Its
      // failure is fine as long as the removal below succeeds.
      await execFileAsync('docker', ['stop', '-t', '15', name]).catch(() => {});
      try {
        await execFileAsync('docker', ['rm', '-f', name]);
      } catch (err) {
        if (!isNoSuchContainerError(err)) throw err;
      }
    },
  };
}

export async function runAgentDesktop(args: {
  jobId: string;
  spec: RunnerJobWireSpec;
  transport: DesktopTransport;
  docker: DesktopAgentDocker;
  resolveHost?: () => Promise<string>;
  protection?: TaskProtection;
  publishHost?: string;
  heartbeatMs?: number;
  livenessMs?: number;
  readyRetryMs?: number;
  delivery?: { attempts?: number; baseDelayMs?: number };
  tmpRoot?: string;
  /** Recursive directory removal (tests inject failures). */
  removeDir?: (dir: string) => Promise<void>;
  /** First delay between teardown retries (doubles up to `retryCapMs`). */
  cleanupRetryMs?: number;
  retryCapMs?: number;
  /** Stop the desktop after this long without reaching the Hub. */
  selfStopMs?: number;
  /** How often the contact deadline is checked. */
  watchdogMs?: number;
  /** How often a parked runner asks about a refused home. */
  decisionPollMs?: number;
  now?: () => number;
}): Promise<{
  ready: boolean;
  error: string | null;
  /**
   * How the home ended: stored by the Hub, discarded (the Hub didn't want
   * it, or decided to drop a refused one), or never snapshotted.
   */
  home: 'accepted' | 'discarded' | 'not-saved';
}> {
  const { jobId, spec, transport, docker } = args;
  const desktop = spec.desktop;
  if (!desktop) throw new Error(`desktop job ${jobId} has no desktop spec`);
  const protection = args.protection ?? noopTaskProtection();
  void protection.set(true).catch(() => {});

  const now = args.now ?? Date.now;
  const selfStopMs = args.selfStopMs ?? DESKTOP_RUNNER_SELF_STOP_MS;
  const retryFirstMs = args.cleanupRetryMs ?? 2_000;
  const retryCapMs = args.retryCapMs ?? 60_000;
  // Any answer from the Hub counts as contact, a 410 included. The claim
  // that handed us this job was the first.
  let lastContact = now();
  const contact = () => {
    lastContact = now();
  };
  const stop = new AbortController();
  let lostContact = false;
  const heartbeat = setInterval(() => {
    void transport
      .heartbeat(jobId)
      .then((r) => {
        contact();
        if (r && r.gone && !stop.signal.aborted) {
          console.log(`[runner-agent] desktop ${jobId} stopped by the Hub`);
          stop.abort();
        }
      })
      .catch(() => {});
    void protection.set(true).catch(() => {});
  }, args.heartbeatMs ?? 30_000);
  // Left ref'd on purpose: it keeps the agent process alive while it holds the
  // desktop (every other handle is unref'd). Cleared in `finally`.
  // A partitioned runner stops its desktop in every phase (startup, the
  // ready report, the hold), not only once the desktop is up. Expiry stops
  // the run; teardown in `finally` then removes the container. The Hub does
  // not rely on this: it waits for the finish (desktop-fleet-contract.ts).
  const watchdog = setInterval(
    () => {
      if (stop.signal.aborted || now() - lastContact < selfStopMs) return;
      lostContact = true;
      console.error(
        `[runner-agent] desktop ${jobId}: no contact with the Hub for ${Math.round(selfStopMs / 60_000)} minutes; stopping it`,
      );
      stop.abort();
    },
    args.watchdogMs ?? Math.min(30_000, Math.max(1, Math.floor(selfStopMs / 10))),
  );
  (watchdog as { unref?: () => void }).unref?.();
  const stoppedReason = () =>
    lostContact
      ? `lost contact with the Hub for ${Math.round(selfStopMs / 60_000)} minutes`
      : 'stopped';
  /** Poll the Hub until it decides what to do with a refused home. */
  const awaitHomeDecision = async (): Promise<'retry' | 'discard'> => {
    for (;;) {
      const decision = await untilDone(
        `asking about the refused desktop home (job=${jobId})`,
        () => transport.getDesktopHomeDecision(jobId),
        retryFirstMs,
        retryCapMs,
      );
      if (decision !== 'hold') return decision;
      await new Promise((r) => setTimeout(r, args.decisionPollMs ?? 30_000));
    }
  };
  /** Leave startup as soon as the run was stopped; teardown handles the rest. */
  const throwIfStopped = () => {
    if (stop.signal.aborted) throw new RunStopped();
  };

  const suffix = jobId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  const name = `agent-hub-desktop-${desktop.computerId}-${suffix}`;
  const volume = `agent-hub-desktop-home-${desktop.computerId}-${suffix}`;
  const limits: DesktopContainerLimits = {
    image: spec.image,
    memory: desktop.memory,
    cpus: desktop.cpus,
  };
  // Spools (restore and snapshot tarballs: copies of the user's home) live
  // under one root so none is ever lost track of. An agent runs one job at a
  // time, so anything already there is a previous run's leftover.
  // Set up inside the run's `try` (below), so a disk that is full or
  // unreadable still reaches `finally`: timers cleared, protection released,
  // the finish sent.
  const spoolRoot = path.join(args.tmpRoot ?? os.tmpdir(), 'agent-hub-desktop-spool');
  const removeDir = args.removeDir ?? ((dir: string) => rm(dir, { recursive: true, force: true }));
  let tmp: string | null = null;
  const spoolFile = (name: string) => {
    if (!tmp) throw new Error('desktop spool not set up');
    return path.join(tmp, name);
  };
  let volumeCreated = false;
  let homeOk = false;
  let containerStarted = false;
  let ready = false;
  let error: string | null = null;
  let home: 'accepted' | 'discarded' | 'not-saved' = 'not-saved';

  const sleepOrStop = (ms: number) => sleepUnlessAborted(ms, stop.signal);

  try {
    await mkdir(spoolRoot, { recursive: true });
    for (const leftover of await readdir(spoolRoot)) {
      await removeDir(path.join(spoolRoot, leftover)).catch((err: unknown) =>
        console.error(
          `[runner-agent] could not remove leftover desktop spool ${leftover}: ${(err as Error).message}`,
        ),
      );
    }
    tmp = await mkdtemp(path.join(spoolRoot, 'job-'));
    await docker.createVolume(volume);
    volumeCreated = true;
    throwIfStopped();
    if (desktop.restoreHome) {
      const file = spoolFile('restore.tar.gz');
      // The Hub only asks for a restore when it holds a snapshot. Booting a
      // fresh home instead would upload over that snapshot on stop. Only this
      // network step races the stop: docker steps run to completion so a
      // container is never created after teardown removed it.
      const found = await raceStop(transport.downloadDesktopHome(jobId, file), stop.signal);
      contact();
      if (!found) {
        throw new Error('the saved desktop home could not be found; refusing to start empty');
      }
      throwIfStopped();
      await docker.restoreHome(volume, spec.image, file);
    }
    homeOk = true;
    throwIfStopped();
    // Set first: a `docker run` that fails can still have created the
    // container, and removal is idempotent.
    containerStarted = true;
    await docker.startDesktop(
      buildDesktopRunArgv({
        name,
        computerId: desktop.computerId,
        volume,
        limits,
        publishHost: args.publishHost,
      }),
      desktop.controlToken,
    );
    throwIfStopped();
    const port = await docker.hostPort(name, DESKTOP_CONTROL_PORT);
    const host = await (args.resolveHost ?? (() => resolveAdvertiseHost()))();

    // Report until it lands: a restarting Hub must find the desktop still up.
    let delay = args.readyRetryMs ?? 1_000;
    while (!stop.signal.aborted) {
      try {
        const r = await raceStop(
          transport.postEnvironment(jobId, { status: 'ready', host, port }),
          stop.signal,
        );
        contact();
        if (r.gone) stop.abort();
        else ready = true;
        break;
      } catch (err) {
        if (err instanceof RunStopped) break;
        console.error(`[runner-agent] desktop ready report failed: ${(err as Error).message}`);
        await sleepOrStop(delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }

    // Hold until the Hub stops it, or the container is seen down twice in a row.
    let misses = 0;
    while (ready && !stop.signal.aborted) {
      await sleepOrStop(args.livenessMs ?? 15_000);
      if (stop.signal.aborted) break;
      // A hung inspect must not hold the run past a stop or the watchdog.
      const running = await raceStop(docker.isRunning(name), stop.signal).catch((err: unknown) =>
        err instanceof RunStopped ? null : true,
      );
      if (stop.signal.aborted) break;
      misses = running === true ? 0 : misses + 1;
      if (misses >= 2) {
        error = 'the desktop container stopped';
        ready = false;
        await deliverCritical(
          `desktop lost (job=${jobId})`,
          async () => {
            await transport.postEnvironment(jobId, { status: 'lost', detail: error! });
          },
          args.delivery,
        ).catch(() => {});
      }
    }
    if (stop.signal.aborted && !error) error = stoppedReason();
  } catch (err) {
    if (err instanceof RunStopped) {
      // Stopped during startup; teardown below cleans up. Nothing to report.
      error = stoppedReason();
      ready = false;
    } else {
      error = err instanceof Error ? err.message : String(err);
      console.error(`[runner-agent] desktop ${jobId}: ${error}`);
      await deliverCritical(
        `desktop lost (job=${jobId})`,
        async () => {
          await transport.postEnvironment(jobId, { status: 'lost', detail: error! });
        },
        args.delivery,
      ).catch(() => {});
    }
  } finally {
    // Heartbeats keep running through teardown: they keep the Hub holding
    // this desktop's slot until the finish below.
    if (containerStarted) {
      await untilDone(
        `removing desktop container ${name}`,
        () => docker.removeContainer(name),
        retryFirstMs,
        retryCapMs,
      );
    }
    if (volumeCreated && homeOk) {
      const file = spoolFile('snapshot.tar.gz');
      for (;;) {
        await untilDone(
          `snapshotting desktop home ${volume}`,
          () => docker.snapshotHome(volume, spec.image, file),
          retryFirstMs,
          retryCapMs,
        );
        const upload = await untilDone(
          `uploading desktop home (job=${jobId})`,
          () => transport.uploadDesktopHome(jobId, file),
          retryFirstMs,
          retryCapMs,
        );
        if (upload.outcome === 'accepted') {
          home = 'accepted';
          break;
        }
        if (upload.outcome === 'discarded') {
          console.log(`[runner-agent] desktop ${jobId}: the Hub no longer wants this home`);
          home = 'discarded';
          break;
        }
        // Refused for good (413): resending can't help. Park: the container is
        // gone, the volume stays as the only copy, and the job stays held so
        // the Hub keeps owning it (it blocks starts on an older home, and a
        // profile delete waits for us to remove this copy). The Hub decides.
        const detail = `home snapshot refused by the Hub (${upload.detail}); kept on the runner as docker volume ${volume}`;
        console.error(`[runner-agent] desktop ${jobId}: ${detail}`);
        await untilDone(
          `reporting rejected desktop home (job=${jobId})`,
          () => transport.reportDesktopHomeRejected(jobId, detail),
          retryFirstMs,
          retryCapMs,
        );
        const decision = await awaitHomeDecision();
        if (decision === 'discard') {
          console.log(`[runner-agent] desktop ${jobId}: discarding the refused home`);
          home = 'discarded';
          break;
        }
        // `retry`: snapshot and upload again (an operator raised the cap).
      }
    }
    // The home is stored, or unwanted by the Hub. The volume still holds the
    // user's data (browser logins included), so its removal is retried until
    // done before the job finishes: finishing is what tells the Hub it's gone.
    if (volumeCreated) {
      await untilDone(
        `removing desktop volume ${volume}`,
        () => docker.removeVolume(volume),
        retryFirstMs,
        retryCapMs,
      );
    }
    // The spool holds a copy of the home; finishing lets the Hub treat this
    // desktop as gone, so it is removed (retried until done) first.
    const spool = tmp;
    if (spool) {
      await untilDone(
        `removing desktop spool ${spool}`,
        () => removeDir(spool),
        retryFirstMs,
        retryCapMs,
      );
    }
    // The finish is the Hub's only confirmation that this desktop is gone
    // (silence never counts), so it is retried until delivered, heartbeating
    // meanwhile. A 403/404 means the Hub no longer has this job as ours, so
    // there is nothing left to acknowledge.
    await untilDone(
      `finish (job=${jobId})`,
      async () => {
        try {
          await transport.postFinish(jobId, ready || error === 'stopped' ? 0 : 1, null);
        } catch (err) {
          if (/finish post failed: (403|404)\b/.test((err as Error).message)) return;
          throw err;
        }
      },
      retryFirstMs,
      retryCapMs,
    );
    clearInterval(heartbeat);
    clearInterval(watchdog);
    await protection.set(false).catch(() => {});
  }
  return { ready, error, home };
}
