// CONTRACT ONLY: no provider call, no target request, no worker launch, no filesystem mutation outside the
// temp fixture paths the stubs own. This suite replays the exact steps a live DeepSeek-flash/max planner
// produced (stored qualification artifact, copied verbatim in `live-plan-fixture.ts`) through the pure
// model-author validator, the shared interface bound and the human `/p2o` command contract.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { registerP2O } from '../../extensions/p2o/index.js';
import { ENTRY_PLAN_LIMITS } from '../../src/application/entry/authoring.js';
import { createPiModelPlanAuthor, planAuthorPrompt, type PiPlanAuthorCompletionResult } from '../../src/application/entry/pi-author.js';
import type { EntryPlanAuthorInput } from '../../src/application/entry/types.js';
import { ENTRY_PLAN_STEP_BOUNDS, type EntryPreparation } from '../../src/interface/target-entry.js';
import { FakeBackend, FakeEntry, fakePi } from '../interface/helpers.js';
import { contractOwnerConsent } from './owner-consent-fixture.js';
import { LIVE_DEEPSEEK_FLASH_MAX_PLAN } from './live-plan-fixture.js';

const liveSteps = LIVE_DEEPSEEK_FLASH_MAX_PLAN.steps;

function setup() {
  const pi = fakePi(true), backend = new FakeBackend(), entry = new FakeEntry();
  backend.entry = entry;
  const controller = registerP2O(pi.api, { backendFactory: () => backend, onboardingFor: contractOwnerConsent });
  return { pi, backend, entry, controller };
}

const lastMessage = (pi: ReturnType<typeof fakePi>) => pi.messages.at(-1);
const lastText = (pi: ReturnType<typeof fakePi>) => String(pi.messages.at(-1)?.content ?? '');

/** Minimal faithful author input; no target bytes, no execution path, no provider selection. */
function authorInput(): EntryPlanAuthorInput {
  const preparation = {
    runId: 'run-1', scopeDigest: 'a'.repeat(64),
    target: { kind: 'local-dir', raw: './repo', locator: './repo' },
    mode: 'fixture', actions: ['read'], spend: { maxCostUsd: 5, maxRequests: 20, maxTokens: 100_000, maxToolCalls: 20, maxAttempts: 2 },
    concurrency: 1, warnings: [], requiresHumanApproval: true, targetRequests: 0, planOnly: true,
  } as unknown as EntryPreparation;
  return {
    preparation,
    depth: 'standard',
    facts: {
      targetKind: 'local-dir', locator: './repo', targetId: 'owner-target', samplePaths: [],
      ownerObservations: [], generatedTasks: [], accounts: ['anonymous'],
      allowedActions: ['read', 'analyze'], allowedCapabilities: ['source.analyze', 'http.request'],
      limits: {
        maxSteps: ENTRY_PLAN_LIMITS.maxSteps, maxStepChars: ENTRY_PLAN_LIMITS.maxStepChars,
        maxSelections: ENTRY_PLAN_LIMITS.maxSelections, maxGeneratedRequests: ENTRY_PLAN_LIMITS.maxGeneratedRequests,
      },
    },
    techniques: ['http.request'],
    skills: [],
    available: { ownerMenu: true, generatedRequests: true },
  };
}

function authorReturning(steps: string[]) {
  return createPiModelPlanAuthor({
    selection: { provider: 'inert-fixture', model: 'inert-worker', thinking: 'max' },
    complete: async () => JSON.stringify({ attemptId: 'plan-bound', steps, ownerMenu: [{ taskId: 'assessment', observationId: 'obs-1' }] }),
  });
}

function authorReturningCompletion(completion: PiPlanAuthorCompletionResult) {
  return createPiModelPlanAuthor({
    selection: { provider: 'inert-fixture', model: 'inert-worker', thinking: 'max' },
    complete: async () => completion,
  });
}

describe('one shared plan-step bound', () => {
  test('the interface contract, the command and the author validator cannot drift', () => {
    expect(ENTRY_PLAN_LIMITS.maxSteps).toBe(ENTRY_PLAN_STEP_BOUNDS.maxSteps);
    expect(ENTRY_PLAN_LIMITS.maxStepChars).toBe(ENTRY_PLAN_STEP_BOUNDS.maxStepChars);
    expect(ENTRY_PLAN_STEP_BOUNDS.maxSteps).toBeGreaterThan(0);
    expect(ENTRY_PLAN_STEP_BOUNDS.maxStepChars).toBeGreaterThan(0);
  });

  test('the stored live planner output is within the shared bound and reaches approval whole', async () => {
    // Provenance guard: while the live artifact is still on disk, this copy must be byte-identical. Only the
    // plan steps are read; no credential, usage or provider data is touched or printed.
    if (existsSync(LIVE_DEEPSEEK_FLASH_MAX_PLAN.artifact)) {
      const stored = JSON.parse(readFileSync(LIVE_DEEPSEEK_FLASH_MAX_PLAN.artifact, 'utf8')) as { plan?: { steps?: unknown } };
      expect(stored.plan?.steps).toEqual(liveSteps);
    }
    expect(liveSteps.map(step => step.length)).toEqual(LIVE_DEEPSEEK_FLASH_MAX_PLAN.stepChars);
    const longest = Math.max(...liveSteps.map(step => step.length));
    expect(longest).toBeLessThanOrEqual(ENTRY_PLAN_STEP_BOUNDS.maxStepChars);
    expect(liveSteps.length).toBeLessThanOrEqual(ENTRY_PLAN_STEP_BOUNDS.maxSteps);
    // The regression this guards: the real plan was longer than the interface's old hidden 160-char bound.
    expect(longest).toBeGreaterThan(160);

    const s = setup();
    s.entry.planOverrides = { runId: 'run-1', steps: [...liveSteps] };
    await s.pi.command('p2o', '--target ./repo --plan-only');
    expect(lastMessage(s.pi)?.customType).toBe('p2o_result');
    await s.pi.command('p2o', 'approve plan-1');
    expect(s.entry.calls).toContain('approve:plan-1');
    // The confirmation must show every approved step whole; a 160-char prefix would hide what the digest seals.
    const confirmation = s.pi.confirmCalls.at(-1)?.message ?? '';
    for (const step of liveSteps) expect(confirmation).toContain(step);
    await s.controller.close();
  });

  test('a plan past the shared bound is refused by the command, never truncated into success', async () => {
    const overLong = 'x'.repeat(ENTRY_PLAN_STEP_BOUNDS.maxStepChars + 1);
    const tooMany = Array.from({ length: ENTRY_PLAN_STEP_BOUNDS.maxSteps + 1 }, (_, index) => `step ${index}`);
    for (const steps of [[overLong], tooMany]) {
      const s = setup();
      s.entry.planOverrides = { runId: 'run-1', steps };
      await s.pi.command('p2o', '--target ./repo');
      expect(lastMessage(s.pi)?.customType).toBe('p2o_error');
      expect(lastText(s.pi)).toMatch(/ENTRY_CONTRACT_VIOLATION/);
      expect(lastText(s.pi)).toContain(String(ENTRY_PLAN_STEP_BOUNDS.maxStepChars));
      expect(s.entry.calls).not.toContain('start');
      await s.controller.close();
    }
  });

  test('the model author states the bound in its prompt and refuses a longer step, never truncating it', async () => {
    const prompt = planAuthorPrompt(authorInput());
    expect(prompt).toMatch(new RegExp(`at most ${ENTRY_PLAN_STEP_BOUNDS.maxSteps} steps`));
    expect(prompt).toMatch(new RegExp(`every step at most ${ENTRY_PLAN_STEP_BOUNDS.maxStepChars} characters`));

    // The real live steps pass the pure validator unaltered.
    await expect(authorReturning([...liveSteps]).author(authorInput())).resolves.toMatchObject({ steps: [...liveSteps] });
    // Exactly at the bound is admissible; one character over is refused (never sliced). The author's own bound
    // check runs before the packet is interpreted, so no packet fixture is needed for the refusal.
    await expect(authorReturning(['y'.repeat(ENTRY_PLAN_STEP_BOUNDS.maxStepChars)]).author(authorInput())).resolves.toMatchObject({
      steps: ['y'.repeat(ENTRY_PLAN_STEP_BOUNDS.maxStepChars)],
    });
    await expect(authorReturning(['y'.repeat(ENTRY_PLAN_STEP_BOUNDS.maxStepChars + 1)]).author(authorInput()))
      .rejects.toThrow(new RegExp(`at most ${ENTRY_PLAN_STEP_BOUNDS.maxStepChars} characters`));
  });

  test('classifies a length-stopped reasoning-only provider completion with actionable headroom facts', async () => {
    const completion = authorReturningCompletion({
      text: '', stopReason: 'length', rawStopReason: 'length', outputTokens: 4096, reasoningTokens: 4096,
      reasoningContent: true, admittedMaxOutputTokens: 4096,
    });
    await expect(completion.author(authorInput())).rejects.toMatchObject({ code: 'MODEL_PLAN_COMPLETION_TRUNCATED' });
    await expect(completion.author(authorInput())).rejects.toThrow(/stopReason=length.*observedOutputTokens=4096.*observedReasoningTokens=4096.*admittedCompletionCeiling=4096.*lower thinking level for planning or raise the planner completion bound/);
  });

  test('keeps valid provider text on the unchanged plan success path', async () => {
    const completion = authorReturningCompletion({
      text: JSON.stringify({ attemptId: 'provider-valid', steps: ['inspect the approved loopback metadata'], ownerMenu: [{ taskId: 'assessment', observationId: 'obs-1' }] }),
      stopReason: 'stop', outputTokens: 42, reasoningTokens: 4, reasoningContent: true, admittedMaxOutputTokens: 4096,
    });
    await expect(completion.author(authorInput())).resolves.toMatchObject({ authoredBy: 'model', steps: ['inspect the approved loopback metadata'] });
  });

  test('fails closed with a distinct no-text diagnostic when provider truncation evidence is absent', async () => {
    const completion = authorReturningCompletion({ text: '', stopReason: 'stop', outputTokens: 0, reasoningTokens: 0, reasoningContent: false, admittedMaxOutputTokens: 4096 });
    await expect(completion.author(authorInput())).rejects.toMatchObject({ code: 'MODEL_PLAN_COMPLETION_EMPTY' });
    await expect(completion.author(authorInput())).rejects.toThrow(/no visible text and no provider truncation stop was observed/);
  });

  test('keeps ENTRY_PLAN_INVALID for malformed present provider text', async () => {
    const completion = authorReturningCompletion({ text: 'not a JSON plan', stopReason: 'stop', outputTokens: 3, reasoningTokens: 0, reasoningContent: false, admittedMaxOutputTokens: 4096 });
    await expect(completion.author(authorInput())).rejects.toMatchObject({ code: 'ENTRY_PLAN_INVALID' });
  });
});
