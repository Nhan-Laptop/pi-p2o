/**
 * planning_update.md P16.3: the graph is the medium, so a worker starts from what the run already recorded instead of from
 * the lead's prose. This is a bounded slice — assets on the task surface, the latest facts, open leads/gaps and the ready
 * chain steps — and it is labelled background: the brief never turns a recorded assertion into proof.
 */
export interface SliceAssetRow { entityId: string; kind?: string; key?: string }
export interface SliceFactRow { entityId: string; kind?: string; statement?: string; recordedBy?: string; evidenceRefs?: readonly string[] }
export interface SliceGap { id: string; text: string }
export interface SliceReadyStep { chain: string; step: number; needs: readonly string[] }

export interface GraphSliceInput {
  surface: string;
  assets: readonly SliceAssetRow[];
  facts: readonly SliceFactRow[];
  gaps: readonly SliceGap[];
  ready: readonly SliceReadyStep[];
  /** Per-list cap. The slice is a starting point, not the graph: the worker can read more with its own tools. */
  limit?: number;
}

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}…` : text;
const latest = <T extends { entityId: string }>(rows: readonly T[]): T[] => {
  const head = new Map<string, T>();
  for (const row of rows) head.set(row.entityId, row);
  return [...head.values()];
};

export function graphSliceLines(input: GraphSliceInput): string[] {
  const limit = input.limit ?? 20, surface = input.surface.trim().toLowerCase();
  const assets = latest(input.assets);
  const onSurface = surface ? assets.filter(asset => (asset.key ?? '').toLowerCase().includes(surface)) : [];
  const shownAssets = (onSurface.length ? onSurface : assets).slice(-limit);
  const facts = latest(input.facts).filter(fact => fact.kind?.startsWith('fact:')).slice(-limit);
  const gaps = input.gaps.slice(-limit), ready = input.ready.slice(-limit);
  const lines: string[] = [];
  if (shownAssets.length) lines.push(clip(`assets ${onSurface.length ? 'on this surface' : 'recorded (none matched this surface)'} (${shownAssets.length}): ${shownAssets.map(asset => `${asset.entityId} ${asset.kind ?? '?'} ${asset.key ?? ''}`).join(' · ')}`, 900));
  if (facts.length) lines.push(clip(`facts so far (${facts.length}, latest): ${facts.map(fact => `${fact.entityId} ${fact.kind} "${fact.statement ?? ''}"${fact.evidenceRefs?.length ? ` [${fact.evidenceRefs.join(',')}]` : ''}${fact.recordedBy ? ` by ${fact.recordedBy}` : ''}`).join(' · ')}`, 900));
  if (gaps.length) lines.push(clip(`open leads/gaps (${gaps.length}): ${gaps.map(gap => `${gap.id} ${gap.text}`).join(' · ')}`, 600));
  if (ready.length) lines.push(clip(`chain frontier: ${ready.map(step => `step ${step.step} of chain ${step.chain} ready (needs ${step.needs.join(', ') || 'nothing'})`).join('; ')}`, 400));
  return lines;
}
