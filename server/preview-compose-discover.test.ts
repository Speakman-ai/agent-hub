import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { discoverComposeFiles, inferMonorepo } from './preview-compose-discover.js';

describe('discoverComposeFiles', () => {
  it('finds root and apps/* compose files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-discover-'));
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      ['services:', '  web:', '    image: nginx', '    ports:', '      - "3000:80"'].join('\n'),
    );
    mkdirSync(path.join(dir, 'apps', 'api'), { recursive: true });
    writeFileSync(
      path.join(dir, 'apps', 'api', 'docker-compose.yml'),
      ['services:', '  api:', '    image: node:22', '    ports:', '      - "4000:4000"'].join('\n'),
    );
    const found = discoverComposeFiles(dir);
    expect(found.length).toBe(2);
    expect(found.some((f) => f.file === 'docker-compose.yml')).toBe(true);
    expect(found.some((f) => f.file.includes('apps/api'))).toBe(true);
    expect(inferMonorepo(dir, found)).toBe(true);
  });

  it('finds compose.preview.yml and ranks it before docker-compose.yml', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ah-discover-preview-'));
    writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      ['services:', '  web:', '    image: nginx', '    ports:', '      - "3000:80"'].join('\n'),
    );
    writeFileSync(
      path.join(dir, 'compose.preview.yml'),
      ['services:', '  frontend:', '    image: node:22', '    ports:', '      - "4200:4200"'].join(
        '\n',
      ),
    );
    const found = discoverComposeFiles(dir);
    expect(found.map((f) => f.file)).toEqual(['compose.preview.yml', 'docker-compose.yml']);
    expect(found[0].suggestedEntryService).toBe('frontend');
  });
});
