import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestJson } from '../../src/contracts/index.js';
import { producerFinding } from '../../src/application/report.js';
import type { FindingPlan } from '../../src/application/types.js';
import { CLAIM, createHarness, packetFixture, type Harness } from '../evidence/fixtures.js';

describe('producer finding receipt selection', () => {
  let h: Harness;
  let plan: FindingPlan;
  beforeEach(() => {
    h = createHarness();
    plan = { findingId: 'finding-1', taskId: h.task.taskId, title: 'Bounded fixture claim', claim: CLAIM,
      state: 'reproduced', classification: 'independently-observed', limitations: ['Fixture only'] };
  });
  afterEach(() => h.dispose());

  it('does not inherit packet-wide receipts when no selectors or vault are supplied', () => {
    const finding = producerFinding(plan, packetFixture(h), h.run.runId);
    expect(finding.evidenceIds).toEqual([]);
    expect(finding.negativeControlEvidenceIds).toEqual([]);
  });

  it('selects only collector-linked receipts from the same producing attempt', () => {
    h.collect('repro', 'reproduction');
    h.collect('negative', 'negative-control');
    h.collect('unrelated', 'observation', { metadata: { claimDigest: digestJson('A different claim') } });
    h.collect('foreign', 'observation', {}, { attemptId: 'different-attempt' });
    h.collect('outside', 'observation');
    const packet = packetFixture(h);
    packet.evidenceIds = ['repro', 'unrelated', 'foreign'];
    const finding = producerFinding(plan, packet, h.run.runId, h.vault);
    expect(finding.evidenceIds).toEqual(['repro']);
    expect(finding.negativeControlEvidenceIds).toEqual(['negative']);
    expect(packet.evidenceIds).toEqual(['repro', 'unrelated', 'foreign']);
  });

  it('honors explicit selectors without adding neighboring receipts', () => {
    const selected = { ...plan, evidenceIds: ['repro'], negativeControlEvidenceIds: ['negative'] };
    const finding = producerFinding(selected, packetFixture(h), h.run.runId);
    expect(finding.evidenceIds).toEqual(['repro']);
    expect(finding.negativeControlEvidenceIds).toEqual(['negative']);
    finding.evidenceIds.push('mutation');
    expect(selected.evidenceIds).toEqual(['repro']);
  });

  it('preserves an explicitly empty selection even if matching receipts exist', () => {
    h.collect('repro', 'reproduction');
    h.collect('negative', 'negative-control');
    const finding = producerFinding({ ...plan, evidenceIds: [], negativeControlEvidenceIds: [] }, packetFixture(h), h.run.runId, h.vault);
    expect(finding.evidenceIds).toEqual([]);
    expect(finding.negativeControlEvidenceIds).toEqual([]);
  });

  it.each([
    { evidenceIds: ['not-in-packet'] },
    { evidenceIds: ['repro', 'repro'] },
    { negativeControlEvidenceIds: ['repro'] },
    { negativeControlEvidenceIds: ['negative', 'negative'] },
  ])('refuses selector widening or duplicate IDs: %j', selectors => {
    expect(() => producerFinding({ ...plan, ...selectors }, packetFixture(h), h.run.runId)).toThrow(/unique members/);
  });

  it('refuses a packet from another run or task', () => {
    expect(() => producerFinding(plan, packetFixture(h), 'different-run')).toThrow(/same run and task/);
    expect(() => producerFinding({ ...plan, taskId: 'different-task' }, packetFixture(h), h.run.runId)).toThrow(/same run and task/);
  });
});
