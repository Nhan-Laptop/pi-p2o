import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSettings } from '../../src/roles.js';
import { DEFAULT_RULE_ID, POLICY_KINDS, SEED_IDS, commandPolicy, decide, parseCommandPolicy, policyAudit, seededRules, type PolicyRequest } from '../../src/policy.js';
import { fixture } from './helpers/report-fixture.js';

/**
 * A7.7 (planning_update.md P7.3): the command policy layer. "Yes to RCE, no to rm -rf" has to be a host decision, not prompt text:
 * rules come from operator settings only, precedence is fixed, the seeded deny list is disable-able and named, an ask is a bounded
 * pending decision the operator resolves with /p2o approve|deny, and every dispatch that can reach a container is evaluated first.
 */
const program = (rules: any[], extra: Record<string, unknown> = {}) => ({ p2o: { commandPolicy: { rules, ...extra } } });
const settingsWith = (raw: unknown) => parseSettings(raw).commandPolicy ?? { rules: [], disableSeeds: [] };
const request = (text: string, kind: PolicyRequest['kind'] = 'shell'): PolicyRequest => ({ kind, text });
const evaluate = (text: string, raw: unknown = {}, kind: PolicyRequest['kind'] = 'shell') => parseSettings(raw).commandPolicy ? commandPolicy(parseSettings(raw).commandPolicy!).evaluate(request(text, kind)) : commandPolicy().evaluate(request(text, kind));

describe('seeded deny list (A7.7)', () => {
  it('denies the irreversible host-level mistakes it names, and nothing ordinary', () => {
    const policy = commandPolicy();
    for (const command of ['rm -rf /', 'rm -fr / --no-preserve-root', 'sudo rm -rf /*', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda bs=1M',
      'shutdown -h now', 'reboot', ':(){ :|:& };:', 'bomb(){ bomb|bomb& };bomb', 'echo pwned > /target/code.txt', 'docker ps', 'sudo docker run x', 'pkill -9 1', 'killall5']) {
      expect(policy.evaluate(request(command)), command).toMatchObject({ action: 'deny' });
    }
    for (const command of ['rm -rf /work/out', 'cat /target/code.txt', 'ls -la', 'curl http://fixture.test/', 'dd if=/dev/zero of=/work/zero bs=1M count=1', 'python3 app.py', 'docker.io is a registry name']) {
      expect(policy.evaluate(request(command)), command).toMatchObject({ action: 'allow', ruleId: DEFAULT_RULE_ID });
    }
    // The Docker seed is a shell/net rule: a URL that merely contains "docker" is not a Docker CLI invocation.
    expect(policy.evaluate(request('GET https://hub.docker.com/v2/', 'http'))).toMatchObject({ action: 'allow' });
    // Every seed has one id, and the ordered list names all of them as enabled.
    expect(new Set(SEED_IDS).size).toBe(SEED_IDS.length);
    expect(policy.enabledSeeds).toEqual([...SEED_IDS]);
    expect(policy.rules.filter(rule => rule.mode === 'regex').length).toBe(SEED_IDS.length);
  });

  it('lets the operator disable a seed by name, records the name, and refuses to guess an unknown one', () => {
    const policy = commandPolicy(parseCommandPolicy(program([], { disableSeeds: ['seed.docker-cli', 'seed.mkfs', 'seed.not-a-rule'] })));
    expect(policy.disabledSeeds).toEqual(['seed.docker-cli', 'seed.mkfs']); // sorted, unknown id dropped
    expect(policy.evaluate(request('docker ps')).action).toBe('allow');
    expect(policy.evaluate(request('mkfs.ext4 /dev/sda1')).action).toBe('allow');
    expect(policy.evaluate(request('rm -rf /')).action).toBe('deny'); // other seeds stay armed
    expect(policy.enabledSeeds).not.toContain('seed.docker-cli');
  });
});

describe('operator rules and precedence (A7.7)', () => {
  it('applies operator deny → seeded deny → operator ask → operator allow → default allow', () => {
    const policy = commandPolicy(parseCommandPolicy(program([
      { action: 'allow', match: 'mkfs', reason: 'fixture allow that must lose to a seed' },
      { action: 'allow', match: 'nmap', reason: 'fixture allow' },
      { action: 'ask', match: 'curl', reason: 'fixture ask outranks allow' },
      { action: 'deny', match: 'nmap', reason: 'fixture deny outranks allow' },
    ])));
    expect(policy.evaluate(request('nmap -sV fixture'))).toMatchObject({ action: 'deny', ruleId: 'operator.deny.3' });
    expect(policy.evaluate(request('mkfs.ext4 /dev/sda1'))).toMatchObject({ action: 'deny', ruleId: 'seed.mkfs' }); // seeds outrank operator allow
    expect(policy.evaluate(request('curl http://fixture.test'))).toMatchObject({ action: 'ask', ruleId: 'operator.ask.2' });
    expect(policy.evaluate(request('ls'))).toMatchObject({ action: 'allow', ruleId: DEFAULT_RULE_ID });
    // The rule order in the settings file decides among equal actions: deny rules keep their given order.
    const two = commandPolicy(parseCommandPolicy(program([{ action: 'deny', match: 'aa', reason: 'first' }, { action: 'deny', match: 'aaa', reason: 'second' }])));
    expect(two.evaluate(request('aaaa'))).toMatchObject({ ruleId: 'operator.deny.0', reason: 'first' });
  });

  it('parses operator settings defensively and treats a match as a literal substring, never a regular expression', () => {
    const parsed = parseCommandPolicy(program([
      { action: 'deny', match: 'a.*b', reason: 'literal fixture' },
      { action: 'maybe', match: 'unused', reason: 'invalid action' },
      { action: 'deny', match: '', reason: 'empty match' },
      { action: 'deny', match: 'ok', reason: 'no reason should also drop the next one' , id: 'no-reason' },
      { action: 'ask', match: 'needs approval', reason: 'fixture ask', id: 'named-rule' },
      { action: 'deny', match: 'named-rule-dup', reason: 'duplicate id dropped', id: 'named-rule' },
    ]));
    expect(parsed.rules.map(rule => rule.id)).toEqual(['operator.deny.0', 'no-reason', 'named-rule']);
    expect(parsed.rules[0].match).toBe('a.*b');
    // `.*` is literal, so it matches the characters and not every string in between.
    const policy = commandPolicy(parsed);
    expect(policy.evaluate(request('a.*b')).action).toBe('deny');
    expect(policy.evaluate(request('aXXb')).action).toBe('allow');
    expect(parseCommandPolicy(null)).toEqual({ rules: [], disableSeeds: [] });
    expect(parseCommandPolicy({ rules: 'nope' })).toEqual({ rules: [], disableSeeds: [] });
    // A rule only comes from operator settings; a case-varied substring is enough (matching is case-insensitive).
    expect(evaluate('CURL http://fixture.test', program([{ action: 'deny', match: 'curl', reason: 'case-insensitive fixture' }]))).toMatchObject({ action: 'deny' });
    expect(POLICY_KINDS).toEqual(['shell', 'net', 'http', 'send']);
  });
});

describe('policy audit derivation (A7.7)', () => {
  it('counts decisions by rule from committed records and names the rule shape the run started with', () => {
    const audit = policyAudit([
      { data: { commandPolicy: { operatorRules: 1, enabledSeeds: ['seed.mkfs', 'seed.power'], disabledSeeds: ['seed.docker-cli'] } } },
      { data: { policyDecision: { action: 'deny', ruleId: 'seed.mkfs', reason: 'x', kind: 'shell', command: 'mkfs.ext4 /dev/sda1' } } },
      { data: { policyAsk: { id: 'policy-ask-11111111-1111-4111-8111-111111111111', requestHash: 'a', kind: 'shell', ruleId: 'operator.ask.0', reason: 'needs approval', command: 'curl x', by: 'owner', at: '2030' } } },
      { data: { policyDigest: { counts: { 'default.target-operation': 2, 'operator.approved': 1 }, total: 3 } } },
      { data: { policyDigest: { counts: { 'default.target-operation': 1 }, total: 1 } } },
    ]);
    expect(audit).toMatchObject({ operatorRules: 1, enabledSeeds: ['seed.mkfs', 'seed.power'], disabledSeeds: ['seed.docker-cli'] });
    expect(audit!.decisions).toEqual([
      { action: 'deny', ruleId: 'seed.mkfs', count: 1 },
      { action: 'ask', ruleId: 'operator.ask.0', count: 1 },
      { action: 'allow', ruleId: 'default.target-operation', count: 3 },
      { action: 'allow', ruleId: 'operator.approved', count: 1 },
    ]);
    expect(policyAudit([{ data: { note: 'no policy record' } }])).toBeUndefined();
    // A resumed run records its policy again: the latest startup record names the shape in force.
    expect(policyAudit([{ data: { commandPolicy: { operatorRules: 0, enabledSeeds: [], disabledSeeds: [] } } }, { data: { commandPolicy: { operatorRules: 2, enabledSeeds: ['seed.mkfs'], disabledSeeds: [] } } }]))
      .toMatchObject({ operatorRules: 2, enabledSeeds: ['seed.mkfs'] });
  });
});

describe('command policy in a run (A7.7)', () => {
  it('denies before any bytes reach a container on every owner dispatch path, and audits each refusal', async () => fixture(async h => {
    await writeFile(join(h.root, 'settings.json'), JSON.stringify(program([{ id: 'no-example', action: 'deny', match: 'example', reason: 'fixture denies this destination' }])));
    await h.command('--target ./source');
    const sandbox = h.sandboxes[0];
    await expect(h.call('p2o_shell', { command: 'curl http://example.test/a' })).rejects.toThrow(/POLICY_DENY: no-example: fixture denies this destination/);
    await expect(h.call('p2o_net', { command: 'nc example.test 80' })).rejects.toThrow(/POLICY_DENY: no-example/);
    await expect(h.call('p2o_http', { method: 'GET', url: 'http://example.test/x' })).rejects.toThrow(/POLICY_DENY: no-example/);
    // Nothing reached the sandbox, so the deny is a host decision and not a target observation.
    expect(sandbox.commands).toEqual([]);
    expect(sandbox.httpCalls).toEqual([]);
    const store = await h.reader();
    try {
      const denials = store.records().filter((record: any) => record.data?.policyDecision).map((record: any) => record.data.policyDecision);
      expect(denials).toHaveLength(3);
      expect(denials.every((entry: any) => entry.action === 'deny' && entry.ruleId === 'no-example')).toBe(true);
      expect(denials.map((entry: any) => entry.kind)).toEqual(['shell', 'net', 'http']);
      expect(denials.every((entry: any) => entry.command.length <= 500)).toBe(true);
      expect(denials[0].taskRef).toBeUndefined();
    } finally { store.close(); }
    // An allowed command still runs, and the allow is counted rather than audited one record per operation.
    const ran = await h.call('p2o_shell', { command: 'printf allowed' });
    expect(ran.details.exitCode).toBe(0);
    expect(sandbox.commands.map((entry: any) => entry.command)).toEqual(['printf allowed']);
  }));

  it('records a pending ask, refuses with its id, and lets the operator approve the exact request exactly once', async () => fixture(async h => {
    await writeFile(join(h.root, 'settings.json'), JSON.stringify(program([{ action: 'ask', match: 'curl', reason: 'outbound fetch needs an operator decision' }])));
    await h.command('--target ./source');
    const sandbox = h.sandboxes[0];
    const ask = /POLICY_ASK_PENDING: (policy-ask-[a-f0-9-]{36}): operator\.ask\.0/.exec(await h.call('p2o_shell', { command: 'curl http://fixture.test/a' }).then(() => '', (error: Error) => error.message));
    expect(ask).toBeTruthy();
    expect(sandbox.commands).toEqual([]); // an ask never executes
    const id = ask![1];
    // A repeated identical request reuses the pending id instead of recording a second ask.
    await expect(h.call('p2o_shell', { command: 'curl http://fixture.test/a' })).rejects.toThrow(new RegExp(`POLICY_ASK_PENDING: ${id}`));
    await h.command(`approve ${id}`);
    expect(h.ctx.notices.at(-1)).toContain(`Policy ask ${id} approved`);
    const allowed = await h.call('p2o_shell', { command: 'curl http://fixture.test/a' });
    expect(allowed.details.exitCode).toBe(0);
    expect(sandbox.commands).toHaveLength(1);
    // The approval was consumed by that one operation: the same request asks again with a new id.
    const again = /POLICY_ASK_PENDING: (policy-ask-[a-f0-9-]{36})/.exec(await h.call('p2o_shell', { command: 'curl http://fixture.test/a' }).then(() => '', (error: Error) => error.message));
    expect(again).toBeTruthy();
    expect(again![1]).not.toBe(id);
    await h.command(`approve ${id}`);
    expect(h.ctx.notices.at(-1)).toContain('was already approved');
    // Denying the new ask refuses that exact request once, and nothing runs.
    await h.command(`deny ${again![1]}`);
    await expect(h.call('p2o_shell', { command: 'curl http://fixture.test/a' })).rejects.toThrow(/POLICY_DENY: operator\.denied/);
    expect(sandbox.commands).toHaveLength(1);
    const store = await h.reader();
    try {
      const records = store.records();
      expect(records.filter((record: any) => record.data?.policyAsk).length).toBe(2);
      expect(records.filter((record: any) => record.data?.policyResolution?.decision === 'allow' && record.by === 'owner').length).toBe(1);
      expect(records.filter((record: any) => record.data?.policyResolution?.decision === 'deny' && record.by === 'owner').length).toBe(1);
      expect(records.filter((record: any) => record.data?.policyConsumed).length).toBe(2);
      // No model surface can write a rule: the ask records the rule the operator configured, quoted as recorded facts.
      expect(JSON.stringify(records.filter((record: any) => record.data?.policyAsk).map((record: any) => record.data.policyAsk)))
        .toContain('outbound fetch needs an operator decision');
    } finally { store.close(); }
  }));

  it('names a disabled seed in the report and prints allow counts by rule from the digest', async () => fixture(async h => {
    await writeFile(join(h.root, 'settings.json'), JSON.stringify(program([{ action: 'deny', match: 'fixture-forbidden', reason: 'fixture rule' }], { disableSeeds: ['seed.docker-cli'] })));
    await h.command('--target ./source');
    await h.call('p2o_shell', { command: 'printf one' });
    await h.call('p2o_shell', { command: 'printf two' });
    await expect(h.call('p2o_shell', { command: 'mkfs.ext4 /dev/sda1' })).rejects.toThrow(/POLICY_DENY: seed\.mkfs/);
    expect(h.sandboxes[0].commands.map((entry: any) => entry.command)).toEqual(['printf one', 'printf two']); // the disabled Docker seed does not refuse ordinary commands
    h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    const line = report.split('\n').find((row: string) => row.startsWith('- Command policy:'));
    expect(line).toContain('1 operator rule(s)');
    expect(line).toContain('7 seeded deny rule(s) enabled');
    expect(line).toContain('disabled seeds: seed.docker-cli');
    expect(line).toContain('deny 1 (seed.mkfs 1)');
    expect(line).toContain('allow 2 (default.target-operation 2)');
    expect(line).toContain('ask 0');
    const store = await h.reader();
    try { expect(store.records().filter((record: any) => record.data?.policyDigest).length).toBeGreaterThan(0); } finally { store.close(); }
  }));

  it('flushes the allow digest on the finish export too, so both export doors count the same operations (P8.0)', async () => fixture(async h => {
    await h.command('--target ./source');
    await h.call('p2o_shell', { command: 'printf finish-export-one' });
    await h.call('p2o_shell', { command: 'printf finish-export-two' });
    const exported = await h.call('p2o_finish', { export: true });
    expect(exported.details.reportPath).toBeTruthy();
    const report = (await h.read(exported.details.reportPath))['REPORT.md'];
    const line = report.split('\n').find((row: string) => row.startsWith('- Command policy:'));
    expect(line).toContain('allow 2 (default.target-operation 2)');
    // The same digest record the manual `/p2o report export` writes: one export door cannot undercount the other.
    const store = await h.reader();
    try {
      const digests = store.records().filter((record: any) => record.data?.policyDigest);
      expect(digests).toHaveLength(1);
      expect(digests[0].data.policyDigest.total).toBe(2);
    } finally { store.close(); }
  }));

  it('routes the broker worker dispatch through the same seam instead of each tool deciding for itself', async () => {
    // A7.7 "one evaluation point": the worker path (broker) is wired to the same executeWithReceipt closure as the owner tools,
    // so adding a fifth tool cannot quietly skip the policy. This pins the wiring, not the wording of a generated prompt.
    const source = await readFile(new URL('../../extensions/p2o/index.ts', import.meta.url), 'utf8');
    const broker = source.slice(source.indexOf('current.broker = new Broker(control, {'));
    for (const kind of ['exec', 'net', 'http']) expect(broker).toMatch(new RegExp(`${kind}: \\(command|${kind}: \\(request`));
    expect(broker.slice(0, 4000)).not.toMatch(/sandbox\.(exec|http)\(/); // the broker itself never reaches a container
    expect(source).toMatch(/\(POLICY_KINDS as readonly string\[\]\)\.includes\(operation\)\) await enforcePolicy\(current, operation as PolicyKind, input, by\)/);
  });
});
