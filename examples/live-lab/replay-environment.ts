// Clean-replay provider for the live lab: a brand-new loopback lab instance per verifier replay.
//
// The controller (not a worker, not a script) closes the standing environment-B instance and starts a fresh
// instance on the same reserved loopback port, verifies its identity/configuration from its own health
// document, admits a verifier-owned qualification receipt, and closes it after the replay with a termination
// receipt. No worker-supplied input reaches this file: the port, the environment identity and the
// configuration digest all come from the owner-approved task scope.
import { digestJson, type JsonObject } from '../../src/contracts/index.js';
import type { CleanReplayBroker, CleanReplaySession, ReplayRequest } from '../../src/evidence/index.js';
import type { VerificationServices } from '../../src/application/index.js';
import type { LabInstance, LabServerModule } from './types.js';

export interface LabReplayOptions {
  module: LabServerModule;
  /** Stable loopback port reserved for the verifier environment. */
  port: number;
  /** Environment identity approved for the verifier task scope. */
  environmentId: string;
  /** The initially started environment-B instance (closed and replaced by a fresh one on prepare). */
  initial: () => LabInstance | undefined;
  setCurrent: (instance: LabInstance) => void;
  /** Seeded account identities of this environment; the fresh instance must provision the same ones. */
  accounts?: readonly { accountId: string; tenant: string; role: string; password: string }[];
}

async function health(origin: string): Promise<JsonObject> {
  // Loopback environment qualification performed by the controller, not an assessed target request.
  const response = await fetch(`${origin}/healthz`, { redirect: 'error' });
  if (!response.ok) throw new Error(`lab health check failed with HTTP ${response.status}`);
  return await response.json() as JsonObject;
}

export function createLabReplayEnvironment(services: VerificationServices, options: LabReplayOptions): CleanReplayBroker {
  const { module } = options;
  return {
    async prepare(request: ReplayRequest): Promise<CleanReplaySession> {
      const task = services.task(request.task.taskId);
      const attempt = services.attempt(request.attempt.attemptId);
      if (!task || !attempt) throw new Error('replay requires a durable verifier task/attempt');
      try { await options.initial()?.close(); } catch { /* the reserved port is released by close */ }
      const instance = await module.startLabServer({
        environmentId: options.environmentId,
        port: options.port,
        configurationDigest: task.scope.configurationDigest,
        // The fresh instance must seed the same account identities as the standing environment, otherwise
        // the verifier's approved account cannot resolve its dispatch-time credential and the replay blocks.
        ...(options.accounts ? { accounts: options.accounts } : {}),
      });
      options.setCurrent(instance);
      let healthDocument: JsonObject;
      try {
        healthDocument = await health(instance.origin);
      } catch (error) {
        await instance.close();
        throw error;
      }
      if (healthDocument.environmentId !== options.environmentId
        || healthDocument.configurationDigest !== instance.configurationDigest
        || healthDocument.instanceId !== instance.instanceId) {
        await instance.close();
        throw new Error('fresh lab instance identity/configuration does not match the approved environment');
      }
      const qualificationDigest = digestJson(healthDocument);
      const environmentEvidenceId = `replay-${instance.instanceId}`;
      const verifierId = request.verifierId;
      const receipt = services.collector.admitDocument(attempt, {
        evidenceId: environmentEvidenceId,
        kind: 'runtime',
        classification: 'independently-observed',
        summary: `Fresh loopback lab instance ${instance.instanceId} qualified for independent replay`,
        document: {
          version: 1, lab: module.LAB_NAME, environmentId: options.environmentId,
          instanceId: instance.instanceId, origin: instance.origin, configurationDigest: instance.configurationDigest,
          qualificationDigest, qualifiedAt: new Date().toISOString(),
        } as JsonObject,
        method: 'controller-created fresh lab instance; loopback health identity verified',
        role: 'verifier',
        collectorId: verifierId,
        environmentId: options.environmentId,
        metadata: {
          cleanEnvironment: true,
          qualification: `fresh lab instance ${instance.instanceId}; health digest ${qualificationDigest}`,
          fixtureInstanceId: instance.instanceId,
        },
      });
      let closed = false;
      return {
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
          const terminationId = `${environmentEvidenceId}-terminated`;
          const termination = services.collector.admitDocument(attempt, {
            evidenceId: terminationId,
            kind: 'runtime',
            classification: 'independently-observed',
            summary: `Fresh lab instance ${instance.instanceId} closed after replay`,
            document: {
              version: 1, lab: module.LAB_NAME, instanceId: instance.instanceId, environmentId: options.environmentId,
              terminationConfirmed: true, terminatedAt: new Date().toISOString(), abortRequested: signal.aborted,
            } as JsonObject,
            method: 'controller-owned lab shutdown with confirmed listener close',
            role: 'verifier',
            collectorId: verifierId,
            environmentId: options.environmentId,
            metadata: { terminationConfirmed: true, fixtureInstanceId: instance.instanceId },
          });
          return { receiptEvidenceId: termination.evidenceId };
        },
      };
    },
  };
}
