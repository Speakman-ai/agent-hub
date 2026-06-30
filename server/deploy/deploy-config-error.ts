/**
 * deploy-config-error.ts — shared error type for deploy.yaml parsing.
 *
 * Extracted from `deploy-config.ts` so `github-workflow-step.ts` can throw the
 * same typed error without importing `deploy-config.ts` (which imports the
 * workflow-step module — extracting the error breaks that cycle). `reason` is a
 * stable machine code the REST layer maps to specific HTTP responses.
 */
export class DeployConfigError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'DeployConfigError';
    this.reason = reason;
  }
}
