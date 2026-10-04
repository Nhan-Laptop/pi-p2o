import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireApprovedSource, bindApprovedSourceContainer } from '../../src/application/source-binding/index.js';
import { createBackendDelegation } from '../../src/application/entry/delegation.js';
import { stubBackend } from '../entry/fixtures.js';
import { createReadOnlySnapshot } from '../../src/application/entry/snapshot.js';
import { createPolicy, TargetBudget } from '../../src/policy/index.js';
import { createToolBroker, createDefaultRegistry } from '../../src/tools/index.js';
import { admitToolResult, openEvidenceVault, type CollectorGrant } from '../../src/evidence/index.js';
import { fixtureScope } from '../policy/fixture.js';
import { approvedRequest, dockerAvailable, hash, qualifiedSettings, repoRoot, roots } from './fixtures.js';
import { observeDocker, readAndDenyWrite } from './container-fixture.js';
import { fixtureCanary, fixtureRepoUrl, gitServer } from './git-server.js';

const missing = await dockerAvailable();
if (missing) console.warn(`SKIP REAL source Docker tests: ${missing}`);
if (missing && process.env.P2O_SOURCE_REQUIRE_DOCKER === '1') throw new Error(missing);
const real = missing ? describe.skip : describe;
real('REAL Docker current pinned pack; REAL broker + collector checks; no paid model', () => {
  it('reads approved local canary from container, denies source writes, preserves matching provenance', async () => {
    const r = await roots(), observer = observeDocker();
    const lockHash = hash(await readFile(join(repoRoot, 'containers/pack.lock.json')));
    let vault: ReturnType<typeof openEvidenceVault> | undefined;
    try {
      const canary = 'export const approvedCanary = "P2O_APPROVED_SOURCE_CANARY";\nthrow new Error("REPO_SOURCE_MUST_NOT_EXECUTE");\n';
      await writeFile(join(r.original, 'canary.ts'), canary);
      await writeFile(join(r.original, '.env'), 'INERT_SECRET=excluded');
      await symlink('/etc/passwd', join(r.original, 'escape.ts'));
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      const qualified = await qualifiedSettings();
      expect('runner' in qualified).toBe(false); expect('fixtureAcknowledgement' in qualified).toBe(false);
      const binding = await bindApprovedSourceContainer({ ...approved, source, qualified });
      expect(binding.inputRoot).toBe(source.seal.root); expect(binding.inputRoot).not.toBe(r.original);
      await expect(bindApprovedSourceContainer({ ...approved, source, qualified, outputRoot: r.original })).rejects.toMatchObject({ code: 'TARGET_DENIED' });
      expect(binding.preflight.checks.find(c => c.name === 'execution-constraints')?.detail).toContain('write-denied=root,inputs');
      const probe = await readAndDenyWrite(binding, qualified);
      expect(probe).toMatchObject({ canary, denied: true, uid: 65532 }); expect(['EROFS', 'EACCES']).toContain(probe.errorCode);
      const proof = await binding.sandbox.verifyMountedSource('canary.ts');
      expect(proof).toMatchObject({ sha256: hash(canary), inputTreeDigest: source.identity.digest, sourceIdentityDigest: source.identityDigest });
      await expect(binding.sandbox.inspectNative('canary.ts')).rejects.toMatchObject({ code: 'UNAVAILABLE' });
      await writeFile(join(r.original, 'canary.ts'), 'UNAPPROVED_ORIGINAL_SWAP'); // Must NOT affect mounted source.
      const scope = fixtureScope(); scope.runId = approved.request.run.runId;
      scope.authorization.reference = approved.request.run.authorization.reference;
      scope.targets[0]!.id = source.identity.targetId;
      for (const account of scope.accounts) account.targetIds = [source.identity.targetId];
      scope.grants = [{ ...scope.grants[0]!, id: 'source-grant', taskId: 'source-task', attemptId: 'source-attempt', capabilities: ['source.analyze'], actions: ['analyze'], targetIds: [source.identity.targetId] }];
      const context = { runId: scope.runId, taskId: 'source-task', attemptId: 'source-attempt', grantId: 'source-grant' };
      const policy = createPolicy(scope), statePath = join(r.root, 'real-budget-journal.json');
      const budgets = new TargetBudget(policy.scope.targets, { runId: scope.runId, freshRun: true, journal: { load: () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : undefined, save: state => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 }) } });
      const broker = createToolBroker({ policy, budgets, sandbox: binding.sandbox, registry: createDefaultRegistry() });
      const input = { paths: ['canary.ts'], contains: 'P2O_APPROVED_SOURCE_CANARY' };
      const result = await broker.execute({ context, tool: 'source.analyze', input });
      expect(result.receipt.configurationDigest).toBe(binding.fingerprints.configurationDigest);
      expect(JSON.stringify(result.data)).toContain('P2O_APPROVED_SOURCE_CANARY');
      expect(JSON.stringify(result.data)).not.toContain('UNAPPROVED_ORIGINAL_SWAP');
      const worker = join(r.root, 'worker'); await mkdir(worker, { mode: 0o700 });
      vault = openEvidenceVault({ root: join(r.root, 'vault'), artifactRoots: { broker: binding.outputRoot }, workerWriteRoots: [worker] });
      const grant: CollectorGrant = { collectorId: 'real-source-collector', role: 'collector', runId: scope.runId, taskId: context.taskId, attemptId: context.attemptId, authorizationRef: scope.authorization.reference, environmentId: binding.fingerprints.environmentId, configurationDigest: binding.fingerprints.configurationDigest, scopeDigest: policy.digest, inputDigests: [...binding.fingerprints.inputDigests], originalEnvironment: true, modifications: [], toolGrantId: context.grantId, tool: { name: result.receipt.tool.id, version: result.receipt.tool.version, implementationDigest: result.receipt.tool.implementationDigest }, artifactRootIds: ['broker'], allowedKinds: ['source'], allowedClassifications: ['static-inference'], validFrom: approved.request.run.authorization.validFrom, expiresAt: approved.request.run.authorization.expiresAt };
      const collection = { result, operationInput: input, artifactRootId: 'broker', evidence: { evidenceId: 'real-approved-source', idempotencyKey: 'real-approved-source', kind: 'source' as const, classification: 'static-inference' as const, summary: 'Approved source canary read and lexically analyzed in current pinned container', artifactIdentity: { digest: source.identity.digest, revision: source.identity.digest }, metadata: { sourceIdentityDigest: source.identityDigest, approvedScopeDigest: source.identity.scopeDigest } } };
      expect(() => admitToolResult(vault!, vault!.issueCollector({ ...grant, configurationDigest: 'f'.repeat(64) }), collection)).toThrow(/configuration/);
      expect(() => admitToolResult(vault!, vault!.issueCollector(grant), { ...collection, operationInput: { paths: ['escape.ts'] } })).toThrow(/operation-input/);
      const admitted = admitToolResult(vault, vault.issueCollector(grant), collection).receipt;
      expect(admitted.provenance).toMatchObject({ trust: 'collector', environmentId: binding.fingerprints.environmentId, configurationDigest: binding.sandbox.configurationDigest, inputDigests: [source.identity.digest], originalEnvironment: true, modifications: [] });
      binding.assertEvidenceScope({ environmentId: admitted.provenance.environmentId, configurationDigest: admitted.provenance.configurationDigest, inputs: [...binding.fingerprints.inputs] });
      expect(() => binding.assertEvidenceScope({ environmentId: 'old-owner-environment', configurationDigest: 'f'.repeat(64), inputs: [] })).toThrow(/fingerprints/);
      await expect(binding.sandbox.analyzeSource([{ path: 'canary.ts', text: 'SPOOFED_STDIN', sha256: hash('SPOOFED_STDIN') }])).rejects.toMatchObject({ code: 'IDENTITY_DENIED' });
      expect(hash(await readFile(join(source.seal.root, 'canary.ts')))).toBe(hash(canary));
      await observer.stop();
      expect(observer.created.length).toBeGreaterThanOrEqual(5); expect(observer.created.every(c => c.image === qualified.image)).toBe(true);
      expect(observer.pulls).toEqual([]); expect(hash(await readFile(join(repoRoot, 'containers/pack.lock.json')))).toBe(lockHash);
    } finally { vault?.close(); await observer.stop(); await r.cleanup(); }
  });
  it('binds REAL controlled Git clone/full commit to real Docker (NOT live GitHub)', async () => {
    const r = await roots(), server = await gitServer(r.root);
    try {
      const approved = await approvedRequest({ root: r.root, origin: fixtureRepoUrl, kind: 'github-repo', digest: server.digest, revision: server.revision });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot, commandRunner: server.runner });
      const binding = await bindApprovedSourceContainer({ ...approved, source, qualified: await qualifiedSettings() });
      expect(binding.fingerprints.inputRevision).toBe(server.revision);
      expect(binding.fingerprints.inputs[0]).toMatchObject({ locator: source.seal.root, digest: server.digest, revision: server.revision });
      expect((await readAndDenyWrite(binding, await qualifiedSettings())).canary).toBe(fixtureCanary);
      expect((await binding.sandbox.verifyMountedSource('canary.ts')).sha256).toBe(hash(fixtureCanary));
      const file = await binding.sandbox.filesystem.readInput('canary.ts');
      expect((await binding.sandbox.analyzeSource([file], 'P2O_REAL_CONTROLLED_GIT_CANARY')).files[0]!.matches[0]!.text).toContain('P2O_REAL_CONTROLLED_GIT_CANARY');
    } finally { await server.close(); await r.cleanup(); }
  });
  it('REAL bound source + real ledger; STUB backend verifies fail-closed delegation/resume ordering only', async () => {
    const r = await roots();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      const binding = await bindApprovedSourceContainer({ ...approved, source, qualified: await qualifiedSettings() });
      const calls: string[] = [], base = stubBackend();
      const backend = stubBackend({ async preflight(input) { calls.push('preflight'); return { ...await base.preflight(input), runId: source.identity.runId }; }, async start(input) { calls.push('start'); return { runId: source.identity.runId, mode: input.mode }; }, async resume(input) { calls.push('resume'); return { runId: input.runId, mode: input.mode }; } });
      const input = { preparation: approved.request.preparation, plan: approved.request.plan, approval: approved.request.approval, acquisition: source.acquisition };
      const unbound = createBackendDelegation({ backend, manifestPath: 'unused-stub-owner-document', mode: 'fixture', requireSourceBinding: true });
      await expect(unbound.delegate(input)).rejects.toMatchObject({ code: 'ENTRY_SOURCE_UNBOUND' }); expect(calls).toEqual([]);
      const delegation = createBackendDelegation({ backend, manifestPath: 'unused-stub-owner-document', mode: 'fixture', requireSourceBinding: true, async bindSource() { calls.push('bind'); return binding; }, async onBeforeDelegate(_input, bound) { calls.push('register'); expect(bound).toBe(binding); bound!.assertEvidenceScope({ environmentId: binding.fingerprints.environmentId, configurationDigest: binding.fingerprints.configurationDigest, inputs: [...binding.fingerprints.inputs] }); } });
      await delegation.delegate(input); expect(calls).toEqual(['bind', 'preflight', 'register', 'start']);
      await delegation.resume({ runId: source.identity.runId, preparation: input.preparation, plan: input.plan }); expect(calls).toEqual(['bind', 'preflight', 'register', 'start', 'preflight', 'resume']);
      await writeFile(approved.approvalPath, '{}');
      await expect(delegation.resume({ runId: source.identity.runId, preparation: input.preparation, plan: input.plan })).rejects.toThrow();
      expect(calls).toHaveLength(6); // No preflight/resume, and NO re-clone after owner refusal.
    } finally { await r.cleanup(); }
  });
  it.each(['identical-root-swap', 'symlink-escape'])('real sandbox refuses %s before another container starts', async mode => {
    const r = await roots(), observer = observeDocker();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'export const canary = true;\n');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      const binding = await bindApprovedSourceContainer({ ...approved, source, qualified: await qualifiedSettings() });
      const file = await binding.sandbox.filesystem.readInput('canary.ts'), before = observer.created.length;
      if (mode === 'identical-root-swap') { await rename(source.seal.root, `${source.seal.root}.old`); await createReadOnlySnapshot({ root: r.original, destination: source.seal.root, bounds: source.seal.bounds, expectedDigest: source.identity.digest, containerReadable: true }); }
      else { await chmod(source.seal.root, 0o755); await symlink('/etc/passwd', join(source.seal.root, 'escape.ts')); await chmod(source.seal.root, 0o555); }
      await expect(binding.sandbox.analyzeSource([file])).rejects.toMatchObject({ code: 'IDENTITY_DENIED' });
      await expect(binding.sandbox.verifyMountedSource('escape.ts')).rejects.toMatchObject({ code: 'IDENTITY_DENIED' });
      await observer.stop(); expect(observer.created.length).toBe(before);
    } finally { await observer.stop(); await r.cleanup(); }
  });
  it('reports expired qualification without a pull/re-pin/local fallback', async () => {
    const r = await roots(), observer = observeDocker();
    try {
      await writeFile(join(r.original, 'canary.ts'), 'approved');
      const approved = await approvedRequest({ root: r.root, origin: r.original });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot });
      const qualified = await qualifiedSettings(); qualified.qualification.expiresAt = '2000-01-01T00:00:00.000Z';
      await expect(bindApprovedSourceContainer({ ...approved, source, qualified })).rejects.toThrow(/qualification expired/);
      await observer.stop(); expect(observer.created).toEqual([]); expect(observer.pulls).toEqual([]);
    } finally { await observer.stop(); await r.cleanup(); }
  });
});
