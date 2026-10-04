export class PolicyError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'PolicyError';
        this.code = code;
    }
}
export function invariant(condition, code, message) {
    if (!condition)
        throw new PolicyError(code, message);
}
export function checkCancelled(signal) {
    if (signal?.aborted)
        throw new PolicyError('CANCELLED', 'Operation cancelled');
}
