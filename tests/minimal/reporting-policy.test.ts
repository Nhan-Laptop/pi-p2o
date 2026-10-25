import { describe, expect, it } from 'vitest';
import { OWNER_TOOLS, WORKER_TOOLS, workerTools } from '../../src/tool-policy.js';
import { workerInstructions } from '../../src/prompts.js';

/**
 * planning_update.md Part XI (S3): the reporting role no longer loses tools. Reporting is a normal worker that happens to
 * be asked for a report; the review separation lives in the lead's review step, not in a hidden tool list.
 */
describe('reporting is an ordinary worker (Part XI)', () => {
  it('gets the same loadout as every other worker', () => {
    expect(workerTools('reporting')).toEqual(workerTools('discovery'));
    expect(new Set(workerTools('reporting'))).toEqual(new Set(WORKER_TOOLS));
  });

  it('keeps the owner loadout a superset and the prompt free of a synthesis-only rule', () => {
    for (const tool of WORKER_TOOLS) if (tool !== 'p2o_request_subtask' && tool !== 'p2o_report') expect(OWNER_TOOLS.includes(tool), tool).toBe(true);
    const text = workerInstructions({ workerId: 'worker-test', role: 'reporting', runId: 'run-test', depth: 1, parentWorkerId: null, lifetime: 'until-stopped', target: { kind: 'directory', label: '/ta' } } as never);
    expect(text).not.toMatch(/synthesis-only|produce no new claim|cannot change candidate proof/i);
  });
});
