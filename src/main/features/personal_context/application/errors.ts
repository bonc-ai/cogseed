import type { DashboardAction, SerializedPersonalContextError } from './types';

export type PersonalContextErrorStage = 'authorization' | 'discovery' | 'sync' | 'review' | 'briefing' | 'delivery' | 'migration';

export class PersonalContextError extends Error {
  readonly stage: PersonalContextErrorStage;
  readonly code: string;
  readonly messageKey: string;
  readonly recoverable: boolean;
  readonly retryAction?: DashboardAction;

  constructor(
    stage: PersonalContextErrorStage,
    code: string,
    messageKey: string,
    options: Readonly<{
      recoverable?: boolean;
      retryAction?: DashboardAction;
      cause?: Error;
      message?: string;
    }> = {},
  ) {
    super(options.message || code, options.cause ? { cause: options.cause } : undefined);
    this.name = 'PersonalContextError';
    this.stage = stage;
    this.code = code;
    this.messageKey = messageKey;
    this.recoverable = options.recoverable ?? false;
    this.retryAction = options.retryAction;
  }
}

function redactMessage(value: string): string {
  return value
    .replace(/(?:access[_-]?token|refresh[_-]?token|app[_-]?secret|client[_-]?secret)\s*[=:]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, 'Bearer [redacted]')
    .slice(0, 500);
}

export function serializePersonalContextError(error: PersonalContextError | Error): SerializedPersonalContextError {
  if (error instanceof PersonalContextError) {
    const cause = error.cause instanceof Error ? redactMessage(error.cause.message) : undefined;
    return {
      stage: error.stage,
      code: error.code,
      messageKey: error.messageKey,
      recoverable: error.recoverable,
      ...(error.retryAction ? { retryAction: error.retryAction } : {}),
      ...(cause ? { causeMessage: cause } : {}),
    };
  }
  return {
    stage: 'migration',
    code: 'internal_error',
    messageKey: 'personal_context.error.internal',
    recoverable: false,
    causeMessage: redactMessage(error.message),
  };
}
