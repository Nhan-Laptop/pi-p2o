import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireApprovedSource, assertSourceIdentity } from '../../src/application/source-binding/index.js';
import { buildGitCloneInvocation, cloneGitHubRepoSafely } from '../../src/application/entry/clone.js';
import { ENTRY_BOUNDS_DEFAULTS } from '../../src/application/entry/types.js';
import { approvedRequest, roots } from './fixtures.js';
import { fixtureCanary, fixtureRepoUrl, gitServer } from './git-server.js';

describe('REAL Git controlled smart-HTTP fixture (NOT live GitHub)', () => {
  it('clones actual Git objects, resolves full commit, excludes links/secrets/git, no hooks/submodules/scripts', async () => {
    const r = await roots(); const server = await gitServer(r.root);
    const inheritedTemplate = process.env.GIT_TEMPLATE_DIR, inheritedConfig = process.env.GIT_CONFIG_GLOBAL;
    try {
      const evil = join(r.root, 'evil-template'); await mkdir(join(evil, 'hooks'), { recursive: true });
      await writeFile(join(evil, 'hooks/post-checkout'), `#!/bin/sh\ntouch ${join(r.root, 'HOOK_EXECUTED')}\n`, { mode: 0o700 });
      const config = join(r.root, 'evil-config'); await writeFile(config, `[filter "evil"]\n smudge = touch ${join(r.root, 'FILTER_EXECUTED')}\n required = true\n`);
      process.env.GIT_TEMPLATE_DIR = evil; process.env.GIT_CONFIG_GLOBAL = config;
      const approved = await approvedRequest({ root: r.root, origin: fixtureRepoUrl, kind: 'github-repo', digest: server.digest, revision: server.revision });
      const source = await acquireApprovedSource({ ...approved, privateRoot: r.privateRoot, commandRunner: server.runner, cloneTimeoutMs: 10000 });
      expect(server.label).toContain('NOT-live-GitHub'); expect(server.requests).toContain('POST /fixture.git/git-upload-pack');
      expect(source.identity.revision).toBe(server.revision); expect(source.identity.digest).toBe(server.digest);
      expect(await readFile(join(source.seal.root, 'canary.ts'), 'utf8')).toBe(fixtureCanary);
      for (const name of ['.git', '.env', 'escape.ts']) expect(existsSync(join(source.seal.root, name))).toBe(false);
      for (const name of ['HOOK_EXECUTED', 'FILTER_EXECUTED', 'REPO_SCRIPT_EXECUTED']) expect(existsSync(join(r.root, name))).toBe(false);
      expect(existsSync(join(source.seal.root, 'never'))).toBe(false);
      assertSourceIdentity(approved.request, source);
      const drifted = { ...structuredClone(source), identity: { ...source.identity, revision: 'b'.repeat(40) } };
      expect(() => assertSourceIdentity(approved.request, drifted)).toThrow();
      expect(server.invocations.every(args => ['clone', '-C'].includes(args[0]!))).toBe(true);
      expect(server.invocations.filter(args => args.includes('rev-parse'))).toHaveLength(2);
    } finally {
      if (inheritedTemplate === undefined) delete process.env.GIT_TEMPLATE_DIR; else process.env.GIT_TEMPLATE_DIR = inheritedTemplate;
      if (inheritedConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = inheritedConfig;
      await server.close(); await r.cleanup();
    }
  });
  it('rejects REAL remote HEAD drift after approval and deletes the failed clone, no auto-repin', async () => {
    const r = await roots(); const server = await gitServer(r.root);
    try {
      const approved = await approvedRequest({ root: r.root, origin: fixtureRepoUrl, kind: 'github-repo', digest: server.digest, revision: server.revision });
      expect(await server.advance()).not.toBe(server.revision);
      await expect(acquireApprovedSource({ ...approved, privateRoot: r.privateRoot, commandRunner: server.runner })).rejects.toMatchObject({ code: 'SCOPE_DIGEST_MISMATCH' });
      expect(await readdir(r.privateRoot)).toEqual([]); expect(server.requests.length).toBeGreaterThan(0);
    } finally { await server.close(); await r.cleanup(); }
  });
  it('always bounds a real cloned tree even without an injectable inspect callback', async () => {
    const r = await roots(); const server = await gitServer(r.root);
    try {
      const destination = join(r.privateRoot, 'source');
      await expect(cloneGitHubRepoSafely({ repoUrl: fixtureRepoUrl, destination, privateRoot: join(r.root, 'git-control'), runner: server.runner, bounds: { ...ENTRY_BOUNDS_DEFAULTS, maxFileBytes: 8 }, timeoutMs: 10000 })).rejects.toMatchObject({ code: 'TARGET_TOO_LARGE' });
      expect(existsSync(destination)).toBe(false);
    } finally { await server.close(); await r.cleanup(); }
  });
  it('production invocation allows HTTPS github.com only and disables redirects/credential/config inheritance', () => {
    const invocation = buildGitCloneInvocation({ repoUrl: fixtureRepoUrl, destination: '/private/source', privateRoot: '/private/control', hooksDir: '/private/control/hooks', templateDir: '/private/control/template' });
    expect(invocation.env.GIT_CONFIG_KEY_0).toBe('http.followRedirects'); expect(invocation.env.GIT_CONFIG_VALUE_0).toBe('false');
    expect(invocation.env.GIT_CONFIG_KEY_1).toBe('http.sslVerify'); expect(invocation.env.GIT_CONFIG_VALUE_1).toBe('true');
    expect(invocation.env.GIT_CONFIG_KEY_7).toBe('protocol.https.allow'); expect(invocation.env.GIT_CONFIG_VALUE_7).toBe('always');
    expect(invocation.args).toContain('--no-recurse-submodules'); expect(invocation.env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(Object.keys(invocation.env)).not.toContain('HTTPS_PROXY'); expect(Object.keys(invocation.env)).not.toContain('SSH_AUTH_SOCK');
  });
});
