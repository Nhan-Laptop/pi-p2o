import { randomUUID } from 'node:crypto';
import type { WorkerReport } from './broker.js';
import type { AssessmentTask } from './tasks.js';
import type { TaskOutputContract } from './work.js';

export interface PhasePacket {
  version:1; id:string; taskId:string; taskRevision:number; workerId:string; reportId:string; at:string;
  delivery:'reported'|'blocked'; reviewStatus:'pending'; contract?:TaskOutputContract;
  observed:{evidence:number;coverage:number;openItems:number;findingClaims:number};
  unreviewedRequired:string[]; outcome?:string; confidence:string; blocked?:string;
}

/** Host-created delivery card. Counts are reported output, never contract acceptance or proof. */
export function makePhasePacket(task:AssessmentTask,workerId:string,reportId:string,report:WorkerReport,at:string):PhasePacket{
  const blocked=Boolean(report.blocked)||report.outcome==='provider-error'||report.outcome==='cancelled'||report.outcome==='prerequisite-blocked';
  return {version:1,id:`phase-${randomUUID()}`,taskId:task.id,taskRevision:task.revision,workerId,reportId,at,delivery:blocked||task.status==='reserved'?'blocked':'reported',reviewStatus:'pending',
    ...(task.outputContract?{contract:task.outputContract}:{ }),observed:{evidence:report.evidence.length,coverage:report.coverage.length,openItems:report.openItems.length,findingClaims:report.findings.length},
    unreviewedRequired:task.outputContract?.required??[],outcome:report.outcome,confidence:report.confidence,...(report.blocked?{blocked:report.blocked}:{})};
}
