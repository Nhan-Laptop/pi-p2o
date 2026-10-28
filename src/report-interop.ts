import { sha256Hex } from './validate.js';

/**
 * SARIF 2.1.0 and STIX 2.1 builders for the report export. Pure functions: no file, store, network or clock; `generatedAt` is the
 * caller's timestamp and every other value comes from the input, so the same input yields byte-identical JSON.
 *
 * SARIF: one rule per policyKey and one result per finding. Severity is the owner-attributed rating; `level` maps it onto SARIF's
 * vocabulary and nothing here claims a confidence about the target. `precision: 'high'` is the rule's own precision (the policy
 * rule did not change), not a statement that the finding was verified on the host.
 *
 * STIX 2.1: a finding is a `vulnerability` SDO. Assets are `identity` SDOs with `identity_class: 'unknown'` because a p2o asset can
 * be a host, service, path, account or tenant and STIX has no honest class for all of them; the actual kind stays in
 * `x_p2o_asset_kind`. `vulnerability --targets--> identity` records where the weakness was recorded.
 * `vulnerability --indicates--> attack-pattern` is deliberate: a vulnerability record does not itself perform a technique, so
 * "uses" would claim the weakness acts; "indicates" says the recorded finding points at that behaviour, not that the target was
 * exploited. Techniques are emitted by id only; ATT&CK names are not vendored in the export.
 *
 * STIX ids are deterministic on purpose: a cross-run diff needs the same id for the same finding, and recomputing an export must
 * not change any byte. Each uuid is sha256 over a domain label plus the identifying parts, with the version and variant nibbles set
 * so the value parses as an RFC 4122 UUID. It is stable, not secret: anyone who knows a findingId can compute its STIX id, which is
 * acceptable for an export whose findings already carry that same id.
 */
export interface InteropAsset { id: string; kind: string; key: string }
export interface InteropFinding {
  ref: string; caseId: string; revision: number; title: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'informational' | null;
  verdict: string; policyKey: string; rootCauseKey?: string;
  cvss?: { vector: string; baseScore: number; severity: string } | null;
  cwe: string[]; wstg: string[]; techniques: string[]; assets: InteropAsset[]; findingId: string;
  locations?: Array<{ kind: 'url' | 'path' | 'header' | 'config' | 'commit' | 'symbol' | 'artifact'; value: string }>;
  evidenceRefs: string[];
}
export interface InteropInput {
  runId: string; target: string; asOfSequence: number; complete: boolean; generatedAt: string;
  findings: readonly InteropFinding[]; toolVersion: string;
}

const TITLE_LIMIT = 500, MESSAGE_LIMIT = 1000, TEXT_LIMIT = 1000, ID_LIMIT = 160, VALUE_LIMIT = 1000, TAG_LIMIT = 80, TOOL_LIMIT = 100;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const EPOCH = '1970-01-01T00:00:00.000Z';
const SARIF_SCHEMA = 'https://json.schemastore.org/sarif-2.1.0.json';
const SARIF_LEVEL: Record<NonNullable<InteropFinding['severity']>, 'error' | 'warning' | 'note'> = {
  critical: 'error', high: 'error', medium: 'warning', low: 'note', informational: 'note',
};
const LOCATION_RANK: Record<NonNullable<InteropFinding['locations']>[number]['kind'], number> = {
  url: 0, path: 1, header: 2, config: 3, commit: 4, symbol: 5, artifact: 6,
};

/** Bounded single-line plain text: control and bidi characters removed, whitespace collapsed, ellipsis when cut. JSON, not Markdown. */
const bounded = (value: unknown, limit: number): string => {
  const text = String(value ?? '').replace(INVISIBLE, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const byFinding = (left: InteropFinding, right: InteropFinding): number =>
  compareText(left.findingId, right.findingId) || compareText(left.caseId, right.caseId) || left.revision - right.revision;
const list = (values: readonly string[] | undefined, limit = TAG_LIMIT): string[] =>
  (values ?? []).map(value => bounded(value, limit)).filter(Boolean);
const findingsOf = (input: InteropInput): InteropFinding[] => Array.isArray(input.findings) ? [...input.findings].sort(byFinding) : [];

/** SARIF rule ids are bounded printable ASCII; the recorded policy key stays in the result's properties. */
const policyRuleId = (value: unknown): string => {
  const text = bounded(value, ID_LIMIT).replace(/[^A-Za-z0-9._:/-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return (text || 'unnamed-policy').slice(0, ID_LIMIT);
};

function sarifRules(findings: readonly InteropFinding[]): Array<Record<string, unknown>> {
  const collected = new Map<string, { wstg: Set<string>; cwe: Set<string> }>();
  for (const finding of findings) {
    const id = policyRuleId(finding.policyKey), entry = collected.get(id) ?? { wstg: new Set<string>(), cwe: new Set<string>() };
    for (const key of finding.wstg ?? []) { const text = bounded(key, TAG_LIMIT); if (text) entry.wstg.add(text); }
    for (const key of finding.cwe ?? []) { const text = bounded(key, TAG_LIMIT); if (text) entry.cwe.add(text); }
    collected.set(id, entry);
  }
  return [...collected.entries()].sort(([left], [right]) => compareText(left, right)).map(([id, entry]) => ({
    id,
    name: 'Attributed policy finding',
    shortDescription: { text: bounded(`Policy ${id}: an attributed owner rating recorded in a case, not host verification of the target.`, TITLE_LIMIT) },
    properties: { tags: ['security', ...[...entry.wstg].sort(compareText), ...[...entry.cwe].sort(compareText)], precision: 'high' },
  }));
}

function sarifLocations(locations: InteropFinding['locations']): Array<Record<string, unknown>> {
  const rows: Array<{ kind: NonNullable<InteropFinding['locations']>[number]['kind']; value: string }> = [], seen = new Set<string>();
  for (const location of locations ?? []) {
    const value = bounded(location.value, VALUE_LIMIT), identity = `${location.kind}\u0000${value}`;
    if (!value || seen.has(identity)) continue;
    seen.add(identity); rows.push({ kind: location.kind, value });
  }
  rows.sort((left, right) => (LOCATION_RANK[left.kind] ?? 99) - (LOCATION_RANK[right.kind] ?? 99) || compareText(left.value, right.value));
  return rows.slice(0, 3).map(location => location.kind === 'url'
    ? { physicalLocation: { artifactLocation: { uri: location.value } } }
    : location.kind === 'path'
      ? { physicalLocation: { artifactLocation: { uri: location.value, uriBaseId: 'SRCROOT' } } }
      : { logicalLocations: [{ fullyQualifiedName: location.value }] });
}

function sarifResult(finding: InteropFinding): Record<string, unknown> {
  const title = bounded(finding.title, TITLE_LIMIT), caseId = bounded(finding.caseId, ID_LIMIT), locations = sarifLocations(finding.locations);
  const result: Record<string, unknown> = { ruleId: policyRuleId(finding.policyKey) };
  if (finding.severity !== null) result.level = SARIF_LEVEL[finding.severity];
  result.message = { text: bounded(`${title} (case ${caseId}@r${finding.revision}) — attributed owner rating, not host verification`, MESSAGE_LIMIT) };
  if (locations.length) result.locations = locations;
  result.partialFingerprints = { 'p2oFindingId/v1': bounded(finding.findingId, ID_LIMIT) };
  result.properties = {
    findingId: bounded(finding.findingId, ID_LIMIT), caseId, caseRevision: finding.revision,
    policyKey: bounded(finding.policyKey, ID_LIMIT), rootCauseKey: finding.rootCauseKey ? bounded(finding.rootCauseKey, ID_LIMIT) : null,
    cwe: list(finding.cwe), wstg: list(finding.wstg), techniques: list(finding.techniques),
    cvss: finding.cvss ? { vector: bounded(finding.cvss.vector, VALUE_LIMIT), baseScore: finding.cvss.baseScore, severity: bounded(finding.cvss.severity, TAG_LIMIT) } : null,
    severity: finding.severity ?? null, evidenceRefs: list(finding.evidenceRefs),
  };
  return result;
}

/** SARIF 2.1.0 log. Results sorted by (findingId, caseId, revision), rules by id; an empty finding list is a valid empty run. */
export function sarifLog(input: InteropInput): Record<string, unknown> {
  const findings = findingsOf(input);
  return {
    $schema: SARIF_SCHEMA,
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'pi-p2o', version: bounded(input.toolVersion, TOOL_LIMIT) || 'unknown', informationUri: 'https://github.com/', rules: sarifRules(findings) } },
      results: findings.map(sarifResult),
      originalUriBaseIds: { SRCROOT: { uri: 'file:///' } },
    }],
  };
}

/** RFC 4122-shaped UUID from sha256; a malformed timestamp becomes the epoch rather than a fabricated current time. */
function stableUuid(...parts: readonly string[]): string {
  const hex = sha256Hex(parts.join('\u0000')).slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
const stixId = (type: string, ...parts: readonly string[]): string => `${type}--${stableUuid(type, ...parts)}`;
const stixTime = (value: unknown): string => {
  const text = bounded(value, 64);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? text : EPOCH;
};
const cweRef = (value: string): string | undefined => {
  const text = bounded(value, TAG_LIMIT), match = /^CWE-(\d{1,5})$/i.exec(text) ?? /^(\d{1,5})$/.exec(text);
  return match ? `CWE-${match[1]}` : undefined;
};
const wstgRef = (value: string): string | undefined => {
  const text = bounded(value, TAG_LIMIT).toUpperCase().replace(/^WSTG-/, '');
  return text ? `WSTG-${text}` : undefined;
};
const externalReferences = (finding: InteropFinding): Array<Record<string, unknown>> => {
  const references: Array<Record<string, unknown>> = [];
  const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort(compareText);
  for (const ref of sorted((finding.cwe ?? []).map(cweRef).filter((item): item is string => Boolean(item)))) references.push({ source_name: 'cwe', external_id: ref });
  for (const ref of sorted((finding.wstg ?? []).map(wstgRef).filter((item): item is string => Boolean(item)))) references.push({ source_name: 'owasp-wstg', external_id: ref });
  for (const ref of sorted(list(finding.techniques, 40))) references.push({ source_name: 'mitre-attack', external_id: ref });
  return references;
};

type Stix = Record<string, unknown>;
interface AssetIdentity { kind: string; assetKey: string; id: string; stixId: string }

/** STIX 2.1 bundle: vulnerability per finding, identity per distinct asset, attack-pattern per distinct technique, then relationships. */
export function stixBundle(input: InteropInput): Record<string, unknown> {
  const findings = findingsOf(input), created = stixTime(input.generatedAt), vulnerabilities: Stix[] = [], relationships: Stix[] = [];
  const identities = new Map<string, AssetIdentity>(), techniques = new Set<string>();
  const relationship = (source: string, type: string, target: string): Stix => ({
    type: 'relationship', spec_version: '2.1', id: stixId('relationship', source, type, target), created, modified: created,
    relationship_type: type, source_ref: source, target_ref: target,
  });
  for (const finding of findings) {
    const vulnerabilityId = stixId('vulnerability', finding.findingId), caseId = bounded(finding.caseId, ID_LIMIT);
    const rootCause = finding.rootCauseKey ? bounded(finding.rootCauseKey, ID_LIMIT) : 'not recorded';
    const description = bounded(`Case ${caseId}@r${finding.revision}; policy ${bounded(finding.policyKey, ID_LIMIT)}; root cause ${rootCause}; severity ${finding.severity ?? 'not rated'}. This is an attributed owner rating, not host verification.`, TEXT_LIMIT);
    vulnerabilities.push({
      type: 'vulnerability', spec_version: '2.1', id: vulnerabilityId, created, modified: created,
      name: bounded(finding.title, TITLE_LIMIT) || 'Untitled finding', description,
      labels: finding.severity ? [finding.severity] : [],
      external_references: externalReferences(finding),
      x_p2o_finding_id: bounded(finding.findingId, ID_LIMIT),
      ...(finding.cvss ? { x_p2o_cvss: { vector: bounded(finding.cvss.vector, VALUE_LIMIT), base_score: finding.cvss.baseScore, severity: bounded(finding.cvss.severity, TAG_LIMIT) } } : {}),
    });
    const own = new Map<string, InteropAsset>();
    for (const asset of finding.assets ?? []) {
      const kind = bounded(asset.kind, TAG_LIMIT), key = bounded(asset.key, TITLE_LIMIT), assetId = bounded(asset.id, ID_LIMIT), identity = `${kind}\u0000${key}\u0000${assetId}`;
      if (!assetId && !key) continue;
      own.set(identity, { id: assetId, kind, key });
      if (!identities.has(identity)) identities.set(identity, { kind, assetKey: key, id: assetId, stixId: stixId('identity', kind, key, assetId) });
    }
    for (const asset of [...own.values()].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.key, right.key) || compareText(left.id, right.id)))
      relationships.push(relationship(vulnerabilityId, 'targets', identities.get(`${asset.kind}\u0000${asset.key}\u0000${asset.id}`)!.stixId));
    for (const technique of list(finding.techniques, 40)) {
      techniques.add(technique);
      relationships.push(relationship(vulnerabilityId, 'indicates', stixId('attack-pattern', technique)));
    }
  }
  const identityObjects = [...identities.values()].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.assetKey, right.assetKey) || compareText(left.id, right.id))
    .map(asset => ({
      type: 'identity', spec_version: '2.1', id: asset.stixId, created, modified: created,
      name: bounded(`${asset.kind} ${asset.assetKey}`, TITLE_LIMIT) || asset.id, identity_class: 'unknown',
      x_p2o_asset_kind: asset.kind, x_p2o_asset_key: asset.assetKey, x_p2o_asset_id: asset.id,
    }));
  const attackPatterns = [...techniques].sort(compareText).map(technique => ({
    type: 'attack-pattern', spec_version: '2.1', id: stixId('attack-pattern', technique), created, modified: created,
    name: technique, external_references: [{ source_name: 'mitre-attack', external_id: technique }],
  }));
  const ordered = new Map(relationships.map(item => [String(item.id), item]));
  return {
    type: 'bundle', id: `bundle--${stableUuid('bundle', bounded(input.runId, ID_LIMIT), String(input.asOfSequence))}`, spec_version: '2.1',
    objects: [...vulnerabilities, ...identityObjects, ...attackPatterns, ...[...ordered.values()].sort((left, right) => compareText(String(left.id), String(right.id)))],
  };
}
