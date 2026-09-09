import { z } from 'zod';

export const CompletionParams = z.object({
  deployment_id: z.string().min(1),
});

export const CompletionBody = z.object({
  prompt: z.string().min(1, 'prompt must be a non-empty string'),
});

/** `Authorization: Bearer <key>` — anything else is treated as no credential. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
