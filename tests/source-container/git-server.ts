/** Controlled REAL Git smart-HTTP server. Test transport only; this is NOT live GitHub/HTTPS. */
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createProcessRunner } from '../../src/application/entry/clone.js';
import type { EntryCommandRunner } from '../../src/application/entry/types.js';
import { fingerprintTree } from '../../src/application/entry/snapshot.js';
import { ENTRY_BOUNDS_DEFAULTS } from '../../src/application/entry/types.js';

export const fixtureRepoUrl = 'https://github.com/p2o-controlled-fixture/source-canary';
export const fixtureCanary = 'export const approvedGitCanary = "P2O_REAL_CONTROLLED_GIT_CANARY";\n';
function git(cwd: string, args: string[]): string {
  const result = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'inert fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'inert fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0' } });
  if (result.status !== 0) throw new Error(`trusted fixture Git failed: ${result.stderr}`);
  return result.stdout.trim();
}
export async function gitServer(root: string) {
  const work = join(root, 'git-fixture-work'), served = join(root, 'git-fixture-server'), bare = join(served, 'fixture.git');
  await mkdir(work); await mkdir(served);
  git(work, ['init', '--initial-branch=main', '--template=']);
  await writeFile(join(work, 'canary.ts'), fixtureCanary);
  await writeFile(join(work, '.env'), 'FIXTURE_SECRET=exclude');
  await writeFile(join(work, '.gitattributes'), '*.ts filter=evil\n');
  await writeFile(join(work, 'package.json'), JSON.stringify({ scripts: { postinstall: `touch ${join(root, 'REPO_SCRIPT_EXECUTED')}` } }));
  await writeFile(join(work, '.gitmodules'), '[submodule "never"]\n path = never\n url = https://example.invalid/NEVER_CONTACT\n');
  await symlink('/etc/passwd', join(work, 'escape.ts'));
  git(work, ['add', '--all']); git(work, ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},never`]); git(work, ['commit', '-m', 'inert approved fixture']);
  git(root, ['clone', '--bare', '--no-hardlinks', '--template=', '--', work, bare]);
  const revision = git(work, ['rev-parse', 'HEAD']);
  const digest = (await fingerprintTree({ root: work, bounds: ENTRY_BOUNDS_DEFAULTS })).digest;
  const requests: string[] = [], children = new Set<ReturnType<typeof spawn>>();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    if (!['/fixture.git/info/refs', '/fixture.git/git-upload-pack'].includes(url.pathname) || !['GET', 'POST'].includes(request.method ?? '')) { response.writeHead(403); response.end(); return; }
    requests.push(`${request.method} ${url.pathname}`);
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) { response.writeHead(413); response.end(); return; } chunks.push(chunk); }
    const child = spawn('/usr/bin/git', ['http-backend'], { cwd: served, shell: false, env: { PATH: '/usr/bin:/bin', HOME: served, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_PROJECT_ROOT: served, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!, CONTENT_TYPE: request.headers['content-type'] ?? '', CONTENT_LENGTH: String(length), REMOTE_ADDR: '127.0.0.1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    let data = Buffer.alloc(0); child.stdout.on('data', chunk => { data = Buffer.concat([data, chunk]); if (data.length > 8 * 1024 * 1024) child.kill('SIGKILL'); }); child.stderr.resume();
    child.on('error', () => { response.writeHead(500); response.end(); });
    child.on('close', () => {
      clearTimeout(timer); children.delete(child);
      const split = data.indexOf('\r\n\r\n');
      if (split < 0) { response.writeHead(500); response.end(); return; }
      const headers: Record<string, string> = {}; let status = 200;
      for (const line of data.subarray(0, split).toString('utf8').split('\r\n')) { const colon = line.indexOf(':'); if (colon < 0) continue; const name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim(); if (name === 'status') status = Number(value.split(' ')[0]); else headers[name] = value; }
      response.writeHead(status, headers); response.end(data.subarray(split + 4));
    });
    child.stdin.end(Buffer.concat(chunks));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture.git`;
  const real = createProcessRunner(), invocations: string[][] = [];
  const runner: EntryCommandRunner = { async run(input) {
    const args = [...input.args]; invocations.push(args);
    const env = { ...input.env };
    if (args[0] === 'clone') {
      if (args.at(-2) !== fixtureRepoUrl) throw new Error('controlled test transport refuses every non-fixture repository');
      args[args.length - 2] = url;
      const ordinal = Number(env.GIT_CONFIG_COUNT); env.GIT_CONFIG_COUNT = String(ordinal + 1); env[`GIT_CONFIG_KEY_${ordinal}`] = 'protocol.http.allow'; env[`GIT_CONFIG_VALUE_${ordinal}`] = 'always';
    }
    return real.run({ ...input, args, env });
  } };
  return { revision, digest, runner, invocations, requests, work, label: 'real-git-controlled-loopback-http-NOT-live-GitHub',
    async advance() { await writeFile(join(work, 'canary.ts'), `${fixtureCanary}// remote commit drift\n`); git(work, ['add', 'canary.ts']); git(work, ['commit', '-m', 'inert remote drift']); git(work, ['push', '--', bare, 'HEAD:refs/heads/main']); return git(work, ['rev-parse', 'HEAD']); },
    async close() { for (const child of children) child.kill('SIGKILL'); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
