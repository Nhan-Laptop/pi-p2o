import { describe, expect, it } from 'vitest';
import { workerBrief, type ExploitBriefFacts } from '../../src/prompts.js';
import type { Ticket } from '../../src/ticket.js';

/**
 * planning_update.md P17.4 / A17.3 (D34): a chain successor needs a grey-box handoff, not a one-line question. The block is
 * derived from records the run already holds and renders "not recorded" for anything absent, so a worker reports a gap in the
 * handoff instead of inventing the fact. The dispatcher passes the facts only for exploitation/chaining tickets, which keeps
 * every other brief byte-identical (and the recon brief inside its recorded ceiling).
 */
const ticket = (purpose: string) => ({ workerId: 'worker-test', role: 'exploit', runId: 'run-test', depth: 1, parentWorkerId: null,
  lifetime: 'until-stopped', purpose, target: { kind: 'url', label: 'https://example.invalid' } }) as Ticket;
const facts = (overrides: Partial<ExploitBriefFacts> = {}): ExploitBriefFacts => ({
  primitive: 'cross-tenant-read is confirmed/tested (proof live_reproduction), gained data.read(foreign-object)',
  targetFacts: ['endpoint GET /api/orders revision 3', 'build unknown'],
  knownControls: ['negative control ev-2: the owner principal sees the same order'],
  needs: ['cred.session(alice)'],
  handles: ['session executor: one long-lived container on this ticket'],
  expectedObservation: 'the other tenant order body is returned to the fixture principal',
  stopCondition: 'stop after one bounded read and a control',
  ...overrides,
});

describe('EXPLOIT CONTEXT brief block (A17.3)', () => {
  it('renders every field of the grey-box handoff for an exploitation ticket', () => {
    const brief = workerBrief({ ticket: ticket('exploitation'), focus: 'cross-tenant-read', task: 'Read one foreign order', exploit: facts() });
    expect(brief).toContain('== EXPLOIT CONTEXT (grey-box handoff for this attempt; derived from the run records, never a finding) ==');
    expect(brief).toContain('PRIMITIVE: cross-tenant-read is confirmed/tested');
    expect(brief).toContain('TARGET FACTS: endpoint GET /api/orders revision 3 | build unknown');
    expect(brief).toContain('KNOWN CONTROLS AND LIMITATIONS: negative control ev-2');
    expect(brief).toContain('NEEDS FRONTIER: cred.session(alice)');
    expect(brief).toContain('HANDLES: session executor');
    expect(brief).toContain('EXPECTED OBSERVATION: the other tenant order body');
    expect(brief).toContain('STOP CONDITION: stop after one bounded read and a control');
    expect(brief).toContain('== End of exploit context ==');
    // The block is a handoff, not a licence to invent what the ledger did not record.
    expect(brief).toContain('A field that says "not recorded" is a gap to report, not a fact to invent');
    // The block stays a bounded appendix: it must not turn the brief into a second task description.
    const block = brief.slice(brief.indexOf('== EXPLOIT CONTEXT'), brief.indexOf('== End of exploit context =='));
    expect(block.length).toBeLessThanOrEqual(1_200);
  });

  it('says "not recorded" for every absent field instead of fabricating one', () => {
    const brief = workerBrief({ ticket: ticket('chaining'), focus: 'f', task: 't', exploit: facts({
      primitive: '', targetFacts: [], knownControls: [], needs: [], handles: [], expectedObservation: '', stopCondition: '',
    }) });
    for (const label of ['PRIMITIVE', 'TARGET FACTS', 'KNOWN CONTROLS AND LIMITATIONS', 'NEEDS FRONTIER', 'HANDLES', 'EXPECTED OBSERVATION', 'STOP CONDITION']) {
      expect(brief.split('\n').find(line => line.startsWith(`${label}: `)), label).toBe(`${label}: not recorded`);
    }
    // No derived sentence may appear when the handler had nothing to derive it from.
    expect(brief).not.toContain('proof live_reproduction');
    expect(brief).not.toContain('gained ');
  });

  it('is absent unless the dispatcher supplies it, so non-chain briefs are unchanged', () => {
    const plain = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't', context: 'No previous work' });
    expect(plain).not.toContain('EXPLOIT CONTEXT');
    // The same ticket with facts is the exploit path only because the dispatcher passes them for that purpose.
    const withFacts = workerBrief({ ticket: ticket('recon'), focus: 'f', task: 't', exploit: facts() });
    expect(withFacts).toContain('== EXPLOIT CONTEXT');
  });

  it('keeps the non-exploit brief inside the recorded ceiling while the exploit appendix is bounded', () => {
    const plain = workerBrief({ ticket: ticket('recon'), focus: 'surface-recon', task: 'Map authorized inputs', context: 'No previous work' });
    expect(plain.length).toBeLessThanOrEqual(1_650);
    const exploit = workerBrief({ ticket: ticket('exploitation'), focus: 'cross-tenant-read', task: 'Read one foreign order', exploit: facts() });
    // 1,650 (the pinned recon ceiling) + 1,200 (the block bound) is the hard bound for the longest brief this pass can produce.
    expect(exploit.length).toBeLessThanOrEqual(2_850);
  });
});
