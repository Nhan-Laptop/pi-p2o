import { checkCancelled } from '../policy/errors.js';
import { normalizeWebTarget } from '../policy/targets.js';
import type { Policy, ToolContext } from '../policy/types.js';
import type { HttpEvidence } from './types.js';

export interface WebEvidence {
  kind: 'web';
  http: HttpEvidence;
  title: string;
  links: { url: string; scopeDecision: 'allowed' | 'blocked' }[];
  forms: { url: string; method: string; scopeDecision: 'allowed' | 'blocked' }[];
  limits: string[];
}
function entities(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt);|&#(?:x[0-9a-f]{1,6}|[0-9]{1,7});/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]!;
    const n = entity.startsWith('&#x') ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
  });
}
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? entities(match[1] ?? match[2] ?? match[3] ?? '') : undefined;
}
/** Constrained browser integration: static DOM observations through broker HTTP only. */
export function observePage(http: HttpEvidence, policy: Policy, context: ToolContext, accountId: string, signal?: AbortSignal): WebEvidence {
  checkCancelled(signal);
  const links: WebEvidence['links'] = [], forms: WebEvidence['forms'] = [];
  const allowed = (url: string, method = 'GET'): 'allowed' | 'blocked' => {
    try { policy.authorize({ context, capability: 'web.observe', action: 'read', url, method, accountId }); return 'allowed'; } catch { return 'blocked'; }
  };
  const absolute = (value: string): string | undefined => {
    try { return normalizeWebTarget(new URL(value, http.finalUrl).href).url; } catch { return undefined; }
  };
  const contentType = http.headers['content-type'] ?? '';
  if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
    for (const match of http.body.matchAll(/<(?:a|form)\b[^>]{0,8192}>/gi)) {
      checkCancelled(signal);
      const tag = match[0];
      if (/^<a\b/i.test(tag) && links.length < 128) {
        const href = attribute(tag, 'href'); const url = href === undefined ? undefined : absolute(href);
        if (url && !links.some(l => l.url === url)) links.push({ url, scopeDecision: allowed(url) });
      } else if (/^<form\b/i.test(tag) && forms.length < 64) {
        const url = absolute(attribute(tag, 'action') ?? http.finalUrl);
        const method = (attribute(tag, 'method') ?? 'GET').toUpperCase();
        if (url) forms.push({ url, method, scopeDecision: allowed(url, method) });
      }
    }
  }
  const title = entities(/<title\b[^>]*>([\s\S]{0,4096}?)<\/title>/i.exec(http.body)?.[1] ?? '').replace(/<[^>]*>/g, '').slice(0, 512);
  return { kind: 'web', http, title, links, forms, limits: ['Static HTML browser only; scripts, subresources, base tags, cookies and service workers are not executed/fetched.', 'No arbitrary browser evaluation, profile access, shell, form submission or claim of live-JS coverage.'] };
}
