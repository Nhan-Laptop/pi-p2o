import { describe, expect, it } from 'vitest';
import { LAB_TOOLS, PLANNER_TOOLS, REPORTER_TOOLS, TARGET_TOOLS, WORKER_TOOLS, reporterTools, workerTools } from '../../src/tool-policy.js';
import { reporterInstructions, workerInstructions } from '../../src/prompts.js';

/**
 * planning_update.md A1 (P0): the reporter is the read-only second reader for an accepted case. It may read evidence,
 * traces and artifacts and write the report; it cannot run target tools, author a claim, change a verdict or plan.
 */
const mentioned = (text: string) => new Set(text.match(/\bp2o_[a-z_]+\b/g) ?? []);
const ticket = (role: string) => ({ workerId: 'worker-test', role, runId: 'run-test', depth: 1, parentWorkerId: null, lifetime: 'until-stopped', target: { kind: 'directory', label: '/ta' }, executorMode: 'shared' } as never);

describe('reporting is a read-only second reader (P0/A1)', () => {
  it('gets only the read/report loadout, never target, lab, claim, note, surface or planning tools', () => {
    expect(workerTools('reporting')).toEqual(reporterTools());
    expect(new Set(workerTools('reporting'))).toEqual(new Set(REPORTER_TOOLS));
    for (const name of [...TARGET_TOOLS, ...LAB_TOOLS, 'p2o_candidate', 'p2o_note', 'p2o_surface', 'p2o_graph',
      'p2o_task_author', 'p2o_task_dispatch', 'p2o_goal_author', 'p2o_case_author', 'p2o_coverage_plan', 'p2o_finish', 'p2o_request_subtask']) {
      expect(REPORTER_TOOLS, name).not.toContain(name);
    }
    expect(REPORTER_TOOLS).toContain('p2o_report');
    expect(PLANNER_TOOLS).not.toContain('p2o_report');
    expect(WORKER_TOOLS).toContain('p2o_candidate');
  });

  it('names only tools the reporter holds and states the read-only rule', () => {
    const text = reporterInstructions(ticket('reporting'));
    for (const named of mentioned(text)) expect(REPORTER_TOOLS, named).toContain(named);
    expect(text).toMatch(/read-only second reader/i);
    expect(text).toMatch(/cannot run target tools, create candidates/i);
  });

  it('does not give a reporting worker the executing worker prompt', () => {
    const executing = workerInstructions(ticket('discovery')), reporting = workerInstructions(ticket('reporting'));
    expect(executing).toMatch(/P2O WORKER/);
    expect(reporting).toMatch(/P2O REPORTER/);
    expect(mentioned(reporting).has('p2o_shell')).toBe(false);
    expect(mentioned(reporting).has('p2o_candidate')).toBe(false);
  });
});
