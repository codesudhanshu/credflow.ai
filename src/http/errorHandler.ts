import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors.js';
import type { Logger } from '../logger.js';

interface ErrorBody {
  error: { code: string; message: string; request_id: string };
}

function body(code: string, message: string, requestId: string): ErrorBody {
  return { error: { code, message, request_id: requestId } };
}

/**
 * Registered last, after every route. Express 5 forwards a rejected promise
 * from an async handler here on its own, so route handlers only ever throw —
 * they never format a failure and never call next(err) by hand. (Express 4
 * would have needed a wrapper around every async handler; the whole rejection
 * matrix in the test suite is what proves this works.)
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    const requestId = req.requestId;

    if (err instanceof AppError) {
      for (const [name, value] of Object.entries(err.headers)) {
        res.setHeader(name, value);
      }
      res.status(err.statusCode).json(body(err.code, err.message, requestId));
      return;
    }

    if (err instanceof ZodError) {
      const detail = err.issues
        .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
        .join('; ');
      res.status(400).json(body('validation_failed', detail, requestId));
      return;
    }

    // Malformed JSON from express.json() and other body-parser failures arrive
    // with a 4xx status already attached.
    const status = (err as { status?: unknown; statusCode?: unknown }).status ??
      (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : 'Invalid request.';
      res.status(status).json(body('validation_failed', message, requestId));
      return;
    }

    logger.error({ err, request_id: requestId }, 'unhandled error');
    res.status(500).json(body('internal_error', 'Unexpected server error.', requestId));
  };
}

/** Registered after the routes but before the error handler. */
export const notFoundHandler: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(body('not_found', `Route ${req.method} ${req.originalUrl} not found.`, req.requestId));
};
