import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPolicy, TargetBudget } from '../../src/policy/index.js';
import {
  createDefaultRegistry, createFuzzPack, createLocalFixtureSandbox, doctor, runDifferential, runExternalTool,
  validateApprovedTemplates, CapabilityRegistry,
  type ExternalFuzzRunner, type ExternalRunnerIdentity, type ExternalRunnerPin, type FuzzDifferentialEvidence,
  type FuzzTemplateEvidence, type ToolDescriptor,
} from '../../src/tools/index.js';
import { bodyTemplate, code, EXPIRES_AT, fuzzBroker, fuzzContext, fuzzRoots, fuzzScope, queryTemplate, templateFixture, writeFixtureModules } from './fixtures.js';

const pair = { kind: 'module-pair' as const, moduleA: 'strict-header.mjs', moduleB: 'lenient-header.mjs' };

test('differential fuzzing finds a seeded divergence in a local module pair and shrinks it to a minimal reproducer', async t => {
  const f = await fuzzBroker(t, fuzzScope('http://127.0.0.1:1'));
  await writeFixtureModules(f.inputRoot);
  const input = { subject: pair, strategy: 'bytes', seed: 'b3-differential-1', cases: 64, maxInputBytes: 32 };
  const first = await f.broker.execute({ context: fuzzContext, tool: 'fuzz.differential', input });
  const evidence = first.data as FuzzDifferentialEvidence;
  assert.equal(evidence.kind, 'fuzz-differential');
  assert.equal(evidence.outcome, 'divergence');
  assert.equal(evidence.seed, 'b3-differential-1');
  assert.equal(evidence.strategy, 'bytes');
  assert.equal(evidence.subject.modules.length, 2);
  for (const module of evidence.subject.modules) assert.match(module.sha256, /^[a-f0-9]{64}$/);
  const divergence = evidence.divergence!;
  assert.ok(divergence.reproducer.bytes >= 1 && divergence.reproducer.bytes <= 4, `reproducer bytes ${divergence.reproducer.bytes}`);
  // Explicit regression for this seed: the 12-byte case shrinks to one invalid UTF-8 byte (0x8e).
  assert.equal(divergence.reproducer.hex, '8e');
  assert.equal(divergence.reproducer.sha256, '949f94d858ef6ad1333164d796a0d777fd82f9155ece7d6fad68c0b992f0e7af');
  assert.ok(divergence.reproducer.bytes <= divergence.initial.bytes);
  assert.notEqual(divergence.subjectA.digest, divergence.subjectB.digest);
  assert.equal(divergence.subjectA.outcome.kind, 'reject');
  assert.equal(divergence.subjectB.outcome.kind, 'accept');
  assert.match(divergence.digest, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(f.outputRoot, first.artifact.path), 'utf8'), JSON.stringify(first.data));
  assert.equal(first.receipt.tool.id, 'fuzz.differential');
  assert.equal(first.receipt.classification, 'observation-not-verified-finding');
  const second = await f.broker.execute({ context: fuzzContext, tool: 'fuzz.differential', input });
  const replay = second.data as FuzzDifferentialEvidence;
  assert.equal(replay.divergence!.reproducer.hex, divergence.reproducer.hex);
  assert.equal(replay.divergence!.reproducer.sha256, divergence.reproducer.sha256);
  assert.equal(replay.divergence!.digest, divergence.digest);
  assert.equal(replay.divergence!.foundAtCase, divergence.foundAtCase);
  assert.equal(f.receipts.length, 2);
});

test('differential fuzzing compares one local implementation against an invariant oracle', async t => {
  const f = await fuzzBroker(t, fuzzScope('http://127.0.0.1:1'));
  await writeFixtureModules(f.inputRoot);
  const result = await f.broker.execute({
    context: fuzzContext, tool: 'fuzz.differential',
    input: { subject: { kind: 'module-invariant', module: 'oracle-header.mjs' }, strategy: 'header-value', seed: 'b3-invariant-1', cases: 64, maxInputBytes: 16 },
  });
  const evidence = result.data as FuzzDifferentialEvidence;
  assert.equal(evidence.outcome, 'divergence');
  assert.equal(evidence.subject.kind, 'module-invariant');
  const divergence = evidence.divergence!;
  assert.equal(divergence.reproducer.hex, '3b'); // the first semicolon silently truncates accepted output
  assert.equal(divergence.subjectB.outcome.kind, 'invariant-violation');
  assert.match(divergence.subjectB.outcome.kind === 'invariant-violation' ? divergence.subjectB.outcome.detail : '', /truncation/);
  assert.equal(divergence.subjectA.outcome.kind, 'accept');
  assert.equal(divergence.shrinkSteps > 0, true);
});

test('differential fuzzing refuses network targets, module URLs and host paths and opens no socket', async t => {
  const web = await templateFixture(t);
  const f = await fuzzBroker(t, fuzzScope(web.origin));
  await writeFixtureModules(f.inputRoot);
  const base = { subject: pair, strategy: 'bytes', seed: 'b3-refusal-1', cases: 4 };
  const cases: [unknown, string][] = [
    [{ ...base, url: `${web.origin}/evil` }, 'INVALID_INPUT'],
    [{ ...base, accountId: 'anonymous' }, 'INVALID_INPUT'],
    [{ ...base, target: 'https://example.test/' }, 'INVALID_INPUT'],
    [{ ...base, subject: { kind: 'module-pair', moduleA: `${web.origin}/mod.mjs`, moduleB: 'lenient-header.mjs' } }, 'TARGET_DENIED'],
    [{ ...base, subject: { kind: 'module-pair', moduleA: 'node:fs', moduleB: 'lenient-header.mjs' } }, 'TARGET_DENIED'],
    [{ ...base, subject: { kind: 'module-pair', moduleA: '/etc/hostname', moduleB: 'lenient-header.mjs' } }, 'FILESYSTEM_DENIED'],
    [{ ...base, subject: { kind: 'module-pair', moduleA: '../outside.mjs', moduleB: 'lenient-header.mjs' } }, 'FILESYSTEM_DENIED'],
  ];
  for (const [input, expected] of cases) {
    await assert.rejects(f.broker.execute({ context: fuzzContext, tool: 'fuzz.differential', input }), code(expected));
  }
  assert.equal(web.hits.length, 0, 'no request may leave the host for a local-code tool');
  // The offline capability has no network authority at all: a URL cannot even be authorized.
  await assert.rejects(
    f.broker.execute({ context: fuzzContext, tool: 'fuzz.differential', input: { ...base, url: `${web.origin}/x` } }),
    code('INVALID_INPUT'),
  );
});

test('differential fuzzing fails closed without a trusted-local-code acknowledgement and is absent by default', async t => {
  const f = await fuzzBroker(t, fuzzScope('http://127.0.0.1:1'));
  await writeFixtureModules(f.inputRoot);
  const options = { inputRoot: f.inputRoot, readInput: (path: string, signal?: AbortSignal) => f.sandbox.filesystem.readInput(path, signal), boundary: 'custom-boundary', timeoutMs: 5000 };
  await assert.rejects(runDifferential({ subject: pair, strategy: 'bytes', seed: 'b3-boundary-1', cases: 1 }, options), code('UNAVAILABLE'));
  await assert.rejects(runDifferential({ subject: pair, strategy: 'bytes', seed: 'b3-boundary-1', cases: 1 }, { ...options, codeExecution: 'none' }), code('UNAVAILABLE'));
  assert.throws(() => createDefaultRegistry().get('fuzz.differential'), code('CAPABILITY_DENIED'));
  assert.throws(() => createDefaultRegistry().get('fuzz.template'), code('CAPABILITY_DENIED'));
  assert.deepEqual(createDefaultRegistry({ fuzz: true }).get('fuzz.differential').isolation, ['local-fixture']);
  assert.deepEqual(createDefaultRegistry({ fuzz: true }).get('fuzz.template').isolation, ['local-fixture', 'container']);
});

test('fuzz capability descriptors cannot be widened or re-identified by registry metadata', () => {
  const descriptors = createDefaultRegistry({ fuzz: true }).list().map(descriptor => structuredClone(descriptor) as ToolDescriptor);
  const tamperers: ((descriptor: ToolDescriptor) => void)[] = [
    descriptor => { (descriptor as { isolation: readonly string[] }).isolation = ['local-fixture', 'container']; },
    descriptor => { (descriptor as { actions: readonly string[] }).actions = ['read']; },
    descriptor => { (descriptor as { sideEffects: readonly string[] }).sideEffects = ['write-private-artifact']; },
    descriptor => { (descriptor as { inputSchema: unknown }).inputSchema = { type: 'string', maxLength: 1 }; },
    descriptor => { (descriptor as { implementationDigest: string }).implementationDigest = 'f'.repeat(64); },
    descriptor => { (descriptor as { version: string }).version = '2.0.0'; },
  ];
  for (const tamper of tamperers) {
    const changed = structuredClone(descriptors) as ToolDescriptor[];
    tamper(changed.find(descriptor => descriptor.id === 'fuzz.differential')!);
    assert.throws(() => new CapabilityRegistry(changed), code('INVALID_INPUT'));
  }
});

test('template fuzzing mutates only declared parts inside scope and records classified observations', async t => {
  const web = await templateFixture(t);
  const f = await fuzzBroker(t, fuzzScope(web.origin), { templates: [queryTemplate(web.origin), bodyTemplate(web.origin)] });
  const result = await f.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'b3-template-1', cases: 6 } });
  const evidence = result.data as FuzzTemplateEvidence;
  assert.equal(evidence.kind, 'fuzz-template');
  assert.equal(evidence.templateId, 'tpl-query');
  assert.equal(evidence.stopped, 'completed');
  assert.equal(evidence.casesRun, 6);
  assert.equal(evidence.baseline.status, 200);
  assert.equal(evidence.observations.length, 6);
  assert.equal(evidence.budget.attemptsUsed, 7);
  assert.equal(evidence.classifications.reduce((total, entry) => total + entry.count, 0), 6);
  assert.ok(evidence.classifications.some(entry => entry.name !== 'same'));
  for (const observation of evidence.observations) {
    const url = new URL(observation.url);
    assert.equal(url.origin, web.origin);
    assert.equal(url.pathname, '/tpl');
    assert.deepEqual([...url.searchParams.keys()], ['q']);
    assert.equal(observation.responseFingerprint.length, 64);
  }
  for (const hit of web.hits) {
    assert.equal(hit.path, '/tpl');
    assert.ok(hit.query.every(name => name === 'q'), `unexpected query parameter in ${hit.query.join(',')}`);
  }
  assert.equal(f.budgets.snapshot('fixture-target').requests, 7);
  assert.equal(await readFile(join(f.outputRoot, result.artifact.path), 'utf8'), JSON.stringify(result.data));
  assert.equal(result.receipt.targets[0], 'fixture-target');
  const body = await f.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-body', seed: 'b3-template-2', cases: 4 } });
  const bodyEvidence = body.data as FuzzTemplateEvidence;
  assert.equal(bodyEvidence.method, 'POST');
  assert.equal(bodyEvidence.observations.length, 4);
  assert.ok(bodyEvidence.observations.every(observation => observation.axis === 'body' && observation.name === 'body'));
  const posts = web.hits.filter(hit => hit.method === 'POST');
  assert.equal(posts.length, 5);
  assert.ok(posts.every(hit => hit.path === '/tpl' && hit.query.length === 1 && hit.query[0] === 'q'));
});

test('template fuzzing enforces per-template caps, rate windows and the target budget', async t => {
  const web = await templateFixture(t);
  const capped = await fuzzBroker(t, fuzzScope(web.origin), { templates: [queryTemplate(web.origin, { maxRequests: 3 })] });
  const first = await capped.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'b3-cap-1', cases: 8 } });
  const cappedEvidence = first.data as FuzzTemplateEvidence;
  assert.equal(cappedEvidence.stopped, 'request-cap');
  assert.equal(cappedEvidence.budget.requestsMax, 3);
  assert.equal(cappedEvidence.observations.length, 2);
  assert.equal(web.hits.length, 3);
  await assert.rejects(
    capped.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'b3-cap-2', cases: 1 } }),
    code('BUDGET_EXCEEDED'),
  );
  const limited = await fuzzBroker(t, fuzzScope(web.origin), { templates: [queryTemplate(web.origin, { rate: { requests: 1, windowMs: 600000 } })] });
  const rate = await limited.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'b3-rate-1', cases: 4 } });
  assert.equal((rate.data as FuzzTemplateEvidence).stopped, 'rate-limit');
  assert.equal((rate.data as FuzzTemplateEvidence).budget.attemptsUsed, 1);
  const budgeted = await fuzzBroker(t, fuzzScope(web.origin, { maxRequests: 2 }), { templates: [queryTemplate(web.origin)] });
  const budget = await budgeted.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'b3-budget-1', cases: 4 } });
  assert.equal((budget.data as FuzzTemplateEvidence).stopped, 'request-cap');
  assert.equal(budgeted.budgets.snapshot('fixture-target').requests, 2);
});

test('template fuzzing refuses host/account mutation, unapproved templates and expired approvals', async t => {
  const web = await templateFixture(t);
  const f = await fuzzBroker(t, fuzzScope(web.origin), { templates: [queryTemplate(web.origin)] });
  const base = { templateId: 'tpl-query', seed: 'b3-refuse-1', cases: 2 };
  await assert.rejects(f.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { ...base, templateId: 'tpl-unknown' } }), code('CAPABILITY_DENIED'));
  for (const extra of [{ url: `${web.origin}/tpl?q=base` }, { accountId: 'anonymous' }, { accountId: 'approved-user' }, { method: 'POST' }, { host: 'example.test' }, { headers: { host: 'example.test' } }, { target: web.origin }]) {
    await assert.rejects(f.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { ...base, ...extra } }), code('INVALID_INPUT'));
  }
  assert.throws(() => validateApprovedTemplates([queryTemplate(web.origin, { headers: [{ name: 'host', base: 'x', tokens: ['y'], maxLength: 8 }] })]), code('ACCOUNT_DENIED'));
  assert.throws(() => validateApprovedTemplates([queryTemplate(web.origin, { headers: [{ name: 'authorization', base: 'x', tokens: ['y'], maxLength: 8 }] })]), code('ACCOUNT_DENIED'));
  assert.throws(() => validateApprovedTemplates([queryTemplate(web.origin, { headers: [{ name: 'cookie', base: 'x', tokens: ['y'], maxLength: 8 }] })]), code('ACCOUNT_DENIED'));
  assert.throws(() => validateApprovedTemplates([queryTemplate(web.origin, { query: [{ name: 'token', tokens: ['x'], maxLength: 8 }] })]), code('ACCOUNT_DENIED'));
  assert.throws(() => validateApprovedTemplates([queryTemplate(web.origin, { query: [{ name: 'q', tokens: ['x'], maxLength: 8 }], method: 'GET', body: { base: 'b', tokens: ['x'], maxLength: 8 } })]), code('ACTION_DENIED'));
  const expired = await fuzzBroker(t, fuzzScope(web.origin), { templates: [queryTemplate(web.origin, { expiresAt: '2020-01-01T00:00:00.000Z' })] });
  await assert.rejects(expired.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: base }), code('EXPIRED'));
  const elsewhere = await fuzzBroker(t, fuzzScope('http://127.0.0.1:9'), { templates: [queryTemplate(web.origin)] });
  await assert.rejects(elsewhere.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: base }), code('TARGET_DENIED'));
  assert.equal(web.hits.length, 0);
});

test('external tool execution refuses an inert unqualified runner and only runs with a matching pin', async t => {
  const paths = await fuzzRoots(t);
  const policy = createPolicy(fuzzScope('http://127.0.0.1:1'));
  const budgets = new TargetBudget(policy.scope.targets);
  const sandbox = createLocalFixtureSandbox({ ...paths, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
  const imageRef = `p2o-lab/ffuf@sha256:${'c'.repeat(64)}`;
  const identity: ExternalRunnerIdentity = {
    tool: 'ffuf', version: '2.1.0', imageRef, binarySha256: 'a'.repeat(64), seccompProfileSha256: 'b'.repeat(64),
    networkPolicy: 'scope-only', platform: 'linux/amd64',
  };
  const pin: ExternalRunnerPin = { ...identity, approvedBy: 'fixture-owner', expiresAt: EXPIRES_AT };
  let calls = 0;
  const runner: ExternalFuzzRunner = {
    identity,
    async run() { calls += 1; return { exitCode: 0, requestsMade: 1, durationMs: 1, stdoutSha256: 'd'.repeat(64), stderrSha256: 'e'.repeat(64), artifactDigest: 'f'.repeat(64) }; },
  };
  const request = { templateId: 'tpl-query', seed: 'b3-external-1', maxRequests: 16 };
  await assert.rejects(runExternalTool({ pins: [pin], request }), code('UNAVAILABLE'));
  await assert.rejects(runExternalTool({ runner: { identity: undefined, run: runner.run }, pins: [pin], request }), code('UNAVAILABLE'));
  await assert.rejects(runExternalTool({ runner, pins: [], request }), code('UNAVAILABLE'));
  await assert.rejects(runExternalTool({ runner: { identity: { ...identity, version: '2.1.1' }, run: runner.run }, pins: [pin], request }), code('IDENTITY_DENIED'));
  await assert.rejects(runExternalTool({ runner: { identity: { ...identity, imageRef: 'p2o-lab/ffuf:latest' }, run: runner.run }, pins: [{ ...pin, imageRef: 'p2o-lab/ffuf:latest' }], request }), code('IDENTITY_DENIED'));
  await assert.rejects(runExternalTool({ runner, pins: [{ ...pin, tool: 'nuclei' }], request }), code('IDENTITY_DENIED'));
  await assert.rejects(runExternalTool({ runner, pins: [{ ...pin, expiresAt: '2020-01-01T00:00:00.000Z' }], request }), code('EXPIRED'));
  await assert.rejects(runExternalTool({ runner: { identity: { ...identity, seccompProfileSha256: 'g'.repeat(64) }, run: runner.run }, pins: [pin], request }), code('IDENTITY_DENIED'));
  const hostNetwork = { ...identity, networkPolicy: 'host' } as unknown as ExternalRunnerIdentity;
  await assert.rejects(runExternalTool({ runner: { identity: hostNetwork, run: runner.run }, pins: [{ ...pin, networkPolicy: 'host' } as unknown as ExternalRunnerPin], request }), code('IDENTITY_DENIED'));
  assert.equal(calls, 0, 'no refusal may reach the runner');
  const pack = createFuzzPack({ policy, budgets, sandbox, request: async () => { throw new Error('unused'); } });
  await assert.rejects(pack.externalTool(request), code('UNAVAILABLE'));
  assert.equal(calls, 0);
  const evidence = await runExternalTool({ runner, pins: [pin], request });
  assert.equal(evidence.kind, 'external-tool-run');
  assert.equal(evidence.tool, 'ffuf');
  assert.match(evidence.identityDigest, /^[a-f0-9]{64}$/);
  assert.equal(evidence.isolation, 'pinned-lab-image:no-host-execution');
  assert.equal(calls, 1);
});

test('doctor fails the fuzz-pack check when the boundary does not acknowledge trusted local code', async t => {
  const paths = await fuzzRoots(t);
  const registry = createDefaultRegistry({ fuzz: true });
  const sandbox = createLocalFixtureSandbox({ ...paths, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
  const report = await doctor({ registry, sandbox, required: ['fuzz.differential', 'fuzz.template'] });
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.name === 'fuzz-pack')?.ok, true);
  const refused = await doctor({ registry, sandbox: { ...sandbox, codeExecution: 'none' }, required: ['fuzz.differential'] });
  assert.equal(refused.ok, false);
  assert.equal(refused.checks.find(check => check.name === 'fuzz-pack')?.ok, false);
});

test('demo: deterministic fuzz evidence for the docs', async t => {
  const f = await fuzzBroker(t, fuzzScope('http://127.0.0.1:1'));
  await writeFixtureModules(f.inputRoot);
  const result = await f.broker.execute({ context: fuzzContext, tool: 'fuzz.differential', input: { subject: pair, strategy: 'bytes', seed: 'b3-differential-1', cases: 64, maxInputBytes: 32 } });
  const evidence = result.data as FuzzDifferentialEvidence;
  const divergence = evidence.divergence!;
  console.log([
    `seed=${evidence.seed} strategy=${evidence.strategy} casesMax=${evidence.casesMax} casesRun=${evidence.casesRun} outcome=${evidence.outcome}`,
    `subjectA=${divergence.subjectA.path} sha256=${evidence.subject.modules[0]!.sha256}`,
    `subjectB=${divergence.subjectB.path} sha256=${evidence.subject.modules[1]!.sha256}`,
    `foundAtCase=${divergence.foundAtCase} shrinkSteps=${divergence.shrinkSteps} initialBytes=${divergence.initial.bytes} reproducer.hex=${divergence.reproducer.hex} reproducer.bytes=${divergence.reproducer.bytes} reproducer.sha256=${divergence.reproducer.sha256}`,
    `subjectA.outcome=${JSON.stringify(divergence.subjectA.outcome)} digest=${divergence.subjectA.digest}`,
    `subjectB.outcome=${JSON.stringify(divergence.subjectB.outcome)} digest=${divergence.subjectB.digest}`,
    `divergence.digest=${divergence.digest}`,
    `artifact=${result.artifact.path} sha256=${result.artifact.sha256}`,
    `receipt.tool=${result.receipt.tool.id}@${result.receipt.tool.version} implementationDigest=${result.receipt.tool.implementationDigest} outcome=${result.receipt.outcome} classification=${result.receipt.classification}`,
  ].join('\n'));
  const web = await templateFixture(t);
  const tf = await fuzzBroker(t, fuzzScope(web.origin), { templates: [queryTemplate(web.origin)] });
  const templateResult = await tf.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'b3-template-1', cases: 4 } });
  const template = templateResult.data as FuzzTemplateEvidence;
  console.log([
    `template kind=${template.kind} templateId=${template.templateId} method=${template.method} stopped=${template.stopped} casesMax=${template.casesMax} casesRun=${template.casesRun} attemptsUsed=${template.budget.attemptsUsed}/${template.budget.requestsMax} baseline.status=${template.baseline.status}`,
    `template.classifications=${JSON.stringify(template.classifications)}`,
    `template.observation[0]=${JSON.stringify(template.observations[0])}`,
    `template.receipt.targets=${JSON.stringify(templateResult.receipt.targets)} requests=${templateResult.receipt.budgets['fixture-target']!.requests}`,
  ].join('\n'));
  const refusals: string[] = [];
  const record = async (label: string, run: () => Promise<unknown>) => {
    try { await run(); refusals.push(`${label} -> EXECUTED`); }
    catch (error) { refusals.push(`${label} -> ${(error as { code?: string }).code ?? 'UNKNOWN'}`); }
  };
  await record('differential input.url', () => f.broker.execute({ context: fuzzContext, tool: 'fuzz.differential', input: { subject: pair, strategy: 'bytes', seed: 'refuse-1', cases: 1, url: 'http://127.0.0.1:1/x' } }));
  await record('differential module http://', () => f.broker.execute({ context: fuzzContext, tool: 'fuzz.differential', input: { subject: { kind: 'module-pair', moduleA: 'http://127.0.0.1:1/a.mjs', moduleB: 'lenient-header.mjs' }, strategy: 'bytes', seed: 'refuse-1', cases: 1 } }));
  await record('template input.url', () => tf.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'refuse-1', url: `${web.origin}/tpl?q=x` } }));
  await record('template input.accountId', () => tf.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-query', seed: 'refuse-1', accountId: 'anonymous' } }));
  await record('template unknown id', () => tf.broker.execute({ context: fuzzContext, tool: 'fuzz.template', input: { templateId: 'tpl-unknown', seed: 'refuse-1', cases: 1 } }));
  await record('external runner absent', () => runExternalTool({ pins: [], request: { templateId: 'tpl-query', seed: 'refuse-1', maxRequests: 8 } }));
  try {
    validateApprovedTemplates([queryTemplate(web.origin, { headers: [{ name: 'host', base: 'x', tokens: ['y'], maxLength: 8 }] })]);
    refusals.push('template host header -> ACCEPTED');
  } catch (error) { refusals.push(`template host header -> ${(error as { code?: string }).code ?? 'UNKNOWN'}`); }
  console.log(`refusals:\n${refusals.join('\n')}`);
});
