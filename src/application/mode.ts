import {
  InterfaceError, type ControlBackend, type Preflight, type ResumeInput, type RunHandle, type RunMode, type StartInput,
} from '../interface/types.js';
import type { ApplicationMode } from './types.js';
import { ApplicationError } from './validation.js';

/**
 * Exact, total mapping between the configured application mode and the interface's safety label.
 *
 * `inert-local-fixture` => `fixture` (loopback lab fixtures plus approved read-only source artifacts),
 * `authorized-assessment` => `assessment`. There is no inference, no default and no widening: the owner
 * document decides and every control-plane call must agree with it.
 */
export function interfaceModeFor(mode: ApplicationMode): RunMode {
  switch (mode) {
    case 'inert-local-fixture': return 'fixture';
    case 'authorized-assessment': return 'assessment';
    default: throw new ApplicationError('invalid-config', `Unknown application mode ${JSON.stringify(mode)}`);
  }
}

function modeMismatch(configured: ApplicationMode, expected: RunMode, supplied: unknown): InterfaceError {
  return new InterfaceError('MODE_MISMATCH',
    `configured application mode ${configured} requires interface mode ${expected}; ${String(supplied)} is refused before any admission, recovery or launch`);
}

/**
 * Fail-closed mode enforcement around the real `ControlBackend` methods, used by the composition so the
 * `ControlBackend`, the Pi entry point (`createP2OBackend`) and every caller all agree on the configured mode.
 *
 * The wrapper never parses a manifest and never reads durable state: a mismatched call is refused before the
 * wrapped method can admit a run, recover an attempt, reuse a checkpoint or launch execution, so a mismatch
 * cannot create or resume durable work. `stop`, `status`, `tasks`, `evidence`, `report`, `events` and `close`
 * are deliberately not gated: owned teardown and read-only inspection must stay reachable regardless of mode.
 */
export function enforceInterfaceMode(backend: ControlBackend, configured: ApplicationMode): ControlBackend {
  const expected = interfaceModeFor(configured);
  const requireMode = (input: StartInput | ResumeInput): void => {
    if (!input || input.mode !== expected) throw modeMismatch(configured, expected, input?.mode);
  };
  // Bind the actual methods once so the wrapper is a pure delegate and never re-implements admission, recovery
  // or launch semantics (or loses them to a `this`-bound copy).
  const actualDoctor = backend.doctor?.bind(backend);
  const actualPreflight = backend.preflight.bind(backend);
  const actualStart = backend.start.bind(backend);
  const actualResume = backend.resume.bind(backend);
  const wrapped: ControlBackend = {
    ...backend,
    ...(actualDoctor
      ? { doctor: async (input: StartInput | ResumeInput, signal?: AbortSignal): Promise<Preflight> => { requireMode(input); return actualDoctor(input, signal); } }
      : {}),
    async preflight(input: StartInput | ResumeInput, signal?: AbortSignal): Promise<Preflight> {
      requireMode(input);
      return actualPreflight(input, signal);
    },
    async start(input: StartInput, signal?: AbortSignal): Promise<RunHandle> {
      requireMode(input);
      return actualStart(input, signal);
    },
    async resume(input: ResumeInput, signal?: AbortSignal): Promise<RunHandle> {
      requireMode(input);
      return actualResume(input, signal);
    },
  };
  return Object.freeze(wrapped);
}
