/**
 * R2.2: nmap XML → host/service assets and observations.
 *
 * nmap's XML is written by one tool with a stable schema, so this reads the six tags the inventory needs instead of pulling an
 * XML dependency: `<host>`/`<status>`/`<address>`, `<hostnames>`, `<ports>`/`<port>`/`<state>`/`<service>`/`<cpe>`, and `<os>`.
 * Everything else (`<script>` output, timing) is counted as ignored: a port scan reports what answered, not what it means.
 */
import { attributes, clean, cleanIdentity } from './sanitize.js';
import { type ExtractAsset, type ExtractFact, type ExtractResult, type Extractor, EXTRACT_MAX_RECORDS } from './types.js';

const ATTR = /([a-zA-Z_][\w.:-]*)="([^"]*)"/g;
const ENTITY: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" };
const decode = (value: string) => value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, entity => ENTITY[entity] ?? entity);

function tagAttributes(source: string, from = 0): { attrs: Record<string, string>; end: number } {
  const end = source.indexOf('>', from);
  const attrs: Record<string, string> = {};
  if (end < 0) return { attrs, end: source.length };
  for (const match of source.slice(from, end).matchAll(ATTR)) attrs[match[1]!] = decode(match[2]!);
  return { attrs, end };
}

const stateOf = (block: string, tag: string): Record<string, string> | undefined => {
  const at = block.search(new RegExp(`<${tag}[\\s>/]`));
  return at < 0 ? undefined : tagAttributes(block, at + tag.length + 1).attrs;
};

export const nmap: Extractor = (source) => {
  const text = source.text;
  if (!text.includes('<nmaprun')) return undefined;
  const assets: ExtractAsset[] = [], facts: ExtractFact[] = [], warnings: string[] = [];
  const seen = new Map<string, number>(), seenService = new Map<string, number>();
  let skippedDown = 0, skippedClosed = 0, records = 0;
  const addHost = (key: string, label: string | undefined, attrs: Record<string, string>): number => {
    const prior = seen.get(key);
    if (prior !== undefined) return prior;
    const index = assets.length;
    seen.set(key, index);
    assets.push({ kind: 'host', key, ...(label ? { label } : {}), attributes: attributes(attrs) });
    return index;
  };
  const hostPattern = /<host(?:\s[^>]*)?>/g;
  for (let match = hostPattern.exec(text); match; match = hostPattern.exec(text)) {
    if (++records > EXTRACT_MAX_RECORDS) { warnings.push(`nmap: more than ${EXTRACT_MAX_RECORDS} hosts; the remainder is counted as omitted`); break; }
    const start = match.index, open = text.indexOf('>', start);
    const close = text.indexOf('</host>', open);
    if (open < 0 || close < 0) { warnings.push('nmap: a host block had no closing tag and was skipped'); continue; }
    const block = text.slice(open + 1, close);
    const status = stateOf(block, 'status')?.state ?? 'up';
    if (status !== 'up') { skippedDown += 1; continue; }
    let address: string | undefined, mac: string | undefined, hostname: string | undefined;
    for (const addressMatch of block.matchAll(/<address\s+([^>]*?)\/?>/g)) {
      const fields = Object.fromEntries([...addressMatch[1]!.matchAll(ATTR)].map(row => [row[1]!, decode(row[2]!)]));
      if (fields.addrtype === 'ipv4' || fields.addrtype === 'ipv6') address ??= fields.addr;
      if (fields.addrtype === 'mac') mac ??= fields.addr;
    }
    const hostnameTag = block.match(/<hostname\s+([^>]*?)\/?>/);
    if (hostnameTag) hostname = Object.fromEntries([...hostnameTag[1]!.matchAll(ATTR)].map(row => [row[1]!, decode(row[2]!)]))['name'];
    const key = cleanIdentity(address ?? hostname, 500);
    if (!key) { warnings.push('nmap: a host had no printable address or hostname and was skipped'); continue; }
    const hostIndex = addHost(key, hostname, { ...(hostname ? { hostname } : {}), ...(mac ? { mac } : {}), source: 'nmap' });
    let openPorts = 0;
    for (const portMatch of block.matchAll(/<port\s+([^>]*?)>([\s\S]*?)<\/port>/g)) {
      const port = Object.fromEntries([...portMatch[1]!.matchAll(ATTR)].map(row => [row[1]!, decode(row[2]!)]));
      const body = portMatch[2]!;
      const state = stateOf(body, 'state')?.state ?? '';
      if (!state.startsWith('open')) { skippedClosed += 1; continue; }
      const service = stateOf(body, 'service') ?? {};
      const number = clean(port.portid, 10), protocol = clean(port.protocol, 10) ?? 'tcp';
      if (!number || !/^\d{1,5}$/.test(number)) continue;
      const serviceKey = cleanIdentity(`${key}:${number}/${protocol}`, 500);
      if (!serviceKey || seenService.has(serviceKey)) continue;
      seenService.set(serviceKey, assets.length);
      const cpe = body.match(/<cpe>([^<]+)<\/cpe>/)?.[1];
      const name = clean(service.name, 120), product = clean(service.product, 200), version = clean(service.version, 120);
      const label = clean([name, product, version].filter(Boolean).join(' '), 200);
      assets.push({ kind: 'service', key: serviceKey, ...(label ? { label } : {}), attributes: attributes({
        host: key, port: number, protocol, state, ...(name ? { service: name } : {}), ...(product ? { product } : {}), ...(version ? { version } : {}),
        ...(clean(service.extrainfo, 300) ? { extrainfo: clean(service.extrainfo, 300)! } : {}), ...(clean(service.ostype, 80) ? { ostype: clean(service.ostype, 80)! } : {}),
        ...(clean(service.conf, 10) ? { confidence: clean(service.conf, 10)! } : {}), ...(cpe ? { cpe: clean(cpe, 500)! } : {}), source: 'nmap' }) });
      const index = assets.length - 1;
      facts.push({ asset: index, kind: 'observed', confidence: product ? 'high' : 'medium',
        statement: `nmap: ${protocol}/${number} is ${state}${name ? ` (${[name, product, version].filter(Boolean).join(' ')})` : ''}` });
      openPorts += 1;
    }
    const os = block.match(/<osmatch\s+([^>]*?)\/?>/);
    const osName = os ? Object.fromEntries([...os[1]!.matchAll(ATTR)].map(row => [row[1]!, decode(row[2]!)]))['name'] : undefined;
    const accuracy = os ? Object.fromEntries([...os[1]!.matchAll(ATTR)].map(row => [row[1]!, decode(row[2]!)]))['accuracy'] : undefined;
    if (osName) facts.push({ asset: hostIndex, kind: 'observed', confidence: 'low', statement: `nmap: OS hint ${clean(osName, 200)}${accuracy ? ` (${clean(accuracy, 10)}% match)` : ''}; a fingerprint, not a verified platform` });
    if (openPorts) facts.push({ asset: hostIndex, kind: 'observed', confidence: 'high', statement: `nmap: ${openPorts} open port(s) answered on this host` });
  }
  if (!assets.length) return undefined;
  if (skippedDown) warnings.push(`nmap: ${skippedDown} host(s) were not up and are not inventoried`);
  if (skippedClosed) warnings.push(`nmap: ${skippedClosed} port(s) were closed/filtered and are not inventoried`);
  if (text.includes('<script ') || text.includes('<script>')) warnings.push('nmap: NSE script output is not parsed; read the artifact for script results');
  return { extractor: 'nmap', assets, facts: facts.filter(fact => fact.asset < assets.length), hypotheses: [], components: [], warnings,
    omitted: { assets: 0, facts: 0, hypotheses: 0, components: 0 } } satisfies ExtractResult;
};
