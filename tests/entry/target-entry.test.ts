/**
 * Entry-workflow unit suite: target resolution, plan-only inertness, approval gating, read-only snapshots,
 * hardened clone arguments, untrusted input handling and honest unsupported-capability failures.
 *
 * Every fixture is inert: the git runner is recorded, the delegation is a double, and no test contacts a
 * network or launches a worker. Refusals are asserted on the typed `EntryError.code`, which is what the
 * interface projects as `CODE: message`.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EntryError } from '../../src/application/entry/errors.js';
import { createTargetEntryPort, type EntryPlanExecutionProposeInput } from '../../src/application/entry/index.js';
import type { EntryBounds, EntryPlanExecution, EntryRunBinding, EntryTechnique } from '../../src/application/entry/types.js';
import type { EntryPrepareInput, EntryTarget } from '../../src/interface/target-entry.js';
import { humanConfirmationRef, issueHumanConfirmationCapability } from '../../src/interface/human-approval.js';
import {
  approvalFor, bindingFor, fakeGitRunner, fixtureAuthor, generatedAuthor, generatedPacket, iso, NOW,
  ownerMenuProposal, recordingDelegation, recordingExecution, recordingObserver, runManifestFor, stubBackend,
  tempRoot, type RecordingDelegation, type RecordingExecution,
} from './fixtures.js';

const canonical = (path: string): string => realpathSync(path);

/** Assert the exact typed refusal code; the interface renders it as `CODE: message`. */
async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown;
  try { await action(); } catch (error) { thrown = error; }
  expect(thrown, `expected ${code}`).toBeInstanceOf(EntryError);
  expect((thrown as EntryError).code).toBe(code);
  expect((thrown as EntryError).message.length).toBeGreaterThan(0);
}

function makeLocalDir(label = 'target', files: Record<string, string> = { 'src/app.ts': 'export const app = true;\n' }): string {
  const dir = canonical(tempRoot(label));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

type EntryPlanAuthorLike = NonNullable<Parameters<typeof createTargetEntryPort>[0]['planAuthor']>;

interface HarnessOptions {
  run: ReturnType<typeof runManifestFor>;
  mode?: 'fixture' | 'assessment';
  planAuthor?: EntryPlanAuthorLike;
  executions?: Partial<Record<'owner-menu' | 'generated-requests', EntryPlanExecution>>;
  delegation?: RecordingDelegation;
  ownerObservations?: EntryRunBinding['ownerObservations'];
  requestEnvelope?: EntryRunBinding['requestEnvelope'];
  bounds?: Partial<EntryBounds>;
  commandRunner?: Parameters<typeof createTargetEntryPort>[0]['commandRunner'];
  approvals?: Parameters<typeof createTargetEntryPort>[0]['approvals'];
  allowFixtureAuthor?: boolean;
}

function harness(options: HarnessOptions) {
  const root = canonical(tempRoot('harness'));
  const workspaceRoot = join(root, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const { observer, events } = recordingObserver();
  const manifestPath = join(root, 'run-manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(options.run)}\n`, { mode: 0o600 });
  const binding = bindingFor({
    backend: stubBackend(),
    manifestPath,
    run: options.run,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.ownerObservations ? { ownerObservations: options.ownerObservations } : {}),
    ...(options.requestEnvelope ? { requestEnvelope: options.requestEnvelope } : {}),
  });
  let counter = 0;
  const port = createTargetEntryPort({
    binding,
    workspaceRoot,
    cwd: root,
    ...(options.planAuthor ? { planAuthor: options.planAuthor } : {}),
    ...(options.executions ? { executions: options.executions } : {}),
    ...(options.delegation ? { delegation: options.delegation.port } : {}),
    ...(options.approvals ? { approvals: options.approvals } : {}),
    clock: () => Date.parse('2026-10-03T10:00:00.000Z'),
    newId: () => `id-${++counter}`,
    observer,
    ...(options.bounds ? { bounds: options.bounds } : {}),
    ...(options.commandRunner ? { commandRunner: options.commandRunner } : {}),
    ...(options.allowFixtureAuthor === undefined ? { allowFixtureAuthor: true } : { allowFixtureAuthor: options.allowFixtureAuthor }),
  });
  return { root, workspaceRoot, port, observer, events, binding };
}

function localInput(dir: string, planOnly = false): EntryPrepareInput {
  return { target: { kind: 'local-dir', raw: dir, locator: dir }, depth: 'standard', planOnly };
}

function githubTarget(): EntryTarget {
  return { kind: 'github-repo', raw: 'https://github.com/owner/repo', locator: 'https://github.com/owner/repo' };
}

function httpTarget(url: string): EntryTarget {
  return { kind: 'http-url', raw: url, locator: url };
}

const menuObservation = (targetId: string, observationId = 'obs-approved'): EntryRunBinding['ownerObservations'][number] => ({
  taskId: 'task-review',
  observationId,
  tool: 'source.analyze',
  summary: 'owner-approved snapshot review',
  targetIds: [targetId],
  capabilities: ['source.analyze'],
  actions: ['analyze'],
});

const ownerMenuAuthor = (run: ReturnType<typeof runManifestFor>, targetId: string, targetLocator: string, observationId = 'obs-approved') =>
  fixtureAuthor({
    authoredBy: 'fixture',
    attemptId: 'attempt-model-1',
    steps: ['read the approved snapshot', 'record the bounded observation'],
    packet: {
      kind: 'owner-menu',
      proposal: ownerMenuProposal({ run, targetId, targetKind: 'artifact', targetLocator, observationId }),
    },
  });

function httpEnvelope(origin: string): NonNullable<EntryRunBinding['requestEnvelope']> {
  return {
    targets: [{ id: 'web-target', kind: 'lab', locator: `${origin}/` }],
    taskGrants: [{ taskId: 'task-recon', targetIds: ['web-target'], allowedActions: ['read'], allowedCapabilities: ['http.request'] }],
    accounts: ['guest'],
    allowedCapabilities: ['http.request'],
    allowedActions: ['read'],
    exclusions: [],
  };
}

/** Complete owner-menu harness (menu + author + execution + delegation) for one approved target. */
function ownerMenuHarness(input: {
  run: ReturnType<typeof runManifestFor>;
  targetId: string;
  targetLocator: string;
  delegation?: RecordingDelegation;
  execution?: RecordingExecution;
  bounds?: Partial<EntryBounds>;
  mode?: 'fixture' | 'assessment';
}) {
  const delegation = input.delegation ?? recordingDelegation();
  const execution: RecordingExecution = (input.execution ?? recordingExecution('owner-menu')) as RecordingExecution;
  const h = harness({
    run: input.run,
    ...(input.mode ? { mode: input.mode } : {}),
    planAuthor: ownerMenuAuthor(input.run, input.targetId, input.targetLocator),
    executions: { 'owner-menu': execution },
    delegation,
    ownerObservations: [menuObservation(input.targetId)],
    ...(input.bounds ? { bounds: input.bounds } : {}),
  });
  return { ...h, delegation, execution };
}

describe('offline target resolution', () => {
  it('resolves all three target kinds without any network access or clone', async () => {
    const localDir = makeLocalDir('three');
    const run = runManifestFor({ localDir, githubUrl: 'https://github.com/owner/repo', webUrl: 'http://127.0.0.1:43123/' });
    const h = harness({ run });
    const local = await h.port.prepare!(localInput(localDir));
    expect(local.target.kind).toBe('local-dir');
    expect(local.target.locator).toBe(localDir);
    // Preparation is zero-I/O: only an owner-pinned digest is echoed here; the content digest is observed
    // during post-approval acquisition and must then match any owner pin.
    expect(local.target.digest).toBeUndefined();
    expect(local.mode).toBe('fixture');
    // `actions` are the owner action verbs granted on the matched target, filtered by the run authorization.
    expect(local.actions).toEqual(['analyze', 'read']);
    expect(local.targetRequests).toBe(0);
    expect(local.requiresHumanApproval).toBe(true);

    const github = await h.port.prepare!({ target: githubTarget(), depth: 'standard', planOnly: false });
    expect(github.target.kind).toBe('github-repo');
    expect(github.target.locator).toBe('https://github.com/owner/repo');
    expect(github.target.digest).toBeUndefined();
    expect(github.warnings.join(' ')).toMatch(/commit is observed after approval/);

    const web = await h.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/'), depth: 'standard', planOnly: false });
    expect(web.target.kind).toBe('http-url');
    expect(web.target.locator).toBe('http://127.0.0.1:43123/');
    // The routed technique for this target is `http.request`, but the preparation reports the owner-granted
    // verbs (read/analyze) the entry workflow is allowed to use, not the capability id.
    expect(web.actions).toEqual(['analyze', 'read']);

    expect(h.events.filter(event => event === 'io:clone' || event === 'io:spawn')).toEqual([]);
    // Preparation no longer fingerprints or stats the target: no io event of any kind may be recorded.
    expect(h.events.filter(event => event.startsWith('io:'))).toEqual([]);
  });

  it('refuses unapproved targets, scope expansion, credentials and fixture-mode network targets', async () => {
    const localDir = makeLocalDir('denied');
    const otherDir = makeLocalDir('other');
    const run = runManifestFor({ localDir, webUrl: 'http://127.0.0.1:43123/base' });
    const h = harness({ run });
    await expectCode(() => h.port.prepare!(localInput(otherDir)), 'TARGET_DENIED');
    await expectCode(() => h.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/other'), depth: 'standard', planOnly: false }), 'TARGET_DENIED');
    await expectCode(() => h.port.prepare!({ target: httpTarget('http://127.0.0.1:9999/base'), depth: 'standard', planOnly: false }), 'TARGET_DENIED');
    await expectCode(() => h.port.prepare!({ target: httpTarget('http://user:pw@127.0.0.1:43123/base'), depth: 'standard', planOnly: false }), 'TARGET_DENIED');
    await expectCode(() => h.port.prepare!({ target: httpTarget('https://app.example.test/base'), depth: 'standard', planOnly: false }), 'TARGET_DENIED');

    // Local identity is lexical before consent: a path outside the approved locator is refused with no
    // filesystem check, so an absent path is TARGET_DENIED (not a stat-derived TARGET_NOT_FOUND).
    await expectCode(() => h.port.prepare!(localInput(join(localDir, 'absent'))), 'TARGET_DENIED');
    const fileTarget = join(localDir, 'src', 'app.ts');
    // A file path that is not the approved directory locator is likewise refused before any type check.
    await expectCode(() => h.port.prepare!({ target: { kind: 'local-dir', raw: fileTarget, locator: fileTarget }, depth: 'standard', planOnly: false }), 'TARGET_DENIED');

    const linkPath = join(canonical(tempRoot('links')), 'link');
    symlinkSync(localDir, linkPath);
    await expectCode(() => h.port.prepare!({ target: { kind: 'local-dir', raw: linkPath, locator: linkPath }, depth: 'standard', planOnly: false }), 'TARGET_DENIED');
  });

  it('refuses a GitHub subpath or query instead of silently widening the clone', async () => {
    const localDir = makeLocalDir('github-widen');
    const run = runManifestFor({ localDir, githubUrl: 'https://github.com/owner/repo' });
    const h = harness({ run });
    const subpath = { kind: 'github-repo' as const, raw: 'https://github.com/owner/repo/tree/main', locator: 'https://github.com/owner/repo' };
    await expectCode(() => h.port.prepare!({ target: subpath, depth: 'standard', planOnly: false }), 'TARGET_DENIED');
    const query = { kind: 'github-repo' as const, raw: 'https://github.com/owner/repo?ref=x', locator: 'https://github.com/owner/repo' };
    await expectCode(() => h.port.prepare!({ target: query, depth: 'standard', planOnly: false }), 'TARGET_DENIED');
  });

  it('refuses a local target whose owner grant lacks the routed action', async () => {
    const localDir = makeLocalDir('no-action');
    const run = runManifestFor({ localDir, actions: ['read'] });
    const h = harness({ run });
    await expectCode(() => h.port.prepare!(localInput(localDir)), 'ENTRY_UNSUPPORTED_CAPABILITY');
  });
});

describe('plan-only is inert', () => {
  it('reads no target content and launches nothing', async () => {
    const localDir = makeLocalDir('plan-only', { 'src/app.ts': 'export const app = true;\n', 'src/lib.ts': 'export const lib = 1;\n' });
    const run = runManifestFor({ localDir });
    const { port, events, delegation, execution } = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir });
    const preparation = await port.prepare!(localInput(localDir, true));
    expect(preparation.planOnly).toBe(true);
    expect(preparation.target.digest).toBeUndefined();
    // The zero-I/O preparation states plan-only explicitly and promises no acquisition or worker launch.
    expect(preparation.warnings.join(' ')).toMatch(/plan-only: no acquisition or worker launch/);
    expect(preparation.warnings.join(' ')).toMatch(/zero target filesystem\/network I\/O/);
    const targetIo = () => events.filter(event => event === 'io:readdir' || event === 'io:read' || event === 'io:copy' || event === 'io:clone' || event === 'io:spawn');
    expect(targetIo()).toEqual([]);

    const plan = await port.plan!({ preparation });
    expect(plan.targetRequests).toBe(0);
    expect(execution.proposed).toHaveLength(1);
    expect(targetIo()).toEqual([]);
    expect(delegation.calls).toEqual([]);
    expect(execution.completed).toEqual([]);

    // The direct start path refuses a plan-only preparation; the explicit `/p2o approve <planId>` path is
    // the executable one, and it acquires the target only after the human approval.
    await expectCode(() => port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) }), 'ENTRY_FAILED');
    expect(delegation.calls).toEqual([]);

    const receipt = await port.approve!({ planId: plan.planId, planDigest: plan.digest, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    expect(receipt.admittedOnce).toBe(true);
    expect(receipt.run?.runId).toBe(run.runId);
    expect(delegation.calls).toEqual(['preflight', 'delegate']);
    expect(execution.completed).toHaveLength(1);
    expect(events).toContain('io:copy');
  });
});

describe('no action before explicit human approval', () => {
  it('clones and delegates only after a matching human approval', async () => {
    const localDir = makeLocalDir('approval');
    const run = runManifestFor({ localDir, githubUrl: 'https://github.com/owner/repo' });
    const git = fakeGitRunner();
    const delegation = recordingDelegation();
    const execution = recordingExecution('owner-menu');
    const h = harness({
      run,
      planAuthor: ownerMenuAuthor(run, 'repo-source', 'https://github.com/owner/repo'),
      executions: { 'owner-menu': execution },
      delegation,
      commandRunner: git.runner,
      ownerObservations: [menuObservation('repo-source')],
    });
    const preparation = await h.port.prepare!({ target: githubTarget(), depth: 'standard', planOnly: false });
    const plan = await h.port.plan!({ preparation });
    expect(git.invocations).toEqual([]);
    expect(delegation.calls).toEqual([]);

    await expectCode(() => h.port.start!({ preparation, plan, approval: approvalFor('f'.repeat(64), plan.digest) }), 'SCOPE_DIGEST_MISMATCH');
    await expectCode(() => h.port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, 'f'.repeat(64)) }), 'SCOPE_DIGEST_MISMATCH');
    const toolApproval = { ...approvalFor(preparation.scopeDigest, plan.digest), channel: 'tool' } as unknown as ReturnType<typeof approvalFor>;
    await expectCode(() => h.port.start!({ preparation, plan, approval: toolApproval }), 'ENTRY_FAILED');
    expect(git.invocations).toEqual([]);
    expect(delegation.calls).toEqual([]);

    const runResult = await h.port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    expect(runResult.runId).toBe(preparation.runId);
    expect(runResult.state).toBe('active');
    expect(git.invocations.map(invocation => invocation.args[0])).toEqual(['clone', '-C']);
    expect(delegation.calls).toEqual(['preflight', 'delegate']);
    expect(execution.completed).toHaveLength(1);
  });

  it('approve is once-only, resolves reads and reports the single current run', async () => {
    const localDir = makeLocalDir('once');
    const run = runManifestFor({ localDir });
    const { port, delegation, execution } = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir });
    const preparation = await port.prepare!(localInput(localDir));
    const plan = await port.plan!({ preparation });
    const read = await port.readPlan!(plan.planId);
    expect(read?.plan.digest).toBe(plan.digest);
    expect(read?.preparation.scopeDigest).toBe(preparation.scopeDigest);

    const first = await port.approve!({ planId: plan.planId, planDigest: plan.digest, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    expect(first.admittedOnce).toBe(true);
    const second = await port.approve!({ planId: plan.planId, planDigest: plan.digest, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    expect(second.admittedOnce).toBe(false);
    expect(delegation.calls.filter(call => call === 'delegate')).toHaveLength(1);
    expect(execution.completed).toHaveLength(1);

    await expectCode(() => port.approve!({ planId: plan.planId, planDigest: 'e'.repeat(64), approval: approvalFor(preparation.scopeDigest, plan.digest) }), 'SCOPE_DIGEST_MISMATCH');
    await expectCode(() => port.approve!({ planId: 'absent', planDigest: plan.digest, approval: approvalFor(preparation.scopeDigest, plan.digest) }), 'PLAN_NOT_FOUND');

    const current = await port.currentRun!();
    expect(current).toMatchObject({ runId: run.runId, targetKind: 'local-dir' });
    await expect(port.resume!(run.runId)).resolves.toMatchObject({ runId: run.runId, state: 'active' });
    await expectCode(() => port.resume!('other-run'), 'ENTRY_RUN_UNKNOWN');
  });
});

describe('read-only bounded snapshot', () => {
  it('excludes secrets, vcs, build, cache and every symlink, and locks the copy down', async () => {
    const localDir = makeLocalDir('snapshot', {
      'src/app.ts': 'export const app = true;\n',
      '.env': 'API_KEY=super-secret\n',
      '.git/config': '[core]\n',
      'node_modules/pkg/index.js': 'module.exports = 1;\n',
      'build/out.js': 'built\n',
      '.cache/blob': 'cached\n',
      'id_rsa': 'PRIVATE KEY\n',
      'keep/notes.txt': 'hello\n',
    });
    const outside = join(canonical(tempRoot('outside')), 'secret.txt');
    writeFileSync(outside, 'outside secret\n');
    symlinkSync(outside, join(localDir, 'escape-link'));
    const run = runManifestFor({ localDir });
    const { port, workspaceRoot, events } = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir });
    const preparation = await port.prepare!(localInput(localDir));
    const plan = await port.plan!({ preparation });
    await port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) });

    const snapshot = join(workspaceRoot, 'entry-views', run.runId, 'source');
    expect(readFileSync(join(snapshot, 'src', 'app.ts'), 'utf8')).toBe('export const app = true;\n');
    expect(existsSync(join(snapshot, 'keep', 'notes.txt'))).toBe(true);
    for (const excluded of ['.env', '.git', 'node_modules', 'build', '.cache', 'id_rsa', 'escape-link']) {
      expect(existsSync(join(snapshot, excluded)), `${excluded} must be excluded`).toBe(false);
    }
    expect(statSync(join(snapshot, 'src', 'app.ts')).mode & 0o777).toBe(0o400);
    expect(statSync(snapshot).mode & 0o777).toBe(0o500);
    expect(events).toContain('io:copy');
  });

  it('refuses trees beyond the file and byte bounds', async () => {
    const many = makeLocalDir('bounds-many', { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    const run = runManifestFor({ localDir: many });
    const h = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: many, bounds: { maxFiles: 2 } });
    // Preparation performs zero target I/O, so an over-bound tree can only be refused when it is acquired.
    const preparation = await h.port.prepare!(localInput(many));
    expect(preparation.targetRequests).toBe(0);
    expect(h.events.filter(event => event.startsWith('io:'))).toEqual([]);
    const plan = await h.port.plan!({ preparation });
    await expectCode(() => h.port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) }), 'TARGET_TOO_LARGE');
    expect(h.delegation.calls).toEqual(['preflight']);

    const big = makeLocalDir('bounds-big', { 'big.bin': 'x'.repeat(4096) });
    const hBig = ownerMenuHarness({ run: runManifestFor({ localDir: big }), targetId: 'local-source', targetLocator: big, bounds: { maxFileBytes: 1024 } });
    const preparationBig = await hBig.port.prepare!(localInput(big));
    const planBig = await hBig.port.plan!({ preparation: preparationBig });
    await expectCode(() => hBig.port.start!({ preparation: preparationBig, plan: planBig, approval: approvalFor(preparationBig.scopeDigest, planBig.digest) }), 'TARGET_TOO_LARGE');
    expect(hBig.delegation.calls).toEqual(['preflight']);
  });

  it('treats untrusted file names as data and never executes or follows them', async () => {
    const localDir = makeLocalDir('untrusted', {
      'src/app.ts': 'export const app = true;\n',
      ';touch pwned': 'literal file name\n',
      'line\nbreak.txt': 'control character name\n',
    });
    const run = runManifestFor({ localDir });
    const { port, workspaceRoot, root, events, delegation } = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir });
    const preparation = await port.prepare!(localInput(localDir));
    // Unsafe names are data and are not even reported before approval: the zero-I/O preparation excludes no
    // files because it reads none. The acquisition reports the excluded unsafe name after the plan approval.
    expect(preparation.warnings.join(' ')).not.toMatch(/unsafe path name/);
    const plan = await port.plan!({ preparation });
    await port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    expect(delegation.inputs[0]?.acquisition.warnings.join(' ')).toMatch(/unsafe path name/);

    const snapshot = join(workspaceRoot, 'entry-views', run.runId, 'source');
    expect(readdirSync(snapshot)).toContain(';touch pwned');
    expect(readFileSync(join(snapshot, ';touch pwned'), 'utf8')).toBe('literal file name\n');
    expect(readdirSync(snapshot).some(name => name.includes('\n'))).toBe(false);
    expect(existsSync(join(localDir, 'pwned'))).toBe(false);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
    expect(events).not.toContain('io:spawn');
  });
});

describe('hardened GitHub clone', () => {
  it('uses exact bounded argv, an allowlisted environment and records the revision', async () => {
    const localDir = makeLocalDir('clone-args');
    const run = runManifestFor({ localDir, githubUrl: 'https://github.com/owner/repo' });
    const git = fakeGitRunner();
    const delegation = recordingDelegation();
    const h = harness({
      run,
      planAuthor: ownerMenuAuthor(run, 'repo-source', 'https://github.com/owner/repo'),
      executions: { 'owner-menu': recordingExecution('owner-menu') },
      delegation,
      commandRunner: git.runner,
      ownerObservations: [menuObservation('repo-source')],
    });
    const previous = process.env.P2O_ENTRY_LEAK;
    process.env.P2O_ENTRY_LEAK = 'must-not-be-inherited';
    try {
      const preparation = await h.port.prepare!({ target: githubTarget(), depth: 'standard', planOnly: false });
      const plan = await h.port.plan!({ preparation });
      await h.port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    } finally {
      if (previous === undefined) delete process.env.P2O_ENTRY_LEAK;
      else process.env.P2O_ENTRY_LEAK = previous;
    }

    const [clone, revParse] = git.invocations;
    expect(clone?.file).toBe('git');
    // `core.symlinks=true` keeps repository links as real links so the shared no-follow walker excludes them
    // from the bounded fingerprint; materializing them as regular files would silently admit link text as
    // approved source. The strict snapshot seal also refuses symlinks, so links never reach a worker.
    expect(clone?.args).toEqual([
      'clone', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
      '--config', `core.hooksPath=${join(h.workspaceRoot, 'entry-git', run.runId, 'git-hooks')}`,
      '--config', 'core.symlinks=true',
      '--config', 'credential.helper=',
      '--config', 'protocol.allow=never',
      '--config', 'protocol.https.allow=always',
      '--config', 'advice.detachedHead=false',
      '--', 'https://github.com/owner/repo', join(h.workspaceRoot, 'entry-views', run.runId, 'repo'),
    ]);
    expect(clone?.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(clone?.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(clone?.env.GIT_ASKPASS).toBe('');
    expect(clone?.env.GIT_TEMPLATE_DIR).toBe(join(h.workspaceRoot, 'entry-git', run.runId, 'git-template'));
    expect(clone?.env.HOME).toBe(join(h.workspaceRoot, 'entry-git', run.runId, 'git-home'));
    expect(clone?.env.P2O_ENTRY_LEAK).toBeUndefined();
    expect(Object.keys(clone?.env ?? {}).every(key => !key.includes('SECRET'))).toBe(true);
    expect(revParse?.args).toEqual(['-C', join(h.workspaceRoot, 'entry-views', run.runId, 'repo'), 'rev-parse', 'HEAD']);
    expect(revParse?.env.GIT_TERMINAL_PROMPT).toBe('0');

    const acquisition = delegation.inputs[0]?.acquisition;
    expect(acquisition?.kind).toBe('github-repo');
    expect(acquisition?.revision).toBe('a'.repeat(40));
    expect(acquisition?.locator).not.toMatch(/owner/);
    expect(acquisition?.locator.startsWith(join(h.workspaceRoot, 'entry-views'))).toBe(true);
  });

  it('turns a failing clone into a redacted refusal without delegating', async () => {
    const localDir = makeLocalDir('clone-failure');
    const run = runManifestFor({ localDir, githubUrl: 'https://github.com/owner/repo' });
    const git = fakeGitRunner({ cloneExit: 128, stderr: 'fatal: could not read https://user:sup3rsecret@evil.example/repo.git\n' });
    const delegation = recordingDelegation();
    const h = harness({
      run,
      planAuthor: ownerMenuAuthor(run, 'repo-source', 'https://github.com/owner/repo'),
      executions: { 'owner-menu': recordingExecution('owner-menu') },
      delegation,
      commandRunner: git.runner,
      ownerObservations: [menuObservation('repo-source')],
    });
    const preparation = await h.port.prepare!({ target: githubTarget(), depth: 'standard', planOnly: false });
    const plan = await h.port.plan!({ preparation });
    let thrown: unknown;
    try {
      await h.port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    } catch (error) { thrown = error; }
    expect((thrown as EntryError).code).toBe('REPO_CLONE_FAILED');
    expect((thrown as Error).message).not.toContain('sup3rsecret');
    expect(delegation.calls).toEqual(['preflight']);
    expect(delegation.calls).not.toContain('delegate');
  });

  it('refuses a clone whose resolved commit differs from the owner-pinned revision', async () => {
    const localDir = makeLocalDir('clone-pin');
    const run = runManifestFor({ localDir, githubUrl: 'https://github.com/owner/repo' });
    run.authorization.targets.find(target => target.id === 'repo-source')!.revision = 'b'.repeat(40);
    const git = fakeGitRunner({ revision: 'a'.repeat(40) });
    const delegation = recordingDelegation();
    const h = harness({
      run,
      planAuthor: ownerMenuAuthor(run, 'repo-source', 'https://github.com/owner/repo'),
      executions: { 'owner-menu': recordingExecution('owner-menu') },
      delegation,
      commandRunner: git.runner,
      ownerObservations: [menuObservation('repo-source')],
    });
    const preparation = await h.port.prepare!({ target: githubTarget(), depth: 'standard', planOnly: false });
    const plan = await h.port.plan!({ preparation });
    await expectCode(() => h.port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) }), 'SCOPE_DIGEST_MISMATCH');
    expect(delegation.calls).toEqual(['preflight']);
    expect(delegation.calls).not.toContain('delegate');
  });
});

describe('model-authored plans only', () => {
  it('fails explicitly when no plan author is wired', async () => {
    const localDir = makeLocalDir('no-author');
    const h = harness({ run: runManifestFor({ localDir }) });
    const preparation = await h.port.prepare!(localInput(localDir));
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_PLAN_AUTHOR_REQUIRED');
  });

  it('refuses fixture authorship in production mode', async () => {
    const localDir = makeLocalDir('fixture-author');
    const run = runManifestFor({ localDir });
    const h = harness({
      run,
      planAuthor: ownerMenuAuthor(run, 'local-source', localDir),
      executions: { 'owner-menu': recordingExecution('owner-menu') },
      ownerObservations: [menuObservation('local-source')],
      allowFixtureAuthor: false,
    });
    const preparation = await h.port.prepare!(localInput(localDir));
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_PLAN_AUTHOR_REQUIRED');
  });

  it('refuses a plan flavour whose execution is not wired, before any action', async () => {
    const localDir = makeLocalDir('unsupported-exec');
    const run = runManifestFor({ localDir, webUrl: 'http://127.0.0.1:43123/' });
    const delegation = recordingDelegation();
    const h = harness({
      run,
      planAuthor: generatedAuthor('http://127.0.0.1:43123/', run.runId),
      executions: { 'owner-menu': recordingExecution('owner-menu') },
      delegation,
    });
    const preparation = await h.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/'), depth: 'standard', planOnly: false });
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_GENERATED_REQUESTS_UNSUPPORTED');
    expect(delegation.calls).toEqual([]);

    const unavailable = recordingExecution('generated-requests', { available: false, code: 'ENTRY_GENERATED_REQUESTS_UNSUPPORTED', message: 'owner approval document path is missing' });
    const h2 = harness({
      run,
      planAuthor: generatedAuthor('http://127.0.0.1:43123/', run.runId),
      executions: { 'generated-requests': unavailable },
      delegation,
      requestEnvelope: httpEnvelope('http://127.0.0.1:43123'),
    });
    const preparation2 = await h2.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/'), depth: 'standard', planOnly: false });
    await expect(h2.port.plan!({ preparation: preparation2 })).rejects.toThrow(/owner approval document path is missing/);
    expect(delegation.calls).toEqual([]);
  });

  it('refuses owner-menu observations the owner did not approve', async () => {
    const localDir = makeLocalDir('invented-obs');
    const run = runManifestFor({ localDir });
    const h = harness({
      run,
      planAuthor: ownerMenuAuthor(run, 'local-source', localDir, 'invented-observation'),
      executions: { 'owner-menu': recordingExecution('owner-menu') },
      ownerObservations: [menuObservation('local-source')],
    });
    const preparation = await h.port.prepare!(localInput(localDir));
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_PLAN_REJECTED');
  });

  it('refuses a packet routed for another technique', async () => {
    const localDir = makeLocalDir('wrong-technique');
    const run = runManifestFor({ localDir, githubUrl: 'https://github.com/owner/repo' });
    const h = harness({
      run,
      planAuthor: generatedAuthor('https://github.com/owner/repo', run.runId),
      executions: { 'generated-requests': recordingExecution('generated-requests') },
    });
    const preparation = await h.port.prepare!({ target: githubTarget(), depth: 'standard', planOnly: false });
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_PLAN_INVALID');
  });

  it('refuses generated requests outside the owner envelope or without one', async () => {
    const localDir = makeLocalDir('envelope');
    const run = runManifestFor({ localDir, webUrl: 'http://127.0.0.1:43123/' });
    const outside = fixtureAuthor({
      authoredBy: 'fixture',
      attemptId: 'attempt-model-1',
      steps: ['request an unapproved origin'],
      packet: { kind: 'generated-requests', proposal: generatedPacket({ runId: run.runId, url: 'http://127.0.0.1:9999/' }) },
    });
    const h = harness({
      run,
      planAuthor: outside,
      executions: { 'generated-requests': recordingExecution('generated-requests') },
      requestEnvelope: httpEnvelope('http://127.0.0.1:43123'),
    });
    const preparation = await h.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/'), depth: 'standard', planOnly: false });
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_PLAN_REJECTED');

    const noEnvelope = harness({
      run,
      planAuthor: generatedAuthor('http://127.0.0.1:43123/', run.runId),
      executions: { 'generated-requests': recordingExecution('generated-requests') },
    });
    const preparation2 = await noEnvelope.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/'), depth: 'standard', planOnly: false });
    await expectCode(() => noEnvelope.port.plan!({ preparation: preparation2 }), 'ENTRY_GENERATED_REQUESTS_UNSUPPORTED');
  });

  it('bounds untrusted author output', async () => {
    const localDir = makeLocalDir('author-bounds');
    const run = runManifestFor({ localDir });
    const h = harness({
      run,
      planAuthor: fixtureAuthor({
        authoredBy: 'fixture',
        attemptId: 'attempt-model-1',
        steps: ['x'.repeat(5000)],
        packet: { kind: 'owner-menu', proposal: ownerMenuProposal({ run, targetId: 'local-source', targetKind: 'artifact', targetLocator: localDir, observationId: 'obs-approved' }) },
      }),
      executions: { 'owner-menu': recordingExecution('owner-menu') },
      ownerObservations: [menuObservation('local-source')],
    });
    const preparation = await h.port.prepare!(localInput(localDir));
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_PLAN_INVALID');
  });

  it('refuses an empty generated packet against a valid envelope', async () => {
    const localDir = makeLocalDir('author-shape');
    const run = runManifestFor({ localDir, webUrl: 'http://127.0.0.1:43123/' });
    const h = harness({
      run,
      planAuthor: fixtureAuthor({
        authoredBy: 'model',
        attemptId: 'attempt-model-1',
        steps: ['step'],
        packet: { kind: 'generated-requests', proposal: { ...generatedPacket({ runId: run.runId, url: 'http://127.0.0.1:43123/' }), requests: [] } },
      }),
      executions: { 'generated-requests': recordingExecution('generated-requests') },
      requestEnvelope: httpEnvelope('http://127.0.0.1:43123'),
    });
    const preparation = await h.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/'), depth: 'standard', planOnly: false });
    await expectCode(() => h.port.plan!({ preparation }), 'ENTRY_PLAN_REJECTED');
  });

  it('routes techniques and depth-narrowed skills from the target kind', async () => {
    const localDir = makeLocalDir('techniques');
    const run = runManifestFor({ localDir, webUrl: 'http://127.0.0.1:43123/' });
    const seen: Array<{ techniques: EntryTechnique[]; skills: string[] }> = [];
    const author: EntryPlanAuthorLike = {
      async author(input) {
        seen.push({ techniques: [...input.techniques], skills: [...input.skills] });
        return {
          authoredBy: 'fixture',
          attemptId: 'attempt-model-1',
          steps: ['step'],
          packet: { kind: 'generated-requests', proposal: generatedPacket({ runId: run.runId, url: 'http://127.0.0.1:43123/' }) },
        };
      },
    };
    const h = harness({
      run,
      planAuthor: author,
      executions: { 'generated-requests': recordingExecution('generated-requests') },
      requestEnvelope: httpEnvelope('http://127.0.0.1:43123'),
    });
    const preparation = await h.port.prepare!({ target: httpTarget('http://127.0.0.1:43123/'), depth: 'quick', planOnly: false });
    await h.port.plan!({ preparation });
    expect(seen).toEqual([{ techniques: ['http.request'], skills: ['attack-surface-mapping', 'authorization-auditing'] }]);
  });
});

describe('delegation contract', () => {
  it('refuses another run identity and a failed preflight', async () => {
    const localDir = makeLocalDir('delegation');
    const run = runManifestFor({ localDir });

    const wrong = recordingDelegation({ runId: 'other-run' });
    const first = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir, delegation: wrong });
    const preparation = await first.port.prepare!(localInput(localDir));
    const plan = await first.port.plan!({ preparation });
    await expectCode(() => first.port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) }), 'ENTRY_DELEGATION_FAILED');

    const blocked = recordingDelegation({ preflightOk: false, preflightCode: 'SCOPE_EXPIRED' });
    const second = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir, delegation: blocked });
    const preparation2 = await second.port.prepare!(localInput(localDir));
    const plan2 = await second.port.plan!({ preparation: preparation2 });
    await expectCode(() => second.port.start!({ preparation: preparation2, plan: plan2, approval: approvalFor(preparation2.scopeDigest, plan2.digest) }), 'ENTRY_DELEGATION_BLOCKED');
    expect(blocked.calls).toEqual(['preflight']);
  });

  it('keeps the prepared scope digest stable when fields are tampered with', async () => {
    const localDir = makeLocalDir('tamper');
    const run = runManifestFor({ localDir });
    const { port } = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir });
    const preparation = await port.prepare!(localInput(localDir));
    const tampered = { ...preparation, actions: ['http.request'] };
    await expectCode(() => port.plan!({ preparation: tampered }), 'SCOPE_DIGEST_MISMATCH');
  });
});

describe('entry failures are typed and private', () => {
  it('always throws EntryError with an explicit code', async () => {
    const localDir = makeLocalDir('typed');
    const h = harness({ run: runManifestFor({ localDir }) });
    let thrown: unknown;
    try { await h.port.prepare!(localInput(join(localDir, 'nope'))); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(EntryError);
    // Lexical pre-consent resolution: this path is not the approved locator, so the refusal is TARGET_DENIED
    // and the message stays private (the code is never echoed into the message text).
    expect((thrown as EntryError).code).toBe('TARGET_DENIED');
    expect((thrown as EntryError).message).not.toContain('TARGET_DENIED');
  });

  it('writes plan records and admissions under the private control root only', async () => {
    const localDir = makeLocalDir('records');
    const run = runManifestFor({ localDir });
    const { port, workspaceRoot } = ownerMenuHarness({ run, targetId: 'local-source', targetLocator: localDir });
    const preparation = await port.prepare!(localInput(localDir));
    const plan = await port.plan!({ preparation });
    const control = join(workspaceRoot, 'entry-control');
    expect(readdirSync(join(control, 'plans'))).toEqual([`${plan.planId}.json`]);
    const record = JSON.parse(readFileSync(join(control, 'plans', `${plan.planId}.json`), 'utf8')) as { digest: string };
    expect(record.digest).toBe(plan.digest);
    await port.start!({ preparation, plan, approval: approvalFor(preparation.scopeDigest, plan.digest) });
    expect(existsSync(join(control, 'admissions', `${plan.planId}.json`))).toBe(true);
    expect(lstatSync(join(control, 'plans', `${plan.planId}.json`)).mode & 0o777).toBe(0o600);
  });

  it('exposes the execution interfaces the port requires', async () => {
    const execution: EntryPlanExecution = recordingExecution('generated-requests');
    const input: EntryPlanExecutionProposeInput = {
      packet: { kind: 'generated-requests', proposal: generatedPacket({ runId: 'run-entry-1', url: 'http://127.0.0.1:43123/' }) },
      preparation: {
        runId: 'run-entry-1',
        target: { kind: 'http-url', raw: 'http://127.0.0.1:43123/', locator: 'http://127.0.0.1:43123/' },
        mode: 'fixture',
        scopeDigest: 'a'.repeat(64),
        actions: ['http.request'],
        spend: { maxCostUsd: 1, maxRequests: 1, maxTokens: 1, maxToolCalls: 1, maxAttempts: 1 },
        concurrency: 1,
        warnings: [],
        requiresHumanApproval: true,
        targetRequests: 0,
        planOnly: false,
      },
    };
    await expect(execution.propose(input)).resolves.toMatchObject({ proposalId: 'generated-requests-proposal-1' });
  });
});

describe('human confirmation authority', () => {
  const approvalsDouble = (options: { existing?: boolean; allowWrite?: boolean } = {}): NonNullable<Parameters<typeof createTargetEntryPort>[0]['approvals']> => ({
    async exists() { return options.existing === true; },
    async write() {
      if (!options.allowWrite) throw new Error('the port must never mint without a controller-issued human confirmation');
      return { path: '/tmp/p2o-test-approval.json', reused: false };
    },
  });

  const ownerMenuCase = (label: string, approvals: NonNullable<Parameters<typeof createTargetEntryPort>[0]['approvals']> = approvalsDouble()) => {
    const localDir = makeLocalDir(label);
    const run = runManifestFor({ localDir });
    return {
      localDir,
      run,
      harness: harness({
        run,
        planAuthor: ownerMenuAuthor(run, 'local-source', localDir),
        executions: { 'owner-menu': recordingExecution('owner-menu') },
        ownerObservations: [menuObservation('local-source')],
        approvals,
      }),
    };
  };

  it('refuses a hand-written human-command approval that carries no controller-issued capability', async () => {
    const { localDir, harness: h } = ownerMenuCase('capability');
    const preparation = await h.port.prepare!(localInput(localDir));
    const plan = await h.port.plan!({ preparation });
    const forged = {
      channel: 'human-command', approvalRef: 'human-forged', approvedAt: iso(NOW),
      scopeDigest: preparation.scopeDigest, planDigest: plan.digest,
    } as unknown as ReturnType<typeof approvalFor>;
    await expectCode(() => h.port.start!({ preparation, plan, approval: forged }), 'ENTRY_HUMAN_APPROVAL_REQUIRED');
  });

  it('refuses a fabricated capability object and a capability bound to another proposal', async () => {
    const { localDir, harness: h } = ownerMenuCase('forged-capability');
    const preparation = await h.port.prepare!(localInput(localDir));
    const plan = await h.port.plan!({ preparation });
    const lookalike = { ...approvalFor(preparation.scopeDigest, plan.digest), authority: { approvalRef: 'human-forged', approvedAt: iso(NOW) } } as unknown as ReturnType<typeof approvalFor>;
    await expect(h.port.start!({ preparation, plan, approval: lookalike })).rejects.toThrow(/HUMAN_CONFIRMATION_REQUIRED/);

    const otherPlan = issueHumanConfirmationCapability({ runId: preparation.runId, scopeDigest: preparation.scopeDigest, planDigest: 'f'.repeat(64) });
    const otherRef = humanConfirmationRef(otherPlan);
    const mismatched = {
      channel: 'human-command', approvalRef: otherRef.approvalRef, approvedAt: otherRef.approvedAt,
      scopeDigest: preparation.scopeDigest, planDigest: plan.digest, authority: otherPlan,
    } as unknown as ReturnType<typeof approvalFor>;
    await expect(h.port.start!({ preparation, plan, approval: mismatched })).rejects.toThrow(/HUMAN_CONFIRMATION_REQUIRED/);
  });

  it('consumes one human confirmation exactly once', async () => {
    const { localDir, harness: h } = ownerMenuCase('replay', approvalsDouble({ allowWrite: true }));
    const preparation = await h.port.prepare!(localInput(localDir));
    const plan = await h.port.plan!({ preparation });
    const approval = approvalFor(preparation.scopeDigest, plan.digest);
    await expect(h.port.start!({ preparation, plan, approval })).resolves.toMatchObject({ runId: preparation.runId });
    await expect(h.port.start!({ preparation, plan, approval })).rejects.toThrow(/HUMAN_CONFIRMATION_REQUIRED/);
  });

  it('does not let a JSON round-trip or a structured clone stand in for the capability', async () => {
    const { localDir, harness: h } = ownerMenuCase('clone');
    const preparation = await h.port.prepare!(localInput(localDir));
    const plan = await h.port.plan!({ preparation });
    const capability = issueHumanConfirmationCapability({ runId: preparation.runId, scopeDigest: preparation.scopeDigest, planDigest: plan.digest });
    const roundTripped = JSON.parse(JSON.stringify(capability)) as ReturnType<typeof issueHumanConfirmationCapability>;
    const approval = {
      channel: 'human-command', approvalRef: 'human-rounded', approvedAt: iso(NOW),
      scopeDigest: preparation.scopeDigest, planDigest: plan.digest, authority: roundTripped,
    } as unknown as ReturnType<typeof approvalFor>;
    await expect(h.port.start!({ preparation, plan, approval })).rejects.toThrow(/HUMAN_CONFIRMATION_REQUIRED/);
  });
});
