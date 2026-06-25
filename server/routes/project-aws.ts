/**
 * Per-project AWS profile config + interactive SSO login helpers.
 *
 *   GET  /api/projects/:projectId/aws-profiles
 *   PUT  /api/projects/:projectId/aws-profiles
 *   GET  /api/projects/:projectId/aws-sso/status?profile=<name>
 *   POST /api/projects/:projectId/aws-sso/login  { profile }
 */
import { Router, Request, Response } from 'express';
import { requireRole } from '../roles.js';
import type { RouteDeps, Project } from '../types.js';
import config, { buildSpawnEnv } from '../config.js';
import { trackChild, killProcessGroup } from '../process-groups.js';
import {
  validateProjectAwsSsoProfiles,
  ProjectAwsProfileValidationError,
  isProjectAwsStaticProfile,
  type ProjectAwsSsoProfilesMap,
} from '../project-aws-profiles.js';
import { writeProjectAwsFiles } from '../project-aws-config-file.js';
import { getProjectAwsSsoProfiles, scrubAwsCredentialEnv } from '../project-aws-spawn.js';
import {
  checkAwsSsoStatusAcrossHomes,
  runAwsStsIdentity,
  spawnAwsSsoLogin,
} from '../aws-sso-identity.js';
import { resolveAwsProbeUserId } from '../aws-sso-caller-identity.js';
import { extractAwsSsoLoginUrl } from '../aws-sso-login-parse.js';
import {
  getActiveAwsSsoLogin,
  setActiveAwsSsoLogin,
  clearActiveAwsSsoLogin,
  clearActiveAwsSsoLoginIfOwner,
} from '../aws-sso-active-login.js';

type ProjectWithAws = Project & { awsSsoProfiles?: ProjectAwsSsoProfilesMap };

function resolveProfileName(project: ProjectWithAws, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new ProjectAwsProfileValidationError('profile is required');
  }
  const name = raw.trim();
  const profiles = getProjectAwsSsoProfiles(project);
  if (!profiles[name]) {
    throw new ProjectAwsProfileValidationError(
      `unknown profile "${name}" — configured: ${Object.keys(profiles).join(', ') || '(none)'}`,
    );
  }
  return name;
}

function awsSpawnEnv(
  userId: string | null,
  files: { configPath: string; credentialsPath: string },
): NodeJS.ProcessEnv {
  const env = buildSpawnEnv(config, { userId });
  scrubAwsCredentialEnv(env);
  env.AWS_CONFIG_FILE = files.configPath;
  env.AWS_SHARED_CREDENTIALS_FILE = files.credentialsPath;
  return env;
}

// Active-login slot state lives in `../aws-sso-active-login.js` so the
// identity-guard semantics can be unit-tested without standing up the
// route stack.

export default function createProjectAwsRoutes(deps: RouteDeps): Router {
  const { findProject, saveProjects, stmts, findAgent } = deps;
  const router = Router();

  router.get(
    '/api/projects/:projectId/aws-profiles',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string) as ProjectWithAws | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ profiles: getProjectAwsSsoProfiles(project) });
    },
  );

  router.put(
    '/api/projects/:projectId/aws-profiles',
    requireRole('Owner'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string) as ProjectWithAws | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const profiles = validateProjectAwsSsoProfiles(body.profiles);
        if (Object.keys(profiles).length === 0) {
          delete project.awsSsoProfiles;
        } else {
          project.awsSsoProfiles = profiles;
        }
        saveProjects();
        writeProjectAwsFiles(project.id, profiles);
        res.json({ profiles });
      } catch (err) {
        if (err instanceof ProjectAwsProfileValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.get(
    '/api/projects/:projectId/aws-sso/status',
    requireRole('Admin'),
    async (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string) as ProjectWithAws | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const profiles = getProjectAwsSsoProfiles(project);
      if (Object.keys(profiles).length === 0) {
        res.status(400).json({ error: 'Project has no AWS profiles configured' });
        return;
      }
      try {
        const profile = resolveProfileName(project, req.query.profile);
        const userId = resolveAwsProbeUserId(req, { stmts, findAgent, projectId: project.id });
        const files = writeProjectAwsFiles(project.id, profiles);
        const configuredProfile = profiles[profile];
        if (isProjectAwsStaticProfile(configuredProfile)) {
          const out = await runAwsStsIdentity(awsSpawnEnv(userId, files), profile);
          if (out.ok) {
            res.json({
              profile,
              loggedIn: true,
              credentialType: 'static',
              account: out.account,
              arn: out.arn,
              userId: out.userId,
            });
            return;
          }
          res.json({
            profile,
            loggedIn: false,
            credentialType: 'static',
            error: out.error,
            needsLogin: false,
          });
          return;
        }
        const out = await checkAwsSsoStatusAcrossHomes({
          userId,
          configPath: files.configPath,
          credentialsPath: files.credentialsPath,
          profile,
        });
        if (out.ok) {
          res.json({
            profile,
            loggedIn: true,
            credentialType: 'sso',
            account: out.account,
            arn: out.arn,
            userId: out.userId,
            homeSource: out.homeSource,
          });
          return;
        }
        res.json({
          profile,
          loggedIn: false,
          credentialType: 'sso',
          error: out.error,
          needsLogin: out.needsLogin,
          homeSource: out.homeSource,
        });
      } catch (err) {
        if (err instanceof ProjectAwsProfileValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }
    },
  );

  router.post(
    '/api/projects/:projectId/aws-sso/login',
    requireRole('Admin'),
    (req: Request, res: Response) => {
      const project = findProject(req.params.projectId as string) as ProjectWithAws | undefined;
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const profiles = getProjectAwsSsoProfiles(project);
      if (Object.keys(profiles).length === 0) {
        res.status(400).json({ error: 'Project has no AWS profiles configured' });
        return;
      }

      let profile: string;
      try {
        profile = resolveProfileName(project, (req.body as Record<string, unknown>)?.profile);
        if (isProjectAwsStaticProfile(profiles[profile])) {
          res.status(400).json({
            error: `profile "${profile}" uses static credentials; SSO login is not supported`,
          });
          return;
        }
      } catch (err) {
        if (err instanceof ProjectAwsProfileValidationError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        throw err;
      }

      const existing = getActiveAwsSsoLogin();
      if (existing) {
        try {
          killProcessGroup(existing.proc, 'SIGTERM');
        } catch {
          /* already dead */
        }
        // Clear the slot eagerly so the upcoming spawn registers cleanly.
        // The deferred `close` handler for `existing.proc` will see a
        // different proc in the slot and skip the redundant reset via
        // the identity guard.
        clearActiveAwsSsoLogin();
      }

      const userId = resolveAwsProbeUserId(req, { stmts, findAgent, projectId: project.id });
      const files = writeProjectAwsFiles(project.id, profiles);
      const env = awsSpawnEnv(userId, files);
      const loginId = Date.now().toString(36);

      const proc = spawnAwsSsoLogin(env, profile);
      trackChild(proc);

      setActiveAwsSsoLogin({ loginId, proc, projectId: project.id, profile });

      let allOutput = '';
      let urlSent = false;
      let responded = false;

      const finish = (payload: Record<string, unknown>, status = 200): void => {
        if (responded) return;
        responded = true;
        res.status(status).json(payload);
      };

      const sendUrl = (url: string): void => {
        if (responded) return;
        urlSent = true;
        finish({ ok: true, loginId, profile, loginUrl: url });
      };

      const onData = (chunk: Buffer): void => {
        allOutput += chunk.toString();
        if (!urlSent) {
          const url = extractAwsSsoLoginUrl(allOutput);
          if (url) sendUrl(url);
        }
      };

      proc.stdout?.on('data', onData);
      proc.stderr?.on('data', onData);

      proc.on('close', (code) => {
        clearActiveAwsSsoLoginIfOwner(proc);
        if (responded) return;
        if (code === 0) {
          finish({ ok: true, loginId, profile, completed: true, output: allOutput.slice(-2000) });
          return;
        }
        finish(
          {
            ok: false,
            loginId,
            profile,
            error: allOutput.trim().slice(-500) || `aws sso login exited ${code}`,
          },
          500,
        );
      });

      proc.on('error', (err) => {
        clearActiveAwsSsoLoginIfOwner(proc);
        finish({ ok: false, loginId, profile, error: err.message }, 500);
      });

      setTimeout(() => {
        if (responded) return;
        const url = extractAwsSsoLoginUrl(allOutput);
        if (url) {
          sendUrl(url);
          return;
        }
        // No URL surfaced after 30 s — the `aws` child is still running
        // and will keep waiting on device auth indefinitely. Kill it (and
        // clear the slot if we still own it) so we don't leak processes
        // or block the next login attempt behind a dead URL extractor.
        try {
          killProcessGroup(proc, 'SIGTERM');
        } catch {
          /* already dead */
        }
        clearActiveAwsSsoLoginIfOwner(proc);
        finish({
          ok: false,
          loginId,
          profile,
          error: 'Timed out waiting for AWS SSO device URL',
          output: allOutput.slice(-1000),
        });
      }, 30_000);
    },
  );

  return router;
}
