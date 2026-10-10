import { isAbsolute } from 'node:path';
import type { AssessmentRecord, LedgerIndex, RecordAck } from '../records.js';
import type { MutationRequest } from './store.js';

export interface WorkHistoryRow { sequence:number; recordId:string; taskId:string; taskRevision:number; fingerprint:string; targetRevision:string; overlapKey?:string; status:string; current:boolean; result:'none'|'partial'|'reusable' }
export interface WorkHistoryPage { rows:WorkHistoryRow[]; total:number; active:number; reusable:number; partial:number; omitted:number }
export interface RecordBackend {
  append(records: AssessmentRecord[], request?: MutationRequest): RecordAck[];
  generated(makeRecords: () => AssessmentRecord[], request: MutationRequest): RecordAck[];
  generatedResult?(request:MutationRequest):RecordAck[]|undefined;
  index(runId?: string): LedgerIndex;
  changeToken(): number;
  workHistory?(fingerprint:string,limit?:number):WorkHistoryPage;
  workOverlap?(overlapKey:string,limit?:number):WorkHistoryPage;
}
const backends = new Map<string, RecordBackend>();
/** Host-installed adapters only. A filename/record never reconstructs an owner service. */
export function bindRecordBackend(path: string, backend: RecordBackend): () => void {
  if (!isAbsolute(path) || !path.endsWith('.sqlite')) throw Error('Canonical ledger alias must be an absolute .sqlite path');
  if (backends.has(path)) throw Error('Canonical ledger already has an owner adapter');
  backends.set(path, backend);
  return () => { if (backends.get(path) === backend) backends.delete(path); };
}
export function recordBackend(path: string): RecordBackend | undefined {
  const backend = backends.get(path);
  if (!backend && path.endsWith('.sqlite')) throw Error('Canonical ledger has no active host adapter; open historical state explicitly read-only');
  return backend;
}
