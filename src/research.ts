import { readPackageFile } from './skills.js';
import { sha256Hex } from './validate.js';
import { describeCapability, isTypedCapability, type Capability } from './capabilities.js';

/**
 * planning_update.md P14.8: technique research is a citation lookup, not an evidence path.
 *
 * Three properties are deliberate. The offline corpus is committed and hashed, so a lookup that cites a card cites text
 * the repository actually ships. A web fetch is limited to the source URLs the corpus already names, so the model's query
 * cannot turn the tool into a generic fetcher. And everything returned is quoted data with a warning: text inside a
 * fetched page that instructs the reader is reported, never followed.
 */
export const RESEARCH_LIMIT = 5;
/** The only bound is the length of the record this becomes, not how many words a lookup may use: the scorer is linear and
 * a natural question about a product, a version and a lifecycle must never be refused for being phrased naturally. */
export const RESEARCH_QUERY_MAX = 200;
export const RESEARCH_EXCERPT_BYTES = 2048;
export const RESEARCH_PAGE_BYTES = 32 * 1024;

export interface TechniqueSource { name: string; url: string; license: string; retrievedAt: string }
export interface TechniqueEntry {
  id: string; title: string; kind: string; prerequisites: string[]; tags: string[]; excerpt: string;
  source: TechniqueSource; sha256: string; path: string;
}
export interface TechniqueIndex { version: 1; entries: TechniqueEntry[] }
export interface ResearchHit extends TechniqueEntry { score: number }
export interface ResearchQuote { text: string; bytes: number; truncated: boolean }

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Positive signal for "this text is trying to instruct the reader" — reported as a label, never acted on. */
const INJECTION_SIGNALS: ReadonlyArray<readonly [string, RegExp]> = [
  ['overrides-instructions', /\b(?:ignore|disregard|forget)\b[^.]{0,40}\b(?:previous|prior|above|system)\b[^.]{0,20}\b(?:instruction|prompt|rule)/i],
  ['claims-authority', /\b(?:you are now|act as|from now on you)\b/i],
  ['wants-scope-change', /\b(?:widen|expand|change|ignore)\b[^.]{0,30}\b(?:scope|target|authori[sz]ation)\b/i],
  ['wants-unverified-claim', /\b(?:mark|record|report|rate)\b[^.]{0,40}\b(?:as )?(?:confirmed|verified|critical|high)\b/i],
  ['suppresses-reporting', /\b(?:do not|don't|never)\b[^.]{0,30}\b(?:report|mention|log|disclose)\b/i],
  ['exfiltrates-secrets', /\b(?:send|post|upload|exfiltrate)\b[^.]{0,40}\b(?:token|secret|credential|api key|password)\b/i],
];
export function injectionSignals(text: string): string[] {
  return INJECTION_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export function researchQuery(value: unknown): string[] {
  if (typeof value !== 'string') throw Error('Research query must be a string');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > RESEARCH_QUERY_MAX || /[\x00-\x1f\x7f]/.test(trimmed)) throw Error(`Research query must be 1..${RESEARCH_QUERY_MAX} printable characters`);
  return [...new Set(trimmed.toLowerCase().split(/\s+/).filter(Boolean))];
}

export function researchLimit(value: unknown): number {
  if (value === undefined) return RESEARCH_LIMIT;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw Error('Research limit must be a positive integer; there is no upper bound');
  return Number(value);
}

export async function loadTechniqueIndex(root: string): Promise<TechniqueIndex> {
  const value = JSON.parse(await readPackageFile(root, 'knowledge/techniques/index.json')) as TechniqueIndex;
  if (value?.version !== 1 || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 5000) throw Error('Invalid technique index');
  for (const entry of value.entries) {
    if (!SLUG.test(entry.id) || typeof entry.title !== 'string' || !entry.title || typeof entry.kind !== 'string'
      || !Array.isArray(entry.prerequisites) || !Array.isArray(entry.tags) || typeof entry.excerpt !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.sha256) || typeof entry.path !== 'string' || !entry.path.startsWith('knowledge/techniques/corpus/')
      || !entry.source || typeof entry.source.url !== 'string' || !/^https:\/\//.test(entry.source.url)
      || typeof entry.source.name !== 'string' || typeof entry.source.license !== 'string') throw Error('Invalid technique index entry');
  }
  return value;
}

/** Local search only: no network, no model, and a hit always carries the corpus hash it came from. */
export function searchTechniques(index: TechniqueIndex, terms: readonly string[], limit = RESEARCH_LIMIT): ResearchHit[] {
  const hits: ResearchHit[] = [];
  for (const entry of index.entries) {
    const tags = entry.tags.join(' ').toLowerCase(), title = entry.title.toLowerCase();
    const prerequisites = entry.prerequisites.join(' ').toLowerCase(), excerpt = entry.excerpt.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (tags.split(/[^a-z0-9]+/).includes(term)) score += 6;
      else if (tags.includes(term)) score += 4;
      if (title.includes(term)) score += 4;
      if (entry.kind === term) score += 3;
      if (prerequisites.includes(term)) score += 2;
      if (excerpt.includes(term)) score += 1;
    }
    if (score > 0) hits.push({ ...entry, score });
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

/** One bounded, control-character-free quote; the record keeps its length so a reader can tell it was clipped. */
export function quoteExcerpt(value: string, limit = RESEARCH_EXCERPT_BYTES): ResearchQuote {
  const normalized = value.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const bytes = Buffer.byteLength(normalized);
  if (bytes <= limit) return { text: normalized, bytes, truncated: false };
  let clipped = normalized.slice(0, limit);
  while (Buffer.byteLength(clipped) > limit) clipped = clipped.slice(0, -1);
  return { text: clipped, bytes: Buffer.byteLength(clipped), truncated: true };
}

export const researchDigest = (body: string | Buffer) => sha256Hex(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);

/**
 * M8: when a link blocks, the lead is told what to research — the transition it needs, not a topic. The skill is the procedure
 * that owns that transition, chosen by the capability the step consumes; the hint is advice for `p2o_research`, never scope.
 */
export const TRANSITION_SKILLS: Readonly<Record<string, string>> = {
  'net.egress': 'ssrf-to-internal', 'dns.resolve': 'ssrf-to-internal',
  'http.request': 'web-injection-to-exec', 'file.read': 'web-injection-to-exec', 'file.write': 'web-injection-to-exec',
  'db.query': 'web-server-side-injection', 'deserialize': 'deserialization-and-dispatch-auditing',
  'exec.code': 'binary-exploit-ladder', 'host.shell': 'binary-exploit-ladder',
  'cred.session': 'credential-and-pivot', 'cred.secret': 'credential-and-pivot',
  'cloud.role': 'sandbox-boundary-analysis',
  'admin.ui': 'web-object-authorization', 'data.read': 'web-object-authorization', 'auth.bypass': 'web-object-authorization',
};
export interface TransitionHint { tool: 'p2o_research'; needs: string; gained: string; query: string; skill: string }
export function transitionHint(need: Capability, gained: readonly Capability[], surface?: string): TransitionHint {
  const to = gained[0] ? describeCapability(gained[0]) : 'the next capability';
  const from = describeCapability(need);
  const kind = isTypedCapability(need) ? need.kind : 'legacy';
  const query = `${from} to ${to}${surface ? ` on ${surface}` : ''}`.slice(0, RESEARCH_QUERY_MAX);
  return { tool: 'p2o_research', needs: from, gained: to, query, skill: TRANSITION_SKILLS[kind] ?? 'exploit-design' };
}
