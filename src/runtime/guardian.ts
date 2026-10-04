/** Standalone watchdog, NOT a Pi extension. Compile beside the other runtime modules. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { captureIdentity, LinuxProcessProbe, ProcessFamily, processIdentity } from "./processes.js";
import { atomicJson, Deadline, errorText, MAX_TIMER_MS, readJson } from "./io.js";
import type { GuardianJournal, StopReceipt, WorkerConfig } from "./types.js";

/**
 * Relay a worker stream through the watchdog. The worker must never observe EPIPE just because the
 * controller died: the watchdog drains its output unconditionally and stops forwarding once the
 * controller pipe breaks, so a crash-recovered worker still settles and exits with its own code.
 */
function relay(source: NodeJS.ReadableStream, target: NodeJS.WritableStream): void {
  let open = true;
  const close = (): void => { open = false; source.resume(); };
  target.on("error", close);
  source.on("error", close);
  source.on("data", (chunk: Buffer) => {
    if (!open) return;
    try { if (!target.write(chunk)) { source.pause(); target.once("drain", () => source.resume()); } }
    catch { close(); }
  });
}

export async function runGuardian(configPath: string): Promise<void> {
  const config = await readJson<WorkerConfig>(configPath, 128 * 1024);
  if (!config || config.version !== 1 || process.env.P2O_ISOLATED !== config.token) throw new Error("Invalid isolated guardian configuration");
  const probe = new LinuxProcessProbe();
  const root = (await probe.snapshot()).find((p) => p.pid === process.pid);
  if (!root) throw new Error("Cannot identify guardian process");
  const journal: GuardianJournal = { token: config.token, guardian: processIdentity(root), processes: [], updatedAt: Date.now() };
  let writes = Promise.resolve();
  const commit = (): Promise<void> => {
    const value = JSON.parse(JSON.stringify(journal)) as GuardianJournal;
    writes = writes.catch(() => {}).then(() => atomicJson(config!.journalFile, value));
    return writes;
  };
  // Durable identity before Pi dispatch covers the controller spawn/persist crash window.
  await commit();
  // The watchdog must fire on the controller's absolute deadline even if the wall clock steps while
  // it is waiting; the deadline stays epoch-shaped, the wait is measured monotonically.
  const clock = new Deadline(config.deadlineAt, Date.now, () => performance.now());
  if (clock.exhausted()) throw new Error("Deadline exhausted before Pi dispatch");
  const family = new ProcessFamily(probe);
  let child: ReturnType<typeof spawn> | undefined;
  let ending: Promise<void> | undefined;
  let pulse: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let polling = false;
  async function finish(reason: StopReceipt["reason"]): Promise<void> {
    if (ending) return ending;
    ending = (async () => {
      if (pulse) clearTimeout(pulse);
      if (deadline) clearTimeout(deadline);
      const receipt = await family.terminate({ deadlineAt: config!.deadlineAt, graceMs: config!.stopGraceMs, reason, now: () => clock.now() });
      journal.termination = receipt;
      journal.processes = family.identities();
      journal.updatedAt = Date.now();
      journal.finished = receipt.verified;
      await commit();
      if (!receipt.verified) {
        // Fail closed: keep retrying KILL without minting a new task/execution budget.
        setTimeout(() => { ending = undefined; void finish(reason).catch(fatal); }, 100);
        process.exitCode = 1;
      } else process.exit(journal.error ? 1 : (journal.exit?.code ?? 0));
    })();
    return ending;
  }
  const onTerm = () => { void finish("stopped").catch(fatal); };
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onTerm);
  process.on("SIGINT", onTerm);
  function fatal(e: unknown): void { journal.error = errorText(e); void finish("failed").catch(() => process.exit(1)); }
  const reserve = Math.max(500, config.stopGraceMs + 500);
  // Same reporting reserve as the controller, and the same 32-bit timer clamp: a far deadline is
  // re-armed in chunks instead of firing immediately.
  const scheduleDeadline = (): void => {
    const delay = clock.remaining() - reserve;
    if (delay <= 0) { deadline = setTimeout(() => { void finish("timed-out").catch(fatal); }, 0); return; }
    deadline = setTimeout(scheduleDeadline, Math.min(delay, MAX_TIMER_MS));
  };
  scheduleDeadline();
  try {
    if (ending) return;
    // stdin stays inherited (that is the controller's RPC channel); stdout/stderr are relayed so the
    // worker's own pipes survive the death of the controller that opened them.
    child = spawn(config.piBinary, config.args, { cwd: config.workspace, env: config.env, stdio: ["inherit", "pipe", "pipe"], detached: false });
    if (child.stdout) relay(child.stdout, process.stdout);
    if (child.stderr) relay(child.stderr, process.stderr);
    // No await/event-loop yield between dispatch and kernel identity capture.
    if (child.pid) {
      const identity = captureIdentity(child.pid, root.bootId);
      if (identity) family.add([identity]);
      else if (child.exitCode === null) throw new Error("Cannot capture Pi process identity");
    }
    child.once("error", fatal);
    child.once("exit", (code, signal) => {
      journal.exit = { code, signal };
      void finish(code === 0 ? "completed" : "failed").catch(fatal);
    });
    async function poll(): Promise<void> {
      if (ending || polling) return;
      polling = true;
      try {
        await family.inspect();
        if (ending) return;
        journal.processes = family.identities();
        journal.updatedAt = Date.now();
        await commit();
      } catch (e) { fatal(e); }
      finally { polling = false; if (!ending) pulse = setTimeout(() => { void poll(); }, 50); }
    }
    await poll();
  } catch (e) { fatal(e); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runGuardian(process.argv[2] ?? "").catch((e) => { process.stderr.write(`${errorText(e)}\n`); process.exitCode = 1; });
}
