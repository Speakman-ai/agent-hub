import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import config from './config.js';
import {
  renderProjectAwsCredentialsIni,
  renderProjectAwsConfigIni,
  resolveAmbientCredentialSource,
  type ProjectAwsSsoProfilesMap,
} from './project-aws-profiles.js';

export interface ProjectAwsFiles {
  configPath: string;
  credentialsPath: string;
}

/**
 * Write (or refresh) the project-scoped AWS config file and return its path.
 * Mode 0600 — contains SSO portal URLs and account ids, not SSO tokens.
 */
export function writeProjectAwsFiles(
  projectId: string,
  profiles: ProjectAwsSsoProfilesMap,
): ProjectAwsFiles {
  const dir = path.join(config.dataDir, 'project-aws-config', projectId);
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config');
  const credentialsPath = path.join(dir, 'credentials');
  // Resolved per write, not cached: the Hub's ambient credential shape can
  // change across a restart (moved to ECS, gained an instance profile) and the
  // files are rewritten on every spawn anyway.
  writeFileSync(
    configPath,
    renderProjectAwsConfigIni(profiles, {
      defaultCredentialSource: resolveAmbientCredentialSource(process.env),
    }),
    { encoding: 'utf-8', mode: 0o600 },
  );
  writeFileSync(credentialsPath, renderProjectAwsCredentialsIni(profiles), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return { configPath, credentialsPath };
}

/** @deprecated Use writeProjectAwsFiles when configuring a spawn. */
export function writeProjectAwsConfigFile(
  projectId: string,
  profiles: ProjectAwsSsoProfilesMap,
): string {
  return writeProjectAwsFiles(projectId, profiles).configPath;
}
