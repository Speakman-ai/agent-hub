import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { createHomeSpools } from './desktop-home-spool.js';

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'home-spool-'));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('desktop home spools', () => {
  it('a spool whose removal fails stays findable and the next sweep removes it', async () => {
    const root = path.join(base, 'spool');
    let failNext = true;
    const spools = createHomeSpools(root, async (dir) => {
      if (failNext) {
        failNext = false;
        throw new Error('EBUSY');
      }
      await rm(dir, { recursive: true, force: true });
    });
    const { dir, close } = await spools.open();
    writeFileSync(path.join(dir, 'home.tar.gz'), 'browser logins');
    await close();
    expect(existsSync(dir)).toBe(true);
    expect(await spools.sweep()).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  it('never sweeps a spool in use', async () => {
    const spools = createHomeSpools(path.join(base, 'spool'));
    const busy = await spools.open();
    expect(await spools.sweep()).toBe(0);
    expect(existsSync(busy.dir)).toBe(true);
    await busy.close();
    expect(existsSync(busy.dir)).toBe(false);
  });

  it('after a restart, every spool left under the root is swept', async () => {
    const root = path.join(base, 'spool');
    mkdirSync(path.join(root, 'xfer-from-before'), { recursive: true });
    writeFileSync(path.join(root, 'xfer-from-before', 'home.tar.gz'), 'copy');
    const fresh = createHomeSpools(root);
    expect(await fresh.sweep()).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  it('reports spools it still cannot remove', async () => {
    const root = path.join(base, 'spool');
    mkdirSync(path.join(root, 'stuck'), { recursive: true });
    const spools = createHomeSpools(root, async () => {
      throw new Error('EACCES');
    });
    expect(await spools.sweep()).toBe(1);
    expect(await createHomeSpools(path.join(base, 'missing')).sweep()).toBe(0);
  });
});
