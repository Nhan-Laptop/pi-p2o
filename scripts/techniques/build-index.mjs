#!/usr/bin/env node
/**
 * planning_update.md P14.8: build knowledge/techniques/index.json from the curated corpus.
 *
 * The index is committed, so an offline lookup needs no build step and no network. Each entry carries the sha256 of the
 * corpus file it came from, which is what lets a `research` record say which text the technique was read from. `--check`
 * exists so the test suite fails when a card was edited without rebuilding, instead of silently serving stale text.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const corpus = join(root, 'knowledge/techniques/corpus');
const target = join(root, 'knowledge/techniques/index.json');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HTTP = /^https:\/\/[^\s]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateCard(card, file) {
  const fail = message => { throw new Error(`${file}: ${message}`); };
  if (!card || typeof card !== 'object' || Array.isArray(card)) fail('card is not an object');
  const keys = Object.keys(card).sort().join(',');
  if (keys !== 'excerpt,id,kind,prerequisites,source,tags,title') fail(`unexpected keys ${keys}`);
  if (typeof card.id !== 'string' || !SLUG.test(card.id)) fail('invalid id');
  if (file !== `${card.id}.json`) fail(`file name does not match id ${card.id}`);
  if (typeof card.title !== 'string' || card.title.trim().length < 8 || card.title.length > 120) fail('invalid title');
  if (typeof card.kind !== 'string' || !SLUG.test(card.kind)) fail('invalid kind');
  const list = (value, low, high, label, shortest) => {
    if (!Array.isArray(value) || value.length < low || value.length > high) fail(`${label} must hold ${low}..${high} items`);
    for (const item of value) if (typeof item !== 'string' || item.trim().length < shortest || item.length > 300) fail(`invalid ${label} item`);
  };
  list(card.prerequisites, 1, 6, 'prerequisites', 10);
  list(card.tags, 1, 8, 'tags', 3);
  if (typeof card.excerpt !== 'string' || card.excerpt.trim().length < 80 || card.excerpt.length > 1200) fail('excerpt must be 80..1200 characters');
  if (/\b(?:TODO|TBD|FIXME)\b/.test(card.excerpt)) fail('excerpt has an unfinished placeholder');
  const source = card.source;
  if (!source || typeof source !== 'object' || Object.keys(source).sort().join(',') !== 'license,name,retrievedAt,url') fail('invalid source');
  if (typeof source.name !== 'string' || source.name.length < 2 || source.name.length > 80) fail('invalid source name');
  if (typeof source.url !== 'string' || !HTTP.test(source.url) || source.url.length > 300) fail('source url must be https');
  if (typeof source.license !== 'string' || source.license.length < 2 || source.license.length > 60) fail('source licence is required');
  if (typeof source.retrievedAt !== 'string' || !DATE.test(source.retrievedAt)) fail('source retrievedAt must be YYYY-MM-DD');
  return card;
}

export async function buildIndex() {
  const files = (await readdir(corpus)).filter(name => name.endsWith('.json')).sort();
  if (!files.length) throw new Error('the technique corpus is empty');
  const entries = [];
  for (const file of files) {
    const bytes = await readFile(join(corpus, file));
    const card = validateCard(JSON.parse(bytes.toString('utf8')), file);
    entries.push({
      id: card.id, title: card.title, kind: card.kind, prerequisites: card.prerequisites, tags: card.tags,
      excerpt: card.excerpt, source: card.source,
      sha256: createHash('sha256').update(bytes).digest('hex'), path: `knowledge/techniques/corpus/${file}`,
    });
  }
  const index = { version: 1, entries };
  return `${JSON.stringify(index, null, 2)}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = await buildIndex();
  if (process.argv.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== text) { console.error('knowledge/techniques/index.json is stale; run node scripts/techniques/build-index.mjs'); process.exit(1); }
    console.log(`index matches the corpus (${JSON.parse(text).entries.length} entries)`);
  } else {
    await writeFile(target, text);
    console.log(`wrote knowledge/techniques/index.json (${JSON.parse(text).entries.length} entries)`);
  }
}
