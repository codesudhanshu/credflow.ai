import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { AppError } from '../domain/errors.js';

interface ErrorBody {
  error: { code: string; message: string; request_id: string };
}

function body(code: string, message: string, requestId: string): ErrorBody {
  return { error: { code, message, request_id: requestId } };
}

/**
 * One place that turns any thrown value into the documented error envelope.
 * Routes and services therefore only ever throw — they never format a failure.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    const requestId = String(req.id);

    if (err instanceof AppError) {
      for (const [name, value] of Object.entries(err.headers)) {
        void reply.header(name, value);
      }
      void reply.code(err.statusCode).send(body(err.code, err.message, requestId));
      return;
    }

    if (err instanceof ZodError) {
      const detail = err.issues
        .map((issue) => `${issue.path.join('.') || '(body)'}: ${issue.message}`)
        .join('; ');
      void reply.code(400).send(body('validation_failed', detail, requestId));
      return;
    }

    // Malformed JSON and other Fastify-level parse failures. TypeScript has
    // narrowed `err` past the two classes above, so read the shape explicitly.
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      const message = err instanceof Error ? err.message : 'Invalid request.';
      void reply.code(statusCode).send(body('validation_failed', message, requestId));
      return;
    }

    req.log.error({ err }, 'unhandled error');
    void reply.code(500).send(body('internal_error', 'Unexpected server error.', requestId));
  });

  app.setNotFoundHandler((req, reply) => {
    void reply
      .code(404)
      .send(body('not_found', `Route ${req.method} ${req.url} not found.`, String(req.id)));
  });
}
