import type { RequestHandler } from 'express';
import { newId } from '../../ids.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Correlation id, echoed in every response and in every error body.
       *
       * Deliberately not called `id`: pino-http declares `req.id` as
       * `string | number`, and augmenting that name would widen ours to the
       * same union everywhere it is read. Keeping a separate field means the
       * type stays `string` and pino still gets the same value via genReqId.
       */
      requestId: string;
    }
  }
}

/**
 * Honours a caller-supplied `x-request-id` so a client's own correlation id
 * survives into our logs, and generates one otherwise. Must be registered
 * before anything that logs or formats an error.
 */
export const requestId: RequestHandler = (req, res, next) => {
  const supplied = req.headers['x-request-id'];
  req.requestId =
    typeof supplied === 'string' && supplied.length > 0 ? supplied : newId('req', 12);
  res.setHeader('x-request-id', req.requestId);
  next();
};
