import type { AssessmentRecord } from './records.js';
import type { StateEvent } from './state/store.js';
import { graphCanonical } from './state/graph.js';
import { sha256Hex, validId } from './validate.js';

export const KNOWLEDGE_DOMAINS=['task','goal','todo','decision','case','coverage-plan','coverage-cell','candidate','gap','phase','report','evidence'] as const;
export type KnowledgeDomain=typeof KNOWLEDGE_DOMAINS[number];
export interface KnowledgeIndexHead {domain:KnowledgeDomain;entityId:string;recordId:string;sequence:number;status:string;actorId:string}
export interface KnowledgeHead extends KnowledgeIndexHead {summary:string;refs:string[]}
export interface KnowledgePage {rows:KnowledgeHead[];total:number;shown:number;omitted:number;cursor:number;asOfSequence:number;nextCursor?:number}
export interface ContextCursor {consumerId:string;throughSequence:number;gapThrough:number;reviewThrough:number;packetSha256:string;eventSequence:number}
export interface ContextItem extends KnowledgeHead {detail:Record<string,unknown>}
export interface KnowledgeLink {recordId:string;relation:string;targetId:string}
export interface KnowledgeIndexSnapshot {version:1;runId:string;asOfSequence:number;heads:KnowledgeIndexHead[];links:KnowledgeLink[];cursors:ContextCursor[];authorityRestored:false}
export interface ContextPacket {
  version:1;runId:string;consumerId:string;role:'planner'|'worker'|'reporting';taskId?:string;asOfSequence:number;
  cursorBefore:{throughSequence:number;gapThrough:number;reviewThrough:number};cursorAfter:{throughSequence:number;gapThrough:number;reviewThrough:number};
  counts:{heads:number;coldRecords:number;openGaps:number;pendingReviews:number;eventsAfterCursor:number};
  changes:Array<{sequence:number;kind:string;actorId:string;taskId?:string;entityId?:string;summary:string;payloadRefs:string[]}>;
  attention:ContextItem[];newGaps:ContextItem[];newReviews:ContextItem[];relevant:ContextItem[];
  omissions:{changes:number;attention:number;newGaps:number;newReviews:number;relevant:number};
  retrieval:{headsCursor:number;eventCursor:number;commands:string[]};warning:string;packetSha256:string;encodedBytes:number;
}

const object=(value:unknown):Record<string,unknown>|undefined=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
/** Deterministic record-to-head descriptor. No I/O, no authority and no semantic proof upgrade. */
export function describeKnowledgeRecord(row:AssessmentRecord):{domain:KnowledgeDomain;entityId:string;status:string;links:Array<[string,string]>}|undefined{
  let domain:KnowledgeDomain|undefined,entityId:string|undefined,status='current';const links:Array<[string,string]>=[];
  const add=(relation:string,value:unknown)=>{if(validId(value))links.push([relation,value]);},many=(relation:string,value:unknown)=>{if(Array.isArray(value))for(const item of value)add(relation,typeof item==='string'?item:object(item)?.id??object(item)?.taskId??object(item)?.caseId);};
  const task=row.kind==='task'?object(row.data?.task):undefined,plan=row.kind==='note'?object(row.data?.plan):undefined,caseEntry=row.kind==='note'?object(row.data?.case):undefined,coveragePlan=row.kind==='note'?object(row.data?.coveragePlan):undefined,coverageCell=row.kind==='note'?object(row.data?.coverageCell):undefined,phase=row.kind==='note'?object(row.data?.phase):undefined;
  if(task&&typeof task.id==='string'){domain='task';entityId=task.id;status=String(task.status);many('evidence',task.evidenceIds);many('prerequisite',task.prerequisites);many('asset',object(task.work)?.assetRefs);add('task',task.parentTaskId);add('task',task.validationOf);add('task',task.retestOf);add('phase',task.phasePacketId);}
  else if(plan&&typeof plan.id==='string'&&['goal','todo','decision'].includes(String(plan.kind))){domain=plan.kind as KnowledgeDomain;entityId=plan.id;status=String(plan.status);many('task',plan.taskIds);many('goal',plan.goalIds);many('evidence',plan.supportRefs);const decision=object(plan.decision);many('task',decision?.chosenTaskIds);many('task',decision?.deferredTaskIds);}
  else if(caseEntry&&typeof caseEntry.id==='string'){domain='case';entityId=caseEntry.id;status=String(caseEntry.reviewStatus);many('asset',caseEntry.assetRefs);many('claim',caseEntry.claimRefs);many('evidence',caseEntry.independentEvidenceRefs);many('task',caseEntry.taskRefs);many('report',caseEntry.reportRefs);many('case',caseEntry.relatedCaseIds);add('case',caseEntry.duplicateOf);add('assertion',object(caseEntry.hypothesis)?.id);for(const item of (caseEntry.contradictions as unknown[]|undefined)??[])add('evidence',object(item)?.evidenceRef);const remediation=object(caseEntry.remediation);many('evidence',remediation?.evidenceRefs);add('task',object(remediation?.retestTask)?.taskId);}
  else if(coveragePlan&&typeof coveragePlan.id==='string'){domain='coverage-plan';entityId=coveragePlan.id;status=String(coveragePlan.status);many('coverage-cell',coveragePlan.cellIds);}
  else if(coverageCell&&typeof coverageCell.id==='string'){domain='coverage-cell';entityId=coverageCell.id;status=coverageCell.retired?'retired':`${String(coverageCell.execution)}/${String(coverageCell.assessment)}`;add('coverage-plan',coverageCell.planId);add('asset',object(coverageCell.assetRef)?.id);many('task',coverageCell.taskRefs);many('claim',coverageCell.claimRefs);many('case',coverageCell.caseRefs);many('evidence',coverageCell.evidenceRefs);many('evidence',coverageCell.negativeControlRefs);many('gap',coverageCell.gapRefs);}
  else if(row.kind==='candidate'&&typeof row.data?.candidate==='string'){domain='candidate';entityId=`claim-head-${sha256Hex(graphCanonical([row.by,row.data.candidate])).slice(0,24)}`;status=String(row.data.closure??'unknown');many('evidence',row.refs);add('evidence',row.data.independentEvidenceRef);}
  else if(row.kind==='open'&&row.id){domain='gap';entityId=row.id;status='open';many('ref',row.refs);}
  else if(phase&&typeof phase.id==='string'){domain='phase';entityId=phase.id;status=String(phase.reviewStatus??'pending');add('task',phase.taskId);add('report',phase.reportId);}
  else if(row.kind==='report'&&row.id){domain='report';entityId=row.workerId??row.id;status=String(row.data?.blocked?'blocked':'reported');many('evidence',row.refs);}
  else if(row.kind==='evidence'&&row.id){domain='evidence';entityId=row.id;status='retained';}
  return domain&&entityId?{domain,entityId,status,links}:undefined;
}

/** Offline barrier audit/rebuild of KNOWLEDGE only. Never applied to a writer/Engine/ticket/budget.
 * Full-history audit is explicit; context/UI do not call it as a hidden fallback. */
export function replayKnowledgeIndex(base:KnowledgeIndexSnapshot,tail:StateEvent[],record:(id:string)=>AssessmentRecord|undefined):KnowledgeIndexSnapshot{
  if(base.version!==1||base.authorityRestored!==false)throw Error('Unsupported knowledge index snapshot');
  const key=(domain:string,id:string)=>`${domain}:${id}`,heads=new Map(base.heads.map(head=>[key(head.domain,head.entityId),{...head}])),links=new Map<string,KnowledgeLink[]>(),cursors=new Map(base.cursors.map(cursor=>[cursor.consumerId,{...cursor}]));
  for(const link of base.links){const rows=links.get(link.recordId)??[];rows.push({...link});links.set(link.recordId,rows);}
  const invalidate=(targetId:string,relation:string)=>{
    const targets=new Set([key(relation,targetId)]);let changed=true;
    while(changed){changed=false;for(const head of heads.values())if(['case','coverage-cell'].includes(head.domain)&&(links.get(head.recordId)??[]).some(link=>targets.has(key(link.relation,link.targetId)))){
      const target=key(head.domain,head.entityId);if(!targets.has(target)){targets.add(target);changed=true;}if(!['withdrawn','retired'].includes(head.status))head.status='stale';
    }}
  };
  let through=base.asOfSequence;
  for(const event of tail){if(event.runId!==base.runId||!Number.isSafeInteger(event.sequence)||event.sequence!==through+1)throw Error('Non-contiguous/foreign knowledge event tail');through=event.sequence;
    for(const id of event.payloadRefs){const row=record(id);if(!row)continue;if(row.runId!==base.runId)throw Error('Foreign record in knowledge replay');
      // Only the event that committed this canonical row may project it; support refs are not writes.
      if(event.entityId!==row.id||!['record.committed','case.revised','review.committed','coverage.revised','phase.committed'].includes(event.kind)&&!event.kind.startsWith('task.'))continue;
      for(const resolved of row.resolves??[]){const gap=heads.get(key('gap',resolved));if(gap)gap.status='resolved';invalidate(resolved,'gap');}
      const descriptor=describeKnowledgeRecord(row);if(!descriptor||!row.id)continue;const {domain,entityId,status}=descriptor;
      const prior=heads.get(key(domain,entityId));if(prior)links.delete(prior.recordId);
      heads.set(key(domain,entityId),{domain,entityId,recordId:row.id,sequence:event.sequence,status,actorId:row.by});links.set(row.id,descriptor.links.map(([relation,targetId])=>({recordId:row.id!,relation,targetId})));
      if(domain==='task')for(const head of heads.values())if(head.domain==='phase'&&(links.get(head.recordId)??[]).some(link=>link.relation==='task'&&link.targetId===entityId))head.status=['reviewed','closed'].includes(status)?'reviewed':status==='reported'?'pending':status;
      if(row.supersedes){if(domain==='candidate')invalidate(row.supersedes,'claim');if(domain==='task'||domain==='case')invalidate(entityId,domain);}
    }
    const graph=object(event.data?.graph),body=object(graph?.body);if(body&&Number(body.revision)>1&&typeof body.entityId==='string'&&['assets','assertions'].includes(String(graph?.table)))invalidate(body.entityId,graph?.table==='assets'?'asset':'assertion');
    const delivery=object(event.data?.context);if(event.kind==='context.consumed'&&delivery){const after=object(delivery.cursorAfter);if(!validId(delivery.consumerId)||!after||typeof delivery.packetSha256!=='string')throw Error('Invalid context receipt in event tail');cursors.set(delivery.consumerId,{consumerId:delivery.consumerId,throughSequence:Number(after.throughSequence),gapThrough:Number(after.gapThrough),reviewThrough:Number(after.reviewThrough),packetSha256:delivery.packetSha256,eventSequence:event.sequence});}
  }
  const uniqueLinks=new Map([...links.values()].flat().map(link=>[graphCanonical(link),link]));
  return {version:1,runId:base.runId,asOfSequence:through,heads:[...heads.values()].sort((a,b)=>key(a.domain,a.entityId)<key(b.domain,b.entityId)?-1:1),links:[...uniqueLinks.values()].sort((a,b)=>graphCanonical(a)<graphCanonical(b)?-1:1),cursors:[...cursors.values()].sort((a,b)=>a.consumerId<b.consumerId?-1:1),authorityRestored:false};
}
