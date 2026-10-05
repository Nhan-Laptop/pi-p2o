export interface ModelAccountingContract {
  modelAccounting?: 'informational';
  maxTokens: number | null;
  maxCostUsd: number | null;
}
/** Legacy omission means bounded, never accounting-only. Null is an explicit absent financial cap. */
export function validModelAccounting(value: ModelAccountingContract): boolean {
  return value.modelAccounting === 'informational'
    ? value.maxTokens === null && value.maxCostUsd === null
    : value.modelAccounting === undefined && typeof value.maxTokens === 'number' && Number.isSafeInteger(value.maxTokens) && value.maxTokens >= 0 && typeof value.maxCostUsd === 'number' && Number.isFinite(value.maxCostUsd) && value.maxCostUsd >= 0;
}
/** A child never removes a legacy parent's explicit financial authority. */
export function modelAccountingNarrows(child: ModelAccountingContract, parent: ModelAccountingContract): boolean {
  if (!validModelAccounting(child) || !validModelAccounting(parent)) return false;
  if (parent.modelAccounting === 'informational') return true;
  return child.modelAccounting === undefined && child.maxTokens! <= parent.maxTokens! && child.maxCostUsd! <= parent.maxCostUsd!;
}
