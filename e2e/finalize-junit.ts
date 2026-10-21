import path from 'path';
import type { ReporterDescription } from '@playwright/test';

/**
 * JUnit for the Finalize test inventory (dynamic test selection). The runner
 * injects FINALIZE_JUNIT_DIR per job instance; outside Finalize this is a no-op.
 */
export function finalizeJunitReporter(
  report: string,
  env: Record<string, string | undefined> = process.env,
): ReporterDescription[] {
  const dir = env.FINALIZE_JUNIT_DIR;
  if (!dir) return [];
  return [['junit', { outputFile: path.join(dir, `${report}.xml`) }]];
}
