// Offline tests for the live vertical slice: the loopback lab target, the owner document, the pinned
// extension identity and the leak-audit gate. No model, no provider, no container and no credential are
// involved; the live path itself is exercised by `examples/live-lab/run.mjs` and `tests/live/run.mjs
// --require-live`.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadApplicationConfig } from '../../src/application/index.js';
import { auditArtifactsForSecrets } from '../../src/runtime/config.js';
import { createContainerSandbox } from '../../src/tools/index.js';
import { buildContainerSandboxOptions } from '../../examples/live-lab/pack.js';
import {
  ACTOR_ADMIN, ACTOR_GUEST, ACTOR_GUEST_B, CLAIM_EXPORT, CLAIM_IDOR, FINDING_EXPORT, FINDING_IDOR, LIVE_SELECTION,
  SNAPSHOT_FILE, TASK_HYP_EXPORT, TASK_HYP_IDOR, TASK_SURFACE_MAP, TASK_VERIFY, assertContractEnumCoverage, assertPricedSelection,
  buildScenario, readContractEnumTable,
} from '../../examples/live-lab/scenario.js';
import type { LabInstance, LabServerModule } from '../../examples/live-lab/types.js';

const repoRoot = process.env.P2O_REPO_ROOT ?? join(import.meta.dirname, '..', '..');
const sourceRoot = process.env.P2O_EXAMPLE_SOURCE ?? join(repoRoot, 'examples', 'live-lab');
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

async function labModule(): Promise<LabServerModule> {
  return await import(pathToFileURL(join(sourceRoot, 'lab-server.mjs')).href) as LabServerModule;
}

async function withLab<T>(body: (lab: LabInstance, module: LabServerModule) => Promise<T>): Promise<T> {
  const module = await labModule();
  const lab = await module.startLabServer({ environmentId: 'test-env-a', port: 0, configurationDigest: sha256('test-configuration') });
  try { return await body(lab, module); } finally { await lab.close(); }
}

async function http(lab: LabInstance, path: string, accountId?: string): Promise<{ status: number; body: string }> {
  const token = accountId ? lab.tokenFor(accountId) : undefined;
  const response = await fetch(`${lab.origin}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, redirect: 'error' });
  return { status: response.status, body: await response.text() };
}

test('lab target: seeded identity, tenants and accounts are deterministic', async () => {
  await withLab(async (lab, module) => {
    assert.deepEqual(module.LAB_ITEMS.map(item => item.id), ['i-100', 'i-200']);
    assert.deepEqual(module.LAB_ITEMS.map(item => item.tenant), ['alpha', 'beta']);
    assert.deepEqual(module.LAB_ACCOUNTS.map(account => account.accountId), ['acct-guest', 'acct-admin']);
    const health = await http(lab, '/healthz');
    assert.equal(health.status, 200);
    const document = JSON.parse(health.body) as Record<string, unknown>;
    assert.equal(document.ok, true);
    assert.equal(document.environmentId, 'test-env-a');
    assert.equal(document.instanceId, lab.instanceId);
    assert.equal(document.configurationDigest, lab.configurationDigest);
    assert.deepEqual(document.tenants, ['alpha', 'beta']);
    // Two instances are distinct identities serving the same seeded build.
    const second = await module.startLabServer({ environmentId: 'test-env-a', port: 0, configurationDigest: lab.configurationDigest });
    try {
      assert.notEqual(second.instanceId, lab.instanceId);
      const secondHealth = JSON.parse((await http(second, '/healthz')).body) as Record<string, unknown>;
      assert.deepEqual(secondHealth.items, document.items);
      assert.notEqual(second.tokenFor(ACTOR_GUEST), lab.tokenFor(ACTOR_GUEST));
    } finally { await second.close(); }
  });
});

test('lab target: unauthenticated access is refused on every tenant-scoped route', async () => {
  await withLab(async lab => {
    for (const route of ['/api/v1/items/i-100?tenant=alpha', '/api/v1/export?item=i-100']) {
      const anonymous = await http(lab, route);
      assert.equal(anonymous.status, 401, `${route} must require a session`);
    }
  });
});

test('lab target: LAB-VULN-1 cross-tenant read accepts the client-supplied tenant parameter', async () => {
  await withLab(async lab => {
    const own = await http(lab, '/api/v1/items/i-100?tenant=alpha', ACTOR_GUEST);
    assert.equal(own.status, 200);
    assert.match(own.body, /"tenant":"alpha"/);
    const control = await http(lab, '/api/v1/items/i-200?tenant=alpha', ACTOR_GUEST);
    assert.equal(control.status, 403);
    assert.match(control.body, /tenant_mismatch/);
    const violation = await http(lab, '/api/v1/items/i-200?tenant=beta', ACTOR_GUEST);
    assert.equal(violation.status, 200);
    assert.match(violation.body, /"tenant":"beta"/);
    assert.match(violation.body, /"sessionTenant":"alpha"/);
  });
});

test('lab target: LAB-VULN-2 export discloses any tenant secret without a role or tenant check', async () => {
  await withLab(async lab => {
    const memberOwn = await http(lab, '/api/v1/export?item=i-100', ACTOR_GUEST);
    assert.equal(memberOwn.status, 200);
    assert.match(memberOwn.body, /"exported":true/);
    const memberCrossTenant = await http(lab, '/api/v1/export?item=i-200', ACTOR_GUEST);
    assert.equal(memberCrossTenant.status, 200);
    assert.match(memberCrossTenant.body, /"value":"beta-live-value"/);
    const adminOwn = await http(lab, '/api/v1/export?item=i-200', ACTOR_ADMIN);
    assert.equal(adminOwn.status, 200);
    // The guarded sibling route enforces the documented contract in the same build; the unguarded route is the outlier.
    const guardedCrossTenant = await http(lab, '/api/v1/export/secure?item=i-200', ACTOR_GUEST);
    assert.equal(guardedCrossTenant.status, 403);
    assert.match(guardedCrossTenant.body, /forbidden/);
    const guardedAdminOwn = await http(lab, '/api/v1/export/secure?item=i-200', ACTOR_ADMIN);
    assert.equal(guardedAdminOwn.status, 200);
    const guardedAdminCrossTenant = await http(lab, '/api/v1/export/secure?item=i-100', ACTOR_ADMIN);
    assert.equal(guardedAdminCrossTenant.status, 403);
  });
});

test('lab target: owner-side session login accepts only the seeded fixtures', async () => {
  await withLab(async lab => {
    const login = await fetch(`${lab.origin}/api/v1/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACTOR_ADMIN, password: 'admin-live-fixture-password' }),
    });
    assert.equal(login.status, 200);
    const session = await login.json() as { accountId: string; tenant: string; token: string };
    assert.equal(session.accountId, ACTOR_ADMIN);
    assert.equal(session.tenant, 'beta');
    assert.equal(session.token, lab.tokenFor(ACTOR_ADMIN));
    const denied = await fetch(`${lab.origin}/api/v1/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACTOR_ADMIN, password: 'not-the-password' }),
    });
    assert.equal(denied.status, 401);
  });
});

test('lab target: a fresh environment only resolves the account identities it was seeded with', async () => {
  // Regression for the replay path: the verifier's approved environment-B account must exist on the fresh
  // instance the controller starts for a replay, otherwise credential resolution denies and the replay blocks.
  const module = await labModule();
  const digest = sha256('test-configuration');
  const withDefaultAccounts = await module.startLabServer({ environmentId: 'test-env-b', port: 0, configurationDigest: digest });
  const withSeededAccounts = await module.startLabServer({ environmentId: 'test-env-b', port: 0, configurationDigest: digest, accounts: [{ accountId: ACTOR_GUEST_B, tenant: 'alpha', role: 'member', password: 'guest-live-fixture-password' }] });
  try {
    assert.equal(withDefaultAccounts.tokenFor(ACTOR_GUEST_B), undefined);
    assert.equal(withSeededAccounts.tokenFor(ACTOR_GUEST_B), withSeededAccounts.tokenFor(ACTOR_GUEST_B));
    assert.ok(withSeededAccounts.tokenFor(ACTOR_GUEST_B));
    assert.equal(withSeededAccounts.tokenFor(ACTOR_GUEST), undefined);
    const seededRead = await http(withSeededAccounts, '/api/v1/items/i-100?tenant=alpha', ACTOR_GUEST_B);
    assert.equal(seededRead.status, 200);
    const crossTenant = await http(withSeededAccounts, '/api/v1/items/i-200?tenant=beta', ACTOR_GUEST_B);
    assert.equal(crossTenant.status, 200);
  } finally {
    await withDefaultAccounts.close();
    await withSeededAccounts.close();
  }
});

test('owner document: validates, prices the live selection and binds every check to an approved task', async () => {
  const price = assertPricedSelection(LIVE_SELECTION.provider, LIVE_SELECTION.model);
  assert.match(price, /^deepseek\/deepseek-flash input=\$0\.3\/M output=\$1\.2\/M$/);

  const runRoot = mkdtempSync(join(tmpdir(), 'p2o-live-doc-'));
  try {
    const snapshotRoot = join(runRoot, 'snapshot');
    mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
    const snapshotFile = join(snapshotRoot, SNAPSHOT_FILE);
    writeFileSync(snapshotFile, readFileSync(join(sourceRoot, SNAPSHOT_FILE)));
    const sandboxOptions = buildContainerSandboxOptions({
      repoRoot, inputRoot: snapshotRoot, outputRoot: join(runRoot, 'broker-artifacts'),
      approvedBy: 'live-lab-test', expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const configurationDigest = createContainerSandbox(sandboxOptions).configurationDigest;
    const module = await labModule();
    const labA = await module.startLabServer({ environmentId: 'test-env-a', port: 0, configurationDigest });
    const labB = await module.startLabServer({
      environmentId: 'test-env-b', port: 0, configurationDigest,
      accounts: [{ accountId: ACTOR_GUEST_B, tenant: 'alpha', role: 'member', password: 'guest-live-fixture-password' }],
    });
    try {
      const scenario = buildScenario({
        runId: 'run-live-doc-test', runRoot, snapshotRoot, snapshotBytes: readFileSync(snapshotFile), labA, labB,
        workspaceRoot: join(runRoot, 'workspaces'), controlRoot: join(runRoot, 'control'), vaultRoot: join(runRoot, 'vault'),
        socketPath: join(runRoot, 'run', 'worker-bridge.sock'), piBinary: join(repoRoot, 'node_modules', '.bin', 'pi'),
        extensionPath: join(sourceRoot, 'bridge-extension.js'), sandboxOptions, configurationDigest, now: Date.now(),
      });
      const assessmentPath = join(runRoot, 'assessment.json');
      writeFileSync(assessmentPath, `${JSON.stringify(scenario.config, null, 2)}\n`, { mode: 0o600 });
      const config = loadApplicationConfig(assessmentPath);
      assert.equal(config.mode, 'authorized-assessment');
      assert.equal(config.sandbox.mode, 'container');
      assert.equal(config.bridge.inertLocalOnly, false);
      assert.equal(config.tasks.length, 4);
      assert.deepEqual(config.tasks.map(entry => entry.manifest.taskId), [TASK_SURFACE_MAP, TASK_HYP_IDOR, TASK_HYP_EXPORT, TASK_VERIFY]);
      assert.equal(config.run.budgets.maxTokens, 400_000);
      assert.equal(config.run.budgets.maxCostUsd, 1);
      assert.ok(config.run.budgets.reportReserveMs > 0);

      // Every approved observation names an approved task and a unique (taskId, observationId) key.
      const keys = new Set<string>();
      for (const check of config.checks ?? []) {
        assert.ok(config.tasks.some(entry => entry.manifest.taskId === check.taskId), `${check.checkId} names an unapproved task`);
        const key = `${check.taskId}/${check.observationId}`;
        assert.ok(!keys.has(key), `duplicate observation ${key}`);
        keys.add(key);
      }

      // The two claims carry baseline, negative-control and reproduction checks so the finding gate can pass.
      for (const [taskId, claim] of [[TASK_HYP_IDOR, CLAIM_IDOR], [TASK_HYP_EXPORT, CLAIM_EXPORT]] as const) {
        const checks = (config.checks ?? []).filter(check => check.taskId === taskId);
        const purposes = checks.map(check => check.test?.purpose).filter(Boolean);
        assert.ok(purposes.includes('baseline'), `${taskId} needs a baseline`);
        assert.ok(purposes.includes('negative-control'), `${taskId} needs a negative control`);
        assert.ok(purposes.includes('reproduction'), `${taskId} needs a reproduction`);
        for (const check of checks.filter(entry => entry.test)) assert.equal(check.test?.invariant, claim);
      }

      // Reporting: two approved findings, both replayed by the verifier task, one explicit untested cell.
      assert.deepEqual((config.reporting?.findings ?? []).map(plan => plan.findingId), [FINDING_IDOR, FINDING_EXPORT]);
      assert.equal((config.reporting?.verification ?? []).length, 2);
      for (const plan of config.reporting?.verification ?? []) assert.equal(plan.verifierTaskId, TASK_VERIFY);
      assert.ok((config.reporting?.coverage ?? []).some(entry => entry.state === 'untested' && entry.actorId === 'anonymous'));

      // The verifier task is the only one allowed to trigger a replay, and it is bound to environment B.
      const verifierTask = config.tasks.find(entry => entry.manifest.taskId === TASK_VERIFY);
      assert.ok(verifierTask);
      assert.ok(verifierTask.toolPolicy.mode === 'sandbox-extension' && verifierTask.toolPolicy.tools.includes('p2o_verify'));
      assert.deepEqual(verifierTask.manifest.scope.targetIds.sort(), ['lab-live-b', 'live-lab-source'].sort());
      assert.equal(verifierTask.manifest.scope.actor.id, ACTOR_GUEST_B);
      for (const task of config.tasks.filter(entry => entry.manifest.taskId !== TASK_VERIFY)) {
        assert.ok(task.toolPolicy.mode === 'sandbox-extension' && !task.toolPolicy.tools.includes('p2o_verify'));
      }

      // The owner document contains no credential material and no non-loopback upstream origin.
      const document = readFileSync(assessmentPath, 'utf8');
      assert.doesNotMatch(document, /sk-[A-Za-z0-9_-]{16,}/);
      assert.doesNotMatch(document, /api\.deepseek\.com/);

      // The pinned extension digest the document approves is the digest of the shipped file.
      const extensionDigest = sha256(readFileSync(join(sourceRoot, 'bridge-extension.js')));
      for (const task of config.tasks) {
        assert.equal(task.toolPolicy.mode === 'sandbox-extension' ? task.toolPolicy.extension.sha256 : '', extensionDigest);
      }
      assert.equal(scenario.authorization.targets.find(target => target.id === 'live-lab-source')?.digest, sha256(readFileSync(snapshotFile)));
    } finally {
      await labA.close();
      await labB.close();
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test('leak audit: a planted credential is detected and an absent one is not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p2o-live-audit-'));
  try {
    const secret = 'sk-livelabplantedcredential0123456789';
    mkdirSync(join(root, 'nested'), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, 'nested', 'clean.json'), '{"note":"no secret here"}\n');
    const clean = await auditArtifactsForSecrets(root, [secret]);
    assert.ok(clean >= 1);
    writeFileSync(join(root, 'nested', 'leak.json'), `{"authorization":"Bearer ${secret}"}\n`);
    await assert.rejects(() => auditArtifactsForSecrets(root, [secret]), /Credential material detected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bridge extension: pinned file exposes the live-lab tool surface and re-hashes itself', () => {
  const source = readFileSync(join(sourceRoot, 'bridge-extension.js'), 'utf8');
  for (const tool of ['p2o_context', 'p2o_broker', 'p2o_authoring', 'p2o_packet', 'p2o_verify']) {
    assert.match(source, new RegExp(`name: '${tool}'`), `extension must register ${tool}`);
  }
  assert.match(source, /assertPinnedExtension/);
  assert.match(source, /handoff\.packet\.json/);
  // The extension must not read configuration from anywhere but the runtime-provided config file.
  assert.doesNotMatch(source, /process\.env\.(?!P2O_CONFIG)/);
});

test('authoring crib enumerates the exact contract enums and required fields (drift fails at authoring time)', () => {
  const table = readContractEnumTable(join(sourceRoot, 'contract-enums.json'));
  assertContractEnumCoverage(table); // throws if the crib drifts from the supervisor's handoff gate
  assert.deepEqual(table.contracts.H1?.enums['interfaces[].reachability'], ['observed', 'inferred']);
  assert.deepEqual(table.contracts.H2?.enums['baseline.status'], ['observed', 'unavailable']);
  const bridge = readFileSync(join(sourceRoot, 'bridge-extension.js'), 'utf8');
  assert.match(bridge, /contract-enums\.json/, 'the crib must load the machine-checked table');
  assert.match(bridge, /Exact \$\{contract\} enum values/, 'the crib must render the exact enum values');
  assert.match(bridge, /Required \$\{contract\} fields/, 'the crib must render the required fields');
  assert.match(bridge, /Exact \$\{contract\} root keys/, 'the crib must render the exact root key set');
  const scenario = readFileSync(join(sourceRoot, 'scenario.ts'), 'utf8');
  assert.match(scenario, /assertContractEnumCoverage\(/, 'scenario construction must run the guard before launch');
});

test('a drifted or incomplete authoring table is refused with an explicit drift error', () => {
  const table = readContractEnumTable(join(sourceRoot, 'contract-enums.json'));
  const drifted = JSON.parse(JSON.stringify(table)) as typeof table;
  drifted.contracts.H1!.enums['interfaces[].reachability'] = ['observed', 'guessed'];
  assert.throws(() => assertContractEnumCoverage(drifted), /enum drift for H1/);
  const incomplete = JSON.parse(JSON.stringify(table)) as typeof table;
  delete incomplete.contracts.H1!.required['interfaces[]'];
  assert.throws(() => assertContractEnumCoverage(incomplete), /does not require H1 interfaces\[\]/);
});

test('p2o_packet refuses a drifting packet at authoring time with the exact paths (R3)', async () => {
  const table = readContractEnumTable(join(sourceRoot, 'contract-enums.json'));
  const bridge = await import(pathToFileURL(join(sourceRoot, 'bridge-extension.js')).href) as {
    cribViolations: (packet: unknown, contract: string, table: unknown) => string[];
  };
  const minimalPacket = (contract: 'H1' | 'H2') => {
    const entry = table.contracts[contract]!;
    const details: Record<string, unknown> = {};
    for (const key of entry.required.details ?? []) details[key] = {};
    for (const [scope, keys] of Object.entries(entry.required)) {
      if (scope === 'details') continue;
      const shape = Object.fromEntries(keys.map(key => [key, 'placeholder']));
      if (scope.endsWith('[]')) details[scope.slice(0, -2)] = [shape];
      else details[scope] = shape;
    }
    for (const [path, values] of Object.entries(entry.enums)) {
      const segments = path.split('.');
      let node: Record<string, unknown> = details;
      for (let index = 0; index < segments.length; index++) {
        const last = index === segments.length - 1;
        const array = segments[index]!.endsWith('[]');
        const key = array ? segments[index]!.slice(0, -2) : segments[index]!;
        if (last) { node[key] = values[0]; break; }
        if (array) { if (!Array.isArray(node[key])) node[key] = [{}]; node = (node[key] as Record<string, unknown>[])[0]!; }
        else node = (node[key] ??= {}) as Record<string, unknown>;
      }
    }
    const packet: Record<string, unknown> = Object.fromEntries(entry.requiredRootKeys.map(key => [key, key === 'details' ? details : 'placeholder']));
    packet.contract = contract;
    packet.details = details;
    return packet;
  };
  for (const contract of ['H1', 'H2'] as const) {
    assert.deepEqual(bridge.cribViolations(minimalPacket(contract), contract, table), [], `${contract} packet built from the table must be accepted`);
  }
  // The exact live-lab failure: a details-only key written at the packet root.
  const strayRoot = { ...minimalPacket('H1'), peerTopology: [] };
  const strayViolations = bridge.cribViolations(strayRoot, 'H1', table);
  assert.ok(strayViolations.some(message => message.includes('unknown root key "peerTopology"') && message.includes('belongs inside details')), JSON.stringify(strayViolations));
  // A guessed enum value is refused with the allowed values.
  const badEnum = minimalPacket('H1');
  (badEnum.details as { interfaces: Array<Record<string, unknown>> }).interfaces[0]!.reachability = 'guessed';
  assert.ok(bridge.cribViolations(badEnum, 'H1', table).some(message => message.includes('interfaces[].reachability must be one of')), 'the enum value must be refused');
  // A missing required field is refused with its path.
  const missing = minimalPacket('H2');
  delete (missing.details as { baseline: Record<string, unknown> }).baseline.status;
  assert.ok(bridge.cribViolations(missing, 'H2', table).some(message => message.includes('missing required field baseline.status')), 'the missing field must be refused');
});
