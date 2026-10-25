import { describe, expect, it } from 'vitest';
import { DUTIES, dutyLine, isWorkPurpose, purposeFromRole } from '../../src/duties.js';
import { WORK_PURPOSES } from '../../src/work.js';
import { ownerInstructions, workerInstructions } from '../../src/prompts.js';
import type { Ticket } from '../../src/ticket.js';

// planning_update.md P1/P2: a worker's purpose, not its role name, says what counts as done.
const ticket = (overrides: Partial<Ticket> = {}) => ({ workerId: 'worker-test', role: 'recon', runId: 'run-test', depth: 1,
  parentWorkerId: null, lifetime: 'until-stopped', target: { kind: 'url', label: 'https://example.invalid' },
  ...overrides }) as Ticket;

describe('purpose-keyed duty (P1)', () => {
  it('gives every work purpose a duty, a failure it prevents and an expected output', () => {
    expect(Object.keys(DUTIES).sort()).toEqual([...WORK_PURPOSES].sort());
    for (const purpose of WORK_PURPOSES) {
      const entry = DUTIES[purpose];
      for (const [field, value] of Object.entries(entry)) { expect(value.trim(), `${purpose}.${field}`).not.toBe(''); expect(value.length, `${purpose}.${field}`).toBeLessThanOrEqual(200); }
      expect(dutyLine(purpose)).toContain(`(${purpose})`);
    }
    // One line, not a paragraph: the duty is re-read at every assignment, so it has to stay scannable. No length ceiling beyond that
    // editorial rule (owner decision 2026-10-24: no context-size budgets).
    for (const purpose of WORK_PURPOSES) expect(dutyLine(purpose), purpose).not.toContain('Before you stop');
  });

  it('derives a purpose from the role when the lead supplied no structured work', () => {
    expect(purposeFromRole('recon')).toBe('mapping');
    expect(purposeFromRole('discovery')).toBe('discovery');
    expect(purposeFromRole('validation')).toBe('validation');
    expect(purposeFromRole('reporting')).toBe('reporting');
    expect(purposeFromRole('general')).toBe('investigation');
    // P14.4: an exploit worker takes a primitive to an effect; it is not root-cause work with no duty line.
    expect(purposeFromRole('exploit')).toBe('exploitation');
    expect(purposeFromRole('something-else')).toBe('investigation');
    expect(isWorkPurpose('retest')).toBe(true);
    expect(isWorkPurpose('mapping ')).toBe(false);
    expect(isWorkPurpose(undefined)).toBe(false);
  });

  it('renders the ticket purpose in the worker instructions, and the role-derived one when the ticket carries none', () => {
    const validation = workerInstructions(ticket({ role: 'discovery', purpose: 'validation' }));
    expect(validation).toContain('(validation)');
    expect(validation).toContain(DUTIES.validation.duty);
    // The lead's structured purpose wins over the role: the worker is told what it must produce, not what role it holds.
    expect(workerInstructions(ticket({ role: 'discovery' }))).toContain('(discovery)');
    expect(workerInstructions(ticket())).toContain(`(mapping)`);
  });

  it('keeps the purpose out of the shared prompt prefix so siblings share the body', () => {
    const mapping = workerInstructions(ticket({ workerId: 'p2o-recon-aaaaaa', role: 'recon' }));
    const sibling = workerInstructions(ticket({ workerId: 'p2o-recon-bbbbbb', role: 'recon' }));
    const reporting = workerInstructions(ticket({ workerId: 'p2o-report-bbbbbb', role: 'reporting' }));
    expect(mapping.split('\n').slice(-2)[0]).toBe(dutyLine('mapping'));
    expect(mapping.split('\n').at(-1)).toContain('Identity:');
    expect(reporting).toContain(dutyLine('reporting'));
    // Everything except the per-purpose duty and the per-worker identity is one shared static body.
    const strip = (text: string) => text.split('\n').filter(line => !line.startsWith('Your duty (') && !line.startsWith('Identity:')).join('\n');
    expect(strip(mapping)).toBe(strip(sibling));
    expect(strip(mapping)).toBe(strip(reporting));
    expect(dutyLine('mapping')).not.toBe(dutyLine('reporting'));
  });
});

describe('validation contract in the lead prompt (P2)', () => {
  const facts = { runId: 'run-x', targetLabel: 'https://example.invalid', targetKind: 'url' as const, sourceSkipped: 0,
    delegation: { enabled: true, maxWorkers: 3, maxDepth: 2 }, workerBudget: 600 };

  it('states the three rules the host enforces and what a confirmed closure then means', () => {
    const text = ownerInstructions(facts);
    expect(text).toContain('Validation runs as a separate worker');
    expect(text).toContain('cites the claim it reproduces');
    expect(text).toContain('keeps its own negative control');
    expect(text).toContain('may not widen the question');
    expect(text).toContain('refuses an overlapping validation without a matching predecessor');
    expect(text).toContain('Only that closure counts as confirmed');
    // Still a policy section: no tool names, and the rule is absent when delegation is off.
    expect(text).not.toMatch(/\bp2o_[a-z_]+\b/);
    expect(ownerInstructions({ ...facts, delegation: { enabled: false, maxWorkers: 1, maxDepth: 1 } })).not.toContain('Validation runs as a separate worker');
  });
});

// planning_update.md P14.4: exploitation and chaining are purposes with an owner, not work that lands on `general`.
describe('exploitation and chaining duties (P14.4)', () => {
  it('gives the exploit role a brief that names the effect it must produce and the wall it may stop at', () => {
    const brief = workerInstructions(ticket({ role: 'exploit' }));
    expect(brief).toContain('(exploitation)');
    expect(brief).toContain(DUTIES.exploitation.duty);
    expect(brief).toContain(DUTIES.exploitation.produces);
    expect(brief).toContain('or the exact wall');
    // The duty is the opposite of "find the root cause": a worker told to exploit must not be told to diagnose.
    expect(brief).not.toContain('find the root cause');
    expect(workerInstructions(ticket({ role: 'exploit', purpose: 'chaining' }))).toContain('effect neither reaches alone');
    expect(DUTIES.chaining.forbids).toMatch(/compose/);
  });
});
