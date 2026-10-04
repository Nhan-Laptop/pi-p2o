import { readdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { ProcessIdentity, ProcessProbe, ProcessRow, StopReceipt } from "./types.js";
import { errorText, until } from "./io.js";
export function processIdentity(p: ProcessIdentity): ProcessIdentity {
  const { pid, ppid, pgid, state, startTicks, bootId } = p;
  return { pid, ppid, pgid, state, startTicks, bootId };
}
/** Synchronous capture closes the spawn/event-loop cancellation race. */
export function captureIdentity(pid: number, bootId: string): ProcessIdentity | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (f.length < 20) throw new Error("Malformed process stat");
    return { pid, ppid: Number(f[1]), pgid: Number(f[2]), state: f[0]!, startTicks: f[19]!, bootId };
  } catch (e) { if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) return undefined; throw e; }
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.bootId === b.bootId && a.startTicks === b.startTicks;
}
export const alive = (p: ProcessIdentity): boolean => p.state !== "Z" && p.state !== "X";
/** Linux only. Missing processes are normal races; permission/incomplete inventories fail closed. */
export class LinuxProcessProbe implements ProcessProbe {
  private lastMs = 0;
  async snapshot(): Promise<ProcessRow[]> {
    if (process.platform !== "linux") throw new Error("Verified process ownership requires Linux /proc");
    const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const ids = (await readdir("/proc")).filter((id) => /^\d+$/.test(id));
    if (ids.length > 65_536) throw new Error("Process inventory limit exceeded");
    const rows: ProcessRow[] = [];
    // Bounded I/O concurrency; do not create one pending read per system process.
    let next = 0;
    const started = Date.now();
    await Promise.all(Array.from({ length: 16 }, async () => {
      for (;;) {
        const id = ids[next++];
        if (!id) return;
        try {
          const stat = await readFile(`/proc/${id}/stat`, "utf8");
          const f = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          const argv = (await readFile(`/proc/${id}/cmdline`, "utf8")).split("\0").filter(Boolean);
          if (f.length < 20) throw new Error("Malformed process stat");
          rows.push({ pid: Number(id), ppid: Number(f[1]), pgid: Number(f[2]), state: f[0]!, startTicks: f[19]!, bootId, argv });
        } catch (e) {
          if (["ENOENT", "ESRCH"].includes((e as NodeJS.ErrnoException).code ?? "")) continue;
          throw e;
        }
      }
    }));
    this.lastMs = Date.now() - started;
    return rows;
  }
  lastSnapshotMs(): number { return this.lastMs; }
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
    if (!Number.isSafeInteger(pid) || Math.abs(pid) <= 1 || pid === process.pid || pid === -process.pid) throw new Error("Unsafe process signal target");
    try { process.kill(pid, signal); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
  }
}
/** The documented late-cancellation window, and a hard cap so a hung `/proc` cannot hold the fence forever. */
const MIN_VERIFY_MS = 100;
const MAX_INVENTORY_MS = 5_000;
/** Attempts per inventory call. A probe with no sample starts with an unmeasured bound; the retry
 *  budget is a measurement strategy, not a renewed cancellation budget. */
const MAX_INVENTORY_ATTEMPTS = 3;
/** Retains identified children even after reparenting or their process-group leader exits. */
export class ProcessFamily {
  private readonly known = new Map<number, ProcessIdentity>();
  constructor(readonly probe: ProcessProbe, roots: ProcessIdentity[] = []) { this.add(roots); }
  add(rows: ProcessIdentity[]): void {
    for (const row of rows) {
      const old = this.known.get(row.pid);
      if (!old || sameProcess(old, row)) this.known.set(row.pid, processIdentity(row));
    }
    if (this.known.size > 4096) throw new Error("Descendant identity limit exceeded; fence must remain held");
  }
  identities(): ProcessIdentity[] { return [...this.known.values()]; }
  async inspect(rows?: ProcessRow[]): Promise<ProcessIdentity[]> {
    rows ??= await this.probe.snapshot();
    const live = rows.filter((row) => this.known.has(row.pid) && sameProcess(this.known.get(row.pid)!, row));
    const reachable = new Set(live.map((p) => p.pid));
    for (;;) {
      const children = rows.filter((p) => reachable.has(p.ppid) && !reachable.has(p.pid));
      if (!children.length) break;
      this.add(children);
      for (const p of children) { reachable.add(p.pid); live.push(p); }
    }
    // Same-group orphans are owned only when the group leader's identity is known.
    const groups = new Set(this.identities().filter((p) => p.pgid === p.pid).map((p) => p.pgid));
    const groupMembers = rows.filter((p) => groups.has(p.pgid) && !reachable.has(p.pid) &&
      (!this.known.has(p.pid) || sameProcess(this.known.get(p.pid)!, p)));
    // Never infer group ownership after ALL known members disappear (PGID reuse).
    const anchored = groupMembers.filter((p) => live.some((q) => q.pgid === p.pgid));
    this.add(anchored); live.push(...anchored);
    return live.filter(alive);
  }
  async terminate(options: {
    deadlineAt: number; graceMs: number; reason: StopReceipt["reason"];
    now?: () => number; sleep?: (ms: number) => Promise<void>;
  }): Promise<StopReceipt> {
    const now = options.now ?? Date.now;
    const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    let survivors: ProcessIdentity[] = this.identities();
    try {
      // Verification may have one bounded late-cancellation window, never an execution/grace renewal.
      // Proving absence costs at least one full inventory pass, and `lastSnapshotMs()` is a sample, not
      // a bound (a freshly attached probe has none at all). A single hard 100 ms window therefore turns
      // a loaded but healthy host into a false "unverified" quarantine while the same host makes that
      // very pass take longer. Each call keeps exactly one snapshot in flight and re-awaits it with a
      // bound derived from the time it has already consumed: a timed-out measurement is never dropped
      // (or duplicated), it is only re-measured. Retries stay inside the caller's absolute deadline;
      // after the deadline one bounded attempt is all that is owed, because the process was already
      // SIGKILLed by then.
      let inventoryMs = Math.max(0, this.probe.lastSnapshotMs?.() ?? 0);
      const inventory = async (): Promise<ProcessRow[]> => {
        let pending: Promise<ProcessRow[]> | undefined;
        for (let attempt = 1; ; attempt++) {
          pending ??= this.probe.snapshot();
          const bound = Math.min(MAX_INVENTORY_MS, Math.max(MIN_VERIFY_MS, 2 * inventoryMs));
          const started = now();
          try {
            const rows = await until(pending, started + bound, now);
            inventoryMs = Math.max(inventoryMs, now() - started);
            return rows;
          } catch (error) {
            inventoryMs = Math.max(inventoryMs, now() - started, bound);
            const retryBound = Math.min(MAX_INVENTORY_MS, Math.max(MIN_VERIFY_MS, 2 * inventoryMs));
            const room = options.deadlineAt - now();
            if (attempt >= MAX_INVENTORY_ATTEMPTS || room <= 0 || room < retryBound) throw error;
          }
        }
      };
      const termUntil = Math.min(options.deadlineAt, now() + options.graceMs);
      let killed = false;
      for (;;) {
        const signal = now() >= termUntil ? "SIGKILL" : "SIGTERM";
        // One authoritative inventory per iteration revalidates identities and discovers new
        // descendants in the same pass; duplicate scans would consume the bounded verify window.
        const owned = await this.inspect(await inventory());
        const groups = new Set(owned.filter((p) => this.known.get(p.pgid)?.pid === p.pgid &&
          owned.some((q) => q.pid === p.pgid && sameProcess(q, this.known.get(p.pgid)!))).map((p) => p.pgid));
        for (const group of groups) this.probe.signal(-group, signal);
        for (const p of owned) if (!groups.has(p.pgid)) this.probe.signal(p.pid, signal);
        killed ||= signal === "SIGKILL";
        survivors = owned;
        if (!survivors.length) return { reason: options.reason, at: now(), verified: true, survivors: [] };
        if (now() >= options.deadlineAt) {
          // The grace window is over. Dispatch the hard cancellation if this iteration has not already
          // done so, then spend one bounded inventory proving absence: returning the pre-kill survivor
          // list would quarantine an attempt whose family is already dead. This is a verification pass
          // only - the SIGKILL was already dispatched, no execution budget is renewed.
          if (!killed) for (const p of survivors) this.probe.signal(p.pid, "SIGKILL");
          survivors = await this.inspect(await inventory());
          return { reason: options.reason, at: now(), verified: survivors.length === 0, survivors };
        }
        await sleep(Math.min(20, Math.max(1, options.deadlineAt - now())));
      }
    } catch (e) { return { reason: options.reason, at: now(), verified: false, survivors, error: errorText(e) }; }
  }
}
