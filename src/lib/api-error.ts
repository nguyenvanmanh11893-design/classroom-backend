import type { ErrorRequestHandler, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';

export type ErrorParams = Record<string, string | number | boolean | null>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly params: ErrorParams = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const supplied = req.header('x-request-id');
  req.requestId = supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied)
    ? supplied
    : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new ApiError(404, 'ROUTE_NOT_FOUND', 'Route not found', { path: req.path }));
};

export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  let apiError: ApiError;

  if (error instanceof ApiError) {
    apiError = error;
  } else if (error instanceof ZodError) {
    apiError = new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', {
      field: error.issues[0]?.path.join('.') || 'request',
    });
  } else if (error instanceof SyntaxError && 'body' in error) {
    apiError = new ApiError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  } else if (isPostgresConstraint(error, '23505')) {
    apiError = new ApiError(409, 'UNIQUE_CONSTRAINT', 'A record with this value already exists');
  } else if (isPostgresConstraint(error, '23503') || isPostgresConstraint(error, '23001')) {
    apiError = new ApiError(409, 'REFERENCE_IN_USE', 'The record is still referenced');
  } else {
    console.error(`[${req.requestId}] Unhandled API error`, error);
    apiError = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong');
  }

  res.status(apiError.status).json({
    error: {
      code: apiError.code,
      params: apiError.params,
      message: apiError.message,
    },
    message: apiError.message,
    requestId: req.requestId,
  });
};

/** Drizzle may wrap the pg error in `cause`; do not depend on its concrete class. */
function isPostgresConstraint(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    if ('code' in current && (current as { code?: unknown }).code === code) return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
