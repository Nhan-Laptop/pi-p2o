/**
 * planning_update.md P14.2: the replayable unit.
 *
 * A receipt is a bounded, redacted excerpt of stdout: enough to argue what happened, useless to a second worker who has to make
 * it happen again. A payload is the opposite trade — the exact bytes are kept so another worker can run them — which means they
 * are stored verbatim and never redacted, so they live in the run's private control directory (0700/0600), are never part of an
 * export, and are removed with that directory when the run is cleaned up. The ledger keeps only `payloadRef` and the sha256, so
 * a finished run can state exactly what it had without pretending the bytes still exist.
 */
import { constants } from 'node:fs';
import { chmod, mkdir, open, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TEXT_CONTROL, sha256Hex, validId } from './validate.js';
import type { EnvironmentRecipe, EnvironmentService } from './compose.js';
export type { EnvironmentRecipe, EnvironmentService } from './compose.js';
export const PAYLOAD_KINDS = ['request', 'script', 'command'] as const;
export type PayloadKind = typeof PAYLOAD_KINDS[number];
/** A payload is a request, a script or one command line; 48 KiB is more than any of those and still a bounded read. */
export const PAYLOAD_BYTES = 48 * 1024;
const NAME_BYTES = 120;
const FILE_BYTES = PAYLOAD_BYTES + 8 * 1024;
const PAYLOAD_ID = /^payload-[a-f0-9-]{36}$/;
/**
 * Text control policy for a payload body only: tab, newline and carriage return are part of HTTP framing and of shell scripts, so
 * they are allowed here where every other text surface refuses them. NUL, the remaining C0/C1 controls and bidirectional overrides
 * stay refused, because they make the stored bytes a different program from the one that was read.
 */
const PAYLOAD_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;

/** What the ledger records. Never the body: a candidate cites the id, and the bytes stay out of every record. */
export interface PayloadRef { id: string; sha256: string; bytes: number; kind: PayloadKind; name: string; createdAt: string; storedBy: string }
export interface PayloadRecord { ref: PayloadRef; body: string }

export const isPayloadId = (value: unknown): value is string => typeof value === 'string' && PAYLOAD_ID.test(value);
export const isPayloadKind = (value: unknown): value is PayloadKind => typeof value === 'string' && (PAYLOAD_KINDS as readonly string[]).includes(value);
/** The one place the layout is decided. Derived from the same private store path the ledger uses, never from a caller path. */
export const payloadDirectory = (storePath: string): string => join(dirname(storePath), 'lab', 'payloads');

const bounded = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw Error(`${label} must be 1..${max} bytes`);
  if (TEXT_CONTROL.test(value)) throw Error(`${label} must not contain control or bidirectional-override characters`);
  return value;
};

/**
 * Run-scoped, byte-exact storage for the payload a claim actually ran.
 * Writes are additive (a fresh id per call), so two workers storing at once cannot collide, and an unknown id fails closed.
 */
export class PayloadStore {
  readonly directory: string;
  constructor(readonly storePath: string) { this.directory = payloadDirectory(storePath); }

  async put(by: string, input: { kind: unknown; name: unknown; body: unknown }): Promise<PayloadRef> {
    if (!validId(by)) throw Error('Invalid payload producer');
    if (!isPayloadKind(input.kind)) throw Error(`Payload kind must be one of ${PAYLOAD_KINDS.join(', ')}`);
    const name = bounded(input.name, 'Payload name', NAME_BYTES).trim();
    // A payload is deliberately not redacted: its whole purpose is to run again byte for byte. It is therefore refused when it
    // contains anything that would make those bytes a different program, and it is only ever written into the private control directory.
    if (typeof input.body !== 'string' || !input.body.trim() || Buffer.byteLength(input.body) > PAYLOAD_BYTES)
      throw Error(`Payload body must be 1..${PAYLOAD_BYTES} bytes`);
    if (PAYLOAD_CONTROL.test(input.body)) throw Error('Payload body must not contain NUL, other control or bidirectional-override characters');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const ref: PayloadRef = { id: `payload-${randomUUID()}`, sha256: sha256Hex(input.body), bytes: Buffer.byteLength(input.body),
      kind: input.kind, name, createdAt: new Date().toISOString(), storedBy: by };
    const file = await open(join(this.directory, `${ref.id}.json`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, ...ref, body: input.body }));
      await file.sync();
    } finally { await file.close(); }
    return ref;
  }

  /** Verified read: the stored bytes are checked against the ref, so a truncated or edited file fails closed instead of replaying. */
  async get(id: unknown): Promise<PayloadRecord> {
    if (!isPayloadId(id)) throw Error('Invalid payload ID: expected payload-<uuid>; store the payload first with action=payload');
    let handle;
    try { handle = await open(join(this.directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error(`Unknown payload ID ${id}; store the payload first with action=payload`); throw error; }
    let raw: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > FILE_BYTES) throw Error('Payload file is not a bounded regular file');
      raw = await handle.readFile('utf8');
    } finally { await handle.close(); }
    let stored: Record<string, unknown>;
    try { stored = JSON.parse(raw) as Record<string, unknown>; } catch { throw Error('Payload file is not readable JSON'); }
    if (stored.id !== id || typeof stored.body !== 'string') throw Error('Payload file does not match its ID');
    const body = stored.body;
    if (typeof stored.sha256 !== 'string' || stored.sha256 !== sha256Hex(body) || stored.bytes !== Buffer.byteLength(body))
      throw Error('Payload integrity failure');
    return { ref: { id, sha256: stored.sha256, bytes: stored.bytes as number, kind: stored.kind as PayloadKind,
      name: String(stored.name ?? ''), createdAt: String(stored.createdAt ?? ''), storedBy: String(stored.storedBy ?? '') }, body };
  }

  /** Existence only: a candidate write must not have to read 32 KiB of somebody's request to know it is citable. */
  async has(id: unknown): Promise<boolean> {
    if (!isPayloadId(id)) return false;
    try { return (await stat(join(this.directory, `${id}.json`))).isFile(); } catch { return false; }
  }
}

/** For the ledger's own validation, which holds only the store path and never a store instance. */
export const payloadExists = (storePath: string, id: unknown): Promise<boolean> => new PayloadStore(storePath).has(id);

/** What a replaying worker receives: a path in its own scratch, never the payload body in the prompt. */
export interface MaterializedPayload { path: string; sha256: string; bytes: number }
interface ScratchWriteLike {
  writeScratch(path: string, bytes: Buffer, signal?: AbortSignal, workdir?: string, mode?: number):
    Promise<{ path: string; root: string; bytes: number; sha256: string; mode: number }>;
}

/**
 * planning_update.md W4: write the stored bytes through the sandbox's fixed scratch writer. The writer re-reads the file and
 * reports its own hash, so a truncated or replaced file is a refusal rather than a replay of different bytes.
 */
export async function materializePayload(record: PayloadRecord, writer: ScratchWriteLike, base = '/work', signal?: AbortSignal): Promise<MaterializedPayload> {
  if (base !== '/work' && !/^\/work\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(base)) throw Error('Invalid payload sandbox base');
  const relative = `payload/${record.ref.id}`;
  const written = await writer.writeScratch(relative, Buffer.from(record.body, 'utf8'), signal, base, 0o500);
  if (written.sha256 !== record.ref.sha256 || written.bytes !== record.ref.bytes)
    throw Error('Materialized payload hash mismatch; nothing is claimed to be materialized');
  return { path: `${base}/${relative}`, sha256: written.sha256, bytes: written.bytes };
}

// ---------------------------------------------------------------- environment recipe (P14.3)

/**
 * planning_update.md P14.3: "difficult to analyse" usually means "needs the app built and running". An environment is a
 * *recipe of local processes inside the caller's own sandbox* — the sandbox has no Docker daemon and must not get one, so
 * nothing here starts a container. `verify` runs the recipe and reports health; the fingerprint comes from the normalized
 * recipe, so two workers verifying the same environment agree on the fingerprint while each gets an instance in its own
 * sandbox. What the recipe cannot express (a different image, a `build:`, a host mount) is refused by the compose reader
 * before it ever reaches this file.
 */
export const ENVIRONMENT_COMMAND_BYTES = 4096;
export const ENVIRONMENT_POLLS = 60;

export interface EnvironmentRef {
  id: string; name: string; fingerprint: string; revision: number; image: string; source: 'compose' | 'explicit';
  setup: number; services: number; seed: number; createdAt: string; createdBy: string;
}
export interface EnvironmentRecord extends EnvironmentRef { recipe: EnvironmentRecipe }
export interface EnvironmentRun {
  id: string; fingerprint: string; revision: number; healthy: boolean;
  services: { name: string; port?: number; log: string }[];
  steps: { step: string; command: string; code: number }[];
}
export interface EnvironmentExec { (command: string, label: string): Promise<{ code: number }> }

const ENVIRONMENT_ID = /^env-[a-f0-9-]{36}$/;
const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isEnvironmentId = (value: unknown): value is string => typeof value === 'string' && ENVIRONMENT_ID.test(value);
export const environmentDirectory = (storePath: string): string => join(dirname(storePath), 'lab', 'environments');

const command = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > ENVIRONMENT_COMMAND_BYTES)
    throw Error(`${label} must be 1..${ENVIRONMENT_COMMAND_BYTES} bytes`);
  if (PAYLOAD_CONTROL.test(value)) throw Error(`${label} must not contain NUL, other control or bidirectional-override characters`);
  return value.trim();
};
const commands = (value: unknown, label: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Error(`${label} must be a list of commands`);
  return value.map((entry, index) => command(entry, `${label} ${index + 1}`));
};
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/** Validated, bounded, canonical: sorted by name so two authors of the same environment fingerprint the same way. */
export function normalizeRecipe(input: unknown, image: string): EnvironmentRecipe {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Environment recipe must be an object');
  const row = input as Record<string, unknown>;
  for (const key of Object.keys(row)) if (!['version', 'source', 'image', 'setup', 'services', 'seed'].includes(key)) throw Error(`Environment recipe has unknown field ${key}`);
  if (typeof image !== 'string' || !image.trim()) throw Error('Environment image is required');
  const services = row.services === undefined ? [] : row.services;
  if (!Array.isArray(services)) throw Error('Environment services must be a list');
  const parsed: EnvironmentService[] = services.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error(`Environment service ${index + 1} must be an object`);
    const service = entry as Record<string, unknown>;
    for (const key of Object.keys(service)) if (!['name', 'command', 'port', 'healthcheck', 'environment'].includes(key)) throw Error(`Environment service ${index + 1} has unknown field ${key}`);
    if (typeof service.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(service.name)) throw Error(`Environment service ${index + 1} needs a plain name`);
    const port = service.port === undefined ? undefined : service.port;
    if (port !== undefined && (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)) throw Error(`Environment service ${service.name} port must be 1..65535`);
    const environment: Record<string, string> = {};
    const variables = service.environment === undefined ? {} : service.environment;
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw Error(`Environment service ${service.name} environment must be a map`);
    for (const [key, value] of Object.entries(variables as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw Error(`Environment service ${service.name} has an invalid variable name`);
      if (typeof value !== 'string' || Buffer.byteLength(value) > 512 || PAYLOAD_CONTROL.test(value)) throw Error(`Environment service ${service.name} variable ${key} must be bounded text`);
      environment[key] = value;
    }
    return { name: service.name, command: command(service.command, `Environment service ${service.name} command`),
      ...(port === undefined ? {} : { port: port as number }),
      ...(service.healthcheck === undefined ? {} : { healthcheck: command(service.healthcheck, `Environment service ${service.name} healthcheck`) }), environment };
  });
  const names = new Set(parsed.map(service => service.name));
  if (names.size !== parsed.length) throw Error('Environment service names must be unique');
  if (!parsed.length && row.seed === undefined && row.setup === undefined) throw Error('Environment needs at least one setup command, service or seed step');
  return { version: 1, source: row.source === 'compose' ? 'compose' : 'explicit', image: image.trim(),
    setup: commands(row.setup, 'Environment setup'), services: parsed.sort((left, right) => left.name.localeCompare(right.name)),
    seed: commands(row.seed, 'Environment seed') };
}

/** The identity a second worker has to reproduce: the normalized recipe, nothing about this machine. */
export const fingerprintRecipe = (recipe: EnvironmentRecipe): string => sha256Hex(JSON.stringify(recipe));

export class EnvironmentStore {
  readonly directory: string;
  constructor(readonly storePath: string) { this.directory = environmentDirectory(storePath); }

  /**
   * One environment per name, one revision per fingerprint. Re-registering the same recipe is idempotent — that is what lets
   * two workers verify the same environment without inventing a second revision — and a changed recipe is a new revision.
   */
  async put(by: string, name: string, recipe: EnvironmentRecipe): Promise<{ ref: EnvironmentRef; created: boolean }> {
    if (!validId(by)) throw Error('Invalid environment producer');
    if (typeof name !== 'string' || !ENVIRONMENT_NAME.test(name)) throw Error('Environment name must be a lowercase slug of at most 64 characters');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const fingerprint = fingerprintRecipe(recipe), existing = await this.list(name);
    const same = existing.find(entry => entry.fingerprint === fingerprint);
    if (same) { await this.markMaterialized(same.id, by); return { ref: same, created: false }; }
    const ref: EnvironmentRef = { id: `env-${randomUUID()}`, name, fingerprint, revision: (existing.at(-1)?.revision ?? 0) + 1, image: recipe.image,
      source: recipe.source, setup: recipe.setup.length, services: recipe.services.length, seed: recipe.seed.length,
      createdAt: new Date().toISOString(), createdBy: by };
    const file = await open(join(this.directory, `${ref.id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(JSON.stringify({ version: 1, ...ref, recipe })); await file.sync(); } finally { await file.close(); }
    await this.markMaterialized(ref.id, by);
    return { ref, created: true };
  }

  async get(id: unknown): Promise<EnvironmentRecord> {
    if (!isEnvironmentId(id)) throw Error('Invalid environment ID: expected env-<uuid>; create the recipe locally with action=env');
    let handle;
    try { handle = await open(join(this.directory, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Error(`Unknown environment ID ${id}; create the recipe locally with action=env`); throw error; }
    let raw: string;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 256 * 1024) throw Error('Environment file is not a bounded regular file');
      raw = await handle.readFile('utf8');
    } finally { await handle.close(); }
    let stored: Record<string, unknown>;
    try { stored = JSON.parse(raw) as Record<string, unknown>; } catch { throw Error('Environment file is not readable JSON'); }
    if (stored.id !== id) throw Error('Environment file does not match its ID');
    const recipe = normalizeRecipe(stored.recipe, String(stored.image ?? ''));
    // The fingerprint is recomputed from the stored recipe, so an edited file cannot claim an identity it no longer has.
    if (stored.fingerprint !== fingerprintRecipe(recipe)) throw Error('Environment integrity failure');
    return { id, name: String(stored.name), fingerprint: String(stored.fingerprint), revision: Number(stored.revision),
      image: String(stored.image), source: stored.source === 'compose' ? 'compose' : 'explicit', setup: recipe.setup.length,
      services: recipe.services.length, seed: recipe.seed.length, createdAt: String(stored.createdAt ?? ''), createdBy: String(stored.createdBy ?? ''), recipe };
  }

  async has(id: unknown): Promise<boolean> {
    if (!isEnvironmentId(id)) return false;
    try { return (await stat(join(this.directory, `${id}.json`))).isFile(); } catch { return false; }
  }

  /**
   * W4: an environment id is a recipe, not a live process. A worker may verify the same ref only after it has registered the
   * same recipe in its own sandbox; otherwise an id from another sandbox would silently run somewhere it was never created.
   */
  private async markMaterialized(id: string, by: string): Promise<void> {
    if (!validId(by)) throw Error('Invalid environment producer');
    const directory = join(this.directory, 'materialized', id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    let handle;
    try { handle = await open(join(directory, by), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
    finally { await handle?.close(); }
  }

  async materialized(id: unknown, by: unknown): Promise<boolean> {
    if (!isEnvironmentId(id) || typeof by !== 'string' || !validId(by)) return false;
    try { return (await stat(join(this.directory, 'materialized', id, by))).isFile(); } catch { return false; }
  }

  /** Revisions of one name, oldest first; the directory is bounded by the number of names in a run. */
  async list(name?: string): Promise<EnvironmentRef[]> {
    let entries: string[];
    try { entries = await readdir(this.directory); } catch { return []; }
    const refs: EnvironmentRef[] = [];
    for (const entry of entries.filter(file => file.endsWith('.json')).sort()) {
      try {
        const record = await this.get(entry.slice(0, -5));
        const { recipe: _recipe, ...ref } = record;
        if (name === undefined || record.name === name) refs.push(ref);
      } catch { /* a damaged file cannot become a revision, and list() never repairs it */ }
    }
    return refs.sort((left, right) => left.revision - right.revision || left.createdAt.localeCompare(right.createdAt));
  }
}

export const environmentExists = (storePath: string, id: unknown): Promise<boolean> => new EnvironmentStore(storePath).has(id);

/**
 * Runs one recipe in the caller's own sandbox. Every command goes through the injected `exec`, so each one becomes an
 * ordinary receipt attributed to the caller; nothing here reaches the target beyond what those commands do themselves.
 */
export async function runEnvironment(input: { recipe: EnvironmentRecipe; ref: EnvironmentRef; exec: EnvironmentExec; base?: string }): Promise<EnvironmentRun> {
  const { recipe, ref, exec } = input;
  const base = input.base ?? '/work';
  if (!/^\/work(\/[A-Za-z0-9][A-Za-z0-9._-]{0,60})?$/.test(base)) throw Error('Environment base must be a sandbox scratch directory');
  const directory = `${base}/.p2o-env/${ref.id}`;
  const steps: EnvironmentRun['steps'] = [], services: EnvironmentRun['services'] = [];
  const run = async (label: string, text: string, allowFailure = false) => {
    const result = await exec(text, label);
    steps.push({ step: label, command: text, code: result.code });
    if (result.code !== 0 && !allowFailure) throw Error(`Environment step ${label} exited ${result.code}; the environment is not verified`);
    return result;
  };
  await run('prepare', `mkdir -p ${directory}`);
  for (const [index, text] of recipe.setup.entries()) await run(`setup ${index + 1}`, text);
  for (const service of recipe.services) {
    const prefix = Object.entries(service.environment).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ');
    const log = `${directory}/${service.name}.log`;
    const launch = `nohup sh -c ${shellQuote(`echo $$ > ${directory}/${service.name}.pid; exec ${service.command}`)} >${log} 2>&1 &`;
    await run(`service ${service.name}`, prefix ? `${prefix} ${launch}` : launch);
    const probe = service.healthcheck
      ? `i=0; while [ $i -lt ${ENVIRONMENT_POLLS} ]; do if sh -c ${shellQuote(service.healthcheck)} >/dev/null 2>&1; then exit 0; fi; i=$((i+1)); sleep 0.5; done; exit 1`
      : service.port !== undefined
        ? `i=0; while [ $i -lt ${ENVIRONMENT_POLLS} ]; do if curl -sf -o /dev/null --max-time 1 http://127.0.0.1:${service.port}/ 2>/dev/null; then exit 0; fi; i=$((i+1)); sleep 0.5; done; exit 1`
        : undefined;
    // A service with neither a healthcheck nor a port is only known to have launched; it is reported that way, not as healthy.
    // A service that never answered is reported unhealthy; aborting would hide which service failed.
    if (probe) await run(`probe ${service.name}`, probe, true);
    services.push({ name: service.name, ...(service.port === undefined ? {} : { port: service.port }), log });
  }
  for (const [index, text] of recipe.seed.entries()) await run(`seed ${index + 1}`, text);
  const healthy = services.every(service => { const probe = steps.find(step => step.step === `probe ${service.name}`); return probe ? probe.code === 0 : false; });
  return { id: ref.id, fingerprint: ref.fingerprint, revision: ref.revision, healthy: services.length ? healthy : true, services, steps };
}

/** Stops the processes this environment started in the caller's sandbox, by the PID files it wrote, and removes its traces. */
export async function stopEnvironment(input: { ref: EnvironmentRef; exec: EnvironmentExec; base?: string }): Promise<{ stopped: boolean; steps: { step: string; code: number }[] }> {
  const base = input.base ?? '/work';
  if (!/^\/work(\/[A-Za-z0-9][A-Za-z0-9._-]{0,60})?$/.test(base)) throw Error('Environment base must be a sandbox scratch directory');
  const directory = `${base}/.p2o-env/${input.ref.id}`;
  const steps: { step: string; code: number }[] = [];
  const run = async (label: string, text: string) => { const result = await input.exec(text, label); steps.push({ step: label, code: result.code }); return result; };
  await run('terminate', `for file in ${directory}/*.pid; do [ -f "$file" ] || continue; kill -TERM "$(cat "$file")" 2>/dev/null || true; done; sleep 0.2; for file in ${directory}/*.pid; do [ -f "$file" ] || continue; kill -KILL "$(cat "$file")" 2>/dev/null || true; done`);
  await run('remove', `rm -rf ${directory}`);
  return { stopped: steps.every(step => step.code === 0), steps };
}
