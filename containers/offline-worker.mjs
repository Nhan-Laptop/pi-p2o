import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACK_VERSION = '1.0.0';
const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };

/** Read-only magic/header/string inspection, never execution, tracing or fuzzing. */
export function inspectBuffer(path, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 1048576) fail('Bounded buffer required');
  let format = 'unknown', architecture = 'unknown';
  if (buffer.length >= 20 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    format = 'elf';
    const machine = buffer[5] === 2 ? buffer.readUInt16BE(18) : buffer.readUInt16LE(18);
    architecture = ({ 3: 'x86', 40: 'arm', 62: 'x86_64', 183: 'aarch64' })[machine] ?? `elf-machine-${machine}`;
  } else if (buffer.length >= 64 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const offset = buffer.readUInt32LE(0x3c);
    if (offset <= buffer.length - 6 && buffer.subarray(offset, offset + 4).equals(Buffer.from([0x50, 0x45, 0, 0]))) {
      format = 'pe'; const machine = buffer.readUInt16LE(offset + 4);
      architecture = ({ 0x14c: 'x86', 0x8664: 'x86_64', 0xaa64: 'aarch64' })[machine] ?? `pe-machine-${machine}`;
    }
  } else if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]))) { format = 'wasm'; architecture = 'wasm32-or-wasm64-not-inferred'; }
  const strings = [];
  const printable = buffer.toString('latin1').replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[REDACTED PRIVATE KEY]');
  for (const match of printable.matchAll(/[\x20-\x7e]{4,256}/g)) { if (strings.length >= 128) break; strings.push(match[0]); }
  return { kind: 'native', path, sha256: hash(buffer), bytes: buffer.length, format, architecture, strings, limits: ['Read-only header/string inspection; untrusted binaries are never executed.', 'Not tracing, fuzzing, crash reproduction or hostile-code isolation.'] };
}

const readText = async path => { try { return (await readFile(path, 'utf8')).trim(); } catch { return null; } };
const statusField = (status, name) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(status)?.[1]?.trim() ?? null;
const limitField = (limits, name) => { const line = limits.split('\n').find(entry => entry.startsWith(name)); return line ? line.slice(name.length).trim().split(/\s+/)[0] ?? null : null; };

/** The only network probe: a kernel-level connect/listen attempt that must be refused by seccomp. */
async function socketDenied() {
  return await new Promise(resolveProbe => {
    const server = createServer();
    server.once('error', error => resolveProbe(['EPERM', 'EACCES'].includes(error.code)));
    server.listen(0, '127.0.0.1', () => server.close(() => resolveProbe(false)));
  });
}

async function writeDenied(path) {
  try { const fd = await open(path, 'w'); await fd.close(); await unlink(path).catch(() => {}); return false; } catch { return true; }
}

async function scratchWritable() {
  const probe = `/tmp/.p2o-write-probe-${process.pid}`;
  try { const fd = await open(probe, 'w'); await fd.close(); await unlink(probe); return true; } catch { return false; }
}

/** cgroup v2 inside a cgroup namespace; v1 fallback for older hosts. */
async function cgroupLimits() {
  const memoryMax = await readText('/sys/fs/cgroup/memory.max');
  const pidsMax = await readText('/sys/fs/cgroup/pids.max');
  if (memoryMax && pidsMax) {
    const [cpuQuota, cpuPeriod] = (await readText('/sys/fs/cgroup/cpu.max') ?? '').split(/\s+/);
    return { version: 2, memoryMax, pidsMax, cpuQuota: cpuQuota ?? null, cpuPeriod: cpuPeriod ?? null };
  }
  return {
    version: 1,
    memoryMax: await readText('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    pidsMax: await readText('/sys/fs/cgroup/pids/pids.max'),
    cpuQuota: await readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),
    cpuPeriod: await readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us'),
  };
}

/**
 * Runs inside the pinned pack and refuses to proceed unless the kernel reports the qualified
 * confinement. The adapter re-verifies every reported value; this is the in-container half.
 */
async function environment() {
  if (process.env.P2O_OFFLINE_PACK !== '1') fail('Pack marker missing');
  if (process.getuid?.() !== 65532 || process.getgid?.() !== 65532) fail('Not in the pinned non-root pack');
  if (process.version !== 'v22.14.0') fail('Unexpected Node release');
  const mountinfo = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').map(line => line.split(' '));
  const mountOptions = path => { const entry = mountinfo.find(line => line[4] === path); return entry ? `${entry[5] ?? ''},${entry[6] ?? ''}` : ''; };
  const readOnly = path => mountOptions(path).split(',').includes('ro');
  const status = await readFile('/proc/self/status', 'utf8');
  const limits = await readFile('/proc/self/limits', 'utf8');
  const evidence = {
    uid: process.getuid?.(), gid: process.getgid?.(), pid1: process.pid === 1,
    nodeVersion: process.version, execPath: process.execPath, arch: process.arch, platform: process.platform,
    rootReadOnly: readOnly('/'), inputReadOnly: readOnly('/inputs'),
    rootWriteDenied: await writeDenied('/.p2o-write-probe'), inputWriteDenied: await writeDenied('/inputs/.p2o-write-probe'),
    scratchWritable: await scratchWritable(), noNetwork: await socketDenied(),
    seccompMode: Number(statusField(status, 'Seccomp')), seccompFilters: Number(statusField(status, 'Seccomp_filters')),
    noNewPrivileges: Number(statusField(status, 'NoNewPrivs')), capabilities: statusField(status, 'CapEff'),
    ulimits: { nofile: limitField(limits, 'Max open files'), core: limitField(limits, 'Max core file size') },
    cgroup: await cgroupLimits(),
  };
  if (evidence.uid !== 65532 || evidence.gid !== 65532) fail('Non-root identity is not 65532:65532');
  if (!evidence.pid1) fail('Worker is not the container init process');
  if (!evidence.rootReadOnly || !evidence.rootWriteDenied) fail('Root filesystem is not read-only');
  if (!evidence.inputReadOnly || !evidence.inputWriteDenied) fail('Input mount is not read-only');
  if (!evidence.scratchWritable) fail('Private scratch is not writable');
  if (!evidence.noNetwork) fail('Network socket syscalls are not denied by the pinned security profile');
  if (evidence.seccompMode !== 2 || !(evidence.seccompFilters >= 1)) fail('Seccomp filtering is not active');
  if (evidence.noNewPrivileges !== 1) fail('no_new_privs is not set');
  if ((evidence.capabilities ?? '').replace(/0/g, '') !== '') fail('Capabilities are not dropped');
  return evidence;
}

async function native(path, expectedSha256) {
  if (typeof path !== 'string' || path.length > 4096 || /[\\:%\u0000-\u001f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) fail('Invalid input path');
  let absolute = '/inputs';
  for (const p of path.split('/')) { absolute = join(absolute, p); if ((await lstat(absolute)).isSymbolicLink()) fail('Symlink denied'); }
  const before = await lstat(absolute);
  if (!before.isFile() || before.nlink !== 1 || before.size > 1048576) fail('Unsafe or excessive native input');
  const fd = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let buffer;
  try {
    const stat = await fd.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || !stat.isFile() || stat.size > 1048576) fail('Native input changed');
    buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) { const { bytesRead } = await fd.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
    if (offset !== stat.size) fail('Native input changed size');
    buffer = buffer.subarray(0, offset);
  } finally { await fd.close(); }
  if (hash(buffer) !== expectedSha256) fail('Native input hash differs from supervisor snapshot');
  return inspectBuffer(path, buffer);
}

async function main() {
  const evidence = await environment();
  let input = '', bytes = 0;
  for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 4194304) fail('Input limit exceeded'); input += chunk.toString('utf8'); }
  const request = JSON.parse(input);
  let result;
  if (request.operation === 'preflight') result = {
    protocol: 1, packVersion: PACK_VERSION, workerSha256: hash(await readFile(fileURLToPath(import.meta.url))), sourceSha256: hash(await readFile(join(root, 'tools/source.js'))),
    nodeSha256: hash(await readFile(process.execPath)), nonRoot: true, ...evidence,
  };
  else if (request.operation === 'source') {
    const { analyzeSourceFiles } = await import('./tools/source.js');
    result = analyzeSourceFiles(request.files, request.contains);
  } else if (request.operation === 'native') result = await native(request.path, request.expectedSha256);
  else fail('Unsupported offline operation');
  const output = JSON.stringify(result);
  if (Buffer.byteLength(output) > 2097152) fail('Output limit exceeded');
  process.stdout.write(output);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Offline pack failed closed\n'); process.exitCode = 1; });
