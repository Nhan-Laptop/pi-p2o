#!/usr/bin/env node
// Generate `contract-enums.json` — the worker authoring crib's single source of truth — from the handoff
// schema in `src/contracts/schemas.ts`. Run after `npm run build` (the schema module is resolved from the
// compiled `dist/` tree so this script needs no TypeScript loader):
//
//   npm run build && node examples/live-lab/generate-contract-enums.mjs
//
// The file records, per contract: the accepted root keys, required root keys, the keys accepted inside
// `details`, the required fields per scope, the exact enum values, and the accepted JSON value TYPES with
// their exact JSON-pointer scopes (details and nested objects/arrays). `scenario.assertContractEnumCoverage()`
// re-derives the same facts from the schema at scenario-build time and refuses any drift, so this file can
// never silently disagree with the supervisor's gate; `bridge-extension.js` enforces the same table at
// authoring time and renders it into the model's crib. Never hand-edit the JSON.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const schemaPath = join(repoRoot, 'dist', 'src', 'contracts', 'schemas.js');
if (!existsSync(schemaPath)) throw new Error(`Compiled schema not found at ${schemaPath}; run \`npm run build\` first`);
const { handoffSchema } = await import(schemaPath);

const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
const typeNames = schema => {
  if (!schema || typeof schema !== 'object') return ['value'];
  if (Array.isArray(schema.anyOf)) return [...new Set(schema.anyOf.flatMap(typeNames))].sort();
  if (schema.type === 'array') return ['array'];
  if (schema.type === 'object') return ['object'];
  if (schema.type === 'integer') return ['integer'];
  if (schema.type === 'number') return ['number'];
  if (schema.type === 'string') return ['string'];
  if (schema.type === 'boolean') return ['boolean'];
  if ('const' in schema) return [typeof schema.const];
  return ['value'];
};
const describe = schema => {
  if (!schema || typeof schema !== 'object') return 'value';
  if (Array.isArray(schema.anyOf)) return [...new Set(schema.anyOf.map(describe))].join(' or ');
  if (schema.type === 'array') return `array of ${schema.items ? describe(schema.items) : 'value'}`;
  if ('const' in schema) return `literal ${JSON.stringify(schema.const)}`;
  if (schema.type) return String(schema.type);
  return 'value';
};
const walkTypes = (node, path, requiredKeys, out) => {
  const required = Array.isArray(requiredKeys) ? requiredKeys : [];
  for (const [key, child] of Object.entries(node.properties ?? {})) {
    const childPath = path ? `${path}.${key}` : key;
    const entry = { types: typeNames(child), description: describe(child), required: required.includes(key) };
    if (child.type === 'array' && child.items) { entry.items = typeNames(child.items); entry.itemDescription = describe(child.items); }
    out[childPath] = entry;
    walkTypes(child, childPath, child.required ?? [], out);
    if (child.items && child.items.properties) walkTypes(child.items, `${childPath}[]`, child.items.required ?? [], out);
  }
};
const walkEnums = (node, path, out) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.enum)) { out[path] = [...node.enum]; return; }
  for (const [key, child] of Object.entries(node.properties ?? {})) walkEnums(child, path ? `${path}.${key}` : key, out);
  if (node.items) walkEnums(node.items, `${path}[]`, out);
};

const contracts = {};
for (const branch of handoffSchema.jsonSchema.anyOf ?? []) {
  const contract = branch.properties?.contract?.const;
  if (contract !== 'H1' && contract !== 'H2') continue;
  const details = branch.properties.details;
  const required = {}, enums = {}, types = {};
  if (Array.isArray(details.required)) required.details = [...details.required];
  if (details.items && Array.isArray(details.items.required)) required['interfaces[]'] = [...details.items.required];
  for (const [key, child] of Object.entries(details.properties ?? {})) {
    if (child.items && Array.isArray(child.items.required)) required[`${key}[]`] = [...child.items.required];
    if (child.properties && Array.isArray(child.required)) required[key] = [...child.required];
  }
  walkEnums(details, 'details', enums);
  walkTypes(details, 'details', details.required ?? [], types);
  const strip = value => Object.fromEntries(Object.entries(value).map(([path, entry]) => [path.replace(/^details\.?/, ''), entry]));
  contracts[contract] = {
    rootKeys: Object.keys(branch.properties).sort(),
    requiredRootKeys: [...branch.required].sort(),
    detailsKeys: Object.keys(details.properties ?? {}).sort(),
    required: sorted(required),
    enums: sorted(strip(enums)),
    // Exact JSON value types per field/element with the pointer scope the authoring gate reports.
    types: sorted(strip(types)),
  };
}
const note = 'Generated from src/contracts/schemas.ts (handoffSchema) by examples/live-lab/generate-contract-enums.mjs; verified in sync by scenario.assertContractEnumCoverage(), enforced by the p2o_packet authoring gate, and rendered into the worker crib. Never hand-edit.';
writeFileSync(join(here, 'contract-enums.json'), `${JSON.stringify({ version: 1, note, contracts }, null, 2)}\n`);
process.stdout.write(`wrote contract-enums.json (${Object.keys(contracts.H1.types).length} H1 type entries, ${Object.keys(contracts.H2.types).length} H2 type entries)\n`);
