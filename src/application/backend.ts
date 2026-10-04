import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ControlBackend, PlanAuthorSlot } from '../interface/types.js';
import type { TargetEntryPort } from '../interface/target-entry.js';
import { createApplication, validateApplicationConfig, type ApplicationOverrides } from './composition.js';
import type { ApplicationConfig } from './types.js';
import { createApplicationEntryPort, ensureOwnerRunManifest, EntryError, type EntryPlanAuthor, type EntrySeams } from './entry/index.js';
import { ApplicationError } from './validation.js';

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

/** Owner-controlled composition documents only: canonical regular file, owner-only, same UID. */
function assertOwnerFile(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new ApplicationError('INTEGRATION_INVALID', `${label} must be a canonical absolute path`);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) {
    throw new ApplicationError('INTEGRATION_UNTRUSTED', `${label} must be an owner-controlled regular file, not a link or group/world-writable file`);
  }
  if (process.getuid && stat.uid !== process.getuid()) throw new ApplicationError('INTEGRATION_UNTRUSTED', `${label} must be owned by the current user`);
  if (realpathSync(path) !== path) throw new ApplicationError('INTEGRATION_UNTRUSTED', `${label} must not traverse symlinks`);
  if (stat.size === 0 || stat.size > MAX_CONFIG_BYTES) throw new ApplicationError('INTEGRATION_INVALID', `${label} must be a non-empty file under ${MAX_CONFIG_BYTES} bytes`);
}

/** Strict loader for the owner-authored application document. Invalid input is never coerced. */
export function loadApplicationConfig(path: string): ApplicationConfig {
  assertOwnerFile(path, 'P2O_APP_CONFIG');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new ApplicationError('INTEGRATION_INVALID', 'P2O_APP_CONFIG is not valid JSON'); }
  return validateApplicationConfig(parsed);
}

/**
 * Default composition entry point for the Pi control plane (`P2O_CONTROL_MODULE`).
 *
 * It is a complete composition, not an injected factory: `P2O_APP_CONFIG` names the exact owner-authored
 * document (run, tasks, policy, runtime, sandbox, reporting plans). A missing document fails closed with
 * `INTEGRATION_REQUIRED`; there is no fixture, plan-only or ambient default.
 *
 * The target workflow (`/p2o --target …`) is part of this composition: the owner-document-derived
 * `entrySeams` are turned into a real `TargetEntryPort` and attached as `ControlBackend.entry`. The port
 * delegates admission/launch to the very same composed backend returned here, resolves targets only inside
 * the owner document's approved target list, and fails closed with `ENTRY_PLAN_AUTHOR_REQUIRED` when no
 * model author is bound (`context.planAuthor`, the owner-private `P2O_PLAN_AUTHOR_MODULE`, or an
 * `overrides.entry.planAuthor` seam).
 */
export async function createP2OBackend(context: import('../interface/types.js').BackendFactoryContext, overrides: ApplicationOverrides = {}): Promise<ControlBackend> {
  const path = process.env.P2O_APP_CONFIG;
  if (!path) {
    const { createFirstUseBackend } = await import('./first-use.js');
    return createFirstUseBackend(context);
  }
  const config = loadApplicationConfig(path);
  const application = await createApplication(config, overrides);
  const backend: ControlBackend = Object.freeze({
    ...application.interfaceBackend,
    async close() {
      await application.interfaceBackend.close();
      await application.close();
    },
  } satisfies ControlBackend);

  const seams: EntrySeams | undefined = application.entrySeams;
  if (!seams) return backend;
  // The composed backend re-reads the owner run document from disk: materialize the derived copy (or verify
  // the operator-pinned one) before the entry port is constructed, then build the port against this backend.
  ensureOwnerRunManifest({ path: seams.manifestPath, run: config.run, derived: overrides.entry?.manifestPath === undefined });
  const planAuthor = await resolvePlanAuthor(context.planAuthor, context.planAuthorSlot, overrides.entry?.planAuthor);
  const entry: TargetEntryPort = await createApplicationEntryPort({
    ...seams,
    backend,
    cwd: context.cwd,
    ...(planAuthor ? { planAuthor } : {}),
  });
  return Object.freeze({ ...backend, entry } satisfies ControlBackend);
}

/**
 * The model author is bound, in order, from the host session slot/`context.planAuthor` (supplied by the Pi
 * extension), the caller override, the composition seams, or the owner-private plan-author module. With a
 * slot the session author is read at plan time, so call ordering cannot strand it. Nothing is substituted:
 * without one, `plan` fails closed with `ENTRY_PLAN_AUTHOR_REQUIRED`.
 */
async function resolvePlanAuthor(host: unknown, slot: PlanAuthorSlot | undefined, override: EntryPlanAuthor | undefined): Promise<EntryPlanAuthor | undefined> {
  const staticAuthor = asPlanAuthor(host) ?? override;
  const modulePath = process.env.P2O_PLAN_AUTHOR_MODULE;
  // An owner module is validated eagerly, so a broken one still refuses at composition construction; it
  // remains the fallback so a session author that arrives later still takes precedence.
  const moduleAuthor = modulePath ? await loadOwnerPlanAuthorModule(modulePath) : undefined;
  if (!slot) return staticAuthor ?? moduleAuthor;
  // The interface builds this backend once, but the host model author only exists when a `/p2o` command
  // runs. Reading the slot per plan keeps a status/tool call first from stranding the later target run.
  return {
    async author(input, signal) {
      const chosen = asPlanAuthor(slot.current) ?? staticAuthor ?? moduleAuthor;
      if (!chosen) {
        throw new EntryError('ENTRY_PLAN_AUTHOR_REQUIRED',
          'no model-authored plan seam is bound: run /p2o from a session with a model, inject entry.planAuthor, or set P2O_PLAN_AUTHOR_MODULE; entry never substitutes a hardcoded plan');
      }
      return await chosen.author(input, signal);
    },
  };
}

/** An object is a plan author when it exposes one callable `author` method; type identity is never trusted. */
function asPlanAuthor(value: unknown): EntryPlanAuthor | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const author = (value as { author?: unknown }).author;
  if (typeof author !== 'function') return undefined;
  return value as EntryPlanAuthor;
}

/**
 * Owner-private ESM plan author (`P2O_PLAN_AUTHOR_MODULE`), mirroring `P2O_CONTROL_MODULE` semantics: the
 * module must be an owner-controlled canonical `.mjs`/`.js` file and export `createEntryPlanAuthor`, which
 * returns an `EntryPlanAuthor` (for example one that drives the owner's own provider gateway). The module
 * is loaded once per backend and never receives the control-plane session.
 */
async function loadOwnerPlanAuthorModule(path: string): Promise<EntryPlanAuthor> {
  if (!isAbsolute(path) || !/\.(mjs|js)$/.test(path)) throw new ApplicationError('INTEGRATION_INVALID', 'P2O_PLAN_AUTHOR_MODULE must be an absolute ESM .mjs/.js file');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new ApplicationError('INTEGRATION_UNTRUSTED', 'the plan-author module must be an owner-controlled regular file, not a link or group/world-writable file');
  }
  if (realpathSync(path) !== path) throw new ApplicationError('INTEGRATION_UNTRUSTED', 'the plan-author module path must be canonical');
  const loaded = await import(pathToFileURL(path).href) as { createEntryPlanAuthor?: unknown };
  if (typeof loaded.createEntryPlanAuthor !== 'function') {
    throw new ApplicationError('INTEGRATION_INVALID', 'the plan-author module must export createEntryPlanAuthor()');
  }
  const author = asPlanAuthor((loaded.createEntryPlanAuthor as () => unknown)());
  if (!author) throw new ApplicationError('INTEGRATION_INVALID', 'createEntryPlanAuthor() did not return an object with an author() method');
  return author;
}
