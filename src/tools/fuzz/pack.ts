import { checkCancelled, invariant } from '../../policy/errors.js';
import { record, text } from '../../policy/validation.js';
import type { Action, Capability, Policy, TargetBudget, ToolContext } from '../../policy/index.js';
import type { HttpExecution } from '../http.js';
import type { ExecutionSandbox } from '../sandbox.js';
import type { ApprovedFuzzTemplate, FuzzDifferentialInput, FuzzTemplateInput, HttpEvidence, ToolDescriptor } from '../types.js';
import { runDifferential, type FuzzDifferentialEvidence } from './differential.js';
import { runExternalTool, type ExternalFuzzRequest, type ExternalFuzzRunner, type ExternalRunnerPin, type ExternalToolRunEvidence } from './external-tool.js';
import { runTemplateFuzz, validateApprovedTemplates, type FuzzTemplateEvidence, type TemplateFuzzState } from './template.js';

export type FuzzEvidence = FuzzDifferentialEvidence | FuzzTemplateEvidence;
export interface FuzzPackExecutionInput {
  readonly context: ToolContext;
  readonly capability: Capability;
  readonly input: unknown;
  readonly descriptor: ToolDescriptor;
  readonly signal?: AbortSignal;
  readonly touchedTargets: Set<string>;
}
export interface FuzzPackConfiguration {
  /** Owner-approved request templates; an empty list refuses every `fuzz.template` call. */
  readonly templates?: readonly ApprovedFuzzTemplate[];
  /** Owner-injected external runner; absent means external execution is refused, never installed. */
  readonly externalRunner?: ExternalFuzzRunner;
  readonly externalRunnerPins?: readonly ExternalRunnerPin[];
}
export interface FuzzPackOptions extends FuzzPackConfiguration {
  readonly policy: Policy;
  readonly budgets: TargetBudget;
  readonly sandbox: ExecutionSandbox;
  readonly request: (execution: HttpExecution) => Promise<HttpEvidence>;
  readonly now?: () => number;
}
export interface FuzzPack {
  authorizeTarget(capability: Capability, input: unknown): { url: string; method: string; accountId: string; action: Action };
  execute(execution: FuzzPackExecutionInput): Promise<FuzzEvidence>;
  /** Contract-only entry point: verified against pinned identities, with no runtime provided here. */
  externalTool(request: ExternalFuzzRequest, signal?: AbortSignal): Promise<ExternalToolRunEvidence>;
  inspect(): readonly { id: string; used: number; maxRequests: number }[];
  close(): void;
}

const networkAction = (method: string): Action => (['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'mutate');

export function createFuzzPack(options: FuzzPackOptions): FuzzPack {
  const now = options.now ?? Date.now;
  const templates = validateApprovedTemplates(options.templates ?? []);
  const byId = new Map(templates.map(template => [template.id, template]));
  const states = new Map<string, TemplateFuzzState>();
  let closed = false;
  const stateFor = (id: string): TemplateFuzzState => {
    const existing = states.get(id);
    if (existing) return existing;
    const created: TemplateFuzzState = { used: 0, windowStart: 0, windowCount: 0 };
    states.set(id, created);
    return created;
  };
  const requireTemplate = (value: unknown): ApprovedFuzzTemplate => {
    const id = text(value, 'templateId', 128);
    const template = byId.get(id);
    invariant(template, 'CAPABILITY_DENIED', 'No owner-approved fuzz template matches this id; unapproved templates are refused');
    return template;
  };

  return Object.freeze({
    authorizeTarget(capability: Capability, input: unknown): { url: string; method: string; accountId: string; action: Action } {
      invariant(!closed, 'UNAVAILABLE', 'Fuzz pack is closed');
      invariant(capability === 'fuzz.template', 'CAPABILITY_DENIED', 'Not a request-template capability');
      const parsed = record(input, 'input');
      const template = requireTemplate(parsed.templateId);
      invariant(now() < Date.parse(template.expiresAt), 'EXPIRED', 'Approved template expired; re-approval is required before any request');
      return { url: template.url, method: template.method, accountId: template.accountId, action: networkAction(template.method) };
    },
    async execute(execution: FuzzPackExecutionInput): Promise<FuzzEvidence> {
      invariant(!closed, 'UNAVAILABLE', 'Fuzz pack is closed');
      checkCancelled(execution.signal);
      if (execution.capability === 'fuzz.differential') {
        const input = record(execution.input, 'input') as unknown as FuzzDifferentialInput;
        return await runDifferential(input, {
          inputRoot: options.sandbox.filesystem.inputRoot,
          readInput: (path, signal) => options.sandbox.filesystem.readInput(path, signal),
          codeExecution: options.sandbox.codeExecution,
          boundary: options.sandbox.boundary,
          timeoutMs: execution.descriptor.limits.timeoutMs,
          signal: execution.signal,
          now,
        });
      }
      invariant(execution.capability === 'fuzz.template', 'CAPABILITY_DENIED', 'Not a fuzz capability');
      const parsed = record(execution.input, 'input');
      const template = requireTemplate(parsed.templateId);
      const input = parsed as unknown as FuzzTemplateInput;
      return await runTemplateFuzz(input, template, {
        context: execution.context,
        descriptor: execution.descriptor,
        request: options.request,
        touchedTargets: execution.touchedTargets,
        state: stateFor(template.id),
        now,
        boundary: options.sandbox.boundary,
        signal: execution.signal,
      });
    },
    async externalTool(request: ExternalFuzzRequest, signal?: AbortSignal): Promise<ExternalToolRunEvidence> {
      invariant(!closed, 'UNAVAILABLE', 'Fuzz pack is closed');
      return await runExternalTool({
        runner: options.externalRunner,
        pins: options.externalRunnerPins,
        request,
        now,
        ...(signal ? { signal } : {}),
      });
    },
    inspect() {
      return Object.freeze(templates.map(template => ({ id: template.id, used: stateFor(template.id).used, maxRequests: template.maxRequests })));
    },
    close(): void { closed = true; },
  });
}
