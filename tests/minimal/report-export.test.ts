import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import type { CaseView } from '../../src/cases.js';
import type { CoverageCellView } from '../../src/coverage.js';
import { csvCell, mdText, wstgAppendix } from '../../src/report-export.js';
import { AssessmentStore } from '../../src/state/store.js';
import { WSTG_BY_KEY } from '../../src/wstg-map.js';
import { parseWorkspaceCommand } from '../../src/ui/workspace.js';
import { fixture, populate } from './helpers/report-fixture.js';

/** W5 (plan): deterministic, model-free, markup-safe report export from committed state. Inert sandbox, real SQLite store. */
const HOSTILE = '[click](https://evil.example/x) ![i](http://evil.example/p.png) <img src=x onerror=alert(1)> <script>1</script> **bold** `code` ```fence www.evil.example user@evil.example | pipe \\ back \u001b[31mRED\u001b[0m bidi‮RTL zero​width';
const sha = (text: Buffer | string) => createHash('sha256').update(text).digest('hex');

describe('mdText and csvCell neutralize hostile target/model text', () => {
  it('leaves no link, image, HTML, fence, table break, autolink, control or bidi character in inline text', () => {
    const text = mdText(HOSTILE, 1000);
    expect(text).not.toMatch(/(?<!\\)[[\]()`*|!<>@]/); // every Markdown/HTML-significant character is escaped
    expect(text).not.toMatch(/https?:\/\//); expect(text).not.toMatch(/\bwww\./i);
    expect(text).not.toMatch(/[\u001b‮​]/); expect(text).not.toContain('\n');
    expect(text).toContain('&lt;script&gt;'); expect(text).toContain('RED'); expect(text).toContain('evil');
    expect(mdText('a\n- list\n# heading\n> quote\n| a | b |')).not.toContain('\n');
    expect(mdText('x'.repeat(50), 10)).toBe('xxxxxxxxxx…'); expect(mdText(undefined)).toBe('');
  });
  it('defuses spreadsheet formulas, quotes, line breaks and invisible characters in CSV', () => {
    for (const formula of ['=HYPERLINK("http://evil.example","x")', '+cmd|calc', '-2+3', '@SUM(A1)', '\t=1+1', '=1+1\n=2']) expect(csvCell(formula), formula).toMatch(/^"'?[^=+\-@\t\r\n]/);
    expect(csvCell('=1+1')).toBe(`"'=1+1"`); expect(csvCell('say "hi"\r\nnow')).toBe('"say ""hi"" now"'); expect(csvCell('a‮b​c')).toBe('"abc"'); expect(csvCell(7)).toBe('"7"');
  });
});

describe('WSTG checklist appendix', () => {
  const support = (key: string) => WSTG_BY_KEY.get(key)!.support;
  const cell = (id: string, questionKey: string, execution: string, currentness = 'current', caseRefs: Array<{ caseId: string; revision: number }> = []) => ({ id, questionKey, execution, currentness, caseRefs }) as unknown as CoverageCellView;
  const accepted = [{ id: 'case-1', revision: 2, acceptedFinding: true }] as unknown as CaseView[];

  it('adds nothing when no live cell uses a wstg- key, so existing reports are unchanged', () => {
    expect(wstgAppendix([], accepted)).toEqual([]);
    expect(wstgAppendix([cell('c1', 'question:tested', 'tested')], accepted)).toEqual([]);
    expect(wstgAppendix([cell('c2', 'wstg-athz-04', 'tested', 'retired')], accepted)).toEqual([]); // a retired cell does not count
  });

  it('gives each test one level, counts every other test as not checked, and lists keys that are not in the pinned map', () => {
    const text = wstgAppendix([
      cell('c-a', 'wstg-athz-04', 'tested', 'current', [{ caseId: 'case-1', revision: 2 }]), cell('c-b', 'wstg-athz-04', 'blocked'),
      cell('c-c', 'wstg-sess-05', 'attempted'), cell('c-d', 'wstg-info-02', 'tested'), cell('c-e', 'wstg-athz-44', 'tested'),
    ], accepted).join('\n');
    expect(text.startsWith('## WSTG checklist\n')).toBe(true);
    expect(text).toMatch(/\| L3 proven \| 1 \|/); expect(text).toMatch(/\| L2 checked \| 1 \|/); expect(text).toMatch(/\| L1 attempted, blocked or stale \| 1 \|/); expect(text).toMatch(/\| L0 not checked \| 105 \|/);
    // The support letter is read from the map, not pinned here: it changes whenever a skill lands for the test.
    expect(text).toMatch(new RegExp(`\\| wstg-athz-04 Insecure Direct Object References \\| ${support('wstg-athz-04')} \\| I \\| L3 \\| c-a, c-b \\|`));
    expect(text).toMatch(new RegExp(`\\| wstg-sess-05 Cross Site Request Forgery \\| ${support('wstg-sess-05')} \\| BI \\| L1 \\| c-c \\|`));
    expect(text).toMatch(new RegExp(`\\| wstg-info-02 Fingerprint Web Server \\| ${support('wstg-info-02')} \\| - \\| L2 \\| c-d \\|`));
    expect(text).toContain(`- INFO: wstg-info-01 (O), wstg-info-03 (${support('wstg-info-03')})`); // the untouched tests are the denominator, each with its support level
    expect(text).toContain('### Cells with a wstg- key that is not in the pinned map'); expect(text).toContain('wstg-athz-44: 1 cell(s)');
    expect(text).not.toMatch(/\bsafe\b|fully covered|all clear/i);
  });

  it('is independent of input order and neutralizes hostile cell ids', () => {
    const cells = [cell('c-2', 'wstg-athz-04', 'tested'), cell('c-1', 'wstg-athz-04', 'attempted'), cell(HOSTILE, 'wstg-sess-05', 'tested')];
    const a = wstgAppendix(cells, []).join('\n');
    expect(wstgAppendix([...cells].reverse(), []).join('\n')).toBe(a);
    expect(a).not.toMatch(/(?<!\\)\]\(/); expect(a).not.toMatch(/<(?:img|script)/i); expect(a).not.toMatch(/https?:\/\//); expect(a).not.toMatch(/[\u001b‮​]/); expect(a).not.toMatch(/(?<!\\)`/);
    expect(a).toContain('evil'); // kept, only made inert
  });

  it('is part of the exported report only when a cell uses a wstg- key, and the second export is byte-identical', async () => fixture(async h => {
    await populate(h, undefined, { tested: 'wstg-athz-04', blocked: 'wstg-sess-05' }); h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'out-a')}`); await h.command(`report export ${join(h.root, 'out-b')}`);
    const a = await h.read(join(h.root, 'out-a')), b = await h.read(join(h.root, 'out-b')); expect(a).toEqual(b);
    const report = a['REPORT.md'], checklist = report.slice(report.indexOf('## WSTG checklist'), report.indexOf('## Accepted current cases'));
    expect(report.indexOf('## Coverage and gaps')).toBeLessThan(report.indexOf('## WSTG checklist'));
    expect(checklist).toMatch(new RegExp(`\\| wstg-athz-04 Insecure Direct Object References \\| ${support('wstg-athz-04')} \\| I \\| L3 \\|`));
    expect(checklist).toMatch(new RegExp(`\\| wstg-sess-05 Cross Site Request Forgery \\| ${support('wstg-sess-05')} \\| BI \\| L1 \\|`));
    expect(checklist).toMatch(/\| L0 not checked \| 106 \|/);
    expect(a['coverage.csv']).toContain('"wstg-athz-04"'); // the keys are ordinary question_key values in the unchanged csv shape
    expect(report.indexOf('## WSTG checklist')).toBeLessThan(report.indexOf('## Risk rating criteria')); expect(report.indexOf('## Risk rating criteria')).toBeLessThan(report.indexOf('## Accepted current cases'));
    expect(report).toMatch(/\| Critical \|.*\|\n\| High \|/); expect(report).toMatch(/\| Informational \|/);
    expect(report).toContain('WSTG tests this case addresses (see the WSTG checklist for level): wstg-athz-04');
    expect(report).toContain('Surface / self-reported risk (unevaluated)'); expect(report).not.toMatch(/\| Surface \/ risk \|/);
  }));

  it('leaves a report without wstg- keys without a checklist, but still rates risk for its accepted case', async () => fixture(async h => {
    await populate(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    expect(report).not.toContain('WSTG'); expect(report).toContain('## Risk rating criteria'); // the scale is about the accepted case, independent of any WSTG key
  }));

  it('omits the risk rating criteria entirely when no case is accepted and current', async () => fixture(async h => {
    await h.command('--target ./source --solo'); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    expect((await h.read(join(h.root, 'out')))['REPORT.md']).not.toContain('Risk rating');
  }));
});

describe('report export command', () => {
  it('parses only an absolute host directory and leaves the read-only /p2o report alone', () => {
    expect(parseWorkspaceCommand('report export /tmp/out')).toEqual({ action: 'report-export', path: '/tmp/out' });
    expect(parseWorkspaceCommand('report export "/tmp/a b"')).toEqual({ action: 'report-export', path: '/tmp/a b' });
    expect(parseWorkspaceCommand('report')).toBeUndefined(); expect(parseWorkspaceCommand('report now')).toBeUndefined();
    for (const bad of ['report export relative/dir', 'report export ../x', 'report export /tmp/a\u0000b']) expect(() => parseWorkspaceCommand(bad), bad).toThrow();
  });

  it('treats a missing directory as the default report location rather than as an error', () => {
    expect(parseWorkspaceCommand('report export')).toEqual({ action: 'report-export' }); expect(parseWorkspaceCommand('report export   ')).toEqual({ action: 'report-export' });
  });

  it('writes the same bytes twice, with a verifiable manifest, private permissions and a source-clone marker, and never calls a model or the target', async () => fixture(async h => {
    const built = await populate(h); const commands = h.sandboxes[0].commands.length, messages = h.pi.messages.length;
    h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'out-a')}`); await h.command(`report export ${join(h.root, 'out-b')}`);
    const a = await h.read(join(h.root, 'out-a')), b = await h.read(join(h.root, 'out-b'));
    expect(a).toEqual(b); expect(Object.keys(a).sort()).toEqual(expect.arrayContaining(['.npmignore', 'REPORT.md', 'cases.csv', 'coverage.csv', 'report-manifest.json'])); expect(Object.keys(a)).toHaveLength(8); // the six public files and the two private markers
    const manifest = JSON.parse(a['report-manifest.json']);
    expect(manifest).toMatchObject({ format: 'p2o-report', version: 2, endReason: 'manual', authorityRestored: false, counts: { acceptedCurrent: 1, cases: 2, coverageCells: 2, openGaps: 1 } });
    for (const file of manifest.files) { expect(sha(a[file.name])).toBe(file.sha256); expect(Buffer.byteLength(a[file.name])).toBe(file.bytes); }
    expect(manifest.files.map((file: any) => file.name)).toEqual(['REPORT.md', 'cases.csv', 'coverage.csv', 'findings.json', 'findings.csv']);
    expect(JSON.stringify(manifest)).not.toMatch(/createdAt|generatedAt|"at"/); // nothing time-dependent can leak into the digest
    expect(((await stat(join(h.root, 'out-a'))).mode & 0o777)).toBe(0o700); expect(((await stat(join(h.root, 'out-a', 'REPORT.md'))).mode & 0o777)).toBe(0o600);
    expect(h.sandboxes[0].commands).toHaveLength(commands); expect(h.pi.messages).toHaveLength(messages);
    const store: AssessmentStore = await h.reader(); try { expect(manifest.asOfSequence).toBeLessThanOrEqual(store.sequence()); expect(manifest.runId).toBe(store.manifest().runId); } finally { store.close(); }
    expect(built.accepted.reviewStatus).toBe('accepted');
  }));

  it('separates accepted-current cases from the rest, lists untested cells before the findings and never claims safety', async () => fixture(async h => {
    await populate(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const { 'REPORT.md': report, 'cases.csv': cases, 'coverage.csv': coverage } = await h.read(join(h.root, 'out'));
    const accepted = report.slice(report.indexOf('## Accepted current cases'), report.indexOf('## Other cases')), other = report.slice(report.indexOf('## Other cases'), report.indexOf('## Worker claims'));
    expect(accepted).toContain('Runtime fixture boundary case'); expect(accepted).not.toContain('Second pending case');
    expect(other).toContain('Second pending case'); expect(other).not.toContain('Runtime fixture boundary case');
    expect(report.indexOf('## Coverage and gaps')).toBeLessThan(report.indexOf('## Accepted current cases'));
    expect(report).toContain('**Read this first.**'); expect(report).toContain('not** a verification');
    expect(report).not.toMatch(/no vulnerabilit|is secure|no issues found|all clear|fully covered/i);
    for (const sentence of report.match(/[^.\n]*\bsafe\b[^.\n]*/gi) ?? []) expect(sentence, sentence).toMatch(/\b(?:not|nothing|never|cannot)\b/i); // 'safe' appears only inside a negation
    expect(cases.split('\n')[0]).toContain('accepted_current'); expect(cases).toContain('"true"'); expect(coverage.split('\n')[0]).toContain('effective_assessment');
    expect(report).toMatch(/\| Cells not tested or not confirmed .* \| [1-9]\d* \|/);
  }));

  it('moves a case out of accepted-current when its claim is superseded and says why, and never lists it as a finding', async () => fixture(async h => {
    const built = await populate(h);
    const claim = (await h.call('p2o_ledger', { id: built.claim.id })).details;
    const base = claim.record ?? claim.records?.[0] ?? {};
    await h.call('p2o_candidate', { candidate: 'report-claim', surface: '/report-fixture', risk: 'authorization', closure: 'open_proof_gap', execution: 'blocked', proof: 'static_trace', evidenceRefs: base.refs ?? [], negativeControls: [], policyBasis: 'inferred', expectedPolicy: 'Withdrawn after re-review', limitations: 'Re-review found the earlier proof insufficient', requirement: 'A reproducible live observation is still missing', supersedes: built.claim.id });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    const accepted = report.slice(report.indexOf('## Accepted current cases'), report.indexOf('## Other cases')), other = report.slice(report.indexOf('## Other cases'), report.indexOf('## Worker claims'));
    expect(accepted).toContain('No case was accepted and current'); expect(accepted).not.toContain('Runtime fixture boundary case');
    expect(other).toContain('Runtime fixture boundary case'); expect(other).toMatch(/stale|superseded/i);
    expect(JSON.parse((await h.read(join(h.root, 'out')))['report-manifest.json']).counts.acceptedCurrent).toBe(0);
  }));

  it('does not let hostile gap text or a hostile case title become active markup or a formula', async () => fixture(async h => {
    await populate(h, { accepted: '=HYPERLINK("http://evil.example/","pay") [x](https://evil.example)', pending: 'Second pending case' });
    await h.call('p2o_note', { kind: 'open', text: HOSTILE }); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const { 'REPORT.md': report, 'cases.csv': cases } = await h.read(join(h.root, 'out'));
    const body = report.split('\n').filter((line: string) => !line.startsWith('> ') && !line.includes('`/p2o export`')).join('\n');
    expect(body).not.toMatch(/(?<!\\)\]\(/); expect(body).not.toMatch(/<(?:img|script)/i); expect(body).not.toMatch(/https?:\/\//); expect(body).not.toMatch(/[\u001b‮​]/);
    expect(body).not.toMatch(/(?<!\\)`/); expect(body).toContain('evil'); // the text is kept, only made inert
    expect(cases).toContain(`"'=HYPERLINK(`); expect(cases.split('\n').some((line: string) => /^"?[=+\-@]/.test(line))).toBe(false);
  }));

  it('states an empty run honestly instead of reporting zero problems as safe', async () => fixture(async h => {
    await h.command('--target ./source --solo'); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    expect(report).toContain('No case was accepted and current at sequence'); expect(report).toContain('This does not mean the target is safe');
    expect(report).toContain('No coverage plan was recorded. Without a denominator nothing can be called covered.'); expect(report).toContain('No open gap is recorded. This does not mean none exists.');
  }));

  it('refuses without confirmation, to existing or relative or private paths, and reads a historical run without writing to its store', async () => fixture(async h => {
    await populate(h);
    h.ctx.setConfirm(false); await h.command(`report export ${join(h.root, 'declined')}`); await expect(stat(join(h.root, 'declined'))).rejects.toThrow();
    h.ctx.setConfirm(true);
    await h.command(`report export ${join(h.root, 'once')}`); await h.command(`report export ${join(h.root, 'once')}`); expect(h.ctx.notices.at(-1)).toContain('already exists');
    await h.command('report export relative/path'); expect(h.ctx.notices.at(-1)).toContain('absolute');
    await h.command(`report export ${join(h.root, '.p2o-state', 'inside')}`); expect(h.ctx.notices.at(-1)).toContain('outside the private state');
    expect(await readdir(h.root)).not.toEqual(expect.arrayContaining([expect.stringContaining('.p2o-tmp-')]));
    const id = await h.runId(); await h.command('stop');
    await h.command(`open ${id}`); const before: AssessmentStore = await h.reader(); const sequence = before.sequence(); before.close();
    await h.command(`report export ${join(h.root, 'historical')}`);
    const after: AssessmentStore = await h.reader(); try { expect(after.sequence()).toBe(sequence); } finally { after.close(); }
    const historical = await h.read(join(h.root, 'historical')), live = await h.read(join(h.root, 'once'));
    expect(historical['REPORT.md']).toContain('historical, read-only store');
    expect(JSON.parse(historical['report-manifest.json']).counts).toEqual(JSON.parse(live['report-manifest.json']).counts);
  }));

  it('has no model-callable way to write a report or hold/release a run', async () => fixture(async h => {
    expect([...h.pi.tools.keys()].filter((name: string) => /report_export|export_report|hold|release/.test(name))).toEqual([]);
  }));
});
