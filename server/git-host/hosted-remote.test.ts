import { describe, expect, it } from 'vitest';
import { isHostedRepoUrl } from './hosted-remote.js';

const opts = {
  barePath: '/data/git/proj.git',
  baseUrls: ['https://hub.example.com', 'http://127.0.0.1:3051', 'https://corp.example/hub'],
};

describe('isHostedRepoUrl', () => {
  it.each([
    '/data/git/proj.git',
    'file:///data/git/proj.git',
    'https://hub.example.com/git/proj.git',
    'https://agent-hub:key@hub.example.com/git/proj.git',
    'http://127.0.0.1:3051/git/proj.git',
    'https://corp.example/hub/git/proj.git',
  ])('accepts %s', (url) => {
    expect(isHostedRepoUrl(url, 'proj', opts)).toBe(true);
  });

  it.each([
    // Right path, unrelated host.
    'https://other-host.example/git/proj.git',
    'https://hub.example.com.evil.test/git/proj.git',
    // Right host, wrong port or scheme.
    'http://127.0.0.1:9/git/proj.git',
    'http://hub.example.com/git/proj.git',
    // Right host, wrong repo or prefix.
    'https://hub.example.com/git/other.git',
    'https://hub.example.com/x/git/proj.git',
    'https://corp.example/git/proj.git',
    'https://hub.example.com/git/proj.git?x=1',
    // Other local repos.
    '/data/git/other.git',
    'relative/proj.git',
    'file://remote-host/data/git/proj.git',
    'ssh://hub.example.com/git/proj.git',
    '',
  ])('rejects %j', (url) => {
    expect(isHostedRepoUrl(url, 'proj', opts)).toBe(false);
  });
});
