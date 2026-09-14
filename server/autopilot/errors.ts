export type AutopilotErrorCode =
  | 'server_disabled'
  | 'not_enabled'
  | 'invalid_config'
  | 'already_active'
  | 'no_active_run'
  | 'not_found'
  | 'not_paused'
  | 'run_stopped'
  | 'stale_generation'
  | 'stale_lease'
  | 'resume_revalidation_failed'
  | 'cancel_failed'
  | 'conflict';

export class AutopilotError extends Error {
  readonly code: AutopilotErrorCode;
  readonly httpStatus: number;

  constructor(code: AutopilotErrorCode, message: string, httpStatus?: number) {
    super(message);
    this.name = 'AutopilotError';
    this.code = code;
    this.httpStatus = httpStatus ?? statusForCode(code);
  }
}

function statusForCode(code: AutopilotErrorCode): number {
  switch (code) {
    case 'server_disabled':
    case 'not_enabled':
      return 403;
    case 'invalid_config':
      return 400;
    case 'not_found':
      return 404;
    case 'already_active':
    case 'no_active_run':
    case 'not_paused':
    case 'run_stopped':
    case 'stale_generation':
    case 'stale_lease':
    case 'resume_revalidation_failed':
    case 'cancel_failed':
    case 'conflict':
      return 409;
    default:
      return 400;
  }
}

export function isAutopilotError(err: unknown): err is AutopilotError {
  return err instanceof AutopilotError;
}
