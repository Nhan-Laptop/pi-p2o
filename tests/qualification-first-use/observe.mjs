import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:token|ownerToken|leaseToken|apiKey|secret|authorizationHeader|password|refreshToken|accessToken)$/i.test(key) ? '[REDACTED]' : redact(item)]));
  if (typeof value === 'string') return value.replace(/p2o-gw\.v1\.[a-f0-9.]+/g, '[attempt-gateway-placeholder]').replace(/qualification-inert-not-a-live-credential/g, '[inert-test-credential]');
  return value;
}
export const append = (file, value) => appendFileSync(file, `${JSON.stringify(redact(value))}\n`, { mode: 0o600 });

export function command(file, args, { timeout = 20000, cwd, env, input, log } = {}) {
  const started = Date.now();
  const result = spawnSync(file, args, { cwd, env, input, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
  const receipt = { file, args, started, ended: Date.now(), exitCode: result.status, signal: result.signal,
    error: result.error?.message, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (log) append(log, receipt); return receipt;
}
export function walk(root, limit = 2000) {
  const files = [];
  function visit(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= limit) throw new Error('ARTIFACT_FILE_BOUND');
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path); else if (entry.isFile()) files.push(path);
    }
  }
  visit(root); return files.sort();
}
export function hashTree(root) {
  return walk(root).map(path => ({ path: relative(root, path), bytes: lstatSync(path).size,
    sha256: sha256(readFileSync(path)) }));
}
export function jsonArtifacts(root) {
  return walk(root).filter(path => /\.json$/.test(path) && lstatSync(path).size <= 2 * 1024 * 1024).flatMap(path => {
    if (/auth\.json$|models\.json$|worker\.json$/.test(path)) return [];
    try { return [{ path, value: redact(JSON.parse(readFileSync(path, 'utf8'))) }]; } catch { return []; }
  });
}
export function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const apiKey = argv.indexOf('--api-key'); if (apiKey >= 0 && argv[apiKey + 1]) argv[apiKey + 1] = '[REDACTED]';
    return { pid: Number(pid), state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]), startTicks: fields[19],
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), executable: (() => {
        try { return readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch { return null; }
      })(), argv: redact(argv) };
  } catch { return null; }
}
const same = (left, right) => left && right && left.pid === right.pid && left.startTicks === right.startTicks && left.bootId === right.bootId;
export function observeProcesses(home, controllerPid, log) {
  const observed = new Map();
  const sample = () => {
    const rows = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => processIdentity(Number(name))).filter(Boolean);
    const owned = new Set([controllerPid, ...[...observed.values()].filter(row => same(row, processIdentity(row.pid))).map(row => row.pid)]);
    for (let pass = 0; pass < 4; pass++) {
      for (const row of rows) {
        if (row.pid === controllerPid || row.pid === process.pid) continue;
        if (!row.argv.some(arg => arg.includes(home)) && !owned.has(row.ppid)) continue;
        owned.add(row.pid);
        const key = `${row.pid}:${row.startTicks}`;
        if (!observed.has(key)) { observed.set(key, row); append(log, { at: Date.now(), event: 'observed-owned-marker-or-child', identity: row }); }
      }
    }
  };
  const timer = setInterval(sample, 80); sample();
  return { observed, sample, survivors() { sample(); return [...observed.values()].filter(row => same(row, processIdentity(row.pid)) && !['Z', 'X'].includes(processIdentity(row.pid)?.state)); },
    close() { clearInterval(timer); sample(); } };
}
export function observeDocker(home, image, log, commandLog) {
  const containers = new Map(), errors = [];
  const child = spawn('/usr/bin/docker', ['events', '--filter', 'type=container', '--filter', `image=${image}`, '--format', '{{json .}}'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  child.stderr.on('data', data => errors.push(data.toString()));
  child.stdout.on('data', data => {
    buffer += data.toString();
    for (;;) {
      const index = buffer.indexOf('\n'); if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      let event; try { event = JSON.parse(line); } catch { continue; }
      const id = event.Actor?.ID ?? event.id;
      if (!id) continue;
      // Observe, never modify: only retain containers with a mount under OUR fresh HOME.
      if (!containers.has(id) && (event.Action ?? event.status) === 'create') {
        const receipt = command('/usr/bin/docker', ['inspect', id], { timeout: 1500 });
        if (receipt.exitCode === 0) {
          const inspect = JSON.parse(receipt.stdout)[0];
          if (inspect.Mounts?.some(mount => mount.Source?.startsWith(`${home}/`))) {
            containers.set(id, inspect); append(log, { at: Date.now(), event: 'owned-create-inspect', inspect });
            append(commandLog, { ...receipt, stdout: '(inspection preserved in docker-events.jsonl)' });
          }
        }
      }
      if (containers.has(id)) append(log, { at: Date.now(), event });
    }
  });
  return { containers, errors,
    absence() {
      return [...containers.entries()].map(([id, inspect]) => {
        const receipt = command('/usr/bin/docker', ['inspect', id], { timeout: 1500, log: commandLog });
        return { id, name: inspect.Name, absent: receipt.exitCode === 1 && /No such (object|container)/.test(receipt.stderr), exitCode: receipt.exitCode };
      });
    },
    close() { child.kill('SIGTERM'); },
  };
}

/** ADDITIONAL REAL DOCKER CANARY, not a substitute for the production broker/container invocation.
 * Uses the actual generated snapshot mount + pinned image. Never mounts the original source read-write. */
export function dockerCanary(config, path, expected, log) {
  const options = config.sandbox?.options;
  if (!options?.approvedSource || options.inputRoot !== options.approvedSource.snapshot.root) throw new Error('CANARY_SOURCE_UNBOUND');
  const label = randomUUID(), name = `p2o-qualification-${label}`;
  const script = `const f=require('node:fs'),c=require('node:crypto'),p='/inputs/'+process.argv[1];const b=f.readFileSync(p);let denial;try{f.writeFileSync(p,'must-not-write');denial='WRITE_SUCCEEDED'}catch(e){denial=e.code}console.log(JSON.stringify({uid:process.getuid(),path:p,sha256:c.createHash('sha256').update(b).digest('hex'),bytes:b.length,denial}));if(denial==='WRITE_SUCCEEDED')process.exit(3)`;
  const create = command('/usr/bin/docker', ['create', '--name', name, '--label', `p2o.qualification.owner=${label}`,
    '--pull=never', '--network=none', '--read-only', '--user=65532:65532', '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true', `--security-opt=seccomp=${options.seccompPath}`,
    '--memory=256m', '--memory-swap=256m', '--pids-limit=32', '--cpus=0.5', '--log-driver=none',
    '--mount', `type=bind,src=${options.inputRoot},dst=/inputs,readonly,bind-propagation=rprivate`,
    '--entrypoint=/usr/local/bin/node', options.image, '-e', script, path], { timeout: 10000, log });
  if (create.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(create.stdout.trim())) throw new Error(`CANARY_CREATE_FAILED: ${create.stderr}`);
  const id = create.stdout.trim(); let inspect, started;
  try {
    const receipt = command('/usr/bin/docker', ['inspect', id], { log });
    if (receipt.exitCode !== 0) throw new Error('CANARY_INSPECT_FAILED'); inspect = JSON.parse(receipt.stdout)[0];
    if (inspect.Config?.Labels?.['p2o.qualification.owner'] !== label || inspect.Image !== options.image) throw new Error('CANARY_IDENTITY_MISMATCH');
    started = command('/usr/bin/docker', ['start', '--attach', id], { timeout: 10000, log });
    if (started.exitCode !== 0) throw new Error(`CANARY_READ_FAILED: ${started.stderr}`);
    const proof = JSON.parse(started.stdout.trim());
    if (proof.sha256 !== expected || proof.uid !== 65532 || !['EROFS', 'EACCES', 'EPERM'].includes(proof.denial)) throw new Error(`CANARY_BAD_PROOF: ${started.stdout}`);
    return { evidenceClass: 'additional-real-Docker-same-approved-mount-not-production-tool', id, name, image: inspect.Image,
      mounts: inspect.Mounts, proof, originalMountUsed: false };
  } finally {
    // Only the created exact ID with the unguessable label and pinned image; never remove by prefix/name.
    const current = command('/usr/bin/docker', ['inspect', id], { timeout: 1500, log });
    if (current.exitCode === 0) {
      const record = JSON.parse(current.stdout)[0];
      if (record.Id === id && record.Config?.Labels?.['p2o.qualification.owner'] === label && record.Image === options.image) command('/usr/bin/docker', ['rm', '--force', id], { timeout: 3000, log });
    }
  }
}
