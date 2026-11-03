import { describe, expect, it } from 'vitest';
import { reportOutline, reportStats, reportView, reportViewHref } from '../lib/report';
import { reportHref } from '../lib/format';

const outline = (markdown: string, max?: number) =>
  reportOutline(markdown, max).map(heading => `${heading.level}:${heading.title}:${heading.line}`);

describe('report outline', () => {
  it('reads ATX levels with their 1-based line numbers', () => {
    const markdown = ['# Report', '', 'intro', '## Findings', '### Detail'].join('\n');
    expect(reportOutline(markdown)).toEqual([
      { level: 1, title: 'Report', line: 1 },
      { level: 2, title: 'Findings', line: 4 },
      { level: 3, title: 'Detail', line: 5 },
    ]);
  });

  it('strips a closing hash sequence and surrounding whitespace without eating inner hashes', () => {
    expect(outline('### Title ###  \n#  Spaced  \n## C# tutorial #\n## C# basics')).toEqual([
      '3:Title:1', '1:Spaced:2', '2:C# tutorial:3', '2:C# basics:4',
    ]);
  });

  it('ignores headings inside backtick and tilde fences, including a longer closer requirement', () => {
    const fenced = ['# Before', '```bash', '## not a heading', 'echo hi', '```', '## After', '~~~', '### also not', '~~~'].join('\n');
    expect(outline(fenced)).toEqual(['1:Before:1', '2:After:6']);
    const longer = ['````', '# inside', '```', '# still inside', '````', '# outside'].join('\n');
    expect(outline(longer)).toEqual(['1:outside:6']);
  });

  it('does not treat prose, seven hashes, indented lines or an empty heading as a heading', () => {
    expect(reportOutline('#tag\n####### seven\n    # indented four\n#\n### ###\nplain text')).toEqual([]);
    expect(reportOutline('')).toEqual([]);
    expect(reportOutline('no headings here\njust text')).toEqual([]);
  });

  it('honours the max bound and the default cap', () => {
    const five = Array.from({ length: 5 }, (_, index) => `## H${index + 1}`).join('\n');
    expect(reportOutline(five, 2)).toEqual([
      { level: 2, title: 'H1', line: 1 },
      { level: 2, title: 'H2', line: 2 },
    ]);
    expect(reportOutline(five, 0)).toEqual([]);
    const many = Array.from({ length: 205 }, (_, index) => `# H${index + 1}`).join('\n');
    const capped = reportOutline(many);
    expect(capped).toHaveLength(200);
    expect(capped.at(-1)).toMatchObject({ title: 'H200', line: 200 });
  });

  it('clamps an over-long heading title', () => {
    const [heading] = reportOutline(`# ${'x'.repeat(500)}`);
    expect(heading?.title).toHaveLength(200);
    expect(heading?.title.endsWith('…')).toBe(true);
  });
});

describe('report stats', () => {
  it('counts lines, UTF-8 bytes and unbounded headings', () => {
    expect(reportStats('')).toEqual({ lines: 0, bytes: 0, headings: 0 });
    expect(reportStats('a\nb')).toEqual({ lines: 2, bytes: 3, headings: 0 });
    expect(reportStats('# Report\nbody\n')).toEqual({ lines: 3, bytes: 14, headings: 1 });
    expect(reportStats('✓')).toEqual({ lines: 1, bytes: 3, headings: 0 });
    expect(reportStats('```\n# not counted\n```\n# counted\n')).toMatchObject({ headings: 1 });
  });

  it('counts every heading even past the outline page cap', () => {
    const many = Array.from({ length: 250 }, (_, index) => `## H${index + 1}`).join('\n');
    expect(reportStats(many).headings).toBe(250);
    expect(reportOutline(many)).toHaveLength(200);
  });
});

describe('report navigation', () => {
  it('builds the plain-anchor report link with an encoded run id', () => {
    expect(reportHref('run-1')).toBe('/report/?run=run-1');
    expect(reportHref('run/1')).toBe('/report/?run=run%2F1');
  });
});

describe('report view selection (P5b)', () => {
  it('defaults to structured only when the bounded facts are present', () => {
    expect(reportView(null, true)).toBe('structured');
    expect(reportView(null, false)).toBe('text');
    expect(reportView('structured', true)).toBe('structured');
    expect(reportView('structured', false)).toBe('text');
    expect(reportView('text', true)).toBe('text');
    expect(reportView('text', false)).toBe('text');
  });

  it('treats an unknown requested view like no request, never like a third mode', () => {
    expect(reportView('markdown', true)).toBe('structured');
    expect(reportView('markdown', false)).toBe('text');
    expect(reportView('', false)).toBe('text');
  });

  it('builds plain-anchor view links that keep the run and the refresh rate', () => {
    expect(reportViewHref('run-1', 'text', null)).toBe('/report/?run=run-1&view=text');
    expect(reportViewHref('run/1', 'structured', '0')).toBe('/report/?run=run%2F1&view=structured&refresh=0');
    expect(reportViewHref('run-1', 'structured', '12')).toBe('/report/?run=run-1&view=structured&refresh=12');
  });
});
