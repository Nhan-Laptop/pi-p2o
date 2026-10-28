/**
 * R2.2/R2.4: package manifests → component assets (`package` kind with name/version/ecosystem).
 *
 * This is the inventory the CVE join starts from, so the identity is normalized per ecosystem: npm and PyPI names are
 * lower-cased (PyPI with PEP 503 `.`/`_` → `-`), Go modules keep their path, Maven keeps `groupId:artifactId`, and a dependency
 * without a resolvable version is counted as unpinned instead of stored as a component that cannot be queried.
 */
import { attributes, clean, parseJson } from './sanitize.js';
import type { ExtractAsset, ExtractComponent, ExtractFact, ExtractResult, Extractor } from './types.js';
import { EXTRACT_MAX_COMPONENTS, EXTRACT_MAX_RECORDS } from './types.js';

const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+~:-]{0,99}$/;
const pypiName = (name: string) => name.toLowerCase().replace(/[._]+/g, '-');

function packageName(value: unknown, ecosystem: 'npm' | 'pypi' | 'go' | 'cargo' | 'rubygems' | 'maven'): string | undefined {
  const name = clean(value, 200);
  if (!name || /\s/.test(name)) return undefined;
  if (ecosystem === 'pypi') return pypiName(name);
  if (ecosystem === 'maven') {
    const [group, artifact, ...rest] = name.split(':');
    if (!group || !artifact || rest.length) return undefined;
    return clean(`${group.toLowerCase()}:${artifact}`, 200);
  }
  return name;
}

interface Draft { ecosystem: 'npm' | 'pypi' | 'go' | 'cargo' | 'rubygems' | 'maven'; name: string; version: string; manifest: string }

interface Collected { drafts: Draft[]; omitted: number; warnings: string[] }

const empty = (): Collected => ({ drafts: [], omitted: 0, warnings: [] });

/** One pass per format; each returns `undefined` when the signature does not match, so sniffing never guesses. */
function npmLock(text: string): Collected | undefined {
  if (!text.trimStart().startsWith('{') || !text.includes('"lockfileVersion"')) return undefined;
  const document = parseJson(text);
  if (!document || typeof document !== 'object') return undefined;
  const root = document as Record<string, unknown>, out = empty();
  const add = (name: unknown, version: unknown) => {
    if (out.drafts.length >= EXTRACT_MAX_COMPONENTS) { out.omitted += 1; return; }
    const parsedName = packageName(name, 'npm'), parsedVersion = clean(version, 100);
    if (!parsedName || !parsedVersion || !VERSION.test(parsedVersion) || /^(?:file|link|workspace):/.test(parsedVersion)) { out.omitted += 1; return; }
    out.drafts.push({ ecosystem: 'npm', name: parsedName, version: parsedVersion, manifest: 'package-lock.json' });
  };
  const packages = root.packages;
  if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
    for (const [path, row] of Object.entries(packages as Record<string, unknown>)) {
      if (!path) continue; // the root project itself is not a dependency
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      if ((row as { link?: unknown }).link === true) continue;
      const name = path.includes('node_modules/') ? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length) : (row as { name?: unknown }).name;
      if (typeof name === 'string' && name.includes('node_modules/')) continue;
      add(name, (row as { version?: unknown }).version);
    }
  }
  const dependencies = root.dependencies;
  if (!out.drafts.length && dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)) {
    const walk = (tree: Record<string, unknown>, depth: number) => {
      if (depth > 20 || out.drafts.length >= EXTRACT_MAX_COMPONENTS) return;
      for (const [name, row] of Object.entries(tree)) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        add(name, (row as { version?: unknown }).version);
        const nested = (row as { dependencies?: unknown }).dependencies;
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) walk(nested as Record<string, unknown>, depth + 1);
      }
    };
    walk(dependencies as Record<string, unknown>, 0);
  }
  if (!out.drafts.length) return undefined;
  return out;
}

function pnpmLock(text: string): Collected | undefined {
  if (!/^\s*lockfileVersion:\s*['"]?[0-9]/m.test(text) || !/\n\s*(?:packages|importers):/m.test(text)) return undefined;
  const out = empty();
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inPackages = /^packages:/.test(line);
    if (!inPackages) continue;
    const key = line.match(/^\s{2}(?:'|")?(?:\/)?(@?[^@\s'":]+(?:\/[^@\s'":]+)?)@([^:\s'"(]+)/);
    if (!key) continue;
    if (out.drafts.length >= EXTRACT_MAX_COMPONENTS) { out.omitted += 1; continue; }
    const name = packageName(key[1], 'npm'), version = clean(key[2], 100);
    if (!name || !version || !VERSION.test(version)) { out.omitted += 1; continue; }
    out.drafts.push({ ecosystem: 'npm', name, version, manifest: 'pnpm-lock.yaml' });
  }
  return out.drafts.length ? out : undefined;
}

function requirements(text: string): Collected | undefined {
  const interesting = text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('-'));
  if (interesting.length < 2) return undefined;
  const exact = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s*\[[^\]]*\])?\s*===?\s*([^\s;#,]+)\s*(?:[#;].*)?$/;
  const out = empty();
  let matched = 0, unpinned = 0;
  for (const line of interesting) {
    const row = line.match(exact);
    if (!row) { unpinned += 1; continue; }
    matched += 1;
    if (out.drafts.length >= EXTRACT_MAX_COMPONENTS) { out.omitted += 1; continue; }
    const name = packageName(row[1], 'pypi'), version = clean(row[2], 100);
    if (!name || !version || !VERSION.test(version)) { out.omitted += 1; continue; }
    out.drafts.push({ ecosystem: 'pypi', name, version, manifest: 'requirements.txt' });
  }
  if (!matched || matched * 2 < interesting.length) return undefined;
  if (unpinned) out.warnings.push(`requirements.txt: ${unpinned} line(s) are not exact pins and are counted as omitted (a range cannot be queried by version)`);
  return out.drafts.length ? out : undefined;
}

function goMod(text: string): Collected | undefined {
  if (!/^module\s+\S+/m.test(text) || !/^require\s/m.test(text)) return undefined;
  const out = empty();
  let inBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!inBlock && /^require\s*\(/.test(trimmed)) { inBlock = true; continue; }
    if (inBlock && trimmed === ')') { inBlock = false; continue; }
    const row = inBlock ? trimmed.match(/^([^\s]+)\s+(v[^\s]+)/) : trimmed.match(/^require\s+([^\s]+)\s+(v[^\s]+)/);
    if (!row) continue;
    if (out.drafts.length >= EXTRACT_MAX_COMPONENTS) { out.omitted += 1; continue; }
    const name = packageName(row[1], 'go'), version = clean(row[2], 100);
    if (!name || !version || !VERSION.test(version)) { out.omitted += 1; continue; }
    out.drafts.push({ ecosystem: 'go', name, version, manifest: 'go.mod' });
  }
  return out.drafts.length ? out : undefined;
}

function cargoLock(text: string): Collected | undefined {
  if (!text.includes('[[package]]') || !/^\s*name\s*=/m.test(text)) return undefined;
  const out = empty();
  for (const block of text.split('[[package]]').slice(1)) {
    if (out.drafts.length >= EXTRACT_MAX_COMPONENTS) { out.omitted += 1; continue; }
    const name = block.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1], version = block.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^\s*source\s*=\s*"([^"]+)"/m)?.[1] ?? '';
    if (!name || !version || /^git\+/.test(source)) { out.omitted += 1; continue; }
    if (!VERSION.test(version)) { out.omitted += 1; continue; }
    out.drafts.push({ ecosystem: 'cargo', name, version, manifest: 'Cargo.lock' });
  }
  return out.drafts.length ? out : undefined;
}

function gemLock(text: string): Collected | undefined {
  if (!/^GEM$/m.test(text) || !/^\s+specs:$/m.test(text)) return undefined;
  const out = empty();
  let inSpecs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inSpecs = false;
    if (/^\s+specs:\s*$/.test(line)) { inSpecs = true; continue; }
    if (!inSpecs) continue;
    const row = line.match(/^\s{4}([A-Za-z0-9._-]+)\s+\(([^)\s]+)\)/);
    if (!row) continue;
    if (out.drafts.length >= EXTRACT_MAX_COMPONENTS) { out.omitted += 1; continue; }
    const name = packageName(row[1], 'rubygems'), version = clean(row[2], 100);
    if (!name || !version || !VERSION.test(version)) { out.omitted += 1; continue; }
    out.drafts.push({ ecosystem: 'rubygems', name, version, manifest: 'Gemfile.lock' });
  }
  return out.drafts.length ? out : undefined;
}

function pomXml(text: string): Collected | undefined {
  if (!text.includes('<project') || !text.includes('<dependency>')) return undefined;
  const out = empty();
  for (const block of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    if (out.drafts.length >= EXTRACT_MAX_COMPONENTS) { out.omitted += 1; continue; }
    const field = (tag: string) => block[1]!.match(new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`))?.[1];
    const group = clean(field('groupId'), 200), artifact = clean(field('artifactId'), 200), version = clean(field('version'), 100);
    if (!group || !artifact || !version || version.includes('${')) { out.omitted += 1; continue; }
    const name = packageName(`${group}:${artifact}`, 'maven');
    if (!name || !VERSION.test(version)) { out.omitted += 1; continue; }
    out.drafts.push({ ecosystem: 'maven', name, version, manifest: 'pom.xml' });
  }
  return out.drafts.length ? out : undefined;
}

const FORMATS = [npmLock, pnpmLock, cargoLock, gemLock, pomXml, goMod, requirements] as const;

export const packages: Extractor = (source) => {
  const text = source.text;
  let collected: Collected | undefined;
  for (const format of FORMATS) {
    collected = format(text);
    if (collected) break;
  }
  if (!collected) return undefined;
  const assets: ExtractAsset[] = [], facts: ExtractFact[] = [], components: ExtractComponent[] = [];
  const warnings = [...collected.warnings], seen = new Set<string>();
  let duplicates = 0, omitted = collected.omitted;
  for (const draft of collected.drafts) {
    if (assets.length >= EXTRACT_MAX_COMPONENTS) { omitted += 1; continue; }
    const key = `${draft.ecosystem}:${draft.name}@${draft.version}`;
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    const index = assets.length;
    assets.push({ kind: 'package', key, label: `${draft.name}@${draft.version}`, attributes: attributes({ name: draft.name, version: draft.version, ecosystem: draft.ecosystem, manifest: draft.manifest }) });
    components.push({ asset: index, name: draft.name, version: draft.version, ecosystem: draft.ecosystem });
    facts.push({ asset: index, kind: 'configuration', confidence: 'high', statement: clean(`${draft.manifest}: declares ${draft.ecosystem} component ${draft.name}@${draft.version}`, 2_000)! });
  }
  if (duplicates) warnings.push(`manifest: ${duplicates} duplicate component row(s) folded into one identity`);
  if (omitted) warnings.push(`manifest: ${omitted} dependency row(s) were unpinned, unresolved or past the ${EXTRACT_MAX_COMPONENTS}-component cap and are not inventoried`);
  if (records(text) > EXTRACT_MAX_RECORDS) warnings.push(`manifest: more than ${EXTRACT_MAX_RECORDS} dependency records; the remainder is not inventoried`);
  if (!assets.length) return undefined;
  return { extractor: `packages:${assets[0]!.attributes!.manifest}`, assets, facts, hypotheses: [], components, warnings,
    omitted: { assets: duplicates + omitted, facts: 0, hypotheses: 0, components: duplicates + omitted } } satisfies ExtractResult;
};

const records = (text: string) => text.split(/\r?\n/).length;
