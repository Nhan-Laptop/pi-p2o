import { expect, it } from 'vitest';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, Sandbox } from '../../src/sandbox.js';
import type { RunProcess } from '../../src/process.js';

/**
 * A17.9 drift guard: the default suite must see the sandbox posture without Docker. Measured 2026-10-27 against the
 * pinned image: root (uid 0) on a writable rootfs with Docker's default 14-capability set, so the argv carries no
 * --read-only, no --cap-drop, no --cap-add and no --privileged. The opt-in Docker suite asserts the live facts; this
 * pins the argv that produces them.
 */
const FORBIDDEN = ['--read-only', '--cap-drop', '--cap-add', '--privileged'];

it('builds the measured sandbox posture into LIMITS and the docker create argv, without Docker', async () => {
  const limits = LIMITS({ runId: 'argv-limits' });
  expect(limits.join(' ')).toContain('--user root');
  for (const flag of FORBIDDEN) expect(limits, flag).not.toContain(flag);
  // Docker's 14 default capabilities are kept: CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, SETPCAP,
  // NET_BIND_SERVICE, NET_RAW, SYS_CHROOT, MKNOD, AUDIT_WRITE, SETFCAP. Dropping or adding one would change posture.

  const root = await realpath(await mkdtemp(join(tmpdir(), 'p2o-argv-')));
  await writeFile(join(root, 'source.txt'), 'source');
  const calls: string[][] = [];
  const containers = new Set<string>();
  const fakeRun: RunProcess = async args => {
    calls.push(args);
    const flags = args[0] === '--host' ? args.slice(2) : args;
    let stdout = '';
    if (flags[0] === 'context') stdout = '"unix:///var/run/docker.sock"';
    else if (flags[0] === 'info') stdout = 'linux';
    else if (flags[0] === 'inspect') stdout = 'true';
    else if (flags[0] === 'create') containers.add(flags[flags.indexOf('--name') + 1]);
    else if (flags[0] === 'rm') containers.delete(flags.at(-1)!);
    else if (flags[0] === 'container') stdout = [...containers].join('\n');
    return { code: 0, stdout, stderr: '', truncated: false };
  };
  const previousHost = process.env.DOCKER_HOST; delete process.env.DOCKER_HOST;
  const sandbox = new Sandbox({ kind: 'directory', path: root }, fakeRun, undefined, { runId: 'argv-create' });
  try {
    await sandbox.start();
    const create = calls.find(args => (args[0] === '--host' ? args[2] : args[0]) === 'create');
    expect(create).toBeDefined();
    expect(create!.join(' ')).toContain('--user root');
    expect(create![create!.indexOf('--volume') + 1]).toMatch(/:\/target:ro$/);
    expect(create![create!.indexOf('--network') + 1]).toBe('bridge');
    for (const flag of FORBIDDEN) expect(create, flag).not.toContain(flag);
    expect(create![create!.indexOf('--label') + 1]).toBe('pi-p2o=minimal');
  } finally {
    await sandbox.stop();
    if (previousHost !== undefined) process.env.DOCKER_HOST = previousHost;
    await rm(root, { recursive: true, force: true });
  }
});
