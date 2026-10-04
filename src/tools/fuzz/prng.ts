import { createHash } from 'node:crypto';
import { invariant } from '../../policy/errors.js';

/**
 * Deterministic PRNG for the fuzz pack. `sha256(label NUL seed)` seeds sfc32, a pure 32-bit integer
 * mixer: the same seed and label always produce the same case sequence on every Node build. Nothing
 * here depends on `Math.random`, wall-clock time, locale or environment.
 */
export interface SeededRandom {
  next(): number;
  int(maxExclusive: number): number;
  bool(probability: number): boolean;
  pick<T>(values: readonly T[]): T;
}

export function seededRandom(seed: string, label: string): SeededRandom {
  const state = createHash('sha256').update(`${label}\u0000${seed}`).digest();
  let a = state.readUInt32BE(0) >>> 0;
  let b = state.readUInt32BE(4) >>> 0;
  let c = state.readUInt32BE(8) >>> 0;
  let d = state.readUInt32BE(12) >>> 0;
  const next = (): number => {
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  // Discard the first draws so case zero is not a function of a barely-mixed state.
  for (let i = 0; i < 12; i++) next();
  return Object.freeze({
    next,
    int(maxExclusive: number): number {
      invariant(Number.isSafeInteger(maxExclusive) && maxExclusive > 0, 'INVALID_INPUT', 'PRNG bound must be a positive integer');
      return Math.min(maxExclusive - 1, Math.floor(next() * maxExclusive));
    },
    bool(probability: number): boolean { return next() < probability; },
    pick<T>(values: readonly T[]): T {
      invariant(values.length > 0, 'INVALID_INPUT', 'PRNG cannot pick from an empty set');
      return values[Math.floor(next() * values.length)]!;
    },
  });
}

/** Seed shape accepted from worker input; recorded verbatim in evidence so a run is replayable. */
export function validateFuzzSeed(value: unknown): string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value), 'INVALID_INPUT', 'seed must be 1-64 characters of [A-Za-z0-9._:-] starting alphanumeric');
  return value;
}

export function bytesToHex(bytes: Uint8Array): string { return Buffer.from(bytes).toString('hex'); }
