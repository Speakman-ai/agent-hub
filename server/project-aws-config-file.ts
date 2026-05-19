import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import config from './config.js';
import {
  renderProjectAwsConfigIni,
  type ProjectAwsSsoProfilesMap,
} from './project-aws-profiles.js';

/**
 * Write (or refresh) the project-scoped AWS config file and return its path.
 * Mode 0600 — contains SSO portal URLs and account ids, not session tokens.
 */
export function writeProjectAwsConfigFile(
  projectId: string,
  profiles: ProjectAwsSsoProfilesMap,
): string {
  const dir = path.join(config.dataDir, 'project-aws-config', projectId);
  mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config');
  writeFileSync(configPath, renderProjectAwsConfigIni(profiles), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return configPath;
}
