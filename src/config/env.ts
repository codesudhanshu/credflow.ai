import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  /** Leave unset to boot an in-process MongoDB (see src/db/client.ts). */
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DB: z.string().min(1).default('usage_platform'),

  /** Base for endpoint_url, so the URL we hand out is actually callable. */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),

  PROVISIONING_MS: z.coerce.number().int().nonnegative().default(10_000),
  SWEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_STORE: z.enum(['mongo', 'memory']).default('mongo'),

  DEMO_ACCOUNT_KEY: z.string().min(1).default('demo-account-key'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parses and validates configuration once, at boot. A misconfigured process
 * should refuse to start rather than fail on the first request that needs the
 * bad value.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${detail}`);
}
