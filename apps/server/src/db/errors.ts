/** A failure that no retry can fix (bad data, a broken invariant). */
export class PermanentError extends Error {}

/**
 * SQLSTATE classes that retrying cannot fix: data exceptions (22), integrity constraint
 * violations (23) and syntax or schema errors (42). Everything else (a lost connection, a
 * timeout, a deadlock, too many connections) may pass, so it is retried.
 */
const PERMANENT_SQLSTATE = /^(22|23|42)/;

export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof PermanentError) return true;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && PERMANENT_SQLSTATE.test(code);
}

/** A database error as a short log line: never the query, the parameters or the URL. */
export function describeDbError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${code} ${error.message}` : error.message;
  }
  return String(error);
}
