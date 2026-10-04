/** Daemon-backed container inventory. No source execution, image pull, ambient owner, or broad cleanup. */
import { randomUUID } from 'node:crypto';
import { PackCreationFence, packScopeKey, samePackScope, type PackSessionLifecycle } from '../../tools/pack-session.js';
import { runFixedProcess, type FixedProcessResult } from '../../tools/process.js';
import { checkCancelled, invariant, PolicyError } from '../../policy/errors.js';
import { deepFreeze, text } from '../../policy/validation.js';
import { alive, LinuxProcessProbe, sameProcess } from '../../runtime/processes.js';
import type { SessionLeaseOwner, SessionResourceRecord, SessionScope } from '../../runtime/types.js';
export interface ContainerLifecycleBinding { scope: SessionScope; lifecycle: PackSessionLifecycle }
export type ContainerLifecycleEngine = (args: readonly string[], input?: string, signal?: AbortSignal, cleanup?: boolean) => Promise<FixedProcessResult>;
export interface ContainerRecoveryOptions { enginePath: '/usr/bin/docker' | '/usr/local/bin/docker'; engineVersion: string }
interface Data extends Record<string, unknown> {
  kind: 'docker-container'; protocol: 1; name: string; enginePath: string; engineVersion: string; daemonId: string;
  imagePin: string; imageId: string; labels: Record<string, string>; scope: SessionScope;
  stage: 'enrolled' | 'allocating' | 'created' | 'started'; containerId?: string;
}
interface Resource { id: string; data: Data; binding?: ContainerLifecycleBinding; controller: AbortController; dispatched: boolean; teardown?: Promise<void> }
const CID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const NAME = /^p2o-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const absent = (r: FixedProcessResult, ref: string) => r.code === 1 && [
  `Error: No such object: ${ref}`, `Error response from daemon: No such container: ${ref}`, `Error response from daemon: No such object: ${ref}`,
].includes(r.stderr.trim());
const obj = (v: unknown): Record<string, unknown> => { invariant(v !== null && typeof v === 'object' && !Array.isArray(v), 'IDENTITY_DENIED', 'Invalid daemon/container identity'); return v as Record<string, unknown>; };
export function containerSessionLabels(scope: SessionScope, id: string, configurationDigest: string): Record<string, string> {
  for (const [key, value] of Object.entries(scope)) text(value, `container scope ${key}`, 256);
  invariant(NAME.test(id) && /^[a-f0-9]{64}$/.test(configurationDigest), 'IDENTITY_DENIED', 'Invalid container session identity');
  return { 'org.pi-p2o.container.session': id, 'org.pi-p2o.container.run': scope.runId, 'org.pi-p2o.container.task': scope.taskId, 'org.pi-p2o.container.attempt': scope.attemptId, 'org.pi-p2o.container.configuration': configurationDigest };
}
export function captureContainerLifecycle(binding: ContainerLifecycleBinding | undefined): ContainerLifecycleBinding | undefined {
  if (!binding) return undefined;
  invariant(binding.lifecycle && ['check', 'enroll', 'update', 'resolve'].every(key => typeof binding.lifecycle[key as keyof PackSessionLifecycle] === 'function'), 'UNAVAILABLE', 'Explicit complete PackSessionLifecycle binding required');
  for (const key of ['runId', 'taskId', 'attemptId'] as const) text(binding.scope[key], `container scope ${key}`, 256);
  return Object.freeze({ scope: deepFreeze({ runId: binding.scope.runId, taskId: binding.scope.taskId, attemptId: binding.scope.attemptId }), lifecycle: binding.lifecycle });
}
async function daemonIdentity(engine: ContainerLifecycleEngine, signal?: AbortSignal): Promise<string> {
  const r = await engine(['info', '--format', '{{.ID}}'], undefined, signal, true);
  invariant(r.code === 0 && /^[a-zA-Z0-9][a-zA-Z0-9:._-]{7,255}$/.test(r.stdout.trim()), 'UNAVAILABLE', 'Exact local Docker daemon identity unavailable');
  return r.stdout.trim();
}
async function inspection(engine: ContainerLifecycleEngine, ref: string): Promise<Record<string, unknown> | undefined> {
  const r = await engine(['inspect', '--format', '{{json .}}', ref], undefined, undefined, true);
  if (absent(r, ref)) return undefined;
  invariant(r.code === 0, 'UNAVAILABLE', 'Container inspection unavailable; absence NOT proved');
  try { return obj(JSON.parse(r.stdout)); } catch { throw new PolicyError('IDENTITY_DENIED', 'Container inspection identity unavailable'); }
}
function verifyIdentity(found: Record<string, unknown>, data: Data): string {
  const id = found.Id, config = obj(found.Config), labels = obj(config.Labels);
  invariant(typeof id === 'string' && CID.test(id) && (!data.containerId || id === data.containerId) && found.Name === `/${data.name}` && found.Image === data.imageId && Object.entries(data.labels).every(([key, value]) => labels[key] === value), 'IDENTITY_DENIED', 'Container ID/name/image/session labels do not match durable owner; foreign resource untouched');
  return id;
}
/** Requires exact daemon/name/ID/labels, and TWO absence rounds. Unconfirmed allocation is never empty proof. */
async function removeOwned(engine: ContainerLifecycleEngine, data: Data, knownUndispatched = false, onIdentity?: (id: string) => Promise<void>): Promise<void> {
  invariant(await daemonIdentity(engine) === data.daemonId, 'IDENTITY_DENIED', 'Docker daemon identity changed; no foreign cleanup');
  let streak = 0;
  for (let round = 0; round < 4; round++) {
    const named = await inspection(engine, data.name);
    if (named) {
      const id = verifyIdentity(named, data);
      if (!data.containerId) { data.containerId = id; await onIdentity?.(id); }
      // Inspect the exact ID too. Names alone are never authorization to signal/remove.
      const exact = await inspection(engine, id);
      invariant(exact && verifyIdentity(exact, data) === id, 'IDENTITY_DENIED', 'Exact enrolled container identity disappeared or changed before removal');
      const removed = await engine(['rm', '--force', id], undefined, undefined, true);
      invariant(removed.code === 0 || absent(removed, id), 'UNAVAILABLE', 'Owned container removal failed');
    } else {
      invariant(data.containerId || knownUndispatched || data.stage === 'enrolled', 'UNAVAILABLE', 'Allocation outcome unknown: missing container name is NOT proof a queued daemon creation cannot appear');
      if (data.containerId) invariant(!await inspection(engine, data.containerId), 'IDENTITY_DENIED', 'Enrolled ID survives under a different name; foreign identity not removed');
    }
    const nameGone = !await inspection(engine, data.name), idGone = !data.containerId || !await inspection(engine, data.containerId);
    streak = nameGone && idGone ? streak + 1 : 0;
    if (streak >= 2) return;
    if (round < 3) await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new PolicyError('UNAVAILABLE', 'Repeated owned container absence could not be verified');
}
export class ContainerResourceManager {
  private readonly fence = new PackCreationFence();
  private readonly active = new Map<string, Resource>();
  private readonly flights = new Set<{ scope?: SessionScope; controller: AbortController; promise: Promise<unknown> }>();
  private readonly releases = new Map<string, Promise<number>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: {
    engine: ContainerLifecycleEngine; enginePath: string; engineVersion: string; image: string; configurationDigest: string;
    runArgs(name: string): string[]; verifiedImageId(): string | undefined; legacyTermination(name: string): Promise<boolean>;
    lifecycle?: ContainerLifecycleBinding; controllerLifecycle?: ContainerLifecycleBinding;
  }) {}
  get sessions(): number { return this.active.size; }
  async invoke(input: unknown, signal?: AbortSignal, preflight = false): Promise<FixedProcessResult> {
    invariant(!this.closed, 'UNAVAILABLE', 'Container manager is closed');
    const binding = preflight ? this.options.controllerLifecycle : this.options.lifecycle;
    invariant(binding || (!this.options.lifecycle && !this.options.controllerLifecycle), 'UNAVAILABLE', preflight ? 'Preflight requires a SEPARATE controller-scoped container lifecycle' : 'Attempt container lifecycle missing; controller probes are not worker authority');
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const work = () => this.perform(input, controller, binding);
    const promise = binding ? this.fence.create(binding.scope, work) : work();
    const flight = { scope: binding?.scope, controller, promise }; this.flights.add(flight);
    try { return await promise; } finally { signal?.removeEventListener('abort', abort); this.flights.delete(flight); }
  }
  private async perform(input: unknown, controller: AbortController, binding?: ContainerLifecycleBinding): Promise<FixedProcessResult> {
    const engine = this.options.engine, name = `p2o-${randomUUID()}`;
    checkCancelled(controller.signal); invariant(!this.closed, 'UNAVAILABLE', 'Container manager is closed');
    if (binding) { await binding.lifecycle.check(binding.scope); await this.fence.check(binding.scope); }
    const daemonId = binding ? await daemonIdentity(engine, controller.signal) : '';
    const imageId = binding ? this.options.verifiedImageId() : '';
    invariant(!binding || (typeof imageId === 'string' && IMAGE.test(imageId)), 'IDENTITY_DENIED', 'Current pinned image was not verified before allocation');
    const data: Data = { kind: 'docker-container', protocol: 1, name, enginePath: this.options.enginePath, engineVersion: this.options.engineVersion, daemonId, imagePin: this.options.image, imageId: imageId ?? '', labels: binding ? containerSessionLabels(binding.scope, name, this.options.configurationDigest) : {}, scope: binding?.scope ?? { runId: '', taskId: '', attemptId: '' }, stage: 'enrolled' };
    const resource: Resource = { id: name, data, binding, controller, dispatched: false };
    this.active.set(name, resource);
    let result: FixedProcessResult | undefined, failure: unknown;
    try {
      if (binding) {
        await binding.lifecycle.enroll(binding.scope, name, structuredClone(data)); // BEFORE daemon allocation; failed writes stay attributable.
        await this.fence.check(binding.scope); await binding.lifecycle.check(binding.scope); checkCancelled(controller.signal);
        data.stage = 'allocating'; await binding.lifecycle.update(binding.scope, name, structuredClone(data));
        await this.fence.check(binding.scope); await binding.lifecycle.check(binding.scope); checkCancelled(controller.signal);
        const args = this.options.runArgs(name).filter(arg => arg !== '--rm'); args[0] = 'create';
        args.splice(1, 0, ...Object.entries(data.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]));
        resource.dispatched = true;
        const created = await engine(args, undefined, controller.signal);
        invariant(created.code === 0 && CID.test(created.stdout.trim()), 'UNAVAILABLE', 'Container create did not return an exact ID; allocation remains attributable');
        data.containerId = created.stdout.trim(); data.stage = 'created';
        const inspected = await inspection(engine, data.containerId);
        invariant(inspected && verifyIdentity(inspected, data) === data.containerId, 'IDENTITY_DENIED', 'Created container exact ID/labels/image not verified');
        await binding.lifecycle.update(binding.scope, name, structuredClone(data)); // ID + labels durable BEFORE execution.
        await this.fence.check(binding.scope); await binding.lifecycle.check(binding.scope); checkCancelled(controller.signal);
        data.stage = 'started'; await binding.lifecycle.update(binding.scope, name, structuredClone(data));
        await this.fence.check(binding.scope); await binding.lifecycle.check(binding.scope); checkCancelled(controller.signal);
        result = await engine(['start', '--attach', '--interactive', data.containerId], JSON.stringify(input), controller.signal);
      } else {
        resource.dispatched = true;
        result = await engine(this.options.runArgs(name), JSON.stringify(input), controller.signal);
      }
    } catch (error) { failure = error; }
    try { await this.cleanup(resource); } catch (error) { throw error; }
    checkCancelled(controller.signal); if (failure) throw failure;
    invariant(result, 'UNAVAILABLE', 'Container invocation did not complete'); return result;
  }
  private cleanup(resource: Resource): Promise<void> {
    if (resource.teardown) return resource.teardown;
    resource.teardown = (async () => {
      if (resource.binding) {
        await removeOwned(this.options.engine, resource.data, !resource.dispatched, async () => { await resource.binding!.lifecycle.update(resource.binding!.scope, resource.id, structuredClone(resource.data)); });
        await resource.binding.lifecycle.resolve(resource.binding.scope, resource.id); // ONLY after exact repeated absence.
      } else invariant(await this.options.legacyTermination(resource.id), 'UNAVAILABLE', 'Container termination could not be verified');
      this.active.delete(resource.id);
    })();
    void resource.teardown.catch(() => { resource.teardown = undefined; }); // Failed teardown is retryable, creation fence NEVER reopens.
    return resource.teardown;
  }
  private binding(scope: SessionScope): ContainerLifecycleBinding {
    const binding = [this.options.lifecycle, this.options.controllerLifecycle].find(b => b && samePackScope(b.scope, scope));
    invariant(binding, 'UNAVAILABLE', 'No exact container lifecycle owner for this scope; empty proof forbidden'); return binding;
  }
  outstanding(scope: SessionScope): number {
    this.binding(scope);
    return Math.max([...this.active.values()].filter(r => r.binding && samePackScope(r.binding.scope, scope)).length, [...this.flights].filter(f => f.scope && samePackScope(f.scope, scope)).length);
  }
  releaseAttempt(scope: SessionScope): Promise<number> {
    this.binding(scope); const key = packScopeKey(scope), existing = this.releases.get(key); if (existing) return existing;
    const pending = (async () => {
      const before = [...this.active.values()].filter(r => r.binding && samePackScope(r.binding.scope, scope)).length;
      for (const flight of this.flights) if (flight.scope && samePackScope(flight.scope, scope)) flight.controller.abort();
      await this.fence.seal(scope);
      await Promise.allSettled([...this.flights].filter(f => f.scope && samePackScope(f.scope, scope)).map(f => f.promise));
      for (const r of [...this.active.values()]) if (r.binding && samePackScope(r.binding.scope, scope)) await this.cleanup(r);
      invariant(this.outstanding(scope) === 0, 'UNAVAILABLE', 'Owned containers remain unresolved'); return before;
    })();
    this.releases.set(key, pending); void pending.catch(() => { this.releases.delete(key); }); return pending;
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => { for (const flight of this.flights) flight.controller.abort(); await this.fence.close(); await Promise.allSettled([...this.flights].map(f => f.promise)); for (const r of [...this.active.values()]) await this.cleanup(r); invariant(this.active.size === 0, 'UNAVAILABLE', 'Container shutdown left unresolved resources'); })();
    void this.closing.catch(() => { this.closing = undefined; }); return this.closing;
  }
}
/** Fresh-controller hook: exact DEAD kernel owner + durable daemon/ID/labels. Never grants reuse. */
export async function recoverContainerResources(resources: readonly SessionResourceRecord[], scope: SessionScope, owner: SessionLeaseOwner, options: ContainerRecoveryOptions): Promise<{ released: number; resolved: string[] }> {
  invariant(resources.length > 0, 'UNAVAILABLE', 'Only durable registry inventory can prove an empty container family; no synthetic empty recovery proof');
  invariant(['/usr/bin/docker', '/usr/local/bin/docker'].includes(options.enginePath), 'UNAVAILABLE', 'Unapproved recovery engine');
  const processes = await new LinuxProcessProbe().snapshot();
  invariant(!processes.some(p => sameProcess(p, owner.process) && alive(p)), 'IDENTITY_DENIED', 'Container owner is still live; recovery cannot release a live owner');
  const engine: ContainerLifecycleEngine = (args, input, signal) => runFixedProcess(options.enginePath, args, { input, signal, timeoutMs: 1000, maxOutputBytes: 1048576 });
  const version = await engine(['version', '--format', '{{.Client.Version}}/{{.Server.Version}}']);
  invariant(version.code === 0 && version.stdout.trim() === `${options.engineVersion}/${options.engineVersion}`, 'UNAVAILABLE', 'Current qualified Docker engine release unavailable; no auto-repin');
  const resolved: string[] = [];
  for (const resource of resources) {
    const data = structuredClone(resource.data) as Data;
    invariant(resource.state === 'active' && data.kind === 'docker-container' && data.protocol === 1 && NAME.test(resource.id) && data.name === resource.id && data.enginePath === options.enginePath && data.engineVersion === options.engineVersion && samePackScope(data.scope, scope) && typeof data.imageId === 'string' && IMAGE.test(data.imageId) && (!data.containerId || CID.test(data.containerId)) && ['enrolled', 'allocating', 'created', 'started'].includes(data.stage), 'IDENTITY_DENIED', 'Durable container identity/scope is incomplete; no inferred cleanup');
    const labels = obj(data.labels);
    invariant(labels['org.pi-p2o.container.session'] === resource.id && labels['org.pi-p2o.container.run'] === scope.runId && labels['org.pi-p2o.container.task'] === scope.taskId && labels['org.pi-p2o.container.attempt'] === scope.attemptId && /^[a-f0-9]{64}$/.test(String(labels['org.pi-p2o.container.configuration'])), 'IDENTITY_DENIED', 'Container session labels do not agree with durable scope');
    await removeOwned(engine, data); resolved.push(resource.id);
  }
  return { released: resolved.length, resolved };
}
