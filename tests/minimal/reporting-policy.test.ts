import { describe, expect, it } from 'vitest';
import { OWNER_TOOLS, TARGET_FACING_OPERATIONS, TARGET_TOOLS, WORKER_TOOLS, reportingOperationDenied, workerTools } from '../../src/tool-policy.js';
import { workerInstructions } from '../../src/prompts.js';

/**
 * planning_update.md P13(g): the reporting-role policy was stated in three shapes — a derived tool list, a restated list of denied
 * broker operations, and prompt prose. Only the first was authoritative, so a new target-facing tool could be offered to someone
 * (or hidden from the tool list while its RPC stayed callable). These tests tie the three shapes to one map.
 */
describe('reporting is synthesis-only, derived from one map (P13g)', () => {
  it('denies exactly the mapped operations, and never a reads-only one', () => {
    for (const op of Object.keys(TARGET_FACING_OPERATIONS)) expect(reportingOperationDenied('reporting', op), op).toBe(true);
    for (const op of ['ledger', 'graph_read', 'note', 'surface', 'report', 'status', 'skill_read', 'artifact_read', 'request_subtask', 'usage', 'objective', 'context_read'])
      expect(reportingOperationDenied('reporting', op), op).toBe(false);
    // Only the reporting role loses them; a discovery worker keeps the same operations.
    for (const op of Object.keys(TARGET_FACING_OPERATIONS)) expect(reportingOperationDenied('discovery', op), op).toBe(false);
  });

  it('maps every denied operation to a tool the reporting loadout does not carry', () => {
    const reporting = new Set(workerTools('reporting'));
    for (const [op, { tool, whole }] of Object.entries(TARGET_FACING_OPERATIONS)) {
      if (whole) expect(reporting.has(tool), `${op} → ${tool} must not be offered to reporting`).toBe(false);
      else expect(reporting.has(tool), `${op} keeps ${tool} for reads`).toBe(true);
      // Worker-facing operations must map to a tool a worker loadout carries; `delegate` is the owner's spawn path and is not one.
      if (tool !== 'p2o_delegate') expect(workerTools('discovery'), op).toContain(tool);
    }
    // Reporting keeps only read/synthesis tools: nothing in its loadout may be target-facing.
    for (const tool of reporting) expect(TARGET_TOOLS.includes(tool), tool).toBe(false);
    expect(reporting.has('p2o_candidate')).toBe(false);
  });

  it('keeps the owner loadout a superset and the prompt consistent with the derived lists', () => {
    for (const tool of WORKER_TOOLS) expect(OWNER_TOOLS.includes(tool) || tool === 'p2o_request_subtask' || tool === 'p2o_report', tool).toBe(true);
    const text = workerInstructions({ workerId: 'worker-test', role: 'reporting', runId: 'run-test', depth: 1, parentWorkerId: null, lifetime: 'until-stopped', target: { kind: 'directory', label: '/target' } } as never);
    for (const tool of TARGET_TOOLS) expect(text.includes(tool), `reporting prompt must not offer ${tool}`).toBe(false);
    expect(text).toMatch(/synthes/i);
  });
});
