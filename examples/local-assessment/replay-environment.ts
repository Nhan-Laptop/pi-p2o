import { digestJson, type JsonObject } from '../../src/contracts/index.js';
import type { CleanReplayBroker, CleanReplaySession, ReplayRequest } from '../../src/evidence/index.js';
import type { ApplicationConfig, VerificationServices } from '../../src/application/index.js';
import { createScopedVerificationPolicy } from '../../src/application/first-use-verification/index.js';
import type { Scope } from '../../src/policy/index.js';
import { startFixture, type FixtureInstance } from './fixture-server.js';
import { ENVIRONMENT_B, TARGET_B } from './scenario.js';

export interface FixtureReplayOptions {
  /** Stable loopback port reserved for the verifier environment. */
  port: number;
  /** The initially started environment-B instance (closed and replaced by a fresh one on prepare). */
  initial: () => FixtureInstance;
  setCurrent: (instance: FixtureInstance) => void;
  /**
   * The owner-approved composition document. The controller issues the verifier capability from the same broker
   * scope the composition's policy and collector use for the exact verifier attempt; the fixture never invents
   * scope, targets, accounts or caps.
   */
  config?: ApplicationConfig;
  /** Deterministic clock for the issued capability (defaults to the wall clock). */
  now?: () => number;
}

async function health(origin: string): Promise<JsonObject> {
  // Loopback environment qualification performed by the controller, not an assessed target request.
  const response = await fetch(`${origin}/healthz`, { redirect: 'error' });
  if (!response.ok) throw new Error(`fixture health check failed with HTTP ${response.status}`);
  return await response.json() as JsonObject;
}

/**
 * Fixture clean-replay provider. Each prepare creates a brand-new loopback fixture instance on the reserved
 * port, verifies its identity/configuration from its health document, issues the scoped verifier capability for
 * the live verifier attempt, admits a verifier-owned qualification receipt, and closes it after the replay with a
 * termination receipt. No worker script, command or external destination is involved.
 */
export function createFixtureReplayEnvironment(services: VerificationServices, options: FixtureReplayOptions): CleanReplayBroker {
  return {
    async prepare(request: ReplayRequest): Promise<CleanReplaySession> {
      const task = services.task(request.task.taskId);
      const attempt = services.attempt(request.attempt.attemptId);
      if (!task || !attempt) throw new Error('replay requires a durable verifier task/attempt');
      // Fail closed without the owner document: a replay capability cannot be invented from the request.
      const config = options.config;
      if (!config) throw new Error('replay requires the owner-approved composition document to issue the scoped verifier capability');
      const template = config.policy.grantTemplates.find(candidate => candidate.taskId === task.taskId);
      if (!template) throw new Error(`replay requires the owner-approved verifier grant for ${task.taskId}`);
      // The exact broker scope the composition's policy/collector already use for this attempt: same owner
      // policy fields and the same attempt-bound grant, so the issued capability's scope digest matches the
      // environment receipt's collector digest. It is an in-process capability, never serialized worker JSON.
      const scope: Scope = {
        version: 1,
        runId: config.policy.runId,
        authorization: config.policy.authorization,
        targets: config.policy.targets,
        exclusions: config.policy.exclusions,
        accounts: config.policy.accounts,
        grants: [{ ...template, attemptId: request.attempt.attemptId }],
      };
      const verificationPolicy = createScopedVerificationPolicy(config.run, scope, options.now);
      try { await options.initial().close(); } catch { /* the reserved port is released by close */ }
      const instance = await startFixture({ environmentId: ENVIRONMENT_B, port: options.port, configurationDigest: task.scope.configurationDigest });
      options.setCurrent(instance);
      const healthDocument = await health(instance.origin);
      if (healthDocument.environmentId !== ENVIRONMENT_B || healthDocument.configurationDigest !== instance.configurationDigest || healthDocument.instanceId !== instance.instanceId) {
        await instance.close();
        throw new Error('fresh fixture instance identity/configuration does not match the approved fixture');
      }
      const qualificationDigest = digestJson(healthDocument);
      const environmentId = `replay-${instance.instanceId}`;
      const verifierId = request.verifierId;
      const receipt = services.collector.admitDocument(attempt, {
        evidenceId: environmentId,
        kind: 'runtime',
        classification: 'independently-observed',
        summary: `Fresh loopback fixture instance ${instance.instanceId} qualified for independent replay`,
        document: {
          version: 1, fixture: 'loopback-tenant-lab', environmentId: ENVIRONMENT_B, targetId: TARGET_B,
          instanceId: instance.instanceId, origin: instance.origin, configurationDigest: instance.configurationDigest,
          qualificationDigest, scopeDigest: verificationPolicy.scopeDigest, qualifiedAt: new Date().toISOString(),
        } as JsonObject,
        method: 'controller-created fresh fixture instance; loopback health identity verified',
        role: 'verifier',
        collectorId: verifierId,
        environmentId: ENVIRONMENT_B,
        metadata: {
          // A brand-new loopback instance on its own reserved port, but the claim is about an independent
          // verifier session, never a reset of the assessed target state.
          independentSession: true,
          targetReset: false,
          fixtureReset: true,
          recipeDigest: request.recipeDigest,
          qualification: `fresh fixture instance ${instance.instanceId}; health digest ${qualificationDigest}`,
          fixtureInstanceId: instance.instanceId,
          scopeDigest: verificationPolicy.scopeDigest,
        },
      });
      let closed = false;
      return {
        verificationPolicy,
        environmentReceiptId: receipt.evidenceId,
        context: { runId: request.task.runId, taskId: request.task.taskId, attemptId: request.attempt.attemptId, grantId: services.grantIdFor(request.task.taskId) },
        artifactRootId: services.artifactRootId,
        httpTool: services.httpTool,
        broker: services.brokerFor(attempt),
        async close(signal: AbortSignal): Promise<{ receiptEvidenceId: string }> {
          if (!closed) {
            closed = true;
            await instance.close();
          }
          const receiptId = `${environmentId}-terminated`;
          const termination = services.collector.admitDocument(attempt, {
            evidenceId: receiptId,
            kind: 'runtime',
            classification: 'independently-observed',
            summary: `Fresh fixture instance ${instance.instanceId} closed after replay`,
            document: {
              version: 1, fixture: 'loopback-tenant-lab', instanceId: instance.instanceId, environmentId: ENVIRONMENT_B,
              terminationConfirmed: true, terminatedAt: new Date().toISOString(), abortRequested: signal.aborted,
            } as JsonObject,
            method: 'controller-owned fixture shutdown with confirmed listener close',
            role: 'verifier',
            collectorId: verifierId,
            environmentId: ENVIRONMENT_B,
            metadata: { terminationConfirmed: true, fixtureInstanceId: instance.instanceId, targetReset: false },
          });
          return { receiptEvidenceId: termination.evidenceId };
        },
      };
    },
  };
}
