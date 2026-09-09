import { pino, type Logger } from 'pino';
import type { Env } from './config/env.js';

export type { Logger };

/**
 * Fastify ships pino wired up; Express does not, so the logger is created here
 * and passed to whatever needs it. Nothing reaches for a module-level logger.
 */
export function createLogger(env: Env): Logger {
  return pino({ level: env.LOG_LEVEL });
}
