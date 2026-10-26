import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SECRET_KINDS, containsSecretValue, identitySummary, loadIdentityFile, parseIdentity, redactSecrets, sealIdentity,
  secretIndex, secretViews, sha256Hex, substituteSecrets, substituteShellSecrets,
  type IdentitySecret, type SecretKind,
} from '../../src/identity.js';

const roots: string[] = [];
const tempDir = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'p2o-identity-'));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const makeSecret = (overrides: Partial<IdentitySecret> = {}): IdentitySecret => ({
  id: 'svc', kind: 'password', value: 'hunter2!', ...overrides,
});
const validRaw = () => ({ secrets: [
  { id: 'svc', kind: 'password', value: 'hunter2!' },
  { id: 'api', kind: 'token', value: 'tok-123' },
] });

describe('parseIdentity', () => {
  it('accepts a valid file and preserves values, labels and scopes verbatim', () => {
    const raw = { secrets: [
      { id: 'svc', kind: 'password', value: '  hunter2!  ', label: ' Service login ', scope: 'prod' },
      { id: 'api-key-1', kind: 'api-key', value: 'abc' },
    ] };
    const parsed = parseIdentity(raw);
    expect(parsed).toEqual(raw);
    expect(parsed.secrets[0].value).toBe('  hunter2!  ');
    expect(SECRET_KINDS).toEqual(['password', 'token', 'api-key', 'cookie', 'private-key', 'basic-auth', 'header', 'other']);
  });

  it('refuses non-objects, missing/empty secrets, duplicates, bad ids, bad kinds, NUL, oversize and unknown keys', () => {
    expect(() => parseIdentity(null)).toThrow(/object/i);
    expect(() => parseIdentity([])).toThrow(/object/i);
    expect(() => parseIdentity('not json')).toThrow(/object/i);
    expect(() => parseIdentity({})).toThrow(/secrets/);
    expect(() => parseIdentity({ secrets: [] })).toThrow(/non-empty/);
    expect(() => parseIdentity({ secrets: [makeSecret(), makeSecret({ value: 'other' })] })).toThrow(/Duplicate secret id: svc/);
    expect(() => parseIdentity({ secrets: [makeSecret({ id: 'Bad_ID' })] })).toThrow(/id/);
    expect(() => parseIdentity({ secrets: [makeSecret({ kind: 'key' as unknown as SecretKind })] })).toThrow(/kind/);
    expect(() => parseIdentity({ secrets: [makeSecret({ value: 'a\u0000b' })] })).toThrow(/NUL/);
    expect(() => parseIdentity({ secrets: [makeSecret({ value: 'x'.repeat(65537) })] })).toThrow(/value/);
    expect(() => parseIdentity({ secrets: [makeSecret()], extra: true })).toThrow(/Unknown identity field: extra/);
    expect(() => parseIdentity({ secrets: [{ ...makeSecret(), extra: true }] })).toThrow(/unknown field: extra/);
    expect(() => parseIdentity({ secrets: [makeSecret(), makeSecret({ id: 'two' })] })).not.toThrow();
  });

  it('enforces the 256-secret and 65536-byte boundaries', () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `s${index}`, kind: 'token', value: 'v' }));
    expect(() => parseIdentity({ secrets: many(257) })).toThrow(/at most 256/);
    expect(parseIdentity({ secrets: many(256) }).secrets).toHaveLength(256);
    expect(parseIdentity({ secrets: [makeSecret({ value: 'x'.repeat(65536) })] }).secrets[0].value).toHaveLength(65536);
  });

  it('validates label and scope length and control characters', () => {
    expect(() => parseIdentity({ secrets: [makeSecret({ label: 'x'.repeat(201) })] })).toThrow(/label/);
    expect(() => parseIdentity({ secrets: [makeSecret({ scope: 'bad\nscope' })] })).toThrow(/scope/);
    expect(() => parseIdentity({ secrets: [makeSecret({ label: 42 as unknown as string })] })).toThrow(/label/);
  });
});

describe('loadIdentityFile', () => {
  it('loads an absolute regular file', async () => {
    const root = await tempDir();
    const path = join(root, 'identity.json');
    await writeFile(path, JSON.stringify(validRaw()));
    await expect(loadIdentityFile(path)).resolves.toEqual(parseIdentity(validRaw()));
  });

  it('refuses a relative path, symlink, directory and oversized file', async () => {
    await expect(loadIdentityFile('identity.json')).rejects.toThrow(/absolute/);
    const root = await tempDir();
    const target = join(root, 'target.json');
    const link = join(root, 'link.json');
    await writeFile(target, JSON.stringify(validRaw()));
    await symlink(target, link);
    await expect(loadIdentityFile(link)).rejects.toThrow(/regular file|symlink/i);
    await expect(loadIdentityFile(root)).rejects.toThrow(/regular file/i);
    const oversized = join(root, 'oversized.json');
    await writeFile(oversized, 'x'.repeat(64 * 1024 + 1));
    await expect(loadIdentityFile(oversized)).rejects.toThrow(/65536|at most/);
  });

  it('refuses invalid UTF-8 and invalid JSON', async () => {
    const root = await tempDir();
    const binary = join(root, 'binary.json');
    await writeFile(binary, Buffer.from([0xff, 0xfe, 0xfd]));
    await expect(loadIdentityFile(binary)).rejects.toThrow(/UTF-8/);
    const json = join(root, 'bad.json');
    await writeFile(json, '{not json');
    await expect(loadIdentityFile(json)).rejects.toThrow(/JSON/);
  });
});

describe('sealIdentity', () => {
  it('writes a 0600 canonical copy and returns no values', async () => {
    const root = await tempDir();
    const sourcePath = join(root, 'identity.json');
    const source = { secrets: [
      { id: 'svc', kind: 'password', value: 's3cr3t-pw-9f2', label: 'Service' },
      { id: 'api', kind: 'token', value: 't0ken-value-7a1', scope: 'prod' },
    ] };
    await writeFile(sourcePath, JSON.stringify(source));
    const controlDir = join(root, 'control');

    const sealed = await sealIdentity(sourcePath, controlDir);
    expect(sealed.path).toBe(join(controlDir, 'identity', 'identity.json'));
    expect(isAbsolute(sealed.path)).toBe(true);
    expect(sealed.count).toBe(2);
    expect('value' in sealed).toBe(false);
    expect(sealed).not.toHaveProperty('secrets');
    expect(JSON.stringify(sealed)).not.toContain('s3cr3t-pw-9f2');
    expect(JSON.stringify(sealed)).not.toContain('t0ken-value-7a1');

    expect((await stat(sealed.path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(controlDir, 'identity'))).mode & 0o777).toBe(0o700);
    const bytes = await readFile(sealed.path);
    expect(sealed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(sealed.sha256).toBe(sha256Hex(bytes));
    expect(bytes.toString('utf8')).toBe(JSON.stringify(parseIdentity(source)));
    const roundTripped = parseIdentity(JSON.parse(bytes.toString('utf8')));
    expect(roundTripped).toEqual(parseIdentity(source));
    expect(roundTripped.secrets.map(secret => secret.value)).toEqual(['s3cr3t-pw-9f2', 't0ken-value-7a1']);
  });

  it('hashes strings and buffers identically', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex(Buffer.from('abc')));
    expect(sha256Hex('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });
});

describe('secretViews and identitySummary', () => {
  it('sorts views by id, omits values, and never leaks a value in the summary', () => {
    const identity = parseIdentity({ secrets: [
      { id: 'zeta', kind: 'token', value: 'ZETA-VALUE-123', label: 'Zeta' },
      { id: 'alpha', kind: 'password', value: 'ALPHA-VALUE-456', scope: 'login' },
      { id: 'beta', kind: 'api-key', value: 'BETA-VALUE-789' },
    ] });
    const views = secretViews(identity);
    expect(views.map(view => view.id)).toEqual(['alpha', 'beta', 'zeta']);
    for (const view of views) expect('value' in view).toBe(false);
    expect(views.find(view => view.id === 'zeta')?.label).toBe('Zeta');
    expect(views.find(view => view.id === 'alpha')?.scope).toBe('login');

    const summary = identitySummary(identity);
    expect(summary.startsWith('3 secret(s):')).toBe(true);
    expect(summary).toContain('password:alpha');
    expect(summary).toContain('token:zeta');
    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual(200);
    for (const secret of identity.secrets) expect(summary).not.toContain(secret.value);
  });

  it('caps a long summary at 200 characters without values', () => {
    const identity = parseIdentity({ secrets: Array.from({ length: 40 }, (_, index) => ({
      id: `secret-${String(index).padStart(2, '0')}`,
      kind: 'token' as const,
      value: `many-value-${index}-abcdef`,
    })) });
    const summary = identitySummary(identity);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary).toContain('40 secret(s)');
    for (const secret of identity.secrets) expect(summary).not.toContain(secret.value);
  });
});

describe('substituteSecrets', () => {
  it('replaces every placeholder, dedupes and sorts used, and indexes secrets by id', () => {
    const identity = parseIdentity({ secrets: [
      { id: 'z', kind: 'token', value: 'z-value' },
      { id: 'a', kind: 'password', value: 'a-value' },
    ] });
    expect(substituteSecrets('${P2O_SECRET:z}/${P2O_SECRET:a}/${P2O_SECRET:z}', identity))
      .toEqual({ text: 'z-value/a-value/z-value', used: ['a', 'z'] });
    expect(substituteSecrets('no placeholders', identity)).toEqual({ text: 'no placeholders', used: [] });
    expect(secretIndex(identity).get('z')?.value).toBe('z-value');
    expect(secretIndex(identity).size).toBe(2);
  });

  it('inserts values literally and throws on an unknown id', () => {
    const identity = parseIdentity({ secrets: [makeSecret({ id: 'd', value: '$&$1' })] });
    expect(substituteSecrets('${P2O_SECRET:d}', identity).text).toBe('$&$1');
    expect(() => substituteSecrets('x ${P2O_SECRET:missing}', identity)).toThrow('Unknown secret id: missing');
  });
});

describe('substituteShellSecrets', () => {
  it("quotes a value containing a single quote as one POSIX word", () => {
    const identity = parseIdentity({ secrets: [{ id: 'x', kind: 'password', value: "abc'def" }] });
    expect(substituteShellSecrets('echo ${P2O_SECRET:x}', identity)).toEqual({
      text: "echo 'abc'\\''def'",
      used: ['x'],
    });
    expect(substituteShellSecrets('X=${P2O_SECRET:x}; echo ${P2O_SECRET:x} | cat', identity).text)
      .toBe("X='abc'\\''def'; echo 'abc'\\''def' | cat");
  });

  it('dedupes used ids across standalone placeholders', () => {
    const identity = parseIdentity({ secrets: [
      { id: 'b', kind: 'token', value: 'one' },
      { id: 'a', kind: 'password', value: 'two' },
    ] });
    expect(substituteShellSecrets('x=${P2O_SECRET:b} y=${P2O_SECRET:a} z=${P2O_SECRET:b}', identity))
      .toEqual({ text: "x='one' y='two' z='one'", used: ['a', 'b'] });
  });

  it('refuses placeholders that are embedded or inside quoted text', () => {
    const identity = parseIdentity({ secrets: [{ id: 'x', kind: 'password', value: "abc'def" }] });
    const bad = [
      'pre${P2O_SECRET:x}',
      '${P2O_SECRET:x}suffix',
      'echo "${P2O_SECRET:x}"',
      "echo '${P2O_SECRET:x}'",
    ];
    for (const text of bad) {
      expect(() => substituteShellSecrets(text, identity)).toThrow('Secret placeholder must be a standalone shell word');
    }
    expect(() => substituteShellSecrets('echo ${P2O_SECRET:missing}', identity)).toThrow('Unknown secret id: missing');
  });
});

describe('redactSecrets', () => {
  it('redacts longest values first, counts occurrences, and is idempotent', () => {
    const identity = parseIdentity({ secrets: [
      { id: 'short', kind: 'password', value: 'pass' },
      { id: 'long', kind: 'password', value: 'password' },
      { id: 'tiny', kind: 'token', value: 'abc' },
    ] });
    const first = redactSecrets('password pass abc password', identity);
    expect(first.text).toBe('[REDACTED:long] [REDACTED:short] abc [REDACTED:long]');
    expect(first.replaced).toBe(3);
    expect(redactSecrets(first.text, identity)).toEqual({ text: first.text, replaced: 0 });
    expect(redactSecrets('clean text', identity)).toEqual({ text: 'clean text', replaced: 0 });
  });

  it('skips values shorter than 4 bytes and redacts at exactly 4 bytes', () => {
    const identity = parseIdentity({ secrets: [
      { id: 'tiny', kind: 'token', value: 'abc' },
      { id: 'four', kind: 'token', value: 'four' },
    ] });
    expect(redactSecrets('abc four', identity)).toEqual({ text: 'abc [REDACTED:four]', replaced: 1 });
  });

  it('leaves existing redaction markers untouched even when they contain a value', () => {
    const identity = parseIdentity({ secrets: [{ id: 'marker', kind: 'token', value: 'REDACTED' }] });
    const first = redactSecrets('REDACTED', identity);
    expect(first).toEqual({ text: '[REDACTED:marker]', replaced: 1 });
    expect(redactSecrets(first.text, identity)).toEqual({ text: first.text, replaced: 0 });
  });

  it('does not rewrite a marker it created earlier in the same pass', () => {
    const identity = parseIdentity({ secrets: [
      { id: 'long', kind: 'password', value: 'password' },
      { id: 'marker', kind: 'token', value: 'REDACTED' },
    ] });
    expect(redactSecrets('password', identity)).toEqual({ text: '[REDACTED:long]', replaced: 1 });
  });

  it('redacts unprotected text around existing markers', () => {
    const identity = parseIdentity({ secrets: [{ id: 'x', kind: 'token', value: 'secret-value' }] });
    expect(redactSecrets('[REDACTED:old] secret-value', identity))
      .toEqual({ text: '[REDACTED:old] [REDACTED:x]', replaced: 1 });
  });
});

describe('containsSecretValue', () => {
  it('finds leaked values and returns undefined for clean text or short values', () => {
    const identity = parseIdentity({ secrets: [
      { id: 'one', kind: 'password', value: 'leaked-value' },
      { id: 'two', kind: 'token', value: 'other-value' },
      { id: 'tiny', kind: 'token', value: 'abc' },
    ] });
    expect(containsSecretValue('prefix leaked-value suffix', identity)).toBe('one');
    expect(containsSecretValue('prefix other-value suffix', identity)).toBe('two');
    expect(containsSecretValue('leaked-value and other-value', identity)).toBe('one');
    expect(containsSecretValue('clean text', identity)).toBeUndefined();
    expect(containsSecretValue('abc', identity)).toBeUndefined();
  });
});
