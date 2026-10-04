import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRecord } from '../../src/contracts/index.js';
import type { DurableStore } from '../../src/store/index.js';

/**
 * Real execution-overlap evidence for the local fixture.
 *
 * Two tasks sharing a name, or two `running` rows in a database, are not proof that work happened at the same
 * time. This monitor reads the controller-persisted runtime handles (`<controlRoot>/handles/<attemptId>.json`),
 * re-verifies each owned pid against `/proc` as the *same* process instance (pid + start ticks, non-zombie), and
 * records, per sample, the durable attempt lifecycle. The report then measures the intersection of the two
 * verified live-process windows. Nothing here is inferred from task metadata.
 */

export interface OverlapSample {
  /** Sampling round; both tasks within one round are observed microseconds apart. */
  round: number;
  at: number;
  taskId: string;
  attemptId: string;
  lifecycle: AttemptRecord['lifecycleState'];
  /** Owned pids reported by the runtime handle at this sample. */
  pids: number[];
  /** Owned pids verified alive as the same process instance at this sample. */
  alive: number[];
}

export interface OverlapWindow {
  taskId: string;
  attemptId: string;
  from: number;
  to: number;
  pids: number[];
  samples: number;
}

export interface OverlapReport {
  tasks: string[];
  samples: OverlapSample[];
  windows: OverlapWindow[];
  /** Rounds where both tasks had at least one verified live owned process. */
  sharedAliveRounds: number;
  /** Rounds where both tasks had a verified live process *and* both were durably `running`. */
  sharedRunningRounds: number;
  /** Measured intersection of the two verified live-process windows, in milliseconds. */
  bothAliveMs: number;
  /** True when at least one round observed both attempts durably `running` with verified live processes. */
  sharedRunningInstant: boolean;
  /** True when at least one round observed both attempts with verified live processes. */
  sharedAliveInstant: boolean;
}

interface ProcessRef { pid: number; startTicks: string }

export interface OverlapMonitorOptions {
  store: DurableStore;
  runId: string;
  controlRoot: string;
  taskIds: readonly string[];
  /** Sampling period. */
  intervalMs?: number;
  /** Hard bound on retained samples. */
  maxSamples?: number;
}

export interface OverlapMonitor {
  /** Stop sampling and compute the report from what was actually observed while the run was live. */
  stop(): OverlapReport;
}

const DEFAULT_INTERVAL_MS = 15;
const DEFAULT_MAX_SAMPLES = 4_000;

/** Owned pids of a persisted runtime handle: guardian plus every tracked descendant. */
function handleProcesses(controlRoot: string, attemptId: string): ProcessRef[] {
  try {
    const handle = JSON.parse(readFileSync(join(controlRoot, 'handles', `${attemptId}.json`), 'utf8')) as {
      native?: { guardian?: ProcessRef; processes?: ProcessRef[] };
    };
    const refs = [handle.native?.guardian, ...(handle.native?.processes ?? [])];
    const seen = new Set<number>();
    const out: ProcessRef[] = [];
    for (const ref of refs) {
      if (!ref || typeof ref.pid !== 'number' || !Number.isSafeInteger(ref.pid) || ref.pid <= 0) continue;
      if (seen.has(ref.pid)) continue;
      seen.add(ref.pid);
      out.push({ pid: ref.pid, startTicks: typeof ref.startTicks === 'string' ? ref.startTicks : '' });
    }
    return out;
  } catch {
    return [];
  }
}

/** Verify the pid is alive as the same non-zombie process instance recorded by the runtime. */
function liveProcess(ref: ProcessRef): boolean {
  try {
    const stat = readFileSync(`/proc/${ref.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields.length < 20) return false;
    if (fields[0] === 'Z') return false; // a zombie is not doing work
    return ref.startTicks === '' || fields[19] === ref.startTicks;
  } catch {
    return false;
  }
}

export function startOverlapMonitor(options: OverlapMonitorOptions): OverlapMonitor {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const samples: OverlapSample[] = [];
  let round = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const sample = (): void => {
    if (samples.length >= maxSamples) return;
    round += 1;
    for (const taskId of options.taskIds) {
      const attempt = options.store.listAttempts(options.runId).filter(candidate => candidate.taskId === taskId).at(-1);
      if (!attempt) continue;
      const pids = handleProcesses(options.controlRoot, attempt.attemptId);
      const alive = pids.filter(liveProcess).map(ref => ref.pid);
      samples.push({
        round, at: Date.now(), taskId, attemptId: attempt.attemptId,
        lifecycle: attempt.lifecycleState, pids: pids.map(ref => ref.pid), alive,
      });
    }
  };

  sample();
  timer = setInterval(sample, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return Object.freeze({
    stop(): OverlapReport {
      if (timer) clearInterval(timer);
      timer = undefined;
      const windows: OverlapWindow[] = [];
      for (const taskId of options.taskIds) {
        const rows = samples.filter(candidate => candidate.taskId === taskId && candidate.alive.length > 0);
        const first = rows[0], last = rows.at(-1);
        if (!first || !last) continue;
        windows.push({
          taskId, attemptId: first.attemptId, from: first.at, to: last.at,
          pids: [...new Set(rows.flatMap(row => row.alive))], samples: rows.length,
        });
      }
      const rounds = new Map<number, OverlapSample[]>();
      for (const row of samples) {
        const bucket = rounds.get(row.round) ?? [];
        bucket.push(row);
        rounds.set(row.round, bucket);
      }
      let sharedAliveRounds = 0, sharedRunningRounds = 0;
      for (const bucket of rounds.values()) {
        const live = options.taskIds.filter(taskId => bucket.some(row => row.taskId === taskId && row.alive.length > 0));
        if (live.length !== options.taskIds.length) continue;
        sharedAliveRounds += 1;
        const running = options.taskIds.every(taskId => bucket.some(row => row.taskId === taskId && row.lifecycle === 'running'));
        if (running) sharedRunningRounds += 1;
      }
      const [first, second] = windows;
      const inner = first && second ? Math.max(0, Math.min(first.to, second.to) - Math.max(first.from, second.from)) : 0;
      return Object.freeze({
        tasks: [...options.taskIds],
        samples: [...samples],
        windows,
        sharedAliveRounds,
        sharedRunningRounds,
        bothAliveMs: inner,
        sharedRunningInstant: sharedRunningRounds > 0,
        sharedAliveInstant: sharedAliveRounds > 0,
      });
    },
  });
}
