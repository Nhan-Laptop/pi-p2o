// Regression for the default-composition planner wiring (workstream P2, deliverable 1).
//
// The owner document's `planner` field is the only switch: without it the control plane fails closed with
// INTEGRATION_REQUIRED; with it, `p2o_plan` propose/read/approve run through the real composition over the
// real supervisor and store, and every invalid planner document or owner file is refused before admission.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createApplication, validateApplicationConfig } from '../../src/application/index.js';
import { prepareLocalAssessment } from '../../examples/local-assessment/main.js';
import { RUN_ID } from '../../examples/local-assessment/scenario.js';

const BOUNDARY = 'plan-materialized tasks execute only the owner-approved observations the approved plan selected';

test('the default composition wires p2o_plan only when the owner document supplies a planner', async () => {
  const runRoot = mkdtempSync(join(tmpdir(), 'p2o-composition-plan-'));
  const prepared = await prepareLocalAssessment({ runRoot, log: () => {} });
  let closed = false;
  try {
    // No planner document: the real interface dispatch fails closed and fabricates nothing.
    await assert.rejects(
      () => prepared.app.interfaceBackend.plan!({ action: 'read', runId: RUN_ID }),
      /INTEGRATION_REQUIRED/,
    );
    await prepared.app.close();
    closed = true;

    const plannerToolPolicy = prepared.config.tasks[0]!.toolPolicy;
    assert.equal(plannerToolPolicy.mode, 'sandbox-extension');

    // Unknown planner fields and a tool policy the owner rules refuse never pass config validation.
    assert.throws(() => validateApplicationConfig({
      ...prepared.config,
      planner: { toolPolicy: plannerToolPolicy, boundaryReceipt: BOUNDARY, unknown: true },
    }), /unknown planner field/);
    assert.throws(() => validateApplicationConfig({
      ...prepared.config,
      planner: { toolPolicy: { mode: 'trusted-fixture', allowUnsandboxedHostTools: true, tools: [] }, boundaryReceipt: BOUNDARY },
    }), /sandbox-bound extension/);
    assert.throws(() => validateApplicationConfig({
      ...prepared.config,
      planner: { toolPolicy: plannerToolPolicy, boundaryReceipt: BOUNDARY, caps: { maxTasks: 0, maxDepth: 2, maxObservations: 4, maxRequests: 8 } },
    }), /planner\.caps\.maxTasks/);

    // With an owner planner document the port is wired: read works over the durable run, and an approval is
    // always an owner file from disk (a missing one is refused, never invented).
    const config = validateApplicationConfig({
      ...prepared.config,
      planner: {
        toolPolicy: plannerToolPolicy, boundaryReceipt: BOUNDARY,
        caps: { maxTasks: 4, maxDepth: 2, maxObservations: 8, maxRequests: 16 },
        planApprovals: [],
      },
    });
    const app = await createApplication(config);
    closed = true;
    try {
      assert.ok(app.planLedger, 'a configured planner exposes the composition-owned ledger');
      await app.admitApprovedRun();
      const read = await app.interfaceBackend.plan!({ action: 'read', runId: RUN_ID }) as {
        runId: string; proposals: unknown[]; approvals: unknown[]; threatModels: unknown[]; coverage: { canFinalize: boolean };
      };
      assert.equal(read.runId, RUN_ID);
      assert.deepEqual(read.proposals, []);
      assert.deepEqual(read.approvals, []);
      assert.deepEqual(read.threatModels, []);
      assert.equal(read.coverage.canFinalize, true);
      await assert.rejects(() => app.interfaceBackend.plan!({
        action: 'approve', runId: RUN_ID, proposalDigest: 'a'.repeat(64), approvalPath: join(runRoot, 'missing-approval.json'),
      }), /plan-path/);
      await assert.rejects(() => app.interfaceBackend.plan!({
        action: 'read', runId: 'run-not-admitted',
      }), /plan-run-unknown/);
    } finally {
      await app.close();
      closed = true;
    }
  } finally {
    if (!closed) { try { await prepared.app.close(); } catch { /* the app may already be closed */ } }
    await prepared.closeFixtures();
  }
});
