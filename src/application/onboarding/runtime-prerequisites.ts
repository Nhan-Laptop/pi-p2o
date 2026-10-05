/**
 * Bundled-runtime readiness for first use.
 *
 * The bundled backend is not self-contained. Managed workers are spawned from the pinned `pi` binary, the
 * headless guardian and the receipt extension are loaded from the compiled runtime, and the container
 * qualification reads the pinned lock, seccomp profile and sandbox bridge from the package. A git-installed
 * copy carries neither `dist/` nor `node_modules/`, so every one of those paths is resolved and checked here
 * BEFORE any owner consent or model plan. A failure always carries `BUNDLED_RUNTIME_MISSING` and names every
 * missing path — never a raw ENOENT after the human has already consented.
 *
 * Owner overrides are environment-only and host-controlled (`P2O_PI_BINARY`, `P2O_RUNTIME_DIST`). They are
 * never read from command arguments, target files, UI input or model content.
 */
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Named refusal code for an incomplete/unbuilt bundled runtime. Never a raw ENOENT. */
export const BUNDLED_RUNTIME_MISSING = 'BUNDLED_RUNTIME_MISSING';
/** Owner-controlled worker `pi` binary override (absolute path to an executable). */
export const PI_BINARY_OVERRIDE_ENV = 'P2O_PI_BINARY';
/** Owner-controlled built-dist override (a directory that contains `src/runtime/guardian.js`). */
export const RUNTIME_DIST_OVERRIDE_ENV = 'P2O_RUNTIME_DIST';

const PACKAGE_ROOT_MARKER = 'containers/pack.lock.json';
const PACKAGE_ROOT_SEARCH_DEPTH = 8;

/** Host-only inputs. Production omits both and validates the discovered root with the real environment. */
export interface BundledRuntimeEnvironment {
  /** Absolute pi-p2o root to validate; defaults to the package root discovered from this module. */
  readonly packageRoot?: string;
  /** Owner-controlled environment overrides; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type PiBinarySource = 'override' | 'package-local' | 'host-path';
export interface ResolvedWorkerPiBinary {
  readonly piBinary: string;
  readonly source: PiBinarySource;
}
export interface WorkerPiBinaryResolution {
  readonly resolved?: ResolvedWorkerPiBinary;
  /** Explicit-but-unusable owner override; reported verbatim so the owner sees their own value. */
  readonly invalidOverride?: string;
}

export type RuntimeDistSource = 'package-local-dist' | 'override-dist';
export interface ResolvedRuntimeDist {
  readonly guardianPath: string;
  readonly receiptExtensionPath: string;
  readonly source: RuntimeDistSource;
}
export interface RuntimeDistResolution {
  readonly resolved?: ResolvedRuntimeDist;
  /** Every dist path that was tried and does not exist (package-local first, then the override). */
  readonly searched: readonly string[];
}

export interface BundledRuntimePlan {
  readonly packageRoot: string;
  readonly piBinary: string;
  readonly piBinarySource: PiBinarySource;
  readonly containerLockPath: string;
  readonly seccompPath: string;
  readonly bridgeExtensionPath: string;
  readonly guardianPath: string;
  readonly receiptExtensionPath: string;
  readonly guardianPathSource: RuntimeDistSource;
}

export type BundledRuntimeInspection =
  | { readonly ok: true; readonly plan: BundledRuntimePlan }
  | { readonly ok: false; readonly code: typeof BUNDLED_RUNTIME_MISSING; readonly missing: readonly string[]; readonly message: string };

export class BundledRuntimeError extends Error {
  readonly code: typeof BUNDLED_RUNTIME_MISSING = BUNDLED_RUNTIME_MISSING;
  readonly missing: readonly string[];
  constructor(missing: readonly string[], message: string) {
    super(message);
    this.missing = missing;
    this.name = 'BundledRuntimeError';
  }
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch { return false; }
}

function canonicalFile(candidate: string): string {
  try { return realpathSync(candidate); }
  catch { return candidate; }
}

function envValue(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Walk up from this module to the pi-p2o package root (source or built layout). The container lock is the
 * shipped marker used by every layout, so discovery works for `src/application/onboarding`, its compiled
 * `dist/src/application/onboarding` counterpart, and any installed copy of either.
 */
export function discoverPackageRoot(modulePath: string = fileURLToPath(import.meta.url)): string | undefined {
  let dir = dirname(modulePath);
  for (let depth = 0; depth <= PACKAGE_ROOT_SEARCH_DEPTH; depth++) {
    if (existsSync(join(dir, PACKAGE_ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** Explicit owner override, then package-local devDependency, then host `pi` on PATH (no shell involved). */
export function resolveWorkerPiBinary(packageRoot: string, env: Readonly<Record<string, string | undefined>> = process.env): WorkerPiBinaryResolution {
  const override = envValue(env, PI_BINARY_OVERRIDE_ENV);
  if (override !== undefined) {
    if (isAbsolute(override) && isExecutableFile(override)) return { resolved: { piBinary: canonicalFile(override), source: 'override' } };
    return { invalidOverride: `${PI_BINARY_OVERRIDE_ENV}=${override} (not an executable absolute file)` };
  }
  const local = join(packageRoot, 'node_modules/.bin/pi');
  if (isExecutableFile(local)) return { resolved: { piBinary: canonicalFile(local), source: 'package-local' } };
  const pathValue = env.PATH ?? '';
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi'];
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutableFile(candidate)) return { resolved: { piBinary: canonicalFile(candidate), source: 'host-path' } };
    }
  }
  return {};
}

/** Package-local `dist/` first; only when it is absent, the explicit owner override. */
export function resolveRuntimeDist(packageRoot: string, env: Readonly<Record<string, string | undefined>> = process.env): RuntimeDistResolution {
  const local = { guardianPath: join(packageRoot, 'dist/src/runtime/guardian.js'), receiptExtensionPath: join(packageRoot, 'dist/src/runtime/pi-receipts.js') };
  if (existsSync(local.guardianPath) && existsSync(local.receiptExtensionPath)) {
    return { resolved: { ...local, source: 'package-local-dist' }, searched: [] };
  }
  const searched: string[] = [local.guardianPath, local.receiptExtensionPath];
  const override = envValue(env, RUNTIME_DIST_OVERRIDE_ENV);
  if (override !== undefined) {
    const root = resolve(override);
    const overridden = { guardianPath: join(root, 'src/runtime/guardian.js'), receiptExtensionPath: join(root, 'src/runtime/pi-receipts.js') };
    searched.push(overridden.guardianPath, overridden.receiptExtensionPath);
    if (existsSync(overridden.guardianPath) && existsSync(overridden.receiptExtensionPath)) {
      return { resolved: { ...overridden, source: 'override-dist' }, searched };
    }
  }
  return { searched };
}

function failure(missing: readonly string[], packageRoot: string | undefined): BundledRuntimeInspection {
  const where = packageRoot ? `the bundled pi-p2o runtime at ${packageRoot}` : 'the pi-p2o package root (no containers/pack.lock.json was found above this module)';
  const body = `${where} is incomplete, so owner consent, planning and worker launch are all refused; missing: ${missing.join(', ')}. `
    + `Fix: in the package root run \`npm install --include=dev\` then \`npm run build\`; alternatively set ${RUNTIME_DIST_OVERRIDE_ENV} to a built dist directory `
    + `and/or ${PI_BINARY_OVERRIDE_ENV} to the worker \`pi\` binary. Nothing was consented, planned or launched.`;
  return { ok: false, code: BUNDLED_RUNTIME_MISSING, missing, message: body.slice(0, 1000) };
}

/**
 * Resolve every path the bundled first-use runtime needs and fail closed naming all of them at once.
 * No install, pull, build, model call or target request happens here.
 */
export function inspectBundledRuntime(environment: BundledRuntimeEnvironment = {}): BundledRuntimeInspection {
  const env = environment.env ?? process.env;
  const packageRoot = environment.packageRoot ?? discoverPackageRoot();
  if (packageRoot === undefined) return failure([PACKAGE_ROOT_MARKER, `${PI_BINARY_OVERRIDE_ENV} or package node_modules/.bin/pi`], undefined);
  const required = {
    containerLockPath: join(packageRoot, PACKAGE_ROOT_MARKER),
    seccompPath: join(packageRoot, 'containers/seccomp.json'),
    bridgeExtensionPath: join(packageRoot, 'examples/local-assessment/bridge-extension.js'),
  };
  const missing = Object.values(required).filter(candidate => !existsSync(candidate));
  const pi = resolveWorkerPiBinary(packageRoot, env);
  if (!pi.resolved) {
    if (pi.invalidOverride !== undefined) missing.push(pi.invalidOverride);
    else missing.push(`${join(packageRoot, 'node_modules/.bin/pi')} (worker pi binary; no executable ${PI_BINARY_OVERRIDE_ENV} and no \`pi\` on PATH)`);
  }
  const dist = resolveRuntimeDist(packageRoot, env);
  if (!dist.resolved) missing.push(...dist.searched);
  if (missing.length) return failure(missing, packageRoot);
  return {
    ok: true,
    plan: {
      packageRoot,
      piBinary: pi.resolved!.piBinary,
      piBinarySource: pi.resolved!.source,
      ...required,
      bridgeExtensionPath: canonicalFile(required.bridgeExtensionPath),
      guardianPath: dist.resolved!.guardianPath,
      receiptExtensionPath: dist.resolved!.receiptExtensionPath,
      guardianPathSource: dist.resolved!.source,
    },
  };
}

/** Fail-closed gate. Called before every consent dialog and again before any prepare/plan/restore work. */
export function assertBundledRuntimeReady(environment?: BundledRuntimeEnvironment): BundledRuntimePlan {
  const inspected = inspectBundledRuntime(environment);
  if (!inspected.ok) throw new BundledRuntimeError(inspected.missing, inspected.message);
  return inspected.plan;
}
