import { readFileSync, writeFileSync } from 'node:fs';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { captureIdentity, LinuxProcessProbe, ProcessFamily, sameProcess, alive } from '../runtime/processes.js';
import { readJson } from '../runtime/io.js';
import type { ProcessIdentity, SessionLeaseOwner, SessionResourceRecord, SessionScope } from '../runtime/types.js';
import { samePackScope } from './pack-session.js';

export interface BrowserOwnerRecord {
  version: 2; sessionId: string; scope: SessionScope; profile: string; controller: ProcessIdentity;
  process?: ProcessIdentity; processes?: ProcessIdentity[]; endpoint?: string;
}
export const browserOwnerFile = (profile: string): string => path.join(profile, 'p2o-owner.json');
export function currentProcessIdentity(pid = process.pid): ProcessIdentity {
  const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const identity = captureIdentity(pid, boot);
  if (!identity || !alive(identity)) throw new Error('Cannot prove pack process identity');
  return identity;
}
/** Synchronous PID/start-time journal closes the spawn/event-loop cancellation gap. */
export function writeBrowserOwner(owner: BrowserOwnerRecord): void {
  writeFileSync(browserOwnerFile(owner.profile), JSON.stringify(owner), { mode: 0o600 });
}

/** Exact identities only. Never signal a pid-file PID just because it exists (or a profile substring). */
export async function terminateBrowserOwner(owner: BrowserOwnerRecord): Promise<number> {
  if (owner.version !== 2 || !/^bs-[a-f0-9]{24}$/.test(owner.sessionId) || !path.isAbsolute(owner.profile)) throw new Error('Invalid browser session identity');
  const probe = new LinuxProcessProbe();
  const marker = `--p2o-session-id=${owner.sessionId}`, profileArg = `--user-data-dir=${owner.profile}`;
  if (owner.processes && (!Array.isArray(owner.processes) || owner.processes.length > 64 || !owner.process || owner.processes.some(identity => identity.bootId !== owner.process!.bootId || identity.pgid !== owner.process!.pgid))) throw new Error('Browser descendant family identity mismatch; refusing to signal');
  let lastRows: Awaited<ReturnType<LinuxProcessProbe['snapshot']>> = [], hadOwned = false;
  let endpointChecked = false;
  // Validate actual session/profile arguments in the SAME authoritative inventory used by the killer,
  // not a separate stale pass. This also avoids redundant global scans eating the session TTL window.
  const guardedProbe = {
    snapshot: async () => {
      let rows = await probe.snapshot();
      const sampled = owner.process && rows.find(row => sameProcess(row, owner.process!));
      if (sampled) {
        // stat and cmdline are separate /proc reads. A process can exit/reap between them; revalidate
        // the kernel identity before treating an empty transitional argv as an identity violation.
        const current = captureIdentity(sampled.pid, sampled.bootId);
        if (!current || !sameProcess(current, sampled)) rows = rows.filter(row => row !== sampled);
        else sampled.state = current.state;
      }
      const row = owner.process && rows.find(row => sameProcess(row, owner.process!) && alive(row));
      const markerRows = rows.filter(row => alive(row) && row.argv.includes(profileArg));
      if (row && (!row.argv.includes(marker) || !row.argv.includes(profileArg) || row.pgid !== owner.process!.pgid)) throw new Error('Browser PID/start-time matches but actual profile/session identity does not; refusing to signal');
      if (!owner.process && markerRows.length) throw new Error('Browser creation identity was not recorded; refusing cleanup without PID/start-time/session proof');
      if (!row && markerRows.some(row => row.argv.includes(marker))) throw new Error('Browser session is live under a different PID/start-time; refusing to infer ownership');
      if (owner.processes?.some(identity => rows.some(row => sameProcess(row, identity) && row.pgid !== identity.pgid))) throw new Error('Actual browser descendant group identity mismatch');
      if (row && owner.endpoint && !endpointChecked) {
        const endpoint = new URL(owner.endpoint);
        // Kernel PID/start/session/profile arguments are mandatory; this private file is corroborating
        // evidence when present. A caller removing the profile cannot invalidate exact live kernel proof.
        const port = await readFile(path.join(owner.profile, 'DevToolsActivePort'), 'utf8').then(text => text.trim().split('\n')).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return undefined;
        });
        if (port && (endpoint.hostname !== '127.0.0.1' || endpoint.port !== port[0] || endpoint.pathname !== port[1])) throw new Error('Actual Chrome CDP/session endpoint identity mismatch');
        endpointChecked = true;
      }
      hadOwned ||= Boolean(row) || Boolean(owner.processes?.some(identity => rows.some(row => alive(row) && sameProcess(row, identity))));
      lastRows = rows; return rows;
    },
    lastSnapshotMs: () => probe.lastSnapshotMs(),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => probe.signal(pid, signal),
  };
  const roots = [...(owner.process ? [owner.process] : []), ...(owner.processes ?? [])];
  const family = new ProcessFamily(guardedProbe, roots);
  const result = await family.terminate({ deadlineAt: performance.now() + 1500, graceMs: 100, reason: 'stopped', now: () => performance.now() });
  if (!result.verified) throw new Error(`Browser teardown is unverified: ${result.error ?? `${result.survivors.length} process(es) survived`}`);
  const stragglers = lastRows.filter(row => alive(row) && (row.argv.includes(profileArg) || row.argv.includes(`--database=${owner.profile}/Crashpad`)));
  if (stragglers.length) throw new Error('Browser profile/session process(es) survived; refusing to remove recovery evidence or attest release');
  await rm(owner.profile, { recursive: true, force: true });
  return hadOwned ? 1 : 0;
}

/** Restart path driven by the actual runtime's durable enrolled resources, not a global profile scan. */
export async function recoverBrowserResources(resources: readonly SessionResourceRecord[], scope: SessionScope, owner: SessionLeaseOwner, profileRoot: string): Promise<{ released: number; resolved: string[] }> {
  if (!resources.length) throw new Error('Only a durable registry lease can prove an empty browser family');
  const probe = new LinuxProcessProbe(), rows = await probe.snapshot();
  if (rows.some(row => sameProcess(row, owner.process) && alive(row))) throw new Error('Browser controller identity is still live; refusing recovery');
  const root = await realpath(profileRoot), rootStat = await lstat(root), resolved: string[] = [];
  if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0 || rootStat.uid !== process.getuid?.()) throw new Error('Browser profile root is not an owned private directory');
  let released = 0;
  for (const resource of resources) {
    const data = resource.data as unknown as BrowserOwnerRecord;
    if (resource.state !== 'active' || !/^bs-[a-f0-9]{24}$/.test(resource.id) || data.version !== 2 ||
      data.sessionId !== resource.id || !data.scope || !samePackScope(data.scope, scope) ||
      !data.controller || !sameProcess(data.controller, owner.process)) throw new Error('Browser durable session/scope/controller identity mismatch');
    const profile = data.profile;
    if (profile === '' && !data.process) {
      resolved.push(resource.id); continue; // enrolled listener-only stage: Chrome dispatch was not yet possible
    }
    if (typeof profile !== 'string' || path.dirname(profile) !== root || !/^p2o-browser-[A-Za-z0-9]{6}$/.test(path.basename(profile))) throw new Error('Browser resource has no bounded private profile identity');
    let record: BrowserOwnerRecord | undefined;
    try {
      const stat = await lstat(profile);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || await realpath(profile) !== profile) throw new Error('Browser profile is not an owned private directory');
      record = await readJson<BrowserOwnerRecord>(browserOwnerFile(profile), 64 * 1024);
    } catch (error) {
      // Absence is proof only when the enrolled creation record already contains a process identity.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !resource.data.process) throw error;
      record = resource.data as unknown as BrowserOwnerRecord;
    }
    if (!record || record.sessionId !== resource.id || record.profile !== profile || !samePackScope(record.scope, scope) || !sameProcess(record.controller, owner.process)) throw new Error('Browser manifest/session/controller identity mismatch');
    if (resource.data.process && (!record.process || !sameProcess(record.process, resource.data.process as ProcessIdentity))) throw new Error('Browser durable process identity mismatch');
    if (JSON.stringify(record.processes ?? []) !== JSON.stringify(resource.data.processes ?? [])) throw new Error('Browser durable descendant identities mismatch');
    released += await terminateBrowserOwner(record);
    resolved.push(resource.id);
  }
  return { released, resolved };
}
