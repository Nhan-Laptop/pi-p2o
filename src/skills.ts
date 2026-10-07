import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, posix, resolve } from 'node:path';
import { validateRequirements, type Workflow } from './capabilities.js';

export interface CatalogSkill { name: string; description: string; kind: 'technique' | 'playbook' | 'overlay'; document: string; workflows: Workflow[] }
export interface CatalogDocument { id: string; path: string; section?: string }
export interface SkillCatalog { version: 1; skills: CatalogSkill[]; documents: CatalogDocument[] }
export interface DocumentPage { id: string; sha256: string; text: string; offset: number; nextOffset?: number; totalCharacters: number }
const MAX_FILE = 2 * 1024 * 1024;
const PAGE_BYTES = 8 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Open each component relative to its held Linux directory FD. Never resolve a checked path twice. */
export async function readPackageFile(root: string, relative: string): Promise<string> {
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
    return buffer.subarray(0, used).toString('utf8');
  } catch { throw new Error('Package document unavailable: missing, unsafe or exceeds size limit'); }
  finally { await Promise.allSettled(handles.reverse().map(h => h.close())); }
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
      if (!/^[a-z0-9][a-z0-9:.-]{0,159}$/.test(d.id) || ids.has(d.id) || typeof d.path !== 'string' || !/\.(md|yaml|yml)$/.test(d.path)) throw new Error('Invalid catalog document');
      ids.add(d.id);
    }
    const names = new Set<string>();
    for (const s of value.skills) {
      if (!SLUG.test(s.name) || names.has(s.name) || !ids.has(s.document) || !['technique', 'playbook', 'overlay'].includes(s.kind) || !Array.isArray(s.workflows)) throw new Error('Invalid catalog skill');
      names.add(s.name);
      for (const w of s.workflows) { if (!SLUG.test(w.id)) throw new Error('Invalid workflow'); validateRequirements(w); }
    }
    this.catalog = value;
    return value;
  }
  async list(offset = 0) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid catalog offset');
    const c = await this.load();
    const entries = c.skills.slice(offset, offset + 8).map(s => ({ ...s, documents: c.documents.filter(d => d.id === s.document || d.id.startsWith(`${s.name}:`)).map(d => d.id) }));
    return { entries, sharedDocuments: c.documents.filter(d => d.id.startsWith('shared:')).map(d => d.id), total: c.skills.length,
      ...(offset + entries.length < c.skills.length ? { nextOffset: offset + entries.length } : {}) };
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
      cached = { text: linked, sha256: createHash('sha256').update(raw).digest('hex') };
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
