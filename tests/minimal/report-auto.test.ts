import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixture, populate } from './helpers/report-fixture.js';

/** P2/P4: the deterministic report is written when a run ends, and carries the rating, scope and unresolved sections. Hermetic: inert sandbox, real SQLite store. */
const settings = (h: any, p2o: Record<string, unknown>) => writeFile(join(h.root, 'settings.json'), JSON.stringify({ p2o }));
const reportDirectory = async (h: any) => join(h.root, '.p2o-reports', `report-${await h.runId()}-final`);
const exists = (path: string) => stat(path).then(() => true, () => false);
const finding = (extra: Record<string, unknown> = {}) => ({ severity: 'medium', basis: 'Confirmed boundary deviation reaching only the tested identity’s own object in the fixture', ...extra });
const HOSTILE = '<script>alert(1)</script> [click](https://evil.example/x) ![i](http://evil.example/p.png) <img src=x onerror=alert(1)> ```fence ````longer www.evil.example **bold**';

describe('automatic report at the end of a run', () => {
  it('is written when the lead finishes, named in the finish result, private, and consistent with its manifest', async () => fixture(async h => {
    await populate(h); const result = await h.call('p2o_finish', {}), directory = await reportDirectory(h);
    expect(result.content[0].text).toContain(`REPORT: ${directory}`); expect(result.details.reportPath).toBe(directory);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const names = (await readdir(directory)).sort(); expect(names).toEqual(expect.arrayContaining(['REPORT.md', 'cases.csv', 'coverage.csv', 'findings.csv', 'findings.json', 'report-manifest.json']));
    const manifest = JSON.parse(await readFile(join(directory, 'report-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ format: 'p2o-report', version: 2, kind: 'final', endReason: 'finished', authorityRestored: false, counts: { acceptedCurrent: 1, cases: 2, unrated: 1 } });
    expect(await readFile(join(directory, 'REPORT.md'), 'utf8')).toContain('> **Run end:** the lead called p2o_finish.');
  }));

  it('records the operator objective and constraints in the ledger and REPORT.md only when the flags were given', async () => {
    await fixture(async h => {
      // A6.6 (D9): the flags record a campaign frame, so a final report must name why it stops; without a recorded goal
      // the run cannot be reported as complete, and `partial` is the recorded exit.
      await h.command('--target ./source --goal "Assess the login boundary" --avoid "No payment flows"');
      await h.call('p2o_finish', { partial: 'Fixture records the operator flags only; no plan goal was ever recorded.' });
      const report = await readFile(join(await reportDirectory(h), 'REPORT.md'), 'utf8');
      expect(report).toContain('Stated objective (operator-supplied, unverified, does not change scope): Assess the login boundary');
      expect(report).toContain('Operator constraint (guidance given to workers, not enforcement): No payment flows');
    });
    await fixture(async h => {
      await h.command('--target ./source'); await h.call('p2o_finish', {});
      const report = await readFile(join(await reportDirectory(h), 'REPORT.md'), 'utf8');
      expect(report).not.toContain('Stated objective'); expect(report).not.toContain('Operator constraint');
    });
  });

  it('is written with an INTERRUPTED banner when the operator stops the run', async () => fixture(async h => {
    await populate(h); await h.command('stop');
    const report = await readFile(join(await reportDirectory(h), 'REPORT.md'), 'utf8');
    expect(report).toMatch(/> \*\*INTERRUPTED RUN — the operator stopped the run \(\/p2o stop\)\.\*\*/);
    expect(JSON.parse(await readFile(join(await reportDirectory(h), 'report-manifest.json'), 'utf8')).endReason).toBe('stopped');
  }));

  it('is off for ephemeral runs unless asked, and survives the ephemeral store when it is asked for', async () => fixture(async h => {
    await h.command('--target ./source --retention ephemeral'); await h.call('p2o_finish', {});
    expect(await exists(join(h.root, '.p2o-reports'))).toBe(false);
  }));
  it('can be switched on for an ephemeral run and off for a durable one', async () => {
    await fixture(async h => { await settings(h, { autoReport: true }); await h.command('--target ./source --retention ephemeral'); const result = await h.call('p2o_finish', {}); expect(result.details.reportPath).toMatch(/\.p2o-reports\/report-run-/); expect(await exists(result.details.reportPath)).toBe(true); });
    await fixture(async h => { await settings(h, { autoReport: false }); await h.command('--target ./source'); const result = await h.call('p2o_finish', {}); expect(result.details.reportPath).toBeUndefined(); expect(await exists(join(h.root, '.p2o-reports'))).toBe(false); });
  });

  it('honours an absolute reportRoot and refuses nothing else about the destination', async () => fixture(async h => {
    const root = join(h.root, 'elsewhere'); await settings(h, { reportRoot: root }); await h.command('--target ./source'); const result = await h.call('p2o_finish', {});
    expect(result.details.reportPath).toBe(join(root, `report-${await h.runId()}-final`)); expect(await exists(join(result.details.reportPath, 'REPORT.md'))).toBe(true);
  }));

  it('never lets a report failure block cleanup: the error is reported and no half directory is left', async () => fixture(async h => {
    await writeFile(join(h.root, 'afile'), 'x'); await settings(h, { reportRoot: join(h.root, 'afile', 'sub') });
    await h.command('--target ./source'); const result = await h.call('p2o_finish', {});
    expect(result.content[0].text).toMatch(/REPORT NOT WRITTEN: /); expect(result.content[0].text).toContain('Container removal verified'); expect(result.details.reportError).toBeTruthy(); expect(result.details.reportPath).toBeUndefined();
    expect((await readdir(h.root)).filter((name: string) => name.includes('p2o-tmp-report'))).toEqual([]);
  }));

  it('lets a human export take the base directory without touching the final snapshot', async () => fixture(async h => {
    await populate(h); await h.command('stop'); const runId = await h.runId(); h.ctx.setConfirm(true);
    await h.command(`open ${runId}`); await h.command('report export');
    const directories = (await readdir(join(h.root, '.p2o-reports'))).filter((name: string) => name.startsWith('report-')).sort();
    expect(directories).toEqual([`report-${runId}`, `report-${runId}-final`]);
    const manifest = JSON.parse(await readFile(join(h.root, '.p2o-reports', `report-${runId}`, 'report-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ endReason: 'manual', historical: true, kind: null });
    expect(JSON.parse(await readFile(join(h.root, '.p2o-reports', `report-${runId}-final`, 'report-manifest.json'), 'utf8'))).toMatchObject({ endReason: 'stopped', kind: 'final' });
  }));
  it('writes a manual export of a historical run to the default directory when no automatic report took it', async () => fixture(async h => {
    await settings(h, { autoReport: false }); await populate(h); await h.command('stop'); const runId = await h.runId(); h.ctx.setConfirm(true);
    await h.command(`open ${runId}`); await h.command('report export');
    const manifest = JSON.parse(await readFile(join(h.root, '.p2o-reports', `report-${runId}`, 'report-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ endReason: 'manual', historical: true });
  }));
});

describe('report v2 content', () => {
  const rated = async (h: any, extra: Record<string, unknown> = {}) => {
    const built = await populate(h, { accepted: 'Boundary case with <b>markup</b> `tick`', pending: 'Second pending case' }, { tested: 'wstg-athz-04', blocked: 'wstg-sess-05' });
    const hostile = (await h.call('p2o_shell', { command: `printf '${HOSTILE.replace(/'/g, '')}'` })).details;
    await h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision, finding: finding({ likelihood: HOSTILE, impact: HOSTILE, remediationSteps: `Check ownership before returning the object. ${HOSTILE}`, cvssVector: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N', cwe: ['CWE-639', 'CWE-285'], references: ['wstg-athz-04'], reproductionEvidenceRefs: [built.observation.evidenceId, hostile.evidenceId], independenceWaiver: 'Solo run: no second actor was available to repeat it', ...extra }) });
    return built;
  };
  const outsideFences = (text: string) => { const kept: string[] = []; let fence = 0; for (const line of text.split('\n')) { const open = /^ *(`{3,})text$/.exec(line); if (!fence && open) { fence = open[1].length; continue; } if (fence && line.trim() === '`'.repeat(fence)) { fence = 0; continue; } if (!fence) kept.push(line); } expect(fence, 'every fence is closed').toBe(0); return kept.join('\n'); };

  it('keeps the OWASP reporting order: scope and limits and executive summary first, coverage before findings, summary table before details', async () => fixture(async h => {
    await rated(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'], at = (heading: string) => { const index = report.indexOf(`\n${heading}`); expect(index, heading).toBeGreaterThan(-1); return index; };
    const order = ['## Provenance', '## Scope and limitations', '## Executive summary', '## Summary', '## Coverage and gaps', '## WSTG checklist', '## Risk rating criteria', '## Findings summary', '## Accepted current cases', '## Other cases', '## Worker claims', '## Tasks and handoffs', '## Limits of this report'].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(report).toMatch(/Accepted, current findings: \*\*1\*\* \(Critical 0, High 0, Medium 1, Low 0, Informational 0\)/); expect(report).toContain('No lead narrative was supplied.');
  }));

  it('prints severity with its basis, host-computed CVSS, CWE, remediation, references with the pinned page, and the reproduction receipt', async () => fixture(async h => {
    await rated(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'];
    expect(report).toMatch(/\| F-1 \| case-[^|]+ r2 \| [^|]+ \| Medium \| 4\.3 \| CWE-639, CWE-285 \| wstg-athz-04 \| none \|/);
    expect(report).toContain('Severity **Medium** (owner-attributed, p2o scale)'); expect(report).toContain('`CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N` = **4.3** (medium)');
    expect(report).toContain('`CWE-639`, `CWE-285`'); expect(report).toContain('Recommended remediation: Check ownership');
    expect(report).toMatch(/`wstg-athz-04` \(pinned page: `https:\/\/github\.com\/OWASP\/wstg\/blob\/28553f878d48358767892916d53e59a9d664811c\/document\/4-Web_Application_Security_Testing\/05-Authorization\/04-Insecure_Direct_Object_References\.md`\)/);
    expect(report).toContain('printf bounded-report-observation'); expect(report).toContain('Independence waiver: Solo run');
  }));

  it('prints reproduction steps in order with their roles and notes, in REPORT.md and findings.json, only when steps were recorded (U8)', async () => fixture(async h => {
    const built = await populate(h), control = (await h.call('p2o_shell', { command: 'printf control-request' })).details.evidenceId, proof = built.observation.evidenceId;
    await h.call('p2o_case_rate', {id: built.accepted.id, revision: built.accepted.revision, finding: finding({ reproductionSteps: [{ ref: control, role: 'baseline', note: 'Control without the session <b>x</b>' }, { ref: proof, role: 'proof' }], independenceWaiver: 'Solo run: no second actor was available' }) });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const files = await h.read(join(h.root, 'out')), report = files['REPORT.md'];
    expect(report).toContain('Reproduction steps, in the order to follow (roles are the owner’s labels for the reader, not proof levels)');
    expect(report.indexOf(`step 1 [baseline]`)).toBeGreaterThan(-1); expect(report.indexOf('step 1 [baseline]')).toBeLessThan(report.indexOf('step 2 [proof]'));
    expect(report).toContain('Control without the session &lt;b&gt;x&lt;/b&gt;'); expect(report).not.toMatch(/(?<!\\)<b>x/);
    const reproduction = JSON.parse(files['findings.json']).findings[0].reproduction;
    expect(reproduction.map((item: any) => item.role)).toEqual(['baseline', 'proof']); expect(reproduction[0].note).toContain('Control without the session'); expect(reproduction[1].note).toBeUndefined();
  }));
  it('prints no step labels and no role keys for a plain id list', async () => fixture(async h => {
    await rated(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const files = await h.read(join(h.root, 'out'));
    expect(files['REPORT.md']).not.toContain('step 1 ['); expect(files['REPORT.md']).toContain('- Reproduction (redacted receipts');
    expect(JSON.parse(files['findings.json']).findings[0].reproduction[0]).not.toHaveProperty('role');
  }));

  it('makes no hostile finding field active outside a fence, and keeps the fence longer than any backtick run inside it', async () => fixture(async h => {
    await rated(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    const report = (await h.read(join(h.root, 'out')))['REPORT.md'], outside = outsideFences(report);
    const body = outside.split('\n').filter((line: string) => !line.startsWith('> ') && !line.includes('`/p2o export`')).join('\n');
    expect(body).not.toMatch(/(?<!\\)\]\(/); expect(body).not.toMatch(/<(?:img|script|b)\b/i); expect(body).not.toMatch(/(?<!\\)!\[/); expect(body).not.toMatch(/[\u001b‮​]/); expect(body).toContain('evil');
    expect(body.replace(/(?<!\\)`[^`\n]*`/g, '')).not.toMatch(/(?<!\\)`/); // the only code spans left are the host-generated vector, CWE, reference and code names
    expect(report).toMatch(/\n {4}`{5,}text\n/); // the receipt that contains a four-backtick run gets a fence of at least five
  }));

  it('writes findings.json, findings.csv and wstg-checklist.csv that parse, defuse formulas and are byte-identical on a second export', async () => fixture(async h => {
    await rated(h); h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'a')}`); await h.command(`report export ${join(h.root, 'b')}`);
    const a = await h.read(join(h.root, 'a')), b = await h.read(join(h.root, 'b')); expect(a).toEqual(b);
    const json = JSON.parse(a['findings.json']); expect(json).toMatchObject({ format: 'p2o-findings', version: 1, findings: [{ ref: 'F-1', severity: 'medium', cvss: { baseScore: 4.3, severity: 'medium' }, cwe: ['CWE-639', 'CWE-285'], wstg: [{ key: 'wstg-athz-04' }] }] });
    expect(json.findings[0].reproduction).toHaveLength(2); expect(json.findings[0].reproduction[0]).toMatchObject({ available: true, operation: 'shell' }); expect(json.findings[0].wstg[0].page).toContain('05-Authorization/04-Insecure_Direct_Object_References.md');
    expect(a['findings.csv'].split('\n')[0]).toContain('"severity"'); expect(a['findings.csv'].split('\n').some((line: string) => /^"?[=+\-@]/.test(line))).toBe(false);
    const checklist = a['wstg-checklist.csv'].split('\n').filter(Boolean); expect(checklist.length).toBe(109); expect(checklist.find((line: string) => line.includes('"wstg-athz-04"'))).toMatch(/"L3"/);
    expect(JSON.parse(a['report-manifest.json']).files.map((file: any) => file.name)).toEqual(['REPORT.md', 'cases.csv', 'coverage.csv', 'findings.json', 'findings.csv', 'wstg-checklist.csv']);
  }));

  it('prints the lead narrative under an unverified label and returns to the original file set with reportFormat 1', async () => {
    await fixture(async h => { await populate(h); const result = await h.call('p2o_finish', { narrative: 'Impact is limited to one fixture object.\n\nNo production data was reached.' });
      const report = await readFile(join(await reportDirectory(h), 'REPORT.md'), 'utf8'); expect(result.details.reportPath).toBeTruthy();
      expect(report).toContain('> **Lead narrative — written by the lead agent, not verified by the host:**'); expect(report).toContain('> Impact is limited to one fixture object.'); expect(report).toContain('> No production data was reached.'); });
    await fixture(async h => { await settings(h, { reportFormat: 1 }); await populate(h); await h.call('p2o_finish', {});
      const directory = await reportDirectory(h), report = await readFile(join(directory, 'REPORT.md'), 'utf8');
      expect((await readdir(directory)).filter((name: string) => !name.startsWith('.')).sort()).toEqual(['REPORT.md', 'cases.csv', 'coverage.csv', 'report-manifest.json']);
      expect(report).not.toContain('## Executive summary'); expect(report).toContain('Format version 1.'); });
  });

  it('marks a rating recorded against an older case revision and lists unresolved items when the run ended in a stop', async () => fixture(async h => {
    const built = await rated(h), view = (await h.call('p2o_board', { board: 'cases', id: built.accepted.id })).details;
    const { currentness, staleReasons, independentCurrent, independenceReason, acceptedFinding, readyToRate, canonicalCaseId, recordId, runId, revision, finding: _f, ratedRevision, ratingCurrent, ...draft } = view;
    await h.call('p2o_case_revise', {id: built.accepted.id, revision, entry: { ...draft, reviewReason: 'Owner re-read the exact current claim, task, asset and limitations' } });
    h.ctx.setConfirm(true); await h.command(`report export ${join(h.root, 'out')}`);
    expect((await h.read(join(h.root, 'out')))['REPORT.md']).toMatch(/rating recorded against r2; the case is now r3, so check that it still applies/);
  }));
});
