import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, posix, resolve } from 'node:path';
import { sha256Hex } from './validate.js';
export interface Workflow { id: string; description: string; prerequisites?: string[]; steps?: string[]; observe?: string[]; wall?: string[] }

export interface CatalogSkill { name: string; description: string; kind: 'technique' | 'playbook' | 'overlay' | 'procedure'; document: string; workflows: Workflow[] }
export interface CatalogDocument { id: string; path: string; section?: string }
export interface SkillCatalog { version: 1; skills: CatalogSkill[]; documents: CatalogDocument[] }
export interface DocumentPage { id: string; sha256: string; text: string; offset: number; nextOffset?: number; totalCharacters: number }
const MAX_FILE = 2 * 1024 * 1024;
const PAGE_BYTES = 24 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A materializable document is a shipped harness, not a reference: the package path decides, not the caller. */
const SCRIPT_DOCUMENT = /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*\/scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.py$/;
const SCRIPT_BYTES = 64 * 1024;
/** A workflow's recipe fields are additive: absent is valid, present is bounded and descriptive like prerequisites. */
const phrases = (value: unknown, low: number, high: number) => value === undefined
  || (Array.isArray(value) && value.length >= low && value.length <= high
    && value.every(p => typeof p === 'string' && p.trim().length >= 10 && p.length <= 500));

/** Open each component relative to its held Linux directory FD. Never resolve a checked path twice. */
export async function readPackageBuffer(root: string, relative: string): Promise<Buffer> {
  const parts = relative.split('/');
  if (!parts.length || parts.some(p => !p || p === '.' || p === '..' || !/^[A-Za-z0-9_.-]+$/.test(p))) throw new Error('Invalid package document');
  const handles: FileHandle[] = [];
  try {
    let directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(directory);
    for (const part of parts.slice(0, -1)) {
      directory = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(directory);
    }
    const file = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    handles.push(file);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE) throw new Error('Package document must be a bounded regular file');
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let used = 0;
    while (used < buffer.length) { const { bytesRead } = await file.read(buffer, used, buffer.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > MAX_FILE) throw new Error('Package document grew past its limit');
    return buffer.subarray(0, used);
  } catch { throw new Error('Package document unavailable: missing, unsafe or exceeds size limit'); }
  finally { await Promise.allSettled(handles.reverse().map(h => h.close())); }
}

export async function readPackageFile(root: string, relative: string): Promise<string> {
  return (await readPackageBuffer(root, relative)).toString('utf8');
}

/** Registry contains package-relative paths; public callers receive IDs only. Recreated per assessment. */
export class SkillLibrary {
  private catalog?: SkillCatalog;
  private readonly documents = new Map<string, { text: string; sha256: string }>();
  constructor(readonly root: string) {}
  async load(): Promise<SkillCatalog> {
    if (this.catalog) return this.catalog;
    const value: SkillCatalog = JSON.parse(await readPackageFile(this.root, 'skills/catalog.json'));
    if (value.version !== 1 || !Array.isArray(value.skills) || !Array.isArray(value.documents) || value.skills.length > 100 || value.documents.length > 600) throw new Error('Invalid skill catalog');
    const ids = new Set<string>();
    for (const d of value.documents) {
      if (!/^[a-z0-9][a-z0-9:.-]{0,159}$/.test(d.id) || ids.has(d.id) || typeof d.path !== 'string' || !/\.(md|yaml|yml|json|py)$/.test(d.path) || d.path.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid catalog document');
      ids.add(d.id);
    }
    const names = new Set<string>();
    for (const s of value.skills) {
      if (!SLUG.test(s.name) || names.has(s.name) || !ids.has(s.document) || !['technique', 'playbook', 'overlay', 'procedure'].includes(s.kind) || !Array.isArray(s.workflows)) throw new Error('Invalid catalog skill');
      names.add(s.name);
      for (const w of s.workflows) { if (!SLUG.test(w.id) || typeof w.description !== 'string' || w.description.length < 20
        || Object.keys(w).some(k => !['id', 'description', 'prerequisites', 'steps', 'observe', 'wall'].includes(k))
        || !phrases(w.steps, 2, 12) || !phrases(w.observe, 1, 12) || !phrases(w.wall, 0, 12)
        || (w.prerequisites !== undefined && (!Array.isArray(w.prerequisites) || w.prerequisites.length > 10
          || w.prerequisites.some(p => typeof p !== 'string' || p.trim().length < 10 || p.length > 500)))) throw new Error('Invalid workflow'); }
    }
    this.catalog = value;
    return value;
  }
  async list(offset = 0, query = '') {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid catalog offset');
    if (typeof query !== 'string' || query.length > 80) throw new Error('Invalid catalog query');
    const c = await this.load();
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const rank = { playbook: 0, overlay: 1, procedure: 2, technique: 3 };
    const selected = c.skills.filter(s => words.every(w => `${s.name} ${s.description}`.toLowerCase().includes(w)))
      .sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));
    const entries = selected.slice(offset, offset + 8).map(s => ({ ...s, documents: c.documents.filter(d => d.id === s.document || d.id.startsWith(`${s.name}:`)).map(d => d.id) }));
    return { entries, sharedDocuments: c.documents.filter(d => d.id.startsWith('shared:')).map(d => d.id), total: selected.length, query,
      ...(offset + entries.length < selected.length ? { nextOffset: offset + entries.length } : {}) };
  }
  /**
   * planning_update.md P14.7: the package bytes of one registered skill script, for materialization into a sandbox.
   * Only `skills/<skill>/scripts/*.py` qualifies — a reference, a SKILL.md or any host path is not a script.
   */
  async materialize(id: string): Promise<{ id: string; path: string; bytes: Buffer; sha256: string }> {
    if (typeof id !== 'string' || !id || id.length > 160) throw new Error('Invalid document request');
    const catalog = await this.load();
    const doc = catalog.documents.find(d => d.id === id);
    if (!doc) throw new Error('Unknown document ID; use p2o_skill_list');
    if (!SCRIPT_DOCUMENT.test(doc.path)) throw new Error('Only a registered skill script can be materialized; read this document with p2o_skill_read');
    const bytes = await readPackageBuffer(this.root, doc.path);
    if (!bytes.length || bytes.length > SCRIPT_BYTES) throw new Error('Registered script is outside the materialization bound');
    return { id, path: doc.path, bytes, sha256: sha256Hex(bytes) };
  }

  async read(id: string, offset = 0): Promise<DocumentPage> {
    if (typeof id !== 'string' || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid document request');
    const catalog = await this.load();
    const doc = catalog.documents.find(d => d.id === id);
    if (!doc) throw new Error('Unknown document ID; use p2o_skill_list');
    let cached = this.documents.get(id);
    if (!cached) {
      const raw = await readPackageFile(this.root, doc.path);
      const selected = doc.section ? section(raw, doc.section) : raw;
      const linked = selected.replace(/\]\(([^)]+)\)/g, (match, href: string) => {
        if (/^(?:https?:|#)/.test(href)) return match;
        const [path, anchor] = href.split('#');
        const target = posix.normalize(posix.join(posix.dirname(doc.path), path));
        const found = catalog.documents.find(d => d.path === target && d.section === anchor)
          ?? catalog.documents.find(d => d.path === target && !d.section);
        return found ? `](p2o-skill:${found.id}${anchor && !found.section ? `#${anchor}` : ''})` : match;
      });
      cached = { text: linked, sha256: sha256Hex(raw) };
      this.documents.set(id, cached);
    }
    if (offset > cached.text.length) throw new Error('Offset exceeds document');
    // Bound by UTF-8 bytes, not JS code units; JSON escaping remains below broker's 64 KiB framing cap.
    let end = offset, bytes = 0;
    for (const char of cached.text.slice(offset)) { const n = Buffer.byteLength(char); if (bytes + n > PAGE_BYTES) break; bytes += n; end += char.length; }
    if (end < cached.text.length) {
      const paragraph = cached.text.lastIndexOf('\n\n', end);
      if (paragraph > offset) end = paragraph + 2;
    }
    return { id, sha256: cached.sha256, text: cached.text.slice(offset, end), offset, totalCharacters: cached.text.length,
      ...(end < cached.text.length ? { nextOffset: end } : {}) };
  }
  hashes(): Record<string, string> { return Object.fromEntries([...this.documents].map(([id, d]) => [id, d.sha256])); }
}
function section(raw: string, anchor: string): string {
  const lines = raw.split('\n');
  const slug = (s: string) => s.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  const start = lines.findIndex(l => /^#+ /.test(l) && slug(l.replace(/^#+ /, '')) === anchor);
  if (start < 0) throw new Error(`Missing catalog section ${anchor}`);
  const level = /^#+/.exec(lines[start])![0].length;
  let end = start + 1;
  for (; end < lines.length; end++) { const heading = /^(#+) /.exec(lines[end]); if (heading && heading[1].length <= level) break; }
  return lines.slice(start, end).join('\n');
}
export function packageRoot(extensionPath: string): string {
  const dir = dirname(extensionPath);
  return resolve(dir, dir.endsWith('/dist/extensions/p2o') ? '../../..' : '../..');
}
