/**
 * W-J/H2: an IaC/cloud-config rule match is the same evidence-ladder grade as a nuclei template match — checkov read the
 * declared configuration and matched a rule; it did not reach the deployed resource. The row stays an open hypothesis
 * until a worker demonstrates the actual effect (an anonymously-readable bucket, a usable hardcoded secret, an assumable
 * role).
 */
import { clean, isRecord, parseJson } from './sanitize.js';
import { type ExtractAsset, type ExtractHypothesis, type ExtractResult, type Extractor, EXTRACT_MAX_RECORDS } from './types.js';

/**
 * Build the per-finding hypothesis statement from one failed_checks row. Mirrors nuclei's `classification()` role: decide
 * what a checkov finding is allowed to claim, since a config-rule hit is a static-source lead, never a demonstrated effect.
 *
 * TODO(human): implement. `row` is the raw failed-check record (already known to be a record whose `check_result.result`
 * is not "skipped"); `resource` is the already-cleaned resource identity backing the asset this hypothesis attaches to.
 * Return undefined if the row has nothing statement-worthy (e.g. no usable check_id), so the caller counts it skipped.
 */
function describeFinding(row: Record<string, unknown>, resource: string): { statement: string; impact?: string } | undefined {
  const checkId = clean(row.check_id, 40) ?? 'unknown-check';
  const name = clean(row.check_name, 200);
  const statement = clean(`checkov: ${checkId}${name ? ` (${name})` : ''} failed on ${resource} — declared-configuration signal, not a demonstrated effect`, 2_000);
  if (!statement) return undefined;
  const guideline = clean(row.guideline, 300);
  return { statement, ...(guideline ? { impact: `remediation guidance: ${guideline}` } : {}) };
}

export const checkov: Extractor = (source) => {
  const trimmed = source.text.trimStart();
  if (!trimmed.startsWith('{')) return undefined;
  const parsed = parseJson(trimmed);
  if (!isRecord(parsed)) return undefined;
  const results = isRecord(parsed.results) ? parsed.results : undefined;
  const failedRaw = Array.isArray(results?.failed_checks) ? results.failed_checks : undefined;
  if (!failedRaw) return undefined;
  const checkType = clean(parsed.check_type, 40);
  const failed = failedRaw.slice(0, EXTRACT_MAX_RECORDS);
  const omitted = failedRaw.length - failed.length;
  const assets: ExtractAsset[] = [], hypotheses: ExtractHypothesis[] = [], warnings: string[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  for (const value of failed) {
    if (!isRecord(value)) { skipped += 1; continue; }
    const checkResult = isRecord(value.check_result) ? value.check_result : undefined;
    if (clean(checkResult?.result, 20)?.toLowerCase() === 'skipped') continue;
    const resource = clean(value.resource, 200);
    if (!resource) { skipped += 1; continue; }
    const described = describeFinding(value, resource);
    if (!described) { skipped += 1; continue; }
    let index = seen.get(resource);
    if (index === undefined) {
      index = assets.length;
      seen.set(resource, index);
      const filePath = clean(value.file_path, 300);
      assets.push({ kind: 'config', key: resource, label: resource, attributes: { source: 'checkov', ...(checkType ? { checkType } : {}), ...(filePath ? { file: filePath } : {}) } });
    }
    hypotheses.push({ asset: index, statement: described.statement, ...(described.impact ? { impact: described.impact } : {}) });
  }
  if (skipped) warnings.push(`checkov: ${skipped} failed-check row(s) had no usable resource identity and were skipped`);
  if (omitted) warnings.push(`checkov: ${omitted} failed check(s) past the ${EXTRACT_MAX_RECORDS}-record walk limit are not parsed`);
  if (assets.length) warnings.push('checkov findings are recorded as open hypotheses: a rule match against declared configuration is a pointer to test, never a claim, case or finding');
  if (!assets.length) return undefined;
  return { extractor: 'checkov', assets, facts: [], hypotheses, components: [], warnings, omitted: { assets: 0, facts: 0, hypotheses: 0, components: 0 } } satisfies ExtractResult;
};
