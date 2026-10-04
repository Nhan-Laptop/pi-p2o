import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkCancelled, invariant, PolicyError } from '../../policy/errors.js';
import { choice, digest, integer, record, text } from '../../policy/validation.js';
import { validateRelativePath } from '../filesystem.js';
import { sha256 } from '../redaction.js';
import type { FuzzDifferentialInput, FuzzDifferentialSubject, FuzzStrategy, SourceFile } from '../types.js';
import { FUZZ_STRATEGIES, generateCase } from './generator.js';
import { bytesToHex, seededRandom, validateFuzzSeed } from './prng.js';
import { minimize } from './shrink.js';

/** Normalized, comparable subject outcome. Ordinary parser rejection is an outcome, never a failure. */
export type FuzzSubjectOutcome =
  | { readonly kind: 'accept'; readonly value: string }
  | { readonly kind: 'reject'; readonly name: string }
  | { readonly kind: 'oversize'; readonly bytes: number }
  | { readonly kind: 'invariant-violation'; readonly detail: string };

export interface FuzzModuleEvidence { readonly role: 'module-a' | 'module-b'; readonly path: string; readonly sha256: string }
export interface FuzzReproducerEvidence { readonly hex: string; readonly preview: string; readonly bytes: number; readonly sha256: string }
export interface FuzzDivergenceSubject { readonly role: 'module-a' | 'module-b'; readonly path: string; readonly outcome: FuzzSubjectOutcome; readonly digest: string }
export interface FuzzDivergenceEvidence {
  readonly foundAtCase: number;
  readonly reproducer: FuzzReproducerEvidence;
  readonly initial: { readonly bytes: number; readonly sha256: string };
  readonly shrinkSteps: number;
  readonly subjectA: FuzzDivergenceSubject;
  readonly subjectB: FuzzDivergenceSubject;
  readonly digest: string;
}
export interface FuzzDifferentialEvidence {
  readonly kind: 'fuzz-differential';
  readonly subject: { readonly kind: FuzzDifferentialSubject['kind']; readonly modules: readonly FuzzModuleEvidence[] };
  readonly strategy: FuzzStrategy;
  readonly seed: string;
  readonly casesMax: number;
  readonly casesRun: number;
  readonly outcome: 'no-divergence' | 'divergence';
  readonly divergence?: FuzzDivergenceEvidence;
  readonly budget: { readonly deadlineMs: number; readonly spentMs: number; readonly maxInputBytes: number; readonly maxOutcomeBytes: number };
  readonly isolation: string;
  readonly limits: readonly string[];
}

export interface DifferentialOptions {
  /** Absolute trusted read-only input root; modules are resolved inside it and nowhere else. */
  readonly inputRoot: string;
  /** The sandbox filesystem port: verifies containment, symlink safety, size and byte identity. */
  readonly readInput: (path: string, signal?: AbortSignal) => Promise<SourceFile>;
  /**
   * Explicit statement that this boundary may import owner-supplied modules into the controller
   * process. Anything other than `trusted-local-modules` refuses differential fuzzing outright.
   */
  readonly codeExecution?: 'none' | 'trusted-local-modules';
  readonly boundary: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export const DIFFERENTIAL_DEFAULTS = Object.freeze({ cases: 256, maxInputBytes: 512, maxOutcomeBytes: 4096, maxShrinkSteps: 4096 });
export const DIFFERENTIAL_LIMITS = Object.freeze([
  'Modules are imported from the trusted read-only input snapshot into the controller process: this is NOT a container or VM boundary and untrusted code is refused.',
  'Generation is deterministic from the recorded seed; shrinkage is deletion-based and ends at a 1-minimal reproducer.',
  'This is an offline capability: it is never granted network authority, and a URL/host/account field or a network module specifier is a hard error.',
  'Cases, input bytes, outcome bytes and wall-clock time are bounded; a synchronous module that never returns cannot be preempted in-process.',
]);

const outcomeDigest = (outcome: FuzzSubjectOutcome): string => digest(outcome);

/** Schemes, package specifiers and absolute paths are refused before the snapshot is touched. */
export function assertLocalModuleSpecifier(value: unknown, label = 'module'): string {
  const specifier = text(value, label, 4096);
  invariant(!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier), 'TARGET_DENIED', `${label} must be a path inside the trusted input snapshot; network/package module specifiers are refused because differential fuzzing is local-code only`);
  return validateRelativePath(specifier);
}

function parseSubject(value: unknown): FuzzDifferentialSubject {
  const o = record(value, 'subject', ['kind', 'module', 'moduleA', 'moduleB']);
  const kind = choice(o.kind, 'subject.kind', ['module-pair', 'module-invariant'] as const);
  if (kind === 'module-pair') {
    return Object.freeze({ kind, moduleA: assertLocalModuleSpecifier(o.moduleA, 'subject.moduleA'), moduleB: assertLocalModuleSpecifier(o.moduleB, 'subject.moduleB') });
  }
  return Object.freeze({ kind, module: assertLocalModuleSpecifier(o.module, 'subject.module') });
}

/** Canonical, bounded serialization of an arbitrary return value; never throws. */
function canonicalValue(value: unknown, depth = 0): string {
  if (depth > 32) return JSON.stringify('[depth-limit]');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (value === undefined) return JSON.stringify('[undefined]');
  if (typeof value !== 'object') return JSON.stringify(`[${typeof value}]`);
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item, depth + 1)).join(',')}]`;
  try {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item, depth + 1)}`).join(',')}}`;
  } catch { return JSON.stringify('[unserializable]'); }
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { name?: unknown }).name === 'string' && (error as { name: string }).name.length > 0) return (error as { name: string }).name.slice(0, 64);
  return 'Error';
}

function normalizeOutcome(subject: (raw: Uint8Array) => unknown, raw: Uint8Array, maxOutcomeBytes: number): FuzzSubjectOutcome {
  let value: unknown;
  try { value = subject(raw); } catch (error) { return { kind: 'reject', name: errorName(error) }; }
  const canonical = canonicalValue(value);
  return canonical.length > maxOutcomeBytes ? { kind: 'oversize', bytes: canonical.length } : { kind: 'accept', value: canonical };
}

interface LoadedModule extends FuzzModuleEvidence {
  readonly outcome: (raw: Uint8Array) => unknown;
  readonly oracles: ((raw: Uint8Array) => unknown) | undefined;
}

async function loadModule(role: 'module-a' | 'module-b', path: string, options: DifferentialOptions): Promise<LoadedModule> {
  checkCancelled(options.signal);
  const verified = await options.readInput(path, options.signal);
  const absolute = join(options.inputRoot, path);
  let namespace: Record<string, unknown>;
  try { namespace = await import(pathToFileURL(absolute).href) as Record<string, unknown>; }
  catch { throw new PolicyError('INVALID_INPUT', `Module ${path} could not be imported as a local ES module`); }
  const after = await readFile(absolute).then(bytes => sha256(bytes), () => undefined);
  invariant(after !== undefined && after === verified.sha256, 'FILESYSTEM_DENIED', `Module ${path} bytes changed around import; the verified snapshot identity is not reproducible`);
  const entry = typeof namespace.outcome === 'function' ? namespace.outcome : typeof namespace.default === 'function' ? namespace.default : undefined;
  invariant(typeof entry === 'function', 'INVALID_INPUT', `Module ${path} must export an outcome(...) function (or a default function)`);
  const oracles = namespace.invariant;
  invariant(oracles === undefined || typeof oracles === 'function', 'INVALID_INPUT', `Module ${path} exports a non-function invariant`);
  return Object.freeze({
    role, path, sha256: verified.sha256,
    outcome: entry as (raw: Uint8Array) => unknown,
    oracles: typeof oracles === 'function' ? oracles as (raw: Uint8Array) => unknown : undefined,
  });
}

interface Comparison { readonly a: FuzzSubjectOutcome; readonly b: FuzzSubjectOutcome }

function invariantOutcome(module: LoadedModule, raw: Uint8Array): FuzzSubjectOutcome {
  invariant(module.oracles, 'INVALID_INPUT', `Module ${module.path} must export an invariant(...) function for a module-invariant subject`);
  let result: unknown;
  try { result = module.oracles(raw); }
  catch { throw new PolicyError('INVALID_INPUT', `Invariant in ${module.path} threw for a generated case; a defective oracle is a harness error, not a finding`); }
  if (result === true) return { kind: 'accept', value: 'true' };
  if (typeof result === 'string' && result.length > 0) return { kind: 'invariant-violation', detail: result.slice(0, 512) };
  invariant(false, 'INVALID_INPUT', `Invariant in ${module.path} must return true or a non-empty violation string`);
}

const previewOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8').slice(0, 2048);

export async function runDifferential(input: FuzzDifferentialInput, options: DifferentialOptions): Promise<FuzzDifferentialEvidence> {
  const now = options.now ?? Date.now;
  const started = now();
  const strategy = choice(input.strategy, 'strategy', FUZZ_STRATEGIES);
  const seed = validateFuzzSeed(input.seed);
  const casesMax = integer(input.cases ?? DIFFERENTIAL_DEFAULTS.cases, 'cases', 1, 4096);
  const maxInputBytes = integer(input.maxInputBytes ?? DIFFERENTIAL_DEFAULTS.maxInputBytes, 'maxInputBytes', 1, 65536);
  invariant(input.timeoutMs === undefined || (Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 && input.timeoutMs <= options.timeoutMs), 'INVALID_INPUT', 'timeoutMs cannot widen the capability deadline');
  invariant(options.codeExecution === 'trusted-local-modules', 'UNAVAILABLE', 'Differential fuzzing imports owner-supplied modules into the controller process; this boundary does not acknowledge trusted local code, and untrusted binaries are refused');
  const timeoutMs = Math.max(1, Math.floor((input.timeoutMs ?? options.timeoutMs) * 0.9));
  const deadline = started + timeoutMs;

  const subject = parseSubject(input.subject);
  const modules: LoadedModule[] = [];
  if (subject.kind === 'module-pair') {
    modules.push(await loadModule('module-a', subject.moduleA, options));
    modules.push(await loadModule('module-b', subject.moduleB, options));
  } else {
    const loaded = await loadModule('module-a', subject.module, options);
    invariant(loaded.oracles, 'INVALID_INPUT', `Invariant subject ${subject.module} must export an invariant(...) function`);
    modules.push(loaded);
  }

  const compare = (raw: Uint8Array): Comparison | undefined => {
    const a = normalizeOutcome(modules[0]!.outcome, raw, DIFFERENTIAL_DEFAULTS.maxOutcomeBytes);
    if (subject.kind === 'module-invariant') {
      const b = invariantOutcome(modules[0]!, raw);
      return b.kind === 'invariant-violation' ? { a, b } : undefined;
    }
    const b = normalizeOutcome(modules[1]!.outcome, raw, DIFFERENTIAL_DEFAULTS.maxOutcomeBytes);
    return outcomeDigest(a) === outcomeDigest(b) ? undefined : { a, b };
  };

  const rng = seededRandom(seed, `differential:${strategy}`);
  let found: { index: number; bytes: Uint8Array } | undefined;
  let casesRun = 0;
  for (let index = 0; index < casesMax; index += 1) {
    checkCancelled(options.signal);
    invariant(now() <= deadline, 'TIMEOUT', 'Differential fuzzing deadline exceeded before a divergence was found');
    const candidate = generateCase(rng, strategy, maxInputBytes);
    casesRun = index + 1;
    if (compare(candidate)) { found = { index, bytes: candidate }; break; }
  }

  const evidence = (divergence?: FuzzDivergenceEvidence): FuzzDifferentialEvidence => Object.freeze({
    kind: 'fuzz-differential' as const,
    subject: { kind: subject.kind, modules: modules.map(module => ({ role: module.role, path: module.path, sha256: module.sha256 })) },
    strategy, seed, casesMax, casesRun,
    outcome: found ? 'divergence' as const : 'no-divergence' as const,
    ...(divergence ? { divergence } : {}),
    budget: { deadlineMs: timeoutMs, spentMs: now() - started, maxInputBytes, maxOutcomeBytes: DIFFERENTIAL_DEFAULTS.maxOutcomeBytes },
    isolation: options.boundary,
    limits: DIFFERENTIAL_LIMITS,
  });
  if (!found) return evidence();

  const minimal = minimize(found.bytes, candidate => compare(candidate) !== undefined, { maxSteps: DIFFERENTIAL_DEFAULTS.maxShrinkSteps, deadline, now });
  const comparison = compare(minimal.bytes);
  invariant(comparison, 'UNAVAILABLE', 'Divergence was not reproducible at the minimized reproducer');
  const reproducer: FuzzReproducerEvidence = Object.freeze({ hex: bytesToHex(minimal.bytes), preview: previewOf(minimal.bytes), bytes: minimal.bytes.length, sha256: sha256(Buffer.from(minimal.bytes)) });
  const subjectA: FuzzDivergenceSubject = Object.freeze({ role: 'module-a', path: modules[0]!.path, outcome: comparison.a, digest: outcomeDigest(comparison.a) });
  const subjectB: FuzzDivergenceSubject = Object.freeze({ role: subject.kind === 'module-pair' ? 'module-b' : 'module-a', path: modules[subject.kind === 'module-pair' ? 1 : 0]!.path, outcome: comparison.b, digest: outcomeDigest(comparison.b) });
  const divergence: FuzzDivergenceEvidence = Object.freeze({
    foundAtCase: found.index,
    reproducer,
    initial: { bytes: found.bytes.length, sha256: sha256(Buffer.from(found.bytes)) },
    shrinkSteps: minimal.steps,
    subjectA, subjectB,
    digest: digest({ kind: 'fuzz-differential-divergence', seed, strategy, reproducerHex: reproducer.hex, subjectA: subjectA.digest, subjectB: subjectB.digest }),
  });
  return evidence(divergence);
}
