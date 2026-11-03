import { describe, expect, it } from 'vitest';
import { clamp, formatTime, graphHref, plural, queryValue, retentionLabel, severityLabel, shortId, sourceLabel, wrapText } from '../lib/format';
import { COLUMN_BANDS, KIND_COLUMNS, KIND_GLYPHS, KIND_LABELS, KIND_ORDER, RELATION_ORDER, RELATION_STYLES, kindColumn, kindGlyph, kindLabel, relationLabel, relationTone } from '../lib/vocabulary';

describe('display formatting', () => {
  it('shows a committed instant as recorded and null as not recorded', () => {
    expect(formatTime('2026-11-03T04:05:06.123Z')).toBe('2026-11-03 04:05:06Z');
    expect(formatTime('2026-11-03T04:05:06Z')).toBe('2026-11-03 04:05:06Z');
    expect(formatTime(null)).toBe('not recorded');
  });

  it('labels sources and retention without inventing values', () => {
    expect(sourceLabel('both')).toBe('store + report');
    expect(sourceLabel('report')).toBe('report bundle');
    expect(sourceLabel('store')).toBe('store');
    expect(retentionLabel('durable-local')).toBe('durable local');
    expect(retentionLabel('unknown')).toBe('retention unknown');
    expect(retentionLabel('ephemeral')).toBe('ephemeral');
    expect(severityLabel(null)).toBe('not rated');
    expect(severityLabel('high')).toBe('high');
  });

  it('pluralises, clamps and shortens deterministically', () => {
    expect(plural(1, 'run')).toBe('1 run');
    expect(plural(0, 'run')).toBe('0 runs');
    expect(plural(2, 'finding', 'findings')).toBe('2 findings');
    expect(clamp('abcdef', 4)).toBe('abc…');
    expect(clamp('abc', 4)).toBe('abc');
    expect(shortId('0123456789abcdef', 8)).toBe('0123456…');
  });

  it('reads query values without a browser', () => {
    expect(queryValue('?run=abc&id=x', 'run')).toBe('abc');
    expect(queryValue('?run=abc&id=x', 'id')).toBe('x');
    expect(queryValue('run=abc', 'run')).toBe('abc');
    expect(queryValue('?run=a+b', 'run')).toBe('a b');
    expect(queryValue('?run=a%2Fb', 'run')).toBe('a/b');
    expect(queryValue('?run=', 'run')).toBeNull();
    expect(queryValue('', 'run')).toBeNull();
    expect(queryValue('?other=1', 'run')).toBeNull();
  });

  it('builds full-page run links with an encoded value', () => {
    expect(graphHref('run-1')).toBe('/graph/?run=run-1');
    expect(graphHref('run/1')).toBe('/graph/?run=run%2F1');
  });

  it('wraps to whole words and marks only a real cut', () => {
    expect(wrapText('alpha beta gamma', 11, 2)).toEqual(['alpha beta', 'gamma']);
    expect(wrapText('alpha beta gamma delta epsilon', 11, 2)).toEqual(['alpha beta', 'gamma delt…']);
    expect(wrapText('alpha beta', 40, 2)).toEqual(['alpha beta']);
    expect(wrapText('supercalifragilistic', 6, 1)).toEqual(['super…']);
    expect(wrapText('', 10, 2)).toEqual([]);
  });
});

describe('graph vocabulary', () => {
  it('labels every kind and gives it exactly one column inside the band list', () => {
    expect([...KIND_ORDER].sort()).toEqual([...Object.keys(KIND_LABELS)].sort());
    for (const kind of KIND_ORDER) {
      expect(kindLabel(kind)).toBe(KIND_LABELS[kind]);
      expect(kindGlyph(kind)).toBe(KIND_GLYPHS[kind]);
      expect(kindColumn(kind)).toBe(KIND_COLUMNS[kind]);
      expect(kindColumn(kind)).toBeGreaterThanOrEqual(0);
      expect(kindColumn(kind)).toBeLessThan(COLUMN_BANDS.length);
    }
    expect(kindColumn('unknown-kind')).toBe(KIND_COLUMNS.digest);
    expect(kindLabel('unknown-kind')).toBe('unknown-kind');
  });

  it('styles every relation and falls back for an unknown one', () => {
    expect([...RELATION_ORDER].sort()).toEqual([...Object.keys(RELATION_STYLES)].sort());
    for (const relation of RELATION_ORDER) {
      expect(relationLabel(relation)).toBe(RELATION_STYLES[relation]!.label);
      expect(relationTone(relation)).toBe(RELATION_STYLES[relation]!.tone);
    }
    expect(relationLabel('unknown')).toBe('unknown');
    expect(relationTone('unknown')).toBe('other');
  });
});
