import { createServer, connect, type Server, type Socket } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ID_PATTERN, type AttemptRecord } from '../contracts/index.js';
import type { DurableStore } from '../store/index.js';
import { ApplicationError } from './validation.js';
import type { BridgeOperation, PlannerContextPort, WorkerBridge, WorkerContextPort } from './types.js';

export interface BridgeIdentity { attemptId?: string; taskId?: string }
export interface BridgeRequest { id: string; token: string; operation: BridgeOperation; payload: unknown; attemptId?: string; taskId?: string }
export interface BridgeResponse { id: string; ok: boolean; data?: unknown; code?: string; message?: string }

const TERMINAL_LIFECYCLE = new Set(['exited', 'failed', 'timed-out', 'cancelled', 'reconciling', 'queued']);
const INACTIVE_RUN = new Set(['completed', 'failed', 'cancelled']);

export interface WorkerBridgeOperations {
  /** All trusted side effects; the bridge only authenticates, frames, aborts and bounds. */
  execute(attempt: Readonly<AttemptRecord>, payload: unknown, signal: AbortSignal): Promise<unknown>;
  acceptedInputs(attempt: Readonly<AttemptRecord>): Promise<unknown>;
  attemptState(attempt: Readonly<AttemptRecord>): Promise<unknown>;
  /** Controller collects/preserves the packet, then the real supervisor admission gate decides. */
  admitPacket?(attempt: Readonly<AttemptRecord>): Promise<{ accepted: boolean; reasons: readonly string[] }>;
  verify(attempt: Readonly<AttemptRecord>, payload: unknown, signal: AbortSignal): Promise<unknown>;
  /** Optional run-scoped threat-model context; absent fails closed for context operations. */
  context?: WorkerContextPort;
  /** Optional planner context; served only to the owner-approved planner attempt. Absent fails closed. */
  plan?: PlannerContextPort;
  serialize<T>(attemptId: string, work: () => Promise<T>): Promise<T>;
  log?(event: string, detail: string): void;
}

export interface WorkerBridgeOptions {
  socketPath: string;
  controlRoot: string;
  runId: string;
  store: DurableStore;
  operations: WorkerBridgeOperations;
  maxFrameBytes?: number;
  maxConnections?: number;
  requestTimeoutMs?: number;
  /** Bound on graceful server close before the listener is abandoned. */
  closeTimeoutMs?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

const DEFAULT_MAX_FRAME = 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 8;
const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_CLOSE_TIMEOUT = 2_000;

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Supervisor-side worker RPC over a unix socket. The bridge holds no authority of its own: it authenticates the
 * attempt against the controller-owned runtime handle **and** the durable live-execution state (run active,
 * attempt non-terminal, current unexpired lease, deadline remaining), bounds every request with an abort signal,
 * and closes by aborting in-flight work and dropping sockets before waiting for the listener.
 */
export function createWorkerBridge(options: WorkerBridgeOptions): WorkerBridge {
  const socketPath = options.socketPath;
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME;
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT;
  const now = options.now ?? Date.now;
  let server: Server | undefined;
  let closing = false;
  let served = 0;
  const sockets = new Set<Socket>();
  const inFlight = new Set<AbortController>();

  function handlePath(attemptId: string): string | undefined {
    if (!ID_PATTERN.test(attemptId)) return undefined;
    return join(options.controlRoot, 'handles', `${attemptId}.json`);
  }

  /** Resolve and authorize the attempt for every dispatch; stale, cancelled or released work is denied. */
  function authorize(request: BridgeIdentity, token: string): AttemptRecord {
    if (typeof token !== 'string' || token.length < 8 || token.length > 256) {
      throw new ApplicationError('bridge-denied', 'Worker/attempt authentication failed');
    }
    let attemptId = typeof request.attemptId === 'string' ? request.attemptId : undefined;
    if (!attemptId && typeof request.taskId === 'string' && ID_PATTERN.test(request.taskId)) {
      attemptId = options.store.getLease(request.taskId)?.attemptId;
    }
    if (!attemptId) throw new ApplicationError('bridge-denied', 'Worker/attempt authentication failed');
    const file = handlePath(attemptId);
    if (!file) throw new ApplicationError('bridge-denied', 'Worker/attempt authentication failed');
    let handle: { ownerToken?: unknown; runId?: unknown; attemptId?: unknown } | undefined;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('unsafe control file');
      handle = JSON.parse(readFileSync(file, 'utf8')) as typeof handle;
    } catch { throw new ApplicationError('bridge-denied', 'Worker/attempt authentication failed'); }
    if (!handle || handle.attemptId !== attemptId || handle.runId !== options.runId || typeof handle.ownerToken !== 'string') {
      throw new ApplicationError('bridge-denied', 'Worker/attempt authentication failed');
    }
    if (!constantTimeEquals(handle.ownerToken, token)) throw new ApplicationError('bridge-denied', 'Worker/attempt authentication failed');

    const attempt = options.store.getAttempt(attemptId);
    if (!attempt || attempt.runId !== options.runId) throw new ApplicationError('bridge-denied', 'Worker/attempt authentication failed');
    // Live-execution checks: never serve a released, cancelled, expired or completed attempt.
    const run = options.store.getRun(options.runId);
    if (!run || INACTIVE_RUN.has(run.state)) throw new ApplicationError('bridge-stale-attempt', 'Run is no longer active');
    if (TERMINAL_LIFECYCLE.has(attempt.lifecycleState)) throw new ApplicationError('bridge-stale-attempt', `Attempt is ${attempt.lifecycleState}`);
    if (now() >= Date.parse(attempt.deadlineAt)) throw new ApplicationError('bridge-stale-attempt', 'Attempt deadline exhausted');
    const lease = options.store.getLease(attempt.taskId);
    if (!lease || lease.attemptId !== attempt.attemptId || lease.token !== attempt.leaseToken || Date.parse(lease.expiresAt) <= now()) {
      throw new ApplicationError('bridge-stale-attempt', 'Attempt does not hold the current workspace lease');
    }
    return attempt;
  }

  async function dispatch(request: BridgeRequest, signal: AbortSignal): Promise<unknown> {
    const attempt = authorize(request, request.token);
    switch (request.operation) {
      case 'broker.execute': return options.operations.serialize(attempt.attemptId, () => options.operations.execute(attempt, request.payload, signal));
      case 'worker.acceptedInputs': return options.operations.acceptedInputs(attempt);
      case 'attempt.state': return options.operations.attemptState(attempt);
      case 'packet.admit': {
        if (!options.operations.admitPacket) throw new ApplicationError('packet-admission-unavailable', 'No controller packet admission path');
        return options.operations.serialize(attempt.attemptId, () => options.operations.admitPacket!(attempt));
      }
      case 'verify.finding': return options.operations.serialize(attempt.attemptId, () => options.operations.verify(attempt, request.payload, signal));
      case 'threat-model.read': {
        const context = options.operations.context;
        if (!context) throw new ApplicationError('context-unavailable', 'This composition serves no run-scoped worker context');
        return context.read(attempt, request.payload);
      }
      case 'threat-model.amend': {
        const context = options.operations.context;
        if (!context) throw new ApplicationError('context-unavailable', 'This composition serves no run-scoped worker context');
        return options.operations.serialize(attempt.attemptId, () => context.amend(attempt, request.payload, signal));
      }
      case 'plan.context': {
        const plan = options.operations.plan;
        if (!plan) throw new ApplicationError('plan-context-unavailable', 'This composition serves no planner context');
        return plan.context(attempt, request.payload);
      }
      default: throw new ApplicationError('bridge-denied', 'Unknown bridge operation');
    }
  }

  function respond(socket: Socket, response: BridgeResponse): void {
    if (!socket.writable) return;
    socket.write(`${JSON.stringify(response)}\n`);
  }

  function handleConnection(socket: Socket): void {
    sockets.add(socket);
    if (sockets.size > maxConnections) { socket.destroy(); return; }
    socket.setNoDelay(true);
    let buffer = '';
    let chain: Promise<void> = Promise.resolve();
    const connectionControllers = new Set<AbortController>();
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > maxFrameBytes) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        chain = chain.then(async () => {
          const started = now();
          let request: BridgeRequest;
          try {
            request = JSON.parse(line) as BridgeRequest;
            if (!request || typeof request !== 'object' || typeof request.id !== 'string' || request.id.length === 0 || request.id.length > 128
              || typeof request.token !== 'string' || typeof request.operation !== 'string'
              || (typeof request.attemptId !== 'string' && typeof request.taskId !== 'string')) {
              throw new ApplicationError('bridge-protocol', 'Malformed bridge request');
            }
          } catch (error) {
            respond(socket, { id: randomUUID(), ok: false, code: 'bridge-protocol', message: error instanceof Error ? error.message : 'malformed request' });
            return;
          }
          const controller = new AbortController();
          connectionControllers.add(controller);
          inFlight.add(controller);
          const deadlineAt = Math.min(now() + requestTimeoutMs, resolveDeadline(request));
          const timer = setTimeout(() => controller.abort(new ApplicationError('bridge-timeout', 'Bridge request deadline exhausted')), Math.max(1, deadlineAt - now()));
          // Liveness watchdog: a stop/cancel/release during a long call aborts the in-flight tool work instead of
          // letting it finish and publish side effects.
          const watchdog = setInterval(() => {
            try { authorize(request, request.token); }
            catch (error) { controller.abort(error); }
          }, 500);
          if (typeof watchdog.unref === 'function') watchdog.unref();
          try {
            const data = await dispatch(request, controller.signal);
            served += 1;
            respond(socket, { id: request.id, ok: true, data });
          } catch (error) {
            const code = error instanceof ApplicationError ? error.code
              : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'bridge-error';
            const message = error instanceof Error ? error.message.slice(0, 512) : 'bridge operation failed';
            options.operations.log?.('bridge-error', `${request.operation}:${code} after ${now() - started}ms: ${message}`);
            respond(socket, { id: request.id, ok: false, code, message });
          } finally {
            clearTimeout(timer);
            clearInterval(watchdog);
            inFlight.delete(controller);
            connectionControllers.delete(controller);
          }
        });
      }
    });
    // A dropped connection can never leave side effects running unattended.
    const abortConnection = (): void => {
      for (const controller of connectionControllers) controller.abort(new ApplicationError('bridge-closed', 'Worker connection closed'));
      connectionControllers.clear();
      sockets.delete(socket);
    };
    socket.on('error', abortConnection);
    socket.on('close', abortConnection);
  }

  function resolveDeadline(request: BridgeRequest): number {
    const attemptId = typeof request.attemptId === 'string' ? request.attemptId : options.store.getLease(request.taskId ?? '')?.attemptId;
    const attempt = attemptId ? options.store.getAttempt(attemptId) : undefined;
    return attempt ? Date.parse(attempt.deadlineAt) : now() + requestTimeoutMs;
  }

  return Object.freeze({
    socketPath,
    get served(): number { return served; },
    async listen(): Promise<void> {
      if (server) throw new ApplicationError('bridge-state', 'Bridge is already listening');
      try {
        const existing = lstatSync(socketPath, { throwIfNoEntry: false });
        if (existing?.isSocket() && process.getuid && existing.uid === process.getuid()) unlinkSync(socketPath);
      } catch { /* a missing socket is the normal case */ }
      const created = createServer(handleConnection);
      await new Promise<void>((resolve, reject) => {
        created.once('error', reject);
        created.listen(socketPath, () => { created.removeListener('error', reject); resolve(); });
      });
      chmodSync(socketPath, 0o600);
      server = created;
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      const current = server;
      server = undefined;
      // Abort in-flight work and drop connections BEFORE waiting for the listener; `server.close` only completes
      // once every connection is gone, so awaiting it first can hang forever.
      for (const controller of inFlight) controller.abort(new ApplicationError('bridge-closed', 'Bridge is closing'));
      inFlight.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (current) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { (current as unknown as { closeAllConnections?: () => void }).closeAllConnections?.(); resolve(); }, closeTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
          current.close(() => { clearTimeout(timer); resolve(); });
        });
      }
      try { if (lstatSync(socketPath, { throwIfNoEntry: false })?.isSocket()) unlinkSync(socketPath); } catch { /* best effort */ }
    },
  });
}

/** Minimal client used by the inert worker program and by tests. */
export function callBridge(socketPath: string, token: string, identity: BridgeIdentity, operation: BridgeOperation, payload: unknown, timeoutMs = 60_000): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = '';
    let settled = false;
    const finish = (error: Error | undefined, data?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(data);
    };
    const timer = setTimeout(() => finish(new ApplicationError('bridge-timeout', 'Bridge call timed out')), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, token, operation, payload, ...identity })}\n`));
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      try {
        const response = JSON.parse(buffer.slice(0, end)) as BridgeResponse;
        if (response.id !== id) return finish(new ApplicationError('bridge-protocol', 'Bridge response identity mismatch'));
        if (!response.ok) return finish(new ApplicationError(response.code ?? 'bridge-error', response.message ?? 'bridge operation failed'));
        finish(undefined, response.data);
      } catch (error) { finish(error instanceof Error ? error : new ApplicationError('bridge-protocol', 'Malformed bridge response')); }
    });
    socket.on('error', (error) => { clearTimeout(timer); finish(error); });
    socket.on('close', () => { clearTimeout(timer); finish(new ApplicationError('bridge-closed', 'Bridge connection closed before a response')); });
  });
}
