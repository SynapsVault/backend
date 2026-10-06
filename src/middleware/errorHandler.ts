import { Request, Response, NextFunction } from 'express';
import * as Sentry from '@sentry/node';
import { AppError } from '../errors/AppError';
import { logger } from '../utils/logger';

export interface ErrorResponse {
  error: {
    message: string;
    code: string;
    statusCode: number;
    details?: unknown;
  };
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestContext = {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    requestId: (req as Request & { id?: string }).id,
  };

  let statusCode = 500;
  let code = 'INTERNAL_SERVER_ERROR';
  let message = 'An unexpected error occurred';
  let details: unknown;

  if (err instanceof AppError) {
    statusCode = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof Error) {
    message = err.message || message;
  }

  const isServerError = statusCode >= 500;

  if (isServerError) {
    logger.error('Unhandled server error', {
      ...requestContext,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    Sentry.captureException(err, { extra: requestContext });
  } else {
    logger.warn('Client error', {
      ...requestContext,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (res.headersSent) {
    return;
  }

  const body: ErrorResponse = {
    error: {
      message,
      code,
      statusCode,
      ...(details !== undefined ? { details } : {}),
    },
  };

  res.status(statusCode).json(body);
}

export function notFoundHandler(req: Request, res: Response): void {
  const requestContext = {
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    requestId: (req as Request & { id?: string }).id,
  };

  logger.warn('Route not found', requestContext);

  const body: ErrorResponse = {
    error: {
      message: `Route ${req.method} ${req.originalUrl} not found`,
      code: 'NOT_FOUND',
      statusCode: 404,
    },
  };

  res.status(404).json(body);
}