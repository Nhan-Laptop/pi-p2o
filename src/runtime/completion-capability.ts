/** Provider/model capability, independent of application financial or token consent. */
export interface CompletionCapability {
  maxTokens: number;
  contextWindow: number;
}

/**
 * Resolve a provider-valid completion ceiling from the actual selected model and a conservative input
 * bound. No application budget, thinking-tier guess or fallback model participates in this calculation.
 * Reasoning is part of the completion ceiling for providers such as DeepSeek, not an additional allowance.
 *
 * This does not guarantee that reasoning leaves visible output. Length-stopped/no-text responses still
 * need fail-closed classification. An explicit owner budget must be admitted separately before dispatch;
 * this function neither supplies consent nor changes a persisted bounded policy.
 */
export function selectedModelCompletionLimit(model: CompletionCapability, inputTokensUpperBound: number): number {
  if (!Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 ||
      !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 ||
      model.maxTokens > model.contextWindow) {
    throw new Error('MODEL_COMPLETION_CAPABILITY_REQUIRED: explicit valid selected-model output/context limits required');
  }
  if (!Number.isSafeInteger(inputTokensUpperBound) || inputTokensUpperBound < 0) {
    throw new Error('MODEL_INPUT_BOUND_INVALID: a nonnegative safe input token bound is required');
  }
  const available = model.contextWindow - inputTokensUpperBound;
  if (available < 1) {
    throw new Error('MODEL_CONTEXT_EXHAUSTED: input leaves no selected-model completion capacity');
  }
  return Math.min(model.maxTokens, available);
}
