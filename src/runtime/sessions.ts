import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { attemptKey } from './filesystem-hooks.js';
import { atomicJson, clone, errorText, privateDirectory, readJson, until } from './io.js';
import { alive, sameProcess } from './processes.js';
import { samePackScope, type PackSessionLifecycle } from '../tools/pack-session.js';
import type {
  ProcessIdentity, ProcessProbe, SessionLeaseOwner, SessionReleaseOptions, SessionReleaseReason, SessionReleaseReceipt,
  SessionReleaser, SessionReleaserResult, SessionResourceRecord, SessionScope, SessionSweepEntry, SessionSweepReceipt,
} from './types.js';

export interface AttemptSessionPack {
  readonly sessions?: number;
  releaseAttempt(scope: SessionScope): Promise<number>;
  outstanding?(scope: SessionScope): number | Promise<number>;
  close?(): Promise<void>;
}
export class SessionLeaseError extends Error {}
const MAX_LEASES = 4096;
const MAX_PACKS = 32;
const MAX_RESOURCES = 256;
const MAX_LEASE_BYTES = 1024 * 1024;
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identifier = (value: string, max: number): boolean => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export interface SessionLeaseRecord {
  version: 1; attemptKey: string; scope: SessionScope; owner: SessionLeaseOwner;
  state: 'open' | 'released' | 'swept'; openedAt: number; updatedAt: number;
  /** Cleanup failures remain retryable, but the use/create fence NEVER reopens. */
  fencedAt?: number;
  resources?: SessionResourceRecord[];
  release?: SessionReleaseReceipt;
  sweep?: { at: number; state: SessionSweepEntry['state']; released?: number; outstanding?: number; error?: string; sweptBy: ProcessIdentity };
}
export interface SessionReleaseRegistryOptions {
  root: string; probe: ProcessProbe; now: () => number; monoNow: () => number; config?: SessionReleaseOptions;
}

/** Durable, bounded attempt fencing and evidence-backed release. No default pack registration. */
export class SessionReleaseRegistry {
  private readonly instance = randomUUID();
  private readonly releasers = new Map<string, SessionReleaser>();
  private readonly receipts = new Map<string, SessionReleaseReceipt>();
  private readonly releases = new Map<string, Promise<SessionReleaseReceipt>>();
  private readonly flights = new Map<string, Promise<SessionReleaseReceipt>>();
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly fenced = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly totalTimeoutMs: number;
  private directory?: Promise<unknown>;
  private shuttingDown?: Promise<void>;
  private closed = false;
  private sweeping?: Promise<SessionSweepReceipt>;

  constructor(private readonly options: SessionReleaseRegistryOptions) {
    const config = options.config ?? {};
    const timeout = config.timeoutMs ?? 2000;
    if (!Number.isSafeInteger(timeout) || timeout < 50 || timeout > 30_000) throw new Error('Invalid session release timeoutMs');
    const total = config.totalTimeoutMs ?? Math.max(4 * timeout, 5000);
    if (!Number.isSafeInteger(total) || total < timeout || total > 60_000) throw new Error('Invalid session release totalTimeoutMs');
    this.timeoutMs = timeout; this.totalTimeoutMs = total;
    for (const releaser of config.releasers ?? []) this.register(releaser);
  }

  register(releaser: SessionReleaser): void {
    if (!releaser || !identifier(releaser.name, 64) || typeof releaser.release !== 'function') throw new Error('Session releaser requires a bounded name and release(scope)');
    const existing = this.releasers.get(releaser.name);
    if (existing) {
      if (existing !== releaser) throw new Error(`Session releaser ${releaser.name} is already registered by another pack`);
      return;
    }
    if (this.closed || this.releasers.size >= MAX_PACKS) throw new Error('Session pack registration closed or inventory limit exceeded');
    // Preserve callback receivers and identity; spreading a class instance loses its prototype methods.
    this.releasers.set(releaser.name, releaser);
  }
  get size(): number { return this.releasers.size; }
  names(): string[] { return [...this.releasers.keys()]; }
  private leaseFile(scope: SessionScope): string { return path.join(this.options.root, `lease-${attemptKey(scope)}.json`); }
  private async ready(): Promise<void> { this.directory ??= privateDirectory(this.options.root); await this.directory; }
  private async write(lease: SessionLeaseRecord): Promise<void> {
    if (Buffer.byteLength(JSON.stringify(lease)) > MAX_LEASE_BYTES) throw new SessionLeaseError('Durable session inventory byte limit exceeded');
    await this.ready(); await atomicJson(this.leaseFile(lease.scope), lease);
  }
  private mutate<T>(scope: SessionScope, work: () => Promise<T>): Promise<T> {
    const key = attemptKey(scope), previous = this.mutations.get(key) ?? Promise.resolve();
    const pending = previous.then(work, work);
    this.mutations.set(key, pending);
    void pending.finally(() => { if (this.mutations.get(key) === pending) this.mutations.delete(key); }).catch(() => {});
    return pending;
  }
  private validate(lease: SessionLeaseRecord, scope: SessionScope): void {
    if (lease.version !== 1 || lease.attemptKey !== attemptKey(scope) || !samePackScope(lease.scope, scope) ||
      !lease.owner || !identifier(lease.owner.token, 256) || !lease.owner.process || !Number.isSafeInteger(lease.owner.process.pid) ||
      !/^\d+$/.test(lease.owner.process.startTicks) || !identifier(lease.owner.process.bootId, 128) ||
      !['open', 'released', 'swept'].includes(lease.state) ||
      (lease.resources !== undefined && (!Array.isArray(lease.resources) || lease.resources.length > MAX_RESOURCES ||
        lease.resources.some(r => !identifier(r.pack, 64) || !identifier(r.id, 128) || !['active', 'resolved'].includes(r.state) || !r.data || typeof r.data !== 'object')))) {
      throw new SessionLeaseError('Session lease file does not match its attempt/process/resource identity');
    }
  }
  async read(scope: SessionScope): Promise<SessionLeaseRecord | undefined> {
    const lease = await readJson<SessionLeaseRecord>(this.leaseFile(scope), MAX_LEASE_BYTES);
    if (lease) this.validate(lease, scope);
    return lease;
  }
  async open(scope: SessionScope, ownerToken: string, process: ProcessIdentity): Promise<void> {
    await this.mutate(scope, async () => {
      if (this.closed) throw new SessionLeaseError('Session registry is sealed after shutdown');
      await this.ready();
      const existing = await this.read(scope);
      if (existing) {
        if (existing.owner.token !== ownerToken || existing.owner.instance !== this.instance || !sameProcess(existing.owner.process, process)) throw new SessionLeaseError(`Session lease for attempt ${scope.attemptId} belongs to another attempt owner`);
        if (existing.state !== 'open' || existing.fencedAt !== undefined || this.fenced.get(attemptKey(scope)) === ownerToken || this.closed) throw new SessionLeaseError(`Session lease for attempt ${scope.attemptId} is sealed; a terminated attempt can never own a new session`);
        return;
      }
      const now = this.options.now();
      const lease: SessionLeaseRecord = { version: 1, attemptKey: attemptKey(scope), scope: { ...scope },
        owner: { instance: this.instance, token: ownerToken, process: clone(process), at: now }, state: 'open', openedAt: now, updatedAt: now, resources: [] };
      this.validate(lease, scope);
      await this.write(lease);
    });
  }
  async assertOpen(scope: SessionScope, ownerToken: string): Promise<void> {
    const lease = await this.read(scope);
    if (!lease) throw new SessionLeaseError(`No session lease exists for attempt ${scope.attemptId}`);
    if (lease.owner.token !== ownerToken) throw new SessionLeaseError(`Session lease for attempt ${scope.attemptId} belongs to another attempt owner`);
    if (this.closed || lease.state !== 'open' || lease.fencedAt !== undefined || this.fenced.get(attemptKey(scope)) === ownerToken) throw new SessionLeaseError(`Session lease for attempt ${scope.attemptId} is sealed; a stale session cannot be reused`);
    if (lease.owner.instance !== this.instance) throw new SessionLeaseError(`Session lease for attempt ${scope.attemptId} is held by another controller; recovery never grants permission to reuse its sessions`);
  }

  /** Explicit constructor hook for browser/proxy/container workers; enrollment is not inferred from responders. */
  binding(scope: SessionScope, ownerToken: string, pack: string): PackSessionLifecycle {
    if (!identifier(pack, 64) || !this.releasers.has(pack)) throw new SessionLeaseError(`No session pack is registered as ${pack}`);
    const checkScope = (context: SessionScope) => { if (!samePackScope(scope, context)) throw new SessionLeaseError('Pack binding belongs to another attempt'); };
    return Object.freeze({
      check: async (context: SessionScope) => { checkScope(context); await this.assertOpen(scope, ownerToken); },
      enroll: async (context: SessionScope, id: string, data: Record<string, unknown> = {}) => {
        checkScope(context);
        await this.mutate(scope, async () => {
          await this.assertOpen(scope, ownerToken);
          if (!identifier(id, 128)) throw new SessionLeaseError('Invalid pack resource identity');
          const lease = (await this.read(scope))!;
          const resources = lease.resources ?? [];
          if (resources.some(r => r.pack === pack && r.id === id) || resources.length >= MAX_RESOURCES) throw new SessionLeaseError('Pack resource already enrolled or inventory limit exceeded');
          if (Buffer.byteLength(JSON.stringify(data)) > 16 * 1024) throw new SessionLeaseError('Pack resource evidence limit exceeded');
          resources.push({ pack, id, state: 'active', data: clone(data) });
          await this.write({ ...lease, resources, updatedAt: this.options.now() });
        });
      },
      update: async (context: SessionScope, id: string, data: Record<string, unknown>) => { checkScope(context); await this.resourceMutation(scope, ownerToken, pack, id, data); },
      resolve: async (context: SessionScope, id: string) => { checkScope(context); await this.resourceMutation(scope, ownerToken, pack, id); },
    });
  }
  private async resourceMutation(scope: SessionScope, token: string, pack: string, id: string, data?: Record<string, unknown>): Promise<void> {
    await this.mutate(scope, async () => {
      const lease = await this.read(scope);
      if (!lease || lease.owner.token !== token) throw new SessionLeaseError('Foreign resource ownership');
      const resource = lease.resources?.find(r => r.pack === pack && r.id === id);
      if (!resource) throw new SessionLeaseError('Unknown enrolled pack resource');
      if (data) {
        if (resource.state !== 'active' || Buffer.byteLength(JSON.stringify(data)) > 16 * 1024) throw new SessionLeaseError('Resolved resource or evidence limit exceeded');
        resource.data = clone(data);
      } else resource.state = 'resolved';
      await this.write({ ...lease, updatedAt: this.options.now() });
    });
  }
  async inventory(scope: SessionScope, pack: string): Promise<SessionResourceRecord[]> {
    return clone((await this.read(scope))?.resources?.filter(r => r.pack === pack && r.state === 'active') ?? []);
  }
  /** Recovery hook: only retire durable resources after the owning pack proves absence, with exact lease token. */
  async resolveResource(scope: SessionScope, ownerToken: string, pack: string, id: string): Promise<void> { await this.resourceMutation(scope, ownerToken, pack, id); }

  private async seal(scope: SessionScope, token: string): Promise<SessionLeaseRecord | undefined> {
    return this.mutate(scope, async () => {
      const lease = await this.read(scope);
      if (!lease) return undefined;
      if (lease.owner.token !== token) throw new SessionLeaseError('Session lease belongs to another attempt owner; refusing to release a foreign lease');
      if (lease.owner.instance !== this.instance && (await until(this.options.probe.snapshot(), this.options.monoNow() + this.timeoutMs, this.options.monoNow)).some(row => sameProcess(row, lease.owner.process) && alive(row))) throw new SessionLeaseError('Session lease is held by another live controller; refusing to release a foreign lease');
      this.fenced.set(attemptKey(scope), token);
      if (lease.fencedAt === undefined) { lease.fencedAt = this.options.now(); await this.write(lease); }
      return lease;
    });
  }
  async release(scope: SessionScope, ownerToken: string, reason: SessionReleaseReason, options: { timeoutMs?: number } = {}): Promise<SessionReleaseReceipt> {
    const flightKey = `${attemptKey(scope)}:${ownerToken}`;
    const concurrent = this.flights.get(flightKey);
    if (concurrent) return concurrent.then(receipt => receipt.verified ? { ...clone(receipt), duplicate: true, state: 'already-released' as const } : clone(receipt));
    const key = attemptKey(scope), previous = Promise.allSettled([this.releases.get(key) ?? Promise.resolve(), this.sweeping ?? Promise.resolve()]);
    // Fence synchronously for callers already in the process of creating a resource. Foreign tokens cannot fence the owner.
    if (!this.fenced.has(key)) this.fenced.set(key, ownerToken);
    const queued = previous.then(() => this.releaseAttempt(scope, ownerToken, reason, options), () => this.releaseAttempt(scope, ownerToken, reason, options));
    this.releases.set(key, queued);
    this.flights.set(flightKey, queued);
    void queued.finally(() => {
      if (this.releases.get(key) === queued) this.releases.delete(key);
      if (this.flights.get(flightKey) === queued) this.flights.delete(flightKey);
    }).catch(() => {});
    return queued;
  }
  private async call(releaser: SessionReleaser, scope: SessionScope, deadline: number, owner?: SessionLeaseOwner): Promise<SessionReleaserResult> {
    const started = this.options.monoNow(), name = releaser.name;
    try {
      if (this.options.monoNow() >= deadline) throw new Error('Session release bounded total deadline exhausted before this pack was called');
      if (owner && !releaser.sweep && !releaser.ownsNoResources) throw new Error('No registered pack crash-recovery sweep for this resource family');
      const released = await until(Promise.resolve(owner && releaser.sweep ? releaser.sweep(scope, owner) : releaser.release(scope)), deadline, this.options.monoNow);
      if (released !== undefined && !validCount(released)) throw new Error('Invalid released session count');
      const outstanding = releaser.outstanding ? await until(Promise.resolve(releaser.outstanding(scope)), deadline, this.options.monoNow) : releaser.ownsNoResources ? 0 : undefined;
      if (!validCount(outstanding)) throw new Error('Pack release is unverified: no attributable outstanding/absence proof');
      const unresolved = await until(this.inventory(scope, name), deadline, this.options.monoNow);
      if (unresolved.length) throw new Error(`${unresolved.length} enrolled resource(s) remain unresolved; an empty responder is not proof of release`);
      return { name, outcome: 'released', ...(released === undefined ? {} : { released }), outstanding, ms: this.options.monoNow() - started };
    } catch (error) { return { name, outcome: 'failed', error: errorText(error), ms: this.options.monoNow() - started }; }
  }
  private async releaseAttempt(scope: SessionScope, token: string, reason: SessionReleaseReason, options: { timeoutMs?: number }): Promise<SessionReleaseReceipt> {
    const started = this.options.monoNow(), at = this.options.now(), key = attemptKey(scope);
    const receipt = (partial: Pick<SessionReleaseReceipt, 'state' | 'verified' | 'outstanding' | 'releasers'> & Partial<SessionReleaseReceipt>): SessionReleaseReceipt =>
      ({ version: 1, scope: { ...scope }, attemptKey: key, reason, at, duplicate: false, ms: this.options.monoNow() - started, ...partial });
    let lease: SessionLeaseRecord | undefined;
    try { lease = await until(this.seal(scope, token), started + this.totalTimeoutMs, this.options.monoNow); }
    catch (error) {
      // A write/deadline failure is not permission to reopen use. Foreign tokens do not fence the owner,
      // because assertOpen/open compare the fence's exact token with the durable lease owner.
      return receipt({ state: 'failed', verified: false, outstanding: 0, releasers: [], evidenceNote: errorText(error) });
    }
    if (lease && lease.resources === undefined) {
      const unavailable = receipt({ state: 'failed', verified: false, outstanding: 0, releasers: [], evidenceNote: 'Legacy lease has no durable resource inventory; fresh empty responders cannot prove pack absence' });
      this.receipts.set(key, unavailable);
      try { await this.write({ ...lease, state: 'open', fencedAt: lease.fencedAt ?? at, updatedAt: at, release: unavailable }); }
      catch (error) { unavailable.evidenceNote += `; legacy verdict persistence failed: ${errorText(error)}`; }
      return unavailable;
    }
    if (lease?.release?.verified) {
      const duplicate = { ...clone(lease.release), duplicate: true, state: 'already-released' as const, ms: this.options.monoNow() - started };
      this.receipts.set(key, duplicate); return duplicate;
    }
    if (lease?.state === 'swept') {
      return receipt({ state: 'failed', verified: false, outstanding: 0, releasers: [], evidenceNote: 'Legacy swept lease has no durable per-pack release proof; refusing a vacuous verified recovery receipt' });
    }
    const perCall = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(perCall) || perCall < 1 || perCall > this.timeoutMs) return receipt({ state: 'failed', verified: false, outstanding: 0, releasers: [], evidenceNote: 'Invalid release bound (may shorten, never extend configured timeout)' });
    const end = started + Math.min(this.totalTimeoutMs, perCall * Math.max(1, this.releasers.size));
    const results: SessionReleaserResult[] = [];
    // Missing lease is not a licence to ignore a live pack. Its attributable absence must still be proved.
    for (const releaser of this.releasers.values()) results.push(await this.call(releaser, { ...scope }, Math.min(end, this.options.monoNow() + perCall)));
    const missing = lease?.resources?.filter(r => r.state === 'active' && !this.releasers.has(r.pack)) ?? [];
    for (const resource of missing) results.push({ name: resource.pack, outcome: 'failed', error: `No registered releaser for enrolled resource ${resource.id}`, ms: 0 });
    const outstanding = results.reduce((sum, result) => sum + (result.outstanding ?? 0), 0);
    const failed = !results.length || results.some(result => result.outcome === 'failed');
    const state = failed ? 'failed' : outstanding ? 'orphaned' : 'released';
    const final = receipt({ state, verified: state === 'released', outstanding, releasers: results,
      ...(!results.length ? { evidenceNote: 'No session pack is registered; pack resource release cannot be proved' } : !lease ? { evidenceNote: 'No durable lease; registered packs were consulted to prove attributable absence' } : {}) });
    if (lease) {
      try { await this.mutate(scope, async () => { const latest = (await this.read(scope))!; await this.write({ ...latest, state: final.verified ? 'released' : 'open', updatedAt: at, release: final }); }); }
      catch (error) { final.state = 'failed'; final.verified = false; final.evidenceNote = `Session release verdict could not be made durable: ${errorText(error)}`; }
    }
    this.receipts.set(key, final); return final;
  }
  recorded(scope: SessionScope): SessionReleaseReceipt | undefined { const receipt = this.receipts.get(attemptKey(scope)); return receipt ? clone(receipt) : undefined; }

  sweepStale(owner: ProcessIdentity): Promise<SessionSweepReceipt> {
    this.sweeping ??= this.sweep(owner).finally(() => { this.sweeping = undefined; });
    return this.sweeping;
  }
  private async sweep(owner: ProcessIdentity): Promise<SessionSweepReceipt> {
    const started = this.options.monoNow(), at = this.options.now(), entries: SessionSweepEntry[] = [];
    await until(Promise.allSettled([...this.releases.values()]), started + this.totalTimeoutMs, this.options.monoNow);
    let names: string[];
    try { names = (await readdir(this.options.root)).filter(name => /^lease-[a-f0-9]{64}\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; names = []; }
    if (names.length > MAX_LEASES) throw new Error('Session lease inventory limit exceeded');
    let rows: Awaited<ReturnType<ProcessProbe['snapshot']>> | undefined, inventoryError: string | undefined;
    try { rows = names.length ? await until(this.options.probe.snapshot(), started + this.totalTimeoutMs, this.options.monoNow) : []; } catch (error) { inventoryError = errorText(error); }
    for (const name of names.sort()) {
      if (this.options.monoNow() >= started + this.totalTimeoutMs) {
        entries.push({ attemptKey: name.slice(6, -5), scope: { runId: 'unknown', taskId: 'unknown', attemptId: name }, state: 'unverifiable', error: 'Bounded sweep inventory total deadline exhausted; remaining lease was not read' });
        continue;
      }
      let lease: SessionLeaseRecord | undefined;
      try { lease = await until(readJson<SessionLeaseRecord>(path.join(this.options.root, name), MAX_LEASE_BYTES), started + this.totalTimeoutMs, this.options.monoNow); if (!lease) throw new Error('Missing lease'); this.validate(lease, lease.scope); if (`lease-${lease.attemptKey}.json` !== name) throw new Error('Lease filename identity mismatch'); }
      catch (error) { entries.push({ attemptKey: name.slice(6, -5), scope: { runId: 'unknown', taskId: 'unknown', attemptId: name }, state: 'unverifiable', error: errorText(error) }); continue; }
      const entry: SessionSweepEntry = { attemptKey: lease.attemptKey, scope: { ...lease.scope }, state: 'unverifiable' }; entries.push(entry);
      if (lease.resources === undefined) { entry.error = 'Legacy lease has no durable resource inventory; absence cannot be proved by a fresh empty pack'; continue; }
      if (lease.state !== 'open') { entry.state = 'already-sealed'; continue; }
      if (!rows) { entry.error = `Owner liveness could not be determined (${inventoryError}); refusing to sweep blind`; continue; }
      if (rows.some(row => sameProcess(row, lease!.owner.process) && alive(row))) { entry.state = 'skipped-live-owner'; continue; }
      try {
        lease = (await this.seal(lease.scope, lease.owner.token))!;
        const results: SessionReleaserResult[] = [];
        for (const releaser of this.releasers.values()) results.push(await this.call(releaser, lease.scope, Math.min(started + this.totalTimeoutMs, this.options.monoNow() + this.timeoutMs), lease.owner));
        const missing = lease.resources?.some(r => r.state === 'active' && !this.releasers.has(r.pack));
        entry.released = results.reduce((sum, r) => sum + (r.released ?? 0), 0);
        entry.outstanding = results.reduce((sum, r) => sum + (r.outstanding ?? 0), 0);
        const failures = results.filter(r => r.outcome === 'failed').map(r => `${r.name}: ${r.error}`);
        if (!results.length) failures.push('No session pack is registered; orphaned resources cannot be swept');
        if (missing) failures.push('No registered pack for an enrolled resource');
        if (entry.outstanding) failures.push(`${entry.outstanding} sessions survived the sweep`);
        if (failures.length) entry.error = failures.join('; '); else entry.state = 'swept';
        await this.mutate(lease.scope, async () => {
          const latest = (await this.read(lease!.scope))!;
          const release: SessionReleaseReceipt = { version: 1, scope: { ...lease!.scope }, attemptKey: lease!.attemptKey, reason: 'crash-recovery', at: this.options.now(), duplicate: false, state: entry.state === 'swept' ? 'released' : 'failed', verified: entry.state === 'swept', outstanding: entry.outstanding ?? 0, releasers: results, ms: this.options.monoNow() - started, ...(entry.error ? { evidenceNote: entry.error } : {}) };
          await this.write({ ...latest, state: entry.state === 'swept' ? 'swept' : 'open', updatedAt: this.options.now(), release, sweep: { at: this.options.now(), state: entry.state, released: entry.released, outstanding: entry.outstanding, error: entry.error, sweptBy: owner } });
        });
      } catch (error) { entry.state = 'unverifiable'; entry.error = errorText(error); }
    }
    return { version: 1, at, scanned: entries.length, stale: entries.filter(e => e.state === 'swept' || e.state === 'unverifiable').length,
      swept: entries.filter(e => e.state === 'swept').length, skipped: entries.filter(e => e.state === 'skipped-live-owner' || e.state === 'already-sealed').length,
      unverifiable: entries.filter(e => e.state === 'unverifiable').length, entries, verified: !entries.some(e => e.state === 'unverifiable') };
  }

  /**
   * Durable enrollment still active after this controller's own shutdown hooks. A hook that returns (or an
   * implementation that silently skips a retry) is not proof, so the registry itself confirms inventory.
   * Foreign controller leases are excluded: those are crash-sweep work, not this controller's shutdown.
   */
  private async unresolvedOwnEnrollments(end: number): Promise<string[]> {
    let names: string[];
    try { names = (await readdir(this.options.root)).filter(name => /^lease-[a-f0-9]{64}\.json$/.test(name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; return [`session lease inventory unreadable: ${errorText(error)}`]; }
    if (names.length > MAX_LEASES) return [`session lease inventory limit exceeded (${names.length}) without enumerating enrolled resources`];
    const failures: string[] = [];
    for (const name of names.sort()) {
      if (this.options.monoNow() >= end) { failures.push('shutdown enrollment inventory deadline exhausted; remaining leases were not read'); break; }
      let lease: SessionLeaseRecord | undefined;
      try { lease = await until(readJson<SessionLeaseRecord>(path.join(this.options.root, name), MAX_LEASE_BYTES), end, this.options.monoNow); if (!lease) throw new Error('Missing lease'); this.validate(lease, lease.scope); }
      catch (error) { failures.push(`${name}: ${errorText(error)}`); continue; }
      if (lease.owner.instance !== this.instance) continue;
      if (lease.resources === undefined) { failures.push(`${name}: legacy lease has no durable resource inventory`); continue; }
      for (const resource of lease.resources) if (resource.state === 'active') failures.push(`${resource.pack}:${resource.id} remains enrolled after pack shutdown`);
    }
    return failures;
  }
  shutdown(): Promise<void> {
    this.closed = true; // Cleanup retries never reopen creation/registration.
    this.shuttingDown ??= (async () => {
      const failures: string[] = [], end = this.options.monoNow() + this.totalTimeoutMs;
      // In-flight releases may be the only thing still killing resources; await them inside the same bound
      // before judging the hooks, so a concurrent finish is not mistaken for a surviving enrollment.
      try { await until(Promise.allSettled([...this.releases.values()]), end, this.options.monoNow); }
      catch (error) { failures.push(`in-flight session releases did not settle: ${errorText(error)}`); }
      for (const releaser of this.releasers.values()) {
        if (!releaser.shutdown) { if (!releaser.ownsNoResources) failures.push(`${releaser.name}: no shutdown hook`); continue; }
        if (this.options.monoNow() >= end) { failures.push(`${releaser.name}: shutdown total deadline exhausted`); continue; }
        try { await until(Promise.resolve(releaser.shutdown()), Math.min(end, this.options.monoNow() + this.timeoutMs), this.options.monoNow); }
        catch (error) { failures.push(`${releaser.name}: ${errorText(error)}`); }
      }
      // A hook that returns is not proof by itself: durable enrollment owned by THIS controller must be
      // resolved too, or a skipped/failed retry would publish a clean shutdown verdict over live resources.
      failures.push(...await this.unresolvedOwnEnrollments(end));
      if (failures.length) throw new Error(`Session pack shutdown failed: ${failures.join('; ')}`);
    })().catch(error => { this.shuttingDown = undefined; throw error; });
    return this.shuttingDown;
  }
}

export function packSessionReleaser(pack: AttemptSessionPack, options: { name?: string; outstanding?: (scope: SessionScope) => number | Promise<number> } = {}): SessionReleaser {
  return { name: options.name ?? 'session-pack', release: scope => pack.releaseAttempt(scope),
    ...(options.outstanding || pack.outstanding ? { outstanding: (scope: SessionScope) => options.outstanding ? options.outstanding(scope) : pack.outstanding!(scope) } : {}),
    ...(pack.close ? { shutdown: () => pack.close!() } : {}) };
}
export const browserPackReleaser = (pack: AttemptSessionPack): SessionReleaser => packSessionReleaser(pack, { name: 'browser-pack' });
