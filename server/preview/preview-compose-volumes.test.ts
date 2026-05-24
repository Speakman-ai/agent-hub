import { describe, it, expect, vi } from 'vitest';
import {
  buildDockerVolumeLsByProjectArgs,
  buildDockerVolumeRmArgs,
  expectedComposeProjectVolumeNames,
  listComposeProjectVolumeNames,
  parseDockerVolumeLsOutput,
  removeComposeProjectVolumes,
} from './preview-compose-volumes.js';

describe('expectedComposeProjectVolumeNames', () => {
  it('derives docker volume names from compose project prefix', () => {
    expect(expectedComposeProjectVolumeNames('agenthub-session-abc')).toEqual([
      'agenthub-session-abc_preview-postgres-data',
      'agenthub-session-abc_preview-frontend-node-modules',
    ]);
  });
});

describe('parseDockerVolumeLsOutput', () => {
  it('splits newline-separated volume names', () => {
    expect(
      parseDockerVolumeLsOutput(
        'agenthub-session-x_preview-postgres-data\n\nagenthub-session-x_custom\n',
      ),
    ).toEqual(['agenthub-session-x_preview-postgres-data', 'agenthub-session-x_custom']);
  });
});

describe('listComposeProjectVolumeNames', () => {
  it('merges label query results with known suffix names', () => {
    const spawnSync = vi.fn().mockReturnValue({
      status: 0,
      stdout: 'agenthub-session-s1_extra-volume\n',
      stderr: '',
    });
    const names = listComposeProjectVolumeNames('agenthub-session-s1', spawnSync);
    expect(spawnSync).toHaveBeenCalledWith(
      'docker',
      buildDockerVolumeLsByProjectArgs('agenthub-session-s1'),
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(names).toContain('agenthub-session-s1_preview-postgres-data');
    expect(names).toContain('agenthub-session-s1_preview-frontend-node-modules');
    expect(names).toContain('agenthub-session-s1_extra-volume');
  });
});

describe('removeComposeProjectVolumes', () => {
  it('runs docker volume rm for each discovered name', () => {
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValue({ status: 0, stdout: '', stderr: '' });

    removeComposeProjectVolumes({
      composeProjectName: 'agenthub-session-rm',
      spawnSync,
    });

    const rmCalls = spawnSync.mock.calls.filter(
      (c) => c[1]?.[0] === 'volume' && c[1]?.[1] === 'rm',
    );
    expect(rmCalls).toHaveLength(2);
    expect(rmCalls[0][1]).toEqual(
      buildDockerVolumeRmArgs('agenthub-session-rm_preview-postgres-data'),
    );
    expect(rmCalls[1][1]).toEqual(
      buildDockerVolumeRmArgs('agenthub-session-rm_preview-frontend-node-modules'),
    );
  });

  it('logs and continues when volume rm fails', () => {
    const warn = vi.fn();
    const spawnSync = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
      .mockReturnValue({ status: 1, stdout: '', stderr: 'volume in use' });

    removeComposeProjectVolumes({
      composeProjectName: 'agenthub-session-fail',
      spawnSync,
      logger: { warn },
    });

    expect(warn).toHaveBeenCalled();
  });
});
