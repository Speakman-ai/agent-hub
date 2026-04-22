#!/usr/bin/env node
import { assertClientTestDepsInstalled } from '../src/utils/assertClientTestDeps.js';

try {
  assertClientTestDepsInstalled();
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
