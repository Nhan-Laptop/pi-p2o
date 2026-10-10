import { IncrementalLedger, notifyRecordObservers, type LedgerIndex } from '../records.js';
import { bindRecordBackend } from './registry.js';
import type { AssessmentStore } from './store.js';

const PAGE = 2000;

/**
 * Canonical rows are append-only, so the legacy v2 projection is kept incrementally: each committed row is validated and indexed
 * once, and a read costs the rows added since the previous read. The result equals `indexRecords(store.records(), runId)`
 * (differentially tested); a failed update drops the cache so the next read rebuilds from the store rather than trusting it.
 */
function incrementalIndex(store: AssessmentStore): (runId?: string) => LedgerIndex {
  let ledger: IncrementalLedger | undefined, owner: string | undefined, through = 0;
  return runId => {
    const key = runId ?? '';
    try {
      if (!ledger || owner !== key) { ledger = new IncrementalLedger(runId); owner = key; through = 0; }
      for (;;) {
        const page = store.recordsSince(through, PAGE);
        if (!page.length) break;
        ledger.append(page.map(item => item.record)); through = page[page.length - 1].sequence;
        if (page.length < PAGE) break;
      }
      return ledger.snapshot(store.sequence());
    } catch (error) { ledger = undefined; owner = undefined; through = 0; throw error; }
  };
}

/** Reuses TaskBoard/EvidenceStore/report APIs without a competing JSONL writer. */
export function bindAssessmentStore(alias: string, store: AssessmentStore): () => void {
  const unbind = bindRecordBackend(alias, {
    append: (records, request) => store.commitRecords(records, request),
    generated: (makeRecords, request) => store.commitGeneratedRecords(makeRecords, request),
    generatedResult: request => store.generatedResult(request),
    index: incrementalIndex(store),
    changeToken: () => store.sequence(),
    workHistory: (fingerprint,limit) => store.workHistory(fingerprint,limit),
    workOverlap: (overlapKey,limit) => store.workOverlap(overlapKey,limit),
  });
  let unsubscribe: () => void;
  try { unsubscribe = store.subscribe(() => notifyRecordObservers(alias)); }
  catch (error) { unbind(); throw error; }
  return () => { unsubscribe(); unbind(); };
}
