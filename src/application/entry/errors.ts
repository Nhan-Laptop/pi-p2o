/**
 * Entry-workflow failures.
 *
 * `EntryError` carries its own `code` and a bounded plain-text message: the interface's `publicError`
 * projection prints `code: message` (see `src/interface/presentation.ts`), so the message must NOT repeat
 * the code. Every refusal is explicit; there is no fabricated success path.
 */
export class EntryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'EntryError';
  }
}

export function entryFail(code: string, message: string): never {
  throw new EntryError(code, message);
}

/** Stable codes owned by the entry workflow. Interface-owned codes live in `/tmp/p2o-entry-contract.md`. */
export type EntryFailureCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_NOT_DIRECTORY'
  | 'TARGET_DENIED'
  | 'TARGET_TOO_LARGE'
  | 'REPO_CLONE_FAILED'
  | 'PLAN_NOT_FOUND'
  | 'ALREADY_APPROVED'
  | 'SCOPE_DIGEST_MISMATCH'
  | 'ENTRY_FAILED'
  | 'ENTRY_INTEGRATION_REQUIRED'
  | 'ENTRY_PLAN_AUTHOR_REQUIRED'
  | 'ENTRY_PLAN_INVALID'
  | 'ENTRY_PLAN_REJECTED'
  | 'ENTRY_GENERATED_REQUESTS_UNSUPPORTED'
  | 'ENTRY_OWNER_MENU_UNSUPPORTED'
  | 'ENTRY_UNSUPPORTED_CAPABILITY'
  | 'ENTRY_PLAN_CORRUPT'
  | 'ENTRY_RUN_UNKNOWN'
  | 'ENTRY_DELEGATION_BLOCKED'
  | 'ENTRY_DELEGATION_FAILED'
  | 'ENTRY_HUMAN_APPROVAL_REQUIRED'
  | 'ENTRY_APPROVAL_CONFLICT'
  | 'ENTRY_APPROVAL_WINDOW'
  | 'ENTRY_SOURCE_UNBOUND'
  | 'MODEL_PLAN_COMPLETION_TRUNCATED'
  | 'MODEL_PLAN_COMPLETION_EMPTY';

/** Bounded, control-character-free rendering of untrusted text (target names, stderr, author output). */
export function safeText(value: unknown, max = 300): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim();
}

/** Bounded digest of an untrusted error without leaking its body. */
export function errorDetail(error: unknown, max = 300): string {
  if (error instanceof EntryError) return `${error.code}: ${safeText(error.message, max)}`;
  if (error instanceof Error) {
    const code = typeof (error as unknown as { code?: unknown }).code === 'string' ? `${(error as unknown as { code: string }).code}: ` : '';
    return safeText(`${code}${error.message}`, max);
  }
  return safeText(String(error), max);
}
