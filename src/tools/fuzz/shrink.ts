import { invariant } from '../../policy/errors.js';

/**
 * Deterministic deletion-based minimizer (ddmin-lite). It repeatedly removes contiguous chunks, from
 * half the input down to single bytes, and keeps a removal only while the failure still reproduces.
 * The final single-byte pass makes the result 1-minimal: no further single-byte deletion reproduces.
 * No PRNG is involved, so the minimal reproducer is a pure function of the failing input.
 */
export interface ShrinkResult {
  readonly bytes: Uint8Array;
  readonly steps: number;
  readonly initialBytes: number;
}

export interface ShrinkOptions {
  readonly maxSteps: number;
  /** Absolute epoch milliseconds after which minimization stops and returns the last reproducer. */
  readonly deadline: number;
  readonly now?: () => number;
}

function without(bytes: Uint8Array, start: number, length: number): Uint8Array {
  const result = new Uint8Array(bytes.length - length);
  result.set(bytes.subarray(0, start), 0);
  result.set(bytes.subarray(start + length), start);
  return result;
}

export function minimize(initial: Uint8Array, fails: (candidate: Uint8Array) => boolean, options: ShrinkOptions): ShrinkResult {
  invariant(initial.length <= 1048576, 'INVALID_INPUT', 'Minimizer input limit exceeded');
  const now = options.now ?? Date.now;
  const initialBytes = initial.length;
  let current = initial;
  let steps = 0;
  const exhausted = (): boolean => steps >= options.maxSteps || now() > options.deadline;
  let chunk = Math.max(1, Math.floor(current.length / 2));
  while (chunk >= 1 && !exhausted()) {
    let progressed = true;
    while (progressed && !exhausted()) {
      progressed = false;
      for (let start = 0; start + chunk <= current.length; start += chunk) {
        if (exhausted()) break;
        const candidate = without(current, start, chunk);
        steps += 1;
        if (fails(candidate)) {
          current = candidate;
          progressed = true;
          start = -chunk; // restart the pass on the shrunken input
        }
      }
    }
    chunk = Math.floor(chunk / 2);
  }
  return Object.freeze({ bytes: current, steps, initialBytes });
}
