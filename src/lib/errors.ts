export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL_ERROR';

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  status?: number;
  details?: unknown;
  requestId?: string;
  cause?: unknown;
}

const DEFAULT_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = 'AppError';
    this.code = options.code;
    this.status = options.status ?? DEFAULT_STATUS[options.code];
    this.details = options.details;
    this.requestId = options.requestId;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
    Object.setPrototypeOf(this, AppError.prototype);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError({ code: 'VALIDATION_ERROR', message, details });
  }

  static notFound(message = 'Resource not found', details?: unknown): AppError {
    return new AppError({ code: 'NOT_FOUND', message, details });
  }

  static unauthorized(message = 'Unauthorized', details?: unknown): AppError {
    return new AppError({ code: 'UNAUTHORIZED', message, details });
  }

  static forbidden(message = 'Forbidden', details?: unknown): AppError {
    return new AppError({ code: 'FORBIDDEN', message, details });
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError({ code: 'CONFLICT', message, details });
  }

  static rateLimited(message = 'Too many requests', details?: unknown): AppError {
    return new AppError({ code: 'RATE_LIMITED', message, details });
  }

  static upstream(message = 'Upstream service error', details?: unknown): AppError {
    return new AppError({ code: 'UPSTREAM_ERROR', message, details });
  }

  static internal(message = 'Internal server error', details?: unknown): AppError {
    return new AppError({ code: 'INTERNAL_ERROR', message, details });
  }

  toJSON(): ErrorResponseBody {
    return serializeError(this);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

export function serializeError(
  error: unknown,
  requestId?: string,
): ErrorResponseBody {
  if (isAppError(error)) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
        ...(error.requestId ?? requestId
          ? { requestId: error.requestId ?? requestId }
          : {}),
      },
    };
  }

  const message =
    error instanceof Error ? error.message : 'Internal server error';

  return {
    error: {
      code: 'INTERNAL_ERROR',
      message,
      ...(requestId ? { requestId } : {}),
    },
  };
}

export function getStatusCode(error: unknown): number {
  return isAppError(error) ? error.status : DEFAULT_STATUS.INTERNAL_ERROR;
}
</｜｜DSML｜｜ parameter>