import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { packageRoot } from './skills.js';
import { sha256Hex } from './validate.js';

/**
 * Identity of the code that actually runs: the extension entry file plus every executable module under the sibling `src/`
 * (`<root>/extensions/p2o/index.*` and `<root>/src/**`, source or `dist/` layout) and the package version. Hashing the entry file
 * alone let a change confined to `src/` slip past the ticket gate. A fixture extension without a sibling `src/` is hashed alone.
 * Any unreadable, oversized, symlinked or special file fails closed; there is never an empty or partial digest.
 */
const DOMAIN = 'p2o-runtime-v2';
const MAX_FILES = 512, MAX_FILE_BYTES = 4 * 1024 * 1024, MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const EXECUTABLE = /\.(?:ts|js)$/, DECLARATION = /\.d\.ts$/;

export interface RuntimeIdentity { sha256: string; version: string; files: number }

async function collect(directory: string, found: string[]): Promise<void> {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`RUNTIME_DIGEST_UNSAFE: symlink in runtime closure: ${entry.name}`);
    if (entry.isDirectory()) { await collect(path, found); continue; }
    if (!entry.isFile()) throw new Error(`RUNTIME_DIGEST_UNSAFE: special file in runtime closure: ${entry.name}`);
    if (EXECUTABLE.test(entry.name) && !DECLARATION.test(entry.name)) found.push(path);
    if (found.length > MAX_FILES) throw new Error(`RUNTIME_DIGEST_UNSAFE: more than ${MAX_FILES} runtime files`);
  }
}

async function packageVersion(extensionPath: string): Promise<string> {
  try {
    const parsed = JSON.parse(await readFile(join(packageRoot(extensionPath), 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version.length <= 64 ? parsed.version : '';
  } catch { return ''; }
}

export async function runtimeIdentity(extensionPath: string): Promise<RuntimeIdentity> {
  const entry = resolve(extensionPath), sourceRoot = resolve(dirname(entry), '../../src'), base = resolve(dirname(entry), '../..');
  const files = [entry];
  const sourceDirectory = await lstat(sourceRoot).catch(() => undefined);
  if (sourceDirectory) {
    if (!sourceDirectory.isDirectory()) throw new Error('RUNTIME_DIGEST_UNSAFE: src is not a plain directory');
    const found: string[] = []; await collect(sourceRoot, found); files.push(...found);
  }
  const version = await packageVersion(entry);
  const hash = createHash('sha256').update(`${DOMAIN}\nversion\0${version}\n`);
  let total = 0;
  const rows = files.map(file => ({ file, name: file === entry ? `entry/${relative(dirname(entry), file)}` : relative(base, file) }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
  for (const { file, name } of rows) {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`RUNTIME_DIGEST_UNSAFE: ${name} is not a regular file`);
    if (info.size > MAX_FILE_BYTES || (total += info.size) > MAX_TOTAL_BYTES) throw new Error('RUNTIME_DIGEST_UNSAFE: runtime closure exceeds its size bound');
    hash.update(`${name}\0${sha256Hex(await readFile(file))}\n`);
  }
  return { sha256: hash.digest('hex'), version, files: rows.length };
}
