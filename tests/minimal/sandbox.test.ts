import { describe, expect, it } from 'vitest';
import { Sandbox, IMAGE } from '../../src/sandbox.js';
import { cleanText, type RunProcess } from '../../src/process.js';

function driver() {
  const calls: string[][] = []; const streams: Array<string | undefined> = []; const names = new Set<string>();
  const queue: string[] = [];
  let cleanupFails = false; let execFails = false;
  // P10/TR-H09: a test hook between dispatch and return, so overlap can be observed without real docker.
  let onExec: ((command: string | undefined) => Promise<void> | void) | undefined;
  const run: RunProcess = async (args, options) => {
    calls.push(args); streams.push(options?.stdin);
    const flags = args[0] === '--host' ? args.slice(2) : args;
    let stdout = '';
    if (flags[0] === 'context') stdout = '"unix:///var/run/docker.sock"';
    if (flags[0] === 'info') stdout = 'linux';
    if (flags[0] === 'create') names.add(flags[flags.indexOf('--name') + 1]);
    if (flags[0] === 'inspect') stdout = 'true';
    if (flags[0] === 'exec') {
      if (execFails) throw new Error('Docker operation timed out');
      stdout = 'safe data';
      await onExec?.(flags.at(-1));
    }
    // Only the ephemeral curl container is scripted; the shell's `sleep infinity` is not.
    if (flags[0] === 'start' && flags.includes('--attach')) stdout = queue.shift() ?? '';
    if (flags[0] === 'rm' && !cleanupFails) names.delete(flags.at(-1)!);
    if (flags[0] === 'container') stdout = [...names].filter(name => flags.join(' ').includes(name)).join('\n');
    return { code: 0, stdout, stderr: '', truncated: false };
  };
  return {
    calls, streams, names, run,
    script: (...values: string[]) => { queue.push(...values); },
    cleanupFailure: () => { cleanupFails = true; },
    cleanupRecovery: () => { cleanupFails = false; },
    execFailure: () => { execFails = true; },
    setExecHook: (hook: typeof onExec) => { onExec = hook; },
  };
}
const target = { kind: 'url' as const, url: 'https://example.com', origin: 'https://example.com' };
const request = { url: '/x', method: 'GET' as const, followRedirects: true, maxRedirects: 3 };

describe('sandbox executor, no agents', () => {
  it('starts a pinned, fully privileged executor with network egress; model shell only reaches docker exec', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start(); await sandbox.exec('printf data');
    const create = d.calls.find(args => args.includes('create'))!;
    expect(create).toContain(IMAGE);
    for (const flag of ['--read-only', '--cap-drop', '--security-opt', '--pids-limit', '--memory', '--cpus']) expect(create, flag).not.toContain(flag);
    expect(create[create.indexOf('--user') + 1]).toBe('root');
    expect(create[create.indexOf('--network') + 1]).toBe('bridge');
    expect(create).not.toContain('printf data');
    expect(d.calls.find(args => args.includes('exec'))?.at(-1)).toBe('printf data');
    await sandbox.stop(); expect(d.names.size).toBe(0);
    await sandbox.stop();
    await expect(sandbox.exec('id')).rejects.toThrow('No active');
  });
  it('sends any method, headers and a body through one ephemeral fixed-curl container', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run, async () => ['93.184.216.34']);
    await sandbox.start();
    d.script('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok');
    const result = await sandbox.http({ ...request, method: 'POST', headers: { 'X-Test': '1', Authorization: 'Bearer t' }, body: '{"a":1}' });
    const index = d.calls.findIndex(args => args.includes('/usr/bin/curl'));
    const create = d.calls[index];
    expect(create[create.indexOf('--network') + 1]).toBe('bridge');
    expect(create[create.indexOf('--entrypoint') + 1]).toBe('/usr/bin/curl');
    expect(create).toContain('example.com:443:93.184.216.34');
    expect(create).toContain('--no-location');
    expect(create).not.toContain('--head');
    expect(create.slice(create.indexOf('--request'))).toEqual(expect.arrayContaining(['--request', 'POST']));
    expect(create.join(' ')).toContain('-H X-Test: 1');
    expect(create.join(' ')).toContain('-H Authorization: Bearer t');
    expect(create).toContain('--data-binary'); expect(create).toContain('@-');
    expect(create).not.toContain('--volume'); expect(create).not.toContain('/bin/sh');
    expect(d.calls[index + 1]).toContain('--interactive');
    expect(d.streams[index + 1]).toBe('{"a":1}');
    expect(result.hops).toEqual(['200 POST https://example.com/x → 93.184.216.34 (public)']);
    expect(d.names.size).toBe(1); // Only the executor remains; the request container is gone.
    d.script('HTTP/1.1 200 OK\r\n\r\nok');
    await expect(sandbox.http({ ...request, url: 'https://other.com/' })).resolves.toMatchObject({ hops: [expect.stringContaining('other.com')] });
    await sandbox.stop();
  });
  it('follows redirects across origins because there is no scope (Part XI)', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run, async () => ['93.184.216.34']);
    await sandbox.start();
    d.script('HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\n', 'HTTP/1.1 200 OK\r\n\r\nok');
    const reached = await sandbox.http(request);
    expect(reached.hops).toEqual(['302 GET https://example.com/x → 93.184.216.34 (public)', '200 GET https://example.com/next → 93.184.216.34 (public)']);
    d.script('HTTP/1.1 302 Found\r\nLocation: https://other.com/\r\n\r\n', 'HTTP/1.1 200 OK\r\n\r\nok');
    const crossed = await sandbox.http(request);
    expect(crossed.hops!).toHaveLength(2); expect(crossed.hops![1]).toContain('other.com'); expect(crossed.redirectStopped).toBeUndefined();
    d.script('HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\n');
    const unfollowed = await sandbox.http({ ...request, followRedirects: false });
    expect(unfollowed.hops).toHaveLength(1);
    expect(unfollowed.stdout).toContain('302');
    await sandbox.stop();
  });
  it('keeps session cookies for the run and never reuses them across origins', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run, async () => ['93.184.216.34']);
    await sandbox.start();
    d.script('HTTP/1.1 200 OK\r\nSet-Cookie: sid=abc123; Path=/; HttpOnly\r\n\r\nok');
    await sandbox.http(request);
    d.script('HTTP/1.1 200 OK\r\n\r\nok');
    await sandbox.http({ ...request, url: '/second' });
    const second = d.calls.filter(args => args.includes('/usr/bin/curl')).at(-1)!;
    expect(second.join(' ')).toContain('-H Cookie: sid=abc123');
    await sandbox.stop();
  });
  it('preserves GET bodies and isolates named sessions, principals and explicit Cookie overrides', async () => {
    const d=driver(),sandbox=new Sandbox(target,d.run,async()=>['93.184.216.34']);await sandbox.start();
    const ok='HTTP/1.1 200 OK\r\n\r\nok';
    d.script('HTTP/1.1 200 OK\r\nSet-Cookie: sid=alice; Path=/\r\n\r\nok');
    await sandbox.http({...request,session:'alice',body:'get-body'});
    let call=d.calls.filter(c=>c.includes('/usr/bin/curl')).at(-1)!;
    expect(call.slice(call.indexOf('--request'),call.indexOf('--request')+2)).toEqual(['--request','GET']);
    expect(call).toContain('--interactive');
    d.script(ok);await sandbox.http({...request,session:'bob'});
    expect(d.calls.filter(c=>c.includes('/usr/bin/curl')).at(-1)!.join(' ')).not.toContain('Cookie: sid=alice');
    d.script(ok);await sandbox.http({...request,session:'alice',principal:'worker'});
    expect(d.calls.filter(c=>c.includes('/usr/bin/curl')).at(-1)!.join(' ')).not.toContain('Cookie: sid=alice');
    d.script(ok);await sandbox.http({...request,session:'alice',headers:{Cookie:'sid=explicit'}});
    call=d.calls.filter(c=>c.includes('/usr/bin/curl')).at(-1)!;
    expect(call).toContain('Cookie: sid=explicit');expect(call).not.toContain('Cookie: sid=alice');
    d.script(ok);await sandbox.http({...request,session:'alice',resetSession:true});
    expect(d.calls.filter(c=>c.includes('/usr/bin/curl')).at(-1)!.join(' ')).not.toContain('Cookie: sid=alice');
    await sandbox.stop();
  });
  it('revalidates at the executor boundary and does not replay writes after transport failure', async () => {
    const d=driver(),sandbox=new Sandbox(target,d.run,async()=>['93.184.216.34']);await sandbox.start();
    await expect(sandbox.http({...request,headers:{'X-Test':'bad\r\nInjected: yes'}})).rejects.toThrow('Invalid value');
    expect(d.calls.filter(c=>c.includes('/usr/bin/curl'))).toHaveLength(0);
    const failing:RunProcess=async(args,options)=>{const result=await d.run(args,options);return args.includes('--attach')?{...result,code:56}:result;};
    const second=new Sandbox(target,failing,async()=>['93.184.216.34']);await second.start();
    d.script('HTTP/1.1 302 Found\r\nLocation: /next\r\n\r\n');
    const result=await second.http({...request,method:'POST',body:'write'});
    expect(result.code).toBe(56);expect(result.hops).toHaveLength(1);expect(result.redirectStopped).toContain('no automatic retry');
    await sandbox.stop();await second.stop();
  });
  it('allows loopback and private destinations and records the address class', async () => {
    const local = { kind: 'url' as const, url: 'http://127.0.0.1:8080/', origin: 'http://127.0.0.1:8080' };
    const d = driver(); const sandbox = new Sandbox(local, d.run);
    await sandbox.start();
    d.script('HTTP/1.1 200 OK\r\n\r\nok');
    const result = await sandbox.http({ ...request, url: 'http://127.0.0.1:8080/health' });
    expect(result.hops).toEqual(['200 GET http://127.0.0.1:8080/health → 127.0.0.1 (loopback)']);
    const create = d.calls.filter(args => args.includes('/usr/bin/curl')).at(-1)!;
    expect(create).not.toContain('--resolve');
    const lan = driver(); const lanSandbox = new Sandbox({ kind: 'url', url: 'http://intranet.lab/', origin: 'http://intranet.lab' }, lan.run, async () => ['10.0.0.7']);
    await lanSandbox.start(); lan.script('HTTP/1.1 200 OK\r\n\r\nok');
    expect((await lanSandbox.http({ ...request, url: 'http://intranet.lab/admin' })).hops).toEqual(['200 GET http://intranet.lab/admin → 10.0.0.7 (private)']);
    await sandbox.stop(); await lanSandbox.stop();
  });
  it('retains ownership if daemon removal is not verified, and permits retry', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start(); d.cleanupFailure();
    await expect(sandbox.stop()).rejects.toThrow('could not be verified');
    expect(d.names.size).toBe(1);
    d.cleanupRecovery(); await sandbox.stop(); expect(d.names.size).toBe(0);
  });
  it('removes the entire sandbox after exec timeout rather than leaving background processes', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start(); d.execFailure();
    await expect(sandbox.exec('sleep 999')).rejects.toThrow('timed out');
    expect(d.names.size).toBe(0);
    await expect(sandbox.exec('id')).rejects.toThrow('No active');
  });
  it('defaults to unlimited tasks, accepts opt-in long timeouts and rejects malformed values', async () => {
    const d = driver(); const sandbox = new Sandbox(target, d.run);
    await sandbox.start();
    for(const seconds of [undefined,0,61,300,900]) await expect(sandbox.exec('id',seconds)).resolves.toMatchObject({code:0});
    expect(d.calls.filter(c=>c.includes('exec')).find(c=>c.at(-1)==='id')).not.toContain('/usr/bin/timeout');
    for(const seconds of [-1,1.5,NaN,Infinity,'30' as any]) await expect(sandbox.exec('id',seconds)).rejects.toThrow('non-negative');
    expect(d.calls.filter(c=>c.includes('/usr/bin/timeout')).at(-1)).toContain('900s');
    await expect(sandbox.http({ ...request, url: 'https://example.com/'.concat('x'.repeat(8200)) })).rejects.toThrow('8192');
    await sandbox.stop();
  });
  it('P10/TR-H09: an explicit shared concurrency cap overlaps target operations, while the default stays strictly serial', async () => {
    const overlapping = driver(); const gates: Array<() => void> = []; let active = 0, peak = 0;
    overlapping.setExecHook(async command => {
      if (command !== 'first' && command !== 'second') return;
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>(resolve => gates.push(resolve)); active -= 1;
    });
    const shared = new Sandbox(target, overlapping.run, undefined, { concurrentOperations: 2 });
    await shared.start();
    const first = shared.exec('first'), second = shared.exec('second');
    while (gates.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    expect(peak).toBe(2);
    gates.splice(0).forEach(release => release()); await Promise.all([first, second]);
    await shared.stop();

    const serialDriver = driver(); const serialGates: Array<() => void> = []; let serialPeak = 0, serialActive = 0;
    serialDriver.setExecHook(async command => {
      if (command !== 'one' && command !== 'two') return;
      serialActive += 1; serialPeak = Math.max(serialPeak, serialActive);
      await new Promise<void>(resolve => serialGates.push(resolve)); serialActive -= 1;
    });
    const serial = new Sandbox(target, serialDriver.run);
    await serial.start();
    const one = serial.exec('one'), two = serial.exec('two');
    while (serialGates.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
    expect(serialPeak, 'without the explicit cap the second command is not dispatched while the first is in flight').toBe(1);
    serialGates.shift()!(); while (serialGates.length < 1) await new Promise(resolve => setTimeout(resolve, 0));
    serialGates.shift()!(); await Promise.all([one, two]);
    expect(serialPeak).toBe(1);
    await serial.stop();
  });
  it('strips terminal escapes from target-controlled output', () => {
    expect(cleanText('\u001b[31mhello\u001b[0m\u0000')).toBe('hello');
  });
});
