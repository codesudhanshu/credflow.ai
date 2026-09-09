/**
 * Node parses a repeated header into an array. Anything we read is
 * single-valued by contract, so a repeated one is treated as absent rather
 * than silently taking the first — a request carrying two `Authorization`
 * headers is malformed, not ambiguous.
 */
export function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
