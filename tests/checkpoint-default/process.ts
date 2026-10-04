/**
 * DEFAULT bundled-entry checkpoint/restart qualification.
 *
 * Both processes use the REAL bundled `/p2o` command, the real inert loopback provider, automated human
 * dialogs, the real supervisor and real enrolled Docker containers. Process one SIGKILLs itself like an
 * operator crash: no release hook, no session teardown, no cleanup handler runs.
 *
 * `persist`/`restore` interrupt the controller immediately after the worker attempt owns its durable
 * launch/handle and before its first provider turn. Fresh process two's FIRST command is `/p2o resume <runId>`,
 * which exercises `entry.resume` -> `restoreFlow` -> `createApplication`: the original immutable source must be
 * reused, the pinned phase spend must continue instead of resetting, and a NEW physical attempt with a NEW
 * enrolled container must run through the bundled entry.
 *
 * `persist-mid`/`restore-mid` interrupt a worker that already consumed its finite phase program. The restored
 * run must be refused further provider turns by the durable spend ledger (explicit model-spend refusal) and no
 * committed turn/cost counter may reset or borrow from another phase.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { commandHarness } from '../autonomous-integration/harness.js';

const [mode, root] = process.argv.slice(2) as [string, string];
if (!['persist', 'persist-mid', 'persist-live-controller', 'restore', 'restore-mid', 'restore-live-controller', 'restore-vault-tamper'].includes(mode) || !root) {
  process.stderr.write('usage: process.js <persist|persist-mid|persist-live-controller|restore|restore-mid|restore-live-controller|restore-vault-tamper> <root>\n');
  process.exit(2);
}
if (mode === 'persist' || mode === 'persist-mid') mkdirSync(root, { recursive: true, mode: 0o700 });
const storageRoot = join(root, 'owner-consent');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const readJson = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
const runRootOf = (): string => join(root, 'runs', readdirSync(join(root, 'runs')).filter(name => name.startsWith('assessment-')).sort()[0]!);
const checkpointOf = (runId: string) => join(root, 'checkpoints', runId, 'checkpoint.json');
const output = (line: string) => process.stdout.write(`${line}\n`);

function handles(control: string): Record<string, any> {
  const directory = join(control, 'handles');
  if (!existsSync(directory)) return {};
  return Object.fromEntries(readdirSync(directory).filter(name => name.endsWith('.json')).map(name => [name.slice(0, -5), readJson(join(directory, name))]));
}
function phaseJournals(statePath: string): Record<string, any> {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    return Object.fromEntries(db.prepare('SELECT phase, json FROM autonomous_phase_journals').all().map(row => [String(row.phase), JSON.parse(String(row.json))]));
  } finally { db.close(); }
}
function attemptsOf(statePath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try { return db.prepare('SELECT attempt_id, lifecycle_state, sequence FROM attempts ORDER BY sequence').all() as never; }
  finally { db.close(); }
}
function leasesOf(statePath: string): Array<Record<string, unknown>> {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try { return db.prepare('SELECT task_id, attempt_id FROM workspace_leases').all() as never; }
  finally { db.close(); }
}
function eventTypes(statePath: string): string[] {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try { return (db.prepare('SELECT type FROM events ORDER BY sequence').all() as Array<{ type: string }>).map(row => String(row.type)); }
  finally { db.close(); }
}
/** Provider turns the phase has already admitted (settled, held or released); the pinned cap is finite. */
function admittedTurns(journal: any): number {
  const sum = (map: any) => Object.values(map ?? {}).reduce((total: number, reservation: any) => total + Number(reservation?.admittedTurns ?? 0), 0);
  return sum(journal?.reservations) + sum(journal?.released);
}
function docker(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync('/usr/bin/docker', args, { encoding: 'utf8', timeout: 30_000 });
}
function enrolledContainers(runId: string): string[] {
  const result = docker(['ps', '-a', '--filter', `label=org.pi-p2o.container.run=${runId}`, '--format', '{{.ID}}']);
  if (result.status !== 0) throw new Error(`docker ps failed: ${result.stderr}`);
  return result.stdout.trim().split('\n').filter(Boolean);
}
function inspectContainer(id: string): any | undefined {
  const result = docker(['inspect', id]);
  if (result.status !== 0) return undefined;
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed[0] : undefined;
}
async function until<T>(what: string, ms: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms; let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value !== undefined) return value; } catch (error) { last = error; }
    await sleep(25);
  }
  throw new Error(`deadline: ${what}${last ? ` (${String(last)})` : ''}`);
}
/** Any live host process whose argv still points inside the run (guardian or worker Pi) defeats recovery. */
function runProcessesAlive(runRoot: string): boolean {
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try { if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(runRoot)) return true; } catch { /* process raced away */ }
  }
  return false;
}
/** Exact real kernel identity of one live process (pid + boot id + start ticks), from /proc. */
function identityOfPid(pid: number): { pid: number; ppid: number; pgid: number; state: string; startTicks: string; bootId: string } {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), state: fields[0]!, startTicks: fields[19]!, bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
}
/** True while the recorded kernel identity still names a live process (pid + boot + start ticks). */
function processAlive(identity: { pid?: number; startTicks?: string } | undefined): boolean {
  if (!identity?.pid || !identity.startTicks) return false;
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return fields[19] === identity.startTicks && fields[0] !== 'Z' && fields[0] !== 'X';
  } catch { return false; }
}
const tokens = (journal: any) => Number(journal?.committed?.tokens ?? 0);
const costMicros = (journal: any) => Number(journal?.committed?.costMicros ?? 0);

function snapshotFor(runRoot: string, control: string, attemptId: string | undefined, containerId: string | undefined, handle: unknown): Record<string, unknown> {
  const runId = String(JSON.parse(readFileSync(join(control, 'application.json'), 'utf8')).run.runId);
  const checkpoint = readJson(checkpointOf(runId));
  const budget = readJson(join(runRoot, 'autonomous-budget.json'));
  const vaultRoot = join(runRoot, 'vault');
  const writer = existsSync(join(vaultRoot, '.writer')) ? lstatSync(join(vaultRoot, '.writer')) : undefined;
  return {
    runId, runRoot, control, vault: { root: vaultRoot, writer: writer ? { dev: String(writer.dev), ino: String(writer.ino) } : null }, statePath: join(runRoot, 'state.sqlite'), sourceRoot: join(root, 'source'),
    sourceSealRoot: checkpoint.checkpoint.source.seal.root,
    sourceIdentity: checkpoint.checkpoint.source.identity,
    planDigest: checkpoint.checkpoint.planDigest,
    mountDigest: checkpoint.checkpoint.mountDigest,
    workerMaxTurns: budget.phases.workers.maxTurns,
    checkpointUsage: checkpoint.checkpoint.progress.usage,
    phases: phaseJournals(join(runRoot, 'state.sqlite')),
    attemptId, containerId, handle,
    persistedAt: new Date().toISOString(),
  };
}

if (mode === 'persist' || mode === 'persist-mid' || mode === 'persist-live-controller') {
  const mid = mode === 'persist-mid';
  const liveController = mode === 'persist-live-controller';
  const harness = await commandHarness({ root, storageRoot, ...(mid ? { holdWorkerMs: 600_000 } : {}) });
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'index.ts'), 'export const marker = "DEFAULT_BUNDLED_CHECKPOINT_RESTART";\n');
  const run = await harness.command(`--target ${source}`);
  if (!run?.runId) throw new Error(`default target command did not admit a run: ${String(JSON.stringify(run)).slice(0, 400)} notifications=${String(JSON.stringify(harness.notifications)).slice(0, 1600)}`);
  const runRoot = runRootOf(), control = runRoot && join(runRoot, 'control'), statePath = join(runRoot, 'state.sqlite');
  if (mid) {
    // Interrupt only after the real worker's container exists: the enrolled resource is physically live.
    const live = await until('durable worker handle and enrolled container', 120_000, () => {
      const found = handles(control);
      const attemptId = Object.keys(found).sort()[0];
      if (!attemptId) return undefined;
      const containerId = enrolledContainers(run.runId)[0];
      return containerId ? { attemptId, containerId, handle: found[attemptId] } : undefined;
    });
    writeJson(join(root, 'original.json'), snapshotFor(runRoot, control, live.attemptId, live.containerId, live.handle));
    output(`CHECKPOINT_DEFAULT_PERSIST_READY ${run.runId} ${live.attemptId} ${live.containerId}`);
    process.kill(process.pid, 'SIGKILL');
    await sleep(60_000);
  }
  // Pre-turn interruption: wait for the durable attempt itself and kill before its first provider turn is
  // admitted, so the pinned phase program stays fully available to the restarted attempt.
  const claimed = await until('durable attempt handle with captured native identity plus persisted checkpoint', 60_000, () => {
    if (!existsSync(checkpointOf(run.runId))) return undefined;
    const found = handles(control);
    const attemptId = Object.keys(found).sort()[0];
    const handle = attemptId ? found[attemptId] : undefined;
    return handle?.native?.guardian ? { attemptId, handle } : undefined;
  });
  const phases = phaseJournals(statePath);
  if (admittedTurns(phases.workers) !== 0 || tokens(phases.workers) !== 0) {
    // The first provider turn beat the kill; the finite phase program is partially consumed. Let the runner
    // start a fresh run instead of pretending this state qualifies.
    output(`CHECKPOINT_DEFAULT_PERSIST_RETRY admitted=${admittedTurns(phases.workers)}`);
    process.exit(0);
  }
  const snapshot: Record<string, unknown> = snapshotFor(runRoot, control, claimed.attemptId, undefined, claimed.handle);
  if (liveController) {
    // Fixture: the run's durable controller lease is re-bound to a REAL live kernel identity, so the original
    // controller is still alive while every worker resource is quiescent. The vault writer must survive.
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { detached: true, stdio: 'ignore' });
    sentinel.unref();
    const identity = identityOfPid(sentinel.pid!);
    const sessionRoot = join(control, 'container-controller-sessions');
    for (const name of readdirSync(sessionRoot)) {
      if (!/^lease-[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(sessionRoot, name);
      const lease = readJson(path);
      lease.owner = { ...(lease.owner ?? {}), process: identity };
      writeFileSync(path, JSON.stringify(lease));
    }
    snapshot.sentinel = { pid: sentinel.pid, identity };
  }
  writeJson(join(root, 'original.json'), snapshot);
  output(`CHECKPOINT_DEFAULT_PERSIST_READY ${run.runId} ${claimed.attemptId} none`);
  process.kill(process.pid, 'SIGKILL');
  await sleep(60_000);
}

if (mode === 'restore-vault-tamper') {
  const snapshot = readJson(join(root, 'original.json'));
  // Re-point the durable vault root at a foreign path: discovery must refuse the exact-layout mismatch before
  // any reconciliation or writer release, and the real controller writer inode must survive untouched.
  const applicationPath = join(snapshot.control, 'application.json');
  const application = readJson(applicationPath);
  application.roots.vault = join(root, 'foreign-vault');
  writeFileSync(applicationPath, JSON.stringify(application));
  const harness = await commandHarness({ root, storageRoot });
  for (const end = Date.now() + 60_000; runProcessesAlive(snapshot.runRoot) && Date.now() < end;) await sleep(250);
  const resumed: any = await harness.command(`resume ${snapshot.runId}`);
  const refusal = harness.notifications.map((notification: any) => String(notification.message)).find(message => message.includes('CHECKPOINT_DISCOVERY'));
  if (!refusal) throw new Error(`a tampered vault root was not refused at discovery: ${String(JSON.stringify({ resumed, notifications: harness.notifications })).slice(0, 900)}`);
  const writer = lstatSync(join(snapshot.vault.root, '.writer'));
  if (!snapshot.vault.writer || String(writer.dev) !== snapshot.vault.writer.dev || String(writer.ino) !== snapshot.vault.writer.ino) {
    throw new Error('the evidence vault writer inode changed after a refused tampered-vault restart');
  }
  output('CHECKPOINT_DEFAULT_VAULT_ROOT_TAMPER_REFUSED');
  await harness.close();
  rmOwnRoot();
  process.exit(0);
}

if (mode === 'restore-live-controller') {
  const snapshot = readJson(join(root, 'original.json'));
  const harness = await commandHarness({ root, storageRoot });
  // Worker resources are quiescent: the killed controller's detached guardian/worker family has exited.
  for (const end = Date.now() + 60_000; runProcessesAlive(snapshot.runRoot) && Date.now() < end;) await sleep(250);
  const resumed: any = await harness.command(`resume ${snapshot.runId}`);
  const refusal = harness.notifications.map((notification: any) => String(notification.message))
    .find(message => message.includes('CHECKPOINT_RESOURCE') && message.includes('the original controller process is still live'));
  if (!refusal) throw new Error(`a live original controller was not refused by the vault-writer ownership proof: ${String(JSON.stringify({ resumed, notifications: harness.notifications })).slice(0, 900)}`);
  const writer = lstatSync(join(snapshot.vault.root, '.writer'));
  if (String(writer.dev) !== snapshot.vault.writer.dev || String(writer.ino) !== snapshot.vault.writer.ino) {
    throw new Error('the evidence vault writer inode changed during a refused restart');
  }
  if (!processAlive(snapshot.sentinel.identity)) throw new Error('the live controller sentinel disappeared; the refusal did not face a live identity');
  process.kill(snapshot.sentinel.pid, 'SIGKILL');
  output('CHECKPOINT_DEFAULT_LIVE_CONTROLLER_REFUSED_WRITER_UNTOUCHED');
  await harness.close();
  rmOwnRoot();
  process.exit(0);
}

if (mode === 'restore' || mode === 'restore-mid') {
  const mid = mode === 'restore-mid';
  const snapshot = readJson(join(root, 'original.json'));
  const before = phaseJournals(snapshot.statePath);
  if (snapshot.containerId) {
    const old = inspectContainer(snapshot.containerId);
    if (!old) throw new Error('the original enrolled container must still exist before restart; physical recovery could not be observed otherwise');
  }
  const harness = await commandHarness({ root, storageRoot });
  const family = [snapshot.handle?.native?.guardian, ...(snapshot.handle?.native?.processes ?? [])].filter(Boolean);
  // The controller is dead; its detached guardian/worker family must exit on the broken pipe. Wait for both the
  // recorded kernel identities and any run-owned argv marker to disappear, so recovery sees a real dead resource.
  for (const end = Date.now() + 60_000; (family.some(processAlive) || runProcessesAlive(snapshot.runRoot)) && Date.now() < end;) await sleep(250);
  const restoreStartedAt = Date.now();
  const observed = new Map<string, any>();
  const poll = setInterval(() => {
    try { for (const id of enrolledContainers(snapshot.runId)) if (!observed.has(id)) observed.set(id, inspectContainer(id)); } catch { /* transient daemon listing failure */ }
  }, 100);
  let resumed: any;
  let settled: any;
  try {
    // The human entry point of a FRESH process: /p2o resume -> bundled entry.resume -> restoreFlow.
    resumed = await harness.command(`resume ${snapshot.runId}`);
    if (resumed?.state !== 'active') throw new Error(`default resume did not report an active run: ${String(JSON.stringify(resumed)).slice(0, 400)} notifications=${String(JSON.stringify(harness.notifications)).slice(0, 2500)}`);
    settled = await until('restarted run to settle', 240_000, async () => {
      const status: any = await harness.controller.execute('status', { runId: snapshot.runId }, harness.cwd);
      // Do not persist a checkpoint from the status poll while the run is still mid-attempt: only settle states stop the poll.
      return status?.run?.state && ['completed', 'failed', 'cancelled'].includes(status.run.state) ? status : undefined;
    });
  } finally { clearInterval(poll); }

  if (mid) {
    if (settled.run.state !== 'failed') throw new Error(`a mid-program restart must be refused further provider turns, settled as ${settled.run.state}`);
    const after = phaseJournals(snapshot.statePath);
    if (tokens(after.workers) < tokens(before.workers) || costMicros(after.workers) < costMicros(before.workers)) throw new Error('a refused restart reset worker spend');
    if (admittedTurns(after.workers) > Number(snapshot.workerMaxTurns)) throw new Error(`a refused restart admitted ${admittedTurns(after.workers)} turns beyond the pinned cap ${snapshot.workerMaxTurns}`);
    for (const phase of ['planner', 'verifier', 'report'] as const) {
      if (tokens(after[phase]) !== tokens(before[phase]) || costMicros(after[phase]) !== costMicros(before[phase])) throw new Error(`a refused restart borrowed from the ${phase} phase`);
    }
    if (!eventTypes(snapshot.statePath).includes('orchestrator.spend-truncated')) throw new Error('the refusal was not recorded as a durable model-spend truncation');
    const attempts = attemptsOf(snapshot.statePath);
    if (attempts.length !== 2 || attempts[1]!.lifecycle_state !== 'failed') throw new Error(`mid-program restart attempts were ${JSON.stringify(attempts)}`);
    if (inspectContainer(snapshot.containerId)) throw new Error('the original container was not physically reclaimed by restart recovery');
    output('CHECKPOINT_DEFAULT_MIDEXECUTION_SPEND_REFUSED_NO_RESET');
    await harness.close();
    rmOwnRoot();
    process.exit(0);
  }

  if (settled.run.state !== 'completed') throw new Error(`restarted run settled as ${settled.run.state}: ${JSON.stringify(settled.run).slice(0, 600)}`);
  // 1. Original immutable source, plan approval and mount identity survived unchanged: no reacquisition.
  const checkpoint = readJson(checkpointOf(snapshot.runId));
  if (checkpoint.checkpoint.planDigest !== snapshot.planDigest) throw new Error('restart changed the approved plan digest');
  if (checkpoint.checkpoint.source.identity.digest !== snapshot.sourceIdentity.digest) throw new Error('restart reacquired a different source identity');
  if (checkpoint.checkpoint.source.seal.root !== snapshot.sourceSealRoot) throw new Error('restart changed the immutable source root');
  if (checkpoint.checkpoint.progress.usage.tokens < snapshot.checkpointUsage.tokens) throw new Error('restart reset the checkpointed token usage');
  const sourceApproval = readJson(join(snapshot.control, 'source-approval.json'));
  if (sourceApproval.source.digest !== snapshot.sourceIdentity.digest || sourceApproval.planDigest !== snapshot.planDigest) throw new Error('restart re-wrote the source approval identity');
  if (readFileSync(join(snapshot.sourceRoot, 'index.ts'), 'utf8') !== readFileSync(join(snapshot.sourceSealRoot, 'index.ts'), 'utf8')) throw new Error('restored immutable snapshot no longer matches the original approved source');
  output('CHECKPOINT_DEFAULT_ORIGINAL_SOURCE_REUSED');
  // 2. The pinned phase spend continued on the SAME durable ledgers; planning was not re-run or re-charged.
  const after = phaseJournals(snapshot.statePath);
  if (tokens(after.planner) !== tokens(before.planner)) throw new Error(`restart re-ran planning (planner tokens ${tokens(before.planner)} -> ${tokens(after.planner)})`);
  if (!(tokens(after.workers) > tokens(before.workers))) throw new Error(`restart did not continue the durable worker spend (${tokens(before.workers)} -> ${tokens(after.workers)})`);
  if (costMicros(after.workers) < costMicros(before.workers)) throw new Error('restart reset the durable worker cost');
  if (!harness.provider.requests.length) throw new Error('the restarted run made no worker model call');
  if (!harness.provider.requests.every((request: any) => (request.tools ?? []).some((tool: any) => tool.function?.name === 'p2o_context'))) throw new Error('a fresh-process restart issued a non-worker (planning) model call');
  output('CHECKPOINT_DEFAULT_SPEND_CONTINUED_NOT_RESET');
  output('CHECKPOINT_DEFAULT_NO_REPLANNING_MODEL_CALL');
  // 3. The interrupted attempt was reconciled to a terminal state and its lease released by the restart.
  const attemptRows = attemptsOf(snapshot.statePath);
  const old = attemptRows.find(row => row.attempt_id === snapshot.attemptId);
  if (!old || !['exited', 'failed'].includes(String(old.lifecycle_state))) throw new Error(`the interrupted attempt was not reconciled terminal: ${JSON.stringify(old)}`);
  if (leasesOf(snapshot.statePath).some(lease => lease.attempt_id === snapshot.attemptId)) throw new Error('the interrupted attempt workspace lease survived the restart');
  // 4. A NEW attempt ran on the restored source through the backend entry, with a verified physical release.
  const afterHandles = handles(snapshot.control);
  const newAttempts = Object.keys(afterHandles).filter(id => id !== snapshot.attemptId).sort();
  if (!newAttempts.length) throw new Error('the restart created no new attempt handle');
  if (!newAttempts.some(id => afterHandles[id]?.sessionRelease?.verified === true)) throw new Error('the restarted attempt has no verified physical session release');
  // 5. The new attempt physically owned a NEW enrolled container created after the restart began.
  const created = [...observed.entries()].filter(([, record]) => record?.Created && Date.parse(record.Created) >= restoreStartedAt - 2_000 && newAttempts.includes(record.Config?.Labels?.['org.pi-p2o.container.attempt']));
  if (!created.length) throw new Error(`no new attempt-owned physical container was observed for the restarted run (observed ${observed.size})`);
  const [newContainerId] = created.sort((a, b) => Date.parse(a[1].Created) - Date.parse(b[1].Created))[0]!;
  if (snapshot.containerId && inspectContainer(snapshot.containerId)) throw new Error('the original container was not physically reclaimed by restart recovery');
  output('CHECKPOINT_DEFAULT_NEW_ATTEMPT_AND_CONTAINER');
  output(`CHECKPOINT_DEFAULT_NEW_ATTEMPT ${newAttempts[0]} ${newContainerId}`);
  output('CHECKPOINT_DEFAULT_TWO_PROCESS_RESTART_OK');
  await harness.close();
  rmOwnRoot();
}

function rmOwnRoot(): void {
  if (process.env.P2O_CHECKPOINT_DEFAULT_KEEP_ROOT === '1') return;
  spawnSync('chmod', ['-R', 'u+rwX', root], { encoding: 'utf8', timeout: 30_000 });
  spawnSync('rm', ['-rf', '--', root], { encoding: 'utf8', timeout: 30_000 });
}
