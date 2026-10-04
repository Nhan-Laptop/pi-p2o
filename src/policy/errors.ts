export type PolicyErrorCode =
  | 'INVALID_INPUT' | 'EXPIRED' | 'NOT_YET_VALID' | 'IDENTITY_DENIED' | 'CAPABILITY_DENIED'
  | 'ACTION_DENIED' | 'TARGET_DENIED' | 'ACCOUNT_DENIED' | 'ADDRESS_DENIED' | 'DNS_CHANGED'
  | 'PEER_MISMATCH' | 'REDIRECT_DENIED' | 'BUDGET_EXCEEDED' | 'RATE_LIMITED'
  | 'CANCELLED' | 'TIMEOUT' | 'OUTPUT_LIMIT' | 'FILESYSTEM_DENIED' | 'UNAVAILABLE';

export class PolicyError extends Error {
  readonly code: PolicyErrorCode;
  constructor(code: PolicyErrorCode, message: string) {
    super(message);
    this.name = 'PolicyError';
    this.code = code;
  }
}
export function invariant(condition: unknown, code: PolicyErrorCode, message: string): asserts condition {
  if (!condition) throw new PolicyError(code, message);
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PolicyError('CANCELLED', 'Operation cancelled');
}
