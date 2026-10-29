import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HEARTBEAT_SECONDS, MIN_HEARTBEAT_SECONDS, campaignFrom, campaignPromptBlock, campaignStartLine,
  defaultObjective, parseCampaign, type CampaignRecord,
} from '../../src/campaign.js';

/**
 * P5/A6.1 (planning_update.md §4): the campaign frame is recorded once, parsed strictly and rendered into two bounded,
 * deterministic strings. Hermetic: pure data, no clock, no I/O, no model.
 */

const AT = '2026-10-26T12:00:00.000Z';
const TARGET = 'https://example.test/invoices';
const build = (overrides: Record<string, unknown> = {}) => campaignFrom({ target: TARGET, at: AT, ...overrides });

describe('campaign frame (A6.1)', () => {
  it('round-trips a stored record through JSON, including allow rules and unknown envelope fields', () => {
    const campaign = campaignFrom({
      goal: 'Assess invoice access across tenant boundaries', avoid: ['No payment flows', 'Do not touch /admin'],
      heartbeatSeconds: 300, targetRevision: 'rev-abc123', target: TARGET, at: AT,
    });
    expect(parseCampaign(JSON.parse(JSON.stringify(campaign)))).toEqual(campaign);
    expect(parseCampaign(campaign)).toEqual(campaign);
    const withAllow: CampaignRecord = {
      ...campaign,
      constraints: [...campaign.constraints, { rule: 'allow', text: 'Use the staging tenant' }],
    };
    expect(parseCampaign(JSON.parse(JSON.stringify(withAllow)))).toEqual(withAllow);
    expect(parseCampaign({ ...campaign, someEnvelopeField: 'ignored' })).toEqual(campaign);
  });

  it('rejects malformed records with undefined and never throws', () => {
    const valid = build({ goal: 'Assess invoices', avoid: ['No payment flows'] });
    const cases: unknown[] = [
      undefined, null, 42, 'campaign', [], {},
      // P7.1: v2 is the current record shape, so only an unknown version is malformed now.
      { ...valid, v: 3 },
      { ...valid, v: '1' },
      { ...valid, objective: 42 },
      { ...valid, objective: '' },
      { ...valid, objective: 'x'.repeat(601) },
      { ...valid, objective: ' padded ' },
      { ...valid, constraints: 'none' },
      { ...valid, constraints: [{ rule: 'maybe', text: 'no' }] },
      { ...valid, constraints: [{ rule: 'deny' }] },
      { ...valid, constraints: [{ rule: 'deny', text: '' }] },
      { ...valid, constraints: [{ rule: 'deny', text: 'x'.repeat(301) }] },
      { ...valid, constraints: Array.from({ length: 13 }, (_, index) => ({ rule: 'deny', text: `rule ${index}` })) },
      { ...valid, heartbeatSeconds: Number.POSITIVE_INFINITY },
      { ...valid, heartbeatSeconds: Number.NaN },
      { ...valid, heartbeatSeconds: -1 },
      { ...valid, heartbeatSeconds: 30 },
      { ...valid, heartbeatSeconds: 600.5 },
      { ...valid, heartbeatSeconds: '600' },
      { ...valid, targetRevision: 7 },
      { ...valid, startedAt: 'not-a-time' },
      { ...valid, startedAt: 42 },
      { ...valid, createdBy: 'worker' },
    ];
    for (const value of cases) expect(parseCampaign(value), JSON.stringify(value)?.slice(0, 80)).toBeUndefined();
  });

  it('returns the existing record unchanged when a later call carries another goal', () => {
    const original = campaignFrom({ goal: 'Original objective', target: TARGET, at: AT });
    const replan = campaignFrom({
      goal: 'A different objective', avoid: ['No payment flows'], heartbeatSeconds: 0,
      targetRevision: 'rev-other', target: 'https://other.test', at: '2027-01-01T00:00:00.000Z',
    }, original);
    expect(replan).toBe(original);
    expect(replan.objective).toBe('Original objective');
    expect(replan.heartbeatSeconds).toBe(DEFAULT_HEARTBEAT_SECONDS);
    expect(replan.createdBy).toBe('operator');
  });

  it('defaults the heartbeat to 600 s, preserves 0, clamps below the floor and falls back on bad values', () => {
    expect(build().heartbeatSeconds).toBe(DEFAULT_HEARTBEAT_SECONDS);
    const disabled = build({ heartbeatSeconds: 0 });
    expect(disabled.heartbeatSeconds).toBe(0);
    expect(campaignStartLine(disabled)).toContain('heartbeat 0s');
    expect(campaignStartLine(disabled)).toContain('heartbeats are disabled');
    expect(campaignStartLine(disabled)).toMatch(/paid rounds/);
    expect(build({ heartbeatSeconds: 1 }).heartbeatSeconds).toBe(MIN_HEARTBEAT_SECONDS);
    expect(build({ heartbeatSeconds: MIN_HEARTBEAT_SECONDS - 1 }).heartbeatSeconds).toBe(MIN_HEARTBEAT_SECONDS);
    expect(build({ heartbeatSeconds: 600.9 }).heartbeatSeconds).toBe(600);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 0.5])
      expect(build({ heartbeatSeconds: bad }).heartbeatSeconds, String(bad)).toBe(bad === 0.5 ? MIN_HEARTBEAT_SECONDS : DEFAULT_HEARTBEAT_SECONDS);
    expect(() => build({ heartbeatSeconds: Number.NaN })).not.toThrow();
  });

  it('derives a bounded, deterministic ASCII objective that differs per target', () => {
    const objective = defaultObjective(TARGET);
    expect(objective).toContain(TARGET);
    expect(objective.length).toBeLessThanOrEqual(600);
    expect(objective).toMatch(/^[\x20-\x7e]+$/);
    expect(defaultObjective(TARGET)).toBe(objective);
    expect(defaultObjective('https://other.test')).not.toBe(objective);
    expect(defaultObjective('café')).toMatch(/^[\x20-\x7e]+$/);
    expect(defaultObjective('u'.repeat(2000)).length).toBeLessThanOrEqual(600);
    expect(defaultObjective('')).toContain('authorized target');
  });

  it('renders a single-line start confirmation with the interval and the paid-rounds disclosure', () => {
    const campaign = build({ goal: 'Assess invoices', avoid: ['No payment flows', 'Do not touch /admin'], heartbeatSeconds: 300 });
    const line = campaignStartLine(campaign);
    expect(line).toContain('Assess invoices');
    expect(line).toContain('2 deny, 0 allow');
    expect(line).toContain('heartbeat 300s');
    expect(line).toContain('heartbeats consume paid rounds');
    expect(line).toContain('created by operator');
    expect(line).not.toContain('\n');
    expect(line).toMatch(/^[\x20-\x7e]+$/);
  });

  it('renders a bounded planner block with every recorded rule, the widen sentence and no worker-only text', () => {
    const campaign = build({
      goal: 'Assess invoice access across tenant boundaries',
      avoid: ['No payment flows', 'Do not touch /admin'],
    });
    const withPermissions: CampaignRecord = {
      ...campaign,
      constraints: [...campaign.constraints, { rule: 'allow', text: 'Use the staging tenant' }],
    };
    const block = campaignPromptBlock(withPermissions);
    expect(block).toContain('Assess invoice access across tenant boundaries');
    expect(block).toContain('No payment flows');
    expect(block).toContain('Do not touch /admin');
    expect(block).toContain('Use the staging tenant');
    expect(block).toContain('may widen');
    expect(block).toContain('operator objective');
    expect(block).toContain('must not silently narrow');
    expect(block.indexOf('No payment flows')).toBeLessThan(block.indexOf('Use the staging tenant'));
    expect(block.length).toBeLessThan(1000);
    expect(block).not.toContain('\n');
    expect(block).toMatch(/^[\x20-\x7e]+$/);
    expect(block.toLowerCase()).not.toContain('worker');
    expect(campaignPromptBlock(withPermissions)).toBe(block);
    expect(campaignPromptBlock({ ...withPermissions, objective: 'two\nlines' })).not.toContain('\n');
  });

  // P21/B3 (2026-10-29): the block gained the conditional goal-proof rule and the recorded-policy citation, so its one-line
  // bound rose 600 -> 1000 (still one bounded paragraph; measured with a policy artifact in policy-baseline.test.ts).
  it('keeps an oversized block under the cap with an explicit omitted count', () => {
    const campaign = build({
      goal: 'x'.repeat(600),
      avoid: Array.from({ length: 12 }, (_, index) => `rule ${index} ${'y'.repeat(290)}`),
    });
    const block = campaignPromptBlock(campaign);
    expect(block.length).toBeLessThan(1000);
    expect(block).toContain('may widen');
    expect(block).toMatch(/omitted/);
  });

  it('marks the objective default or operator-authored and builds constraints from avoid, capped and deduped', () => {
    const derived = build();
    expect(derived.createdBy).toBe('default');
    expect(derived.objective).toBe(defaultObjective(TARGET));
    const operator = build({ goal: '  Assess invoices  ' });
    expect(operator.createdBy).toBe('operator');
    expect(operator.objective).toBe('Assess invoices');
    const clipped = build({ goal: 'x'.repeat(1000) });
    expect(clipped.createdBy).toBe('operator');
    expect(clipped.objective.length).toBe(600);
    expect(build({ goal: '   ' }).createdBy).toBe('default');

    const avoid = ['', '   ', 'No payment flows', 'No payment flows', '  Do not touch /admin  ', ...Array.from({ length: 20 }, (_, index) => `rule ${index}`)];
    const capped = build({ avoid });
    expect(capped.constraints).toHaveLength(12);
    expect(capped.constraints.every(constraint => constraint.rule === 'deny')).toBe(true);
    expect(new Set(capped.constraints.map(constraint => constraint.text)).size).toBe(12);
    expect(capped.constraints[0]).toEqual({ rule: 'deny', text: 'No payment flows' });
    expect(capped.constraints[1]).toEqual({ rule: 'deny', text: 'Do not touch /admin' });

    const multiline = build({ avoid: ['first rule\nsecond rule'] });
    expect(multiline.constraints.map(constraint => constraint.text)).toEqual(['first rule', 'second rule']);
    const long = build({ avoid: ['a'.repeat(1000)] });
    expect(long.constraints[0]!.text.length).toBe(300);
  });
});
