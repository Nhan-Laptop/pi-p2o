import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CapabilityRegistry, createDefaultRegistry, createLocalFixtureSandbox, createRedactor, doctor, type ApiEvidence, type InventoryEvidence, type SourceEvidence, type WebEvidence } from '../../src/tools/index.js';
import { SandboxFilesystem } from '../../src/tools/filesystem.js';
import { brokerFixture, code, context, fixtureScope, roots, webFixture } from './fixtures.js';

const input = (url: string) => ({ url, accountId: 'anonymous' });
test('source analysis collects hashes/imports/routes/dependencies/secret indicators without executing code/hooks', async t => {
  const f = await brokerFixture(t, fixtureScope());
  const result = await f.broker.execute({ context, tool: 'source.analyze', input: { paths: ['app.ts', 'package.json'], contains: 'password' } });
  const data = result.data as SourceEvidence;
  assert.equal(data.kind, 'source'); assert.deepEqual(data.files[0]!.imports, ['node:http']);
  assert.deepEqual(data.files[0]!.routes, [{ method: 'GET', path: '/ok', line: 3 }]);
  assert.equal(data.files[1]!.dependencies['dependencies:fixture-dep'], '1.2.3');
  assert.equal(data.files[0]!.indicators[0]!.line, 4); assert.doesNotMatch(JSON.stringify(result), /fixture-only-secret/);
  assert.match(data.files[0]!.matches[0]!.text, /REDACTED/);
  assert.equal(f.budgets.snapshot('fixture-target').requests, 0); assert.match(data.limits[0]!, /Lexical/);
});
test('constrained browser observes HTML through broker; no scripts/subresources/forms are executed', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const result = await f.broker.execute({ context, tool: 'web.observe', input: input(`${web.origin}/page`) });
  const data = result.data as WebEvidence;
  assert.equal(data.title, 'Fixture'); assert.deepEqual(data.links.map(l => l.scopeDecision), ['allowed', 'blocked', 'blocked']);
  assert.equal(data.forms[0]!.scopeDecision, 'blocked'); assert.equal(data.forms[0]!.method, 'POST');
  assert.deepEqual(web.hits.map(h => h.path), ['/page']); assert.match(data.limits.join(' '), /Static HTML/);
  await assert.rejects(f.broker.execute({ context, tool: 'web.observe', input: { ...input(`${web.origin}/page`), eval: 'fetch("http://outside.test")' } }), code('INVALID_INPUT'));
});
test('API mapping records operations without following servers/remote refs/templates/mutations', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const result = await f.broker.execute({ context, tool: 'api.map', input: input(`${web.origin}/schema`) });
  const data = result.data as ApiEvidence;
  assert.equal(data.format, 'openapi-json'); assert.deepEqual(data.operations.map(o => o.scopeDecision), ['allowed', 'blocked', 'template-not-expanded', 'blocked']);
  assert.deepEqual(web.hits.map(h => h.path), ['/schema']);
});
test('inventory is scoped HEAD endpoint observation, pre-authorizes full list, and shares budgets', async t => {
  const web = await webFixture(t), f = await brokerFixture(t, fixtureScope(web.origin));
  const result = await f.broker.execute({ context, tool: 'service.inventory', input: { urls: [`${web.origin}/ok`, `${web.origin}/page`], accountId: 'anonymous' } });
  assert.equal((result.data as InventoryEvidence).services.length, 2); assert.deepEqual(web.hits.map(h => h.method), ['HEAD', 'HEAD']);
  await assert.rejects(f.broker.execute({ context, tool: 'service.inventory', input: { urls: [`${web.origin}/ok`, `${web.origin}/excluded/x`], accountId: 'anonymous' } }), code('TARGET_DENIED'));
  await assert.rejects(f.broker.execute({ context, tool: 'service.inventory', input: { urls: [`${web.origin}/ok`, `${web.origin}/ok`], accountId: 'anonymous' } }), code('INVALID_INPUT'));
  assert.equal(web.hits.length, 2);
});
test('filesystem rejects traversal, absolute paths, symlink files/ancestors and hardlinks', async t => {
  const f = await brokerFixture(t, fixtureScope());
  const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'host fixture secret');
  await symlink(outside, join(f.inputRoot, 'linked.txt'));
  await symlink(f.root, join(f.inputRoot, 'linked-directory'));
  await link(outside, join(f.inputRoot, 'hardlinked.txt'));
  for (const path of ['../outside.txt', outside, 'app.ts/../outside.txt', 'linked.txt', 'linked-directory/outside.txt', 'hardlinked.txt', 'C:\\outside.txt', '%2e%2e/outside.txt']) await assert.rejects(f.broker.execute({ context, tool: 'source.analyze', input: { paths: [path] } }), code('FILESYSTEM_DENIED'));
  assert.equal(await readFile(outside, 'utf8'), 'host fixture secret');
});
test('private output cannot follow task directory symlinks or mutate trusted inputs', async t => {
  const f = await brokerFixture(t, fixtureScope());
  await mkdir(join(f.outputRoot, context.runId), { mode: 0o700 });
  await symlink(f.inputRoot, join(f.outputRoot, context.runId, context.taskId));
  const before = await readFile(join(f.inputRoot, 'app.ts'), 'utf8');
  await assert.rejects(f.broker.execute({ context, tool: 'source.analyze', input: { paths: ['app.ts'] } }), code('FILESYSTEM_DENIED'));
  assert.equal(await readFile(join(f.inputRoot, 'app.ts'), 'utf8'), before);
});
test('preflight denies symlink roots, writable input/output aliasing, non-private output and missing acknowledgement', async t => {
  const p = await roots(t);
  const alias = join(p.root, 'alias'); await symlink(p.inputRoot, alias);
  const fs = new SandboxFilesystem({ ...p, inputRoot: alias }); assert.equal((await fs.preflight()).ok, false);
  assert.throws(() => new SandboxFilesystem({ ...p, outputRoot: join(p.inputRoot, 'outputs') }), code('FILESYSTEM_DENIED'));
  await chmod(p.outputRoot, 0o755);
  assert.equal((await new SandboxFilesystem(p).preflight()).ok, false);
  assert.throws(() => createLocalFixtureSandbox({ ...p, acknowledgement: 'silent-fallback' as never }), code('UNAVAILABLE'));
});
test('filesystem input identity replacement is denied after preflight', async t => {
  const p = await roots(t), fs = new SandboxFilesystem(p); assert.equal((await fs.preflight()).ok, true);
  await rename(p.inputRoot, join(p.root, 'old-inputs')); await mkdir(p.inputRoot, { mode: 0o700 }); await writeFile(join(p.inputRoot, 'app.ts'), 'replacement');
  await assert.rejects(fs.readInput('app.ts'), code('FILESYSTEM_DENIED'));
});
test('parallel artifact reservation, byte/count limits and cancellation are deterministic', async t => {
  const p = await roots(t), fs = new SandboxFilesystem({ ...p, maxArtifacts: 2, maxArtifactBytes: 20 }); assert.equal((await fs.preflight()).ok, true);
  const [one, two] = await Promise.all([fs.writeArtifact(context, '{}'), fs.writeArtifact(context, '{}')]);
  assert.notEqual(one.path, two.path); assert.equal(await readFile(join(p.outputRoot, one.path), 'utf8'), '{}');
  await assert.rejects(fs.writeArtifact(context, '{}'), code('OUTPUT_LIMIT'));
  const f2 = new SandboxFilesystem({ ...p, maxArtifactBytes: 1 }); assert.equal((await f2.preflight()).ok, true);
  await assert.rejects(f2.writeArtifact(context, '{}'), code('OUTPUT_LIMIT'));
  const cancel = new AbortController(); cancel.abort(); await assert.rejects(fs.readInput('app.ts', cancel.signal), code('CANCELLED'));
});
test('capability registry/doctor exposes identity, schemas/limits and refuses native pack in fixture mode', async t => {
  const p = await roots(t); const sandbox = createLocalFixtureSandbox({ ...p, acknowledgement: 'local-fixtures-only-not-hostile-code-isolation' });
  const registry = createDefaultRegistry();
  assert.equal((await doctor({ registry, sandbox, required: ['source.analyze', 'http.request', 'web.observe', 'api.map', 'service.inventory'] })).ok, true);
  const d = registry.get('http.request'); assert.equal(d.version, '1.0.0'); assert.match(d.implementationDigest, /^[a-f0-9]{64}$/); assert.ok(d.sideEffects.includes('explicit-mutation'));
  assert.throws(() => registry.validateInput('http.request', { url: 'http://127.0.0.1/', accountId: 'anonymous', bash: 'anything' }), code('INVALID_INPUT'));
  assert.throws(() => registry.validateOutput('http.request', { kind: 'http' }), code('INVALID_INPUT'));
  assert.equal((await doctor({ registry, sandbox, required: ['native.inspect'] })).ok, false);
  assert.equal((await doctor({ registry: createDefaultRegistry({ native: true }), sandbox, required: ['native.inspect'] })).ok, false);
  assert.throws(() => createDefaultRegistry({ limits: { maxResponseBytes: 999999999 } }), code('INVALID_INPUT'));
});
test('redaction covers structured secrets, known encoded/echoed values and private-key blocks', () => {
  const redactor = createRedactor(['unique-fixture-secret']);
  const safe = JSON.stringify(redactor.value({ Authorization: 'Bearer whatever', nested: { password: 'unknown-value' }, body: 'echo unique-fixture-secret password="inline-secret" -----BEGIN PRIVATE KEY-----\nsecret bytes\n-----END PRIVATE KEY-----' }));
  assert.doesNotMatch(safe, /unique-fixture-secret|unknown-value|inline-secret|secret bytes|whatever/);
  assert.match(safe, /REDACTED/);
});
test('registry metadata cannot spoof version/schema/identity, hide side effects or widen implemented limits', () => {
  const descriptor = createDefaultRegistry().get('http.request');
  assert.throws(() => new CapabilityRegistry([{ ...descriptor, version: '99.0.0' }]), code('INVALID_INPUT'));
  assert.throws(() => new CapabilityRegistry([{ ...descriptor, implementationDigest: '0'.repeat(64) }]), code('INVALID_INPUT'));
  assert.throws(() => new CapabilityRegistry([{ ...descriptor, inputSchema: { ...descriptor.inputSchema, additionalProperties: { type: 'string' } } }]), code('INVALID_INPUT'));
  assert.throws(() => new CapabilityRegistry([{ ...descriptor, limits: { ...descriptor.limits, maxResponseBytes: Number.MAX_SAFE_INTEGER } }]), code('INVALID_INPUT'));
  assert.throws(() => new CapabilityRegistry([{ ...descriptor, sideEffects: ['write-private-artifact'] }]), code('INVALID_INPUT'));
});
test('private-key source excerpts are masked across lines, not just at the PEM header', async t => {
  const f = await brokerFixture(t, fixtureScope());
  await writeFile(join(f.inputRoot, 'key.txt'), '-----BEGIN ENCRYPTED PRIVATE KEY-----\nfixture-private-key-bytes\n-----END ENCRYPTED PRIVATE KEY-----\n');
  const result = await f.broker.execute({ context, tool: 'source.analyze', input: { paths: ['key.txt'], contains: 'fixture-private-key-bytes' } });
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-key-bytes/); assert.match(JSON.stringify(result.data), /REDACTED PRIVATE KEY LINE/);
});
