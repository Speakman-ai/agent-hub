/**
 * Unit tests for `writeProjectAwsConfigFile()`.
 *
 * The file this writes is injected into every SSO-enabled session spawn as
 * `AWS_CONFIG_FILE`, so the contract (path layout, INI content, mode 0600)
 * is load-bearing — a silent regression here would misconfigure every
 * spawned agent.
 *
 * `config.dataDir` is per-test-file random under `os.tmpdir()` (see
 * `test/setup.ts`), so we can call the function directly and read back
 * from inside the test data dir without any extra plumbing.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import config from './config.js';
import { writeProjectAwsConfigFile } from './project-aws-config-file.js';
import {
  renderProjectAwsConfigIni,
  type ProjectAwsSsoProfilesMap,
} from './project-aws-profiles.js';

const SAMPLE: ProjectAwsSsoProfilesMap = {
  dev: {
    sso_account_id: '120569607241',
    sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
    sso_region: 'us-east-2',
    sso_role_name: 'AdministratorAccess',
    region: 'us-east-2',
  },
  prod: {
    sso_account_id: '999988887777',
    sso_start_url: 'https://d-9a670b4c46.awsapps.com/start/',
    sso_region: 'us-east-2',
    sso_role_name: 'ReadOnlyAccess',
    region: 'us-east-1',
    output: 'yaml',
  },
};

function freshProjectId(): string {
  return `aws-cfgfile-${uuidv4().slice(0, 8)}`;
}

describe('writeProjectAwsConfigFile', () => {
  beforeEach(() => {
    // Defence-in-depth: every test runs against a fresh tmp data dir, but
    // ensure the path the function will use does not exist before we call
    // it. (The test/setup.ts random suffix already guarantees this, but
    // an explicit clean baseline makes the assertions unambiguous.)
    expect(config.dataDir.startsWith(os.tmpdir())).toBe(true);
  });

  it('creates the file at <dataDir>/project-aws-config/<projectId>/config and returns its path', () => {
    const projectId = freshProjectId();
    const expectedDir = path.join(config.dataDir, 'project-aws-config', projectId);

    // Sanity: the parent dir does not exist yet.
    expect(existsSync(expectedDir)).toBe(false);

    const returned = writeProjectAwsConfigFile(projectId, SAMPLE);

    expect(returned).toBe(path.join(expectedDir, 'config'));
    expect(existsSync(returned)).toBe(true);
  });

  it('writes the INI rendering of the profile map verbatim', () => {
    const projectId = freshProjectId();
    const configPath = writeProjectAwsConfigFile(projectId, SAMPLE);
    const actual = readFileSync(configPath, 'utf-8');
    const expected = renderProjectAwsConfigIni(SAMPLE);
    expect(actual).toBe(expected);
    // Anchored sanity checks — if `renderProjectAwsConfigIni` ever drops
    // the `profile ` prefix or stops sorting, AWS CLI would silently fall
    // back to the default profile (a security-relevant misconfig).
    expect(actual).toContain('[profile dev]');
    expect(actual).toContain('[profile prod]');
    expect(actual.indexOf('[profile dev]')).toBeLessThan(actual.indexOf('[profile prod]'));
    expect(actual).toContain('sso_account_id = 120569607241');
    expect(actual).toContain('output = yaml');
    // `dev` omitted `output`, so the renderer must default it to `json`.
    expect(actual).toContain('output = json');
  });

  it('writes the file with mode 0o600 (owner read/write only)', () => {
    const projectId = freshProjectId();
    const configPath = writeProjectAwsConfigFile(projectId, SAMPLE);
    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is idempotent — a second call overwrites the previous content', () => {
    const projectId = freshProjectId();
    const path1 = writeProjectAwsConfigFile(projectId, SAMPLE);
    const initial = readFileSync(path1, 'utf-8');
    expect(initial).toContain('[profile prod]');

    const trimmed: ProjectAwsSsoProfilesMap = { dev: SAMPLE.dev };
    const path2 = writeProjectAwsConfigFile(projectId, trimmed);

    expect(path2).toBe(path1);
    const after = readFileSync(path2, 'utf-8');
    expect(after).toBe(renderProjectAwsConfigIni(trimmed));
    expect(after).toContain('[profile dev]');
    expect(after).not.toContain('[profile prod]');
    // Mode must survive an overwrite — fs.writeFileSync re-applies the
    // mode arg on every call, but a regression that drops the option
    // would silently leave the file world-readable on first creation
    // and only catch the missing flag on the second pass.
    expect(statSync(path2).mode & 0o777).toBe(0o600);
  });

  it('does not throw when the parent directory already exists (mkdir recursive=true)', () => {
    const projectId = freshProjectId();
    const dir = path.join(config.dataDir, 'project-aws-config', projectId);
    mkdirSync(dir, { recursive: true });
    // Drop a sentinel inside the dir so we can prove the mkdir didn't
    // wipe it — `recursive: true` should be a no-op on an existing dir.
    const sentinel = path.join(dir, 'sentinel.txt');
    writeFileSync(sentinel, 'preexisting');

    expect(() => writeProjectAwsConfigFile(projectId, SAMPLE)).not.toThrow();
    expect(readFileSync(sentinel, 'utf-8')).toBe('preexisting');
    expect(existsSync(path.join(dir, 'config'))).toBe(true);
  });

  it('isolates writes by projectId', () => {
    const projectA = freshProjectId();
    const projectB = freshProjectId();
    const pathA = writeProjectAwsConfigFile(projectA, SAMPLE);
    const pathB = writeProjectAwsConfigFile(projectB, { dev: SAMPLE.dev });
    expect(pathA).not.toBe(pathB);
    expect(readFileSync(pathA, 'utf-8')).toContain('[profile prod]');
    expect(readFileSync(pathB, 'utf-8')).not.toContain('[profile prod]');
  });
});
