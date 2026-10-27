import { Type } from 'typebox';
import { capabilitySchema, choices } from './schema-kit.js';
import { KNOWLEDGE_DOMAINS } from './context.js';
import { COVERAGE_OUTCOMES } from './records.js';
import { ROLES, THINKING_LEVELS } from './roles.js';
import { WORKER_OUTCOMES } from './broker.js';
import { CANDIDATE_CLOSURES, CANDIDATE_EXECUTIONS, CANDIDATE_PROOFS, POLICY_BASES } from './evidence.js';
import { PAYLOAD_BYTES, PAYLOAD_KINDS } from './lab.js';
import { RESEARCH_QUERY_MAX } from './research.js';
import { RISK_LABEL_TRUTH } from './truth.js';
import { HTTP_METHOD_PATTERN } from './target.js';
import { outputContractSchema, workDecisionSchema, workSpecSchema } from './work-tool.js';

/**
 * Parameter schemas of the model-facing tools. They are the declaration payload sent on every turn, so the byte sizes are pinned by
 * tests/minimal/workflow-policy.test.ts; the L1 task verbs and graph tools keep theirs in board-verbs.ts or beside their validators.
 */
export const stateParameters = Type.Object({action:choices(['heads', 'search']),q:Type.Optional(Type.String({minLength:2,maxLength:80})),domain:Type.Optional(choices(KNOWLEDGE_DOMAINS)),status:Type.Optional(Type.String({maxLength:80})),cursor:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false});

export const taskDraftSchema = Type.Object({
    // P2: surface/risk are cosmetic prose (admission clamps them to their 200-char cap with a warning trace), so their declared
    // cap sits well above the admission cap: Pi must let a long draft reach the host instead of hard-refusing it at argument
    // validation. Semantic fields keep their exact caps — the host refuses those rather than truncating them.
    question:Type.String({minLength:1,maxLength:1500}),surface:Type.String({minLength:1,maxLength:2000}),risk:Type.String({minLength:1,maxLength:2000, description: RISK_LABEL_TRUTH}),
    // Required for every role except recon, which may omit them for a lighter intent (src/tasks.ts validate() enforces the role-conditional minimum).
    role:choices(ROLES),roleReason:Type.Optional(Type.String({maxLength:1000})),
    expectedTrue:Type.Optional(Type.String({maxLength:1000})),expectedFalse:Type.Optional(Type.String({maxLength:1000})),stopCondition:Type.Optional(Type.String({maxLength:1000})),
    expectedOutput:Type.Optional(Type.String({minLength:5,maxLength:1000})),
    unknowns:Type.Optional(Type.Array(Type.String({minLength:10,maxLength:500}))),missingPrerequisites:Type.Optional(Type.Array(Type.String({minLength:10,maxLength:500}))),
    // P10/TR-L06: an intent that cites no receipt and no prerequisite omits both lists; the host records [] instead of demanding
    // the caller restate "none" (a non-empty list is still validated as same-run evidence / pinned prerequisites).
    evidenceIds:Type.Optional(Type.Array(Type.String({maxLength:80}),{description:'Same-run evidence IDs this intent already stands on; omit when none and the host records an empty list'})),
    prerequisites:Type.Optional(Type.Array(Type.Object({taskId:Type.String({maxLength:80}),revision:Type.Optional(Type.Integer({minimum:1}))}),{description:'Reviewed prerequisite tasks; omit when none and the host records an empty list'})),
    validationOf:Type.Optional(Type.String({maxLength:80})),retestOf:Type.Optional(Type.String({maxLength:80})),parentTaskId:Type.Optional(Type.String({maxLength:80})),
    work:Type.Optional(workSpecSchema),decision:Type.Optional(workDecisionSchema),outputContract:Type.Optional(outputContractSchema),
    // P10/WF-02/03 (Q28): optional per-task worker runtime. The host validates the model against the configured role models and
    // the thinking level against THINKING_LEVELS at admission; dispatch model/thinking override it for one dispatch.
    runtime:Type.Optional(Type.Object({model:Type.Optional(Type.String({maxLength:200,description:'Worker model for this task; must be one of the configured role models (the host lists them in the planner prompt and refuses others)'})),thinking:Type.Optional(choices(THINKING_LEVELS))},{additionalProperties:false,description:'P10/WF-02/03 (Q28): optional per-task worker runtime; the host validates the model against the configured role models and the level against the supported thinking levels at admission, and dispatch-level model/thinking overrides it for that dispatch'})),
    skills:Type.Optional(Type.Array(Type.String({maxLength:64}))),workflow:Type.Optional(Type.String({maxLength:64})),
    // P5.1 measured rerun: the lead omitted this for every discovery intent and could not see why the host refused it.
    methodReason:Type.Optional(Type.String({maxLength:1000,description:'Why this method answers the question. Required (at least 10 characters) for every role except recon; the host refuses the intent when it is missing'})),
  },{additionalProperties:false});

/** P8.3: `match` is no longer a task action; create performs the same preflight and returns its payload instead of creating. */
export const TASK_ACTIONS = ['create','revise','list','start','review','close','block','cancel','dispatch'] as const;
/** P13e: one row per action, so a new action is a type error instead of inheriting a default parameter list. */
export const TASK_ACTION_PARAMETERS: Readonly<Record<typeof TASK_ACTIONS[number], readonly string[]>> = {
  create: ['action','draft'], revise: ['action','draft','id','revision'], list: ['action','id','cursor','limit'],
  dispatch: ['action','ids','id','priority','workerId','model','thinking'], start: ['action','id'],
  review: ['action','id','revision','reason','evidenceIds','externalEvidence'], close: ['action','id','revision','reason','evidenceIds','externalEvidence'],
  block: ['action','id','revision','reason','evidenceIds','externalEvidence'], cancel: ['action','id','revision','reason','evidenceIds','externalEvidence'],
};

export const surfaceParameters = Type.Object({component:Type.String({minLength:1,maxLength:200}),entryPoint:Type.String({minLength:1,maxLength:200}),text:Type.Optional(Type.String({maxLength:1000})),refs:Type.Optional(Type.Array(Type.String({maxLength:80})))},{additionalProperties:false});

export const skillListParameters = Type.Object({ query: Type.Optional(Type.String({ maxLength: 80 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) });

export const skillReadParameters = Type.Object({ id: Type.String({ maxLength: 160 }), offset: Type.Optional(Type.Integer({ minimum: 0 })),
  materialize: Type.Optional(Type.Boolean({ description: 'Copy a registered skill script into your own scratch and return {path, sha256, bytes}; refuses anything else and never reads a host path' })) });

/** P14.1: the capability shape is declared once in schema-kit.ts, which both this module and the work identity can import without a cycle. */
export { capabilitySchema };

export const candidateParameters = Type.Object({
      candidate: Type.String({ pattern: '^[a-z0-9][a-z0-9-]{0,79}$' }), surface: Type.String({ minLength: 1, maxLength: 200 }), risk: Type.String({ minLength: 1, maxLength: 200, description: 'Grouping label for this claim; it is compared with the task risk and is never read as a severity or a ceiling.' }),
      closure: choices(CANDIDATE_CLOSURES),
      execution: choices(CANDIDATE_EXECUTIONS),
      proof: choices(CANDIDATE_PROOFS),
      evidenceRefs: Type.Array(Type.String({ maxLength: 80 }), { description: 'Owner-generated Evidence ID UUIDs from tool results, not invented labels or probe cell names' }),
      negativeControls: Type.Array(Type.String({ maxLength: 80 }), { description: 'Evidence ID UUIDs of commands containing the negative-control observations; describe individual control cells in limitations, not in this ID array' }),
      policyBasis: choices(POLICY_BASES),
      expectedPolicy: Type.String({ minLength: 1, maxLength: 1000, description: 'State the violated intended policy/invariant and its provenance; a sibling route difference alone is only inferred' }),
      limitations: Type.String({ minLength: 1, maxLength: 1500 }), control: Type.Optional(Type.String({ maxLength: 1000 })),
      resolves: Type.Optional(Type.Array(Type.String({ maxLength: 80 }))),
      requirement: Type.Optional(Type.String({ minLength: 10, maxLength: 1000, description: 'For blocked execution, describe the actual scope restriction, missing binary/dependency or failed prerequisite; not a capability ID' })), supersedes: Type.Optional(Type.String({ maxLength: 80 })), independentEvidenceRef: Type.Optional(Type.String({ maxLength: 80 })),
      gained: Type.Optional(Type.Array(capabilitySchema, { description: 'Typed capabilities this primitive hands to a later step, so the lead can join them to another step\'s needs' })),
      needs: Type.Optional(Type.Array(capabilitySchema, { description: 'Typed capabilities this primitive needs from an earlier step or the environment; omit when nothing outside the surface must hold' })),
      note: Type.Optional(Type.String({ maxLength: 300, description: 'Free text caveat about the capability pair; displayed, never matched' })),
      payloadRef: Type.Optional(Type.String({ maxLength: 80, description: 'Payload artifact ID from p2o_lab for the request, script or command that actually ran; requires tested execution, and the derived replayable flag follows it' })),
      leadRefs: Type.Optional(Type.Array(Type.String({ maxLength: 80 }), { description: 'P16.4: CVE lead record IDs from p2o_research action=cve. A lead can shape a hypothesis but never settle it: policyBasis must be inferred and closure open_proof_gap' })),
      environmentRef: Type.Optional(Type.String({ maxLength: 80, description: 'Environment artifact ID from p2o_lab for the recipe it was demonstrated in; requires tested execution, and replayable needs it as well as payloadRef' })),
    });

/** planning_update.md P14.2 + P14.3: one tool for the two replayable artifacts — the payload and the environment. */
export const LAB_ACTIONS = ['payload', 'env', 'verify', 'destroy'] as const;
export const labServiceSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 41, description: 'Plain service name; it also names the pid and log file' }),
  command: Type.String({ minLength: 1, maxLength: 4096, description: 'The process to start in the background; run from your own scratch' }),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: 'Port probed over HTTP loopback after launch' })),
  healthcheck: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: 'Shell command that must exit 0; preferred over a port probe for non-HTTP services' })),
  environment: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 512 }))),
}, { additionalProperties: false });

export const labParameters = Type.Object({
  action: choices(LAB_ACTIONS),
  kind: Type.Optional(choices(PAYLOAD_KINDS)),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: 'Payload label, or the environment name (lowercase slug) for action=env' })),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: PAYLOAD_BYTES, description: 'The exact bytes to keep: runnable as-is, stored verbatim and deliberately not redacted' })),
  id: Type.Optional(Type.String({ maxLength: 80, description: 'Payload or environment ID; stored bytes and the recipe hash are checked before use' })),
  materialize: Type.Optional(Type.Boolean({ description: 'action=payload with id: write the stored bytes into your own sandbox scratch at payload/<id> and return its path, sha256 and byte count instead of the body' })),
  compose: Type.Optional(Type.Boolean({ description: 'action=env only: deriving the recipe from docker-compose.yml|compose.yaml under /target needs planner/host authority and is refused for a worker, which must author setup/services/seed explicitly; refused keys are named' })),
  setup: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { description: 'Commands run in order before services; each must exit 0' })),
  services: Type.Optional(Type.Array(labServiceSchema)),
  seed: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { description: 'Commands run after services are healthy; each must exit 0' })),
}, { additionalProperties: false });

export const RESEARCH_LIMIT_SCHEMA = 5;
export const researchParameters = Type.Object({
  action: Type.Optional(choices(['technique', 'cve', 'triage', 'fetch'] as const)),
  query: Type.Optional(Type.String({ minLength: 1, maxLength: RESEARCH_QUERY_MAX, description: 'Technique words to look up, e.g. "ssrf cloud metadata" or "joomla 2.5 end of life support lifecycle"; write the question the way you would ask it' })),
  url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192, description: 'action=fetch: any http(s) URL to fetch host-side; the full body is returned with status, content type, byte count and sha256. No allowlist and no size cap.' })),
  web: Type.Optional(Type.Boolean({ description: 'Default true: also fetch the top hits\' cited source pages host-side and return quoted excerpts with a hash. Pass false for an offline-only lookup that never touches the network' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum hits, default 5; no upper bound' })),
  // P16.4: action=cve names a product/version and the host builds the NVD query; action=fetch takes any URL.
  product: Type.Optional(Type.String({ minLength: 2, maxLength: 120, description: 'action=cve: product name as published (e.g. "joomla", "nginx")' })),
  version: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'action=cve: version observed on the target, e.g. "2.5.0"' })),
  vendor: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: 'action=cve: vendor when it is known (e.g. "apache")' })),
  cpe: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'action=cve: optional CPE 2.3 name when recon recorded one (cpe:2.3:...)' })),
  assetRefs: Type.Optional(Type.Array(Type.Object({ id: Type.String({ pattern: '^asset-[a-f0-9]{24}$' }), revision: Type.Optional(Type.Integer({ minimum: 1 })) }), { description: 'action=cve: same-run assets whose version produced this query, so untriaged leads can be tied to scope' })),
  leadId: Type.Optional(Type.String({ maxLength: 80, description: 'action=triage: lead record ID from action=cve' })),
  state: Type.Optional(choices(['tasked', 'ruled_out'] as const)),
  reason: Type.Optional(Type.String({ minLength: 10, maxLength: 1000, description: 'action=triage: why the lead is tasked or ruled out (required for ruled_out)' })),
}, { additionalProperties: false });

export const captureParameters = Type.Object({path:Type.String({minLength:1,maxLength:2048}),offset:Type.Optional(Type.Integer({minimum:0})),timeout:Type.Optional(Type.Integer({minimum:0})),maxKiB:Type.Optional(Type.Integer({minimum:1,maximum:8192,description:"Cap this one capture at N KiB of stdout+stderr prefix; never above the run's capture setting (default 1 MiB)"}))});

/**
 * A7.3 (planning_update.md P7.4): the shell/network tools gain an interactive form. `session` names a run-owned session
 * (required for `send`/`read` and for an `exec` inside one); `send` is raw bytes to the session's PTY; `read` drains output
 * after the host-side cursor. Exactly one of command/send/read is an operation.
 */
export const execParameters = Type.Object({
  command: Type.Optional(Type.String({ minLength: 1, maxLength: 32 * 1024 })),
  timeout: Type.Optional(Type.Integer({ minimum: 0, description: 'Optional seconds; 0 or omitted means no task timeout. For send: how long to wait for output to settle, default 5s' })),
  session: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'Run in this open session instead of the run shell' })),
  send: Type.Optional(Type.String({ maxLength: 16 * 1024, description: 'Write these exact bytes to the session PTY (include newline yourself); returns output until it goes quiet or the timeout' })),
  read: Type.Optional(Type.Boolean({ description: 'Return PTY output since the host cursor for the session' })),
});

/** A7.2/A7.8: run-owned persistent sessions. `listen` is refused until an ingress path is configured (P7.7). */
export const sessionParameters = Type.Object({
  action: choices(['open','list','exec','listen','upload','download','snapshot','close'] as const),
  session: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]{0,63}$' })),
  command: Type.Optional(Type.String({ minLength: 1, maxLength: 32 * 1024, description: 'action=exec: one non-interactive command in the session container' })),
  purpose: Type.Optional(Type.String({ minLength: 3, maxLength: 200, description: 'action=open: one line naming what the session is for (recorded)' })),
  path: Type.Optional(Type.String({ minLength: 1, maxLength: 2048, description: 'action=upload/download: relative path inside the session scratch' })),
  content: Type.Optional(Type.String({ maxLength: 48 * 1024, description: 'action=upload: UTF-8 bytes to materialize (1..48 KiB)' })),
  port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  protocol: Type.Optional(choices(['tcp','udp'] as const)),
  timeout: Type.Optional(Type.Integer({ minimum: 0, description: 'action=exec: optional seconds; 0 or omitted means no task timeout' })),
}, { additionalProperties: false });

/** A7.4/P7.5: the identity surface is a list only. A value never crosses this tool, in either direction. */
export const secretParameters = Type.Object({
  action: choices(['list'] as const),
}, { additionalProperties: false });

export const httpParameters = Type.Object({
      url: Type.String({ minLength: 1, maxLength: 8 * 1024 }),
      method: Type.Optional(Type.String({ minLength: 1, maxLength: 32, pattern: HTTP_METHOD_PATTERN })),
      headers: Type.Optional(Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 8 * 1024 }))),
      body: Type.Optional(Type.String({ maxLength: 48 * 1024 })),
      followRedirects: Type.Optional(Type.Boolean()),
      maxRedirects: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
      session: Type.Optional(Type.String({ minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$' })),
      principal: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'A7.4: declared principal whose cookie jar this request belongs to (default "default"); a name, never a credential value' })),
      resetSession: Type.Optional(Type.Boolean()),
      timeout: Type.Optional(Type.Integer({minimum:0,description:'Optional per-hop seconds; 0 or omitted disables the task timeout'})),
      connectTimeout: Type.Optional(Type.Integer({minimum:0,description:'Optional connect seconds; 0 or omitted uses underlying network/library defaults'})),
    });

export const noteParameters = Type.Object({
      kind: choices(['note', 'coverage', 'observation', 'open']),
      text: Type.String({ minLength: 1, maxLength: 2000 }),
      surface: Type.Optional(Type.String({ maxLength: 200 })),
      risk: Type.Optional(Type.String({ maxLength: 200, description: 'Grouping label for this coverage row; not a severity, a ceiling or a limit on what may be attempted.' })),
      outcome: Type.Optional(choices(COVERAGE_OUTCOMES)),
      refs: Type.Optional(Type.Array(Type.String({ maxLength: 200 }))),
    });

export const artifactParameters = Type.Object({id:Type.String({minLength:45,maxLength:45,pattern:'^artifact-[a-f0-9-]{36}$'}),offset:Type.Optional(Type.Integer({minimum:0})),length:Type.Optional(Type.Integer({minimum:1,maximum:48*1024}))});

export const ledgerParameters = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), id: Type.Optional(Type.String({ maxLength: 80 })), cursor: Type.Optional(Type.Integer({ minimum:0 })) });

export const delegateParameters = Type.Object({
      focus: Type.String({ minLength: 3, maxLength: 60, description: 'Short label, e.g. "idor-checkout"' }),
      task: Type.String({ minLength: 1, maxLength: 4000, description: 'The objective: what to test/verify, success criteria and stop conditions' }),
      context: Type.Optional(Type.String({ maxLength: 4000, description: 'Background the worker must not re-derive: known facts, covered surfaces, record ids' })),
      role: Type.Optional(choices(ROLES)),
      skills: Type.Optional(Type.Array(Type.String({ maxLength: 64 }))),
      model: Type.Optional(Type.String({ maxLength: 200 })),
      workflow: Type.Optional(Type.String({ maxLength: 64, description: 'Optional catalog workflow ID belonging to the selected skills; descriptive prerequisites do not grant permissions' })),
      thinking: Type.Optional(choices(THINKING_LEVELS)),
      taskId:Type.Optional(Type.String({maxLength:80,description:'Owner-authored proposed task ID; prerequisites and reservations are checked. Worker requests cannot dispatch owner task IDs.'})),
      work:Type.Optional(Type.Object({},{additionalProperties:true,description:'Optional structured work identity exactly as in p2o_task_create (with decision and outputContract); enables exact duplicate/history checks. Omitted: identity is unknown.'})),
      decision:Type.Optional(Type.Object({},{additionalProperties:true})),outputContract:Type.Optional(Type.Object({},{additionalProperties:true})),
    });

export const subtaskParameters = Type.Object({focus:Type.String({minLength:3,maxLength:60}),task:Type.String({minLength:1,maxLength:4000}),context:Type.Optional(Type.String({maxLength:4000})),role:Type.Optional(choices(ROLES))});

export const loopParameters = Type.Object({action:choices(['status','wait','blocked','hint','constrain']),reason:Type.Optional(Type.String({minLength:1,maxLength:1000})),
  /** A7.9/D23: one bounded operator instruction recorded for the next planner round; constraints narrow absolutely, hints guide. */
  text:Type.Optional(Type.String({minLength:3,maxLength:300,description:'action hint/constrain: one sentence (3..300 characters) recorded append-only and rendered into the next planner prompt'})),
  /** M7: one condition-bounded revisit. With `notBefore`, reason must be `block-decay` or `cooldown-expiry` and the wait is scheduled, not budgeted. */
  notBefore:Type.Optional(Type.String({maxLength:40,description:'ISO timestamp for a condition-bounded revisit (reason block-decay|cooldown-expiry), within 24h'}))});

export const workersParameters = Type.Object({
      action: Type.Optional(choices(['list', 'steer', 'stop', 'continue'])),
      waitFor: Type.Optional(choices(['change', 'all-report'])),
      timeoutSeconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 300 })),
      cursor:Type.Optional(Type.Integer({minimum:0,description:'Prior ledger cursor for a bounded change page'})),
      workerId: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: 'Required for action steer/stop' })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Required for action steer' })),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: 'Required for action stop' })),
      brief: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: 'Required for action continue: the same ticket, a different approach' })),
    });

export const reportParameters = Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      findings: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }))),
      evidence: Type.Optional(Type.Array(Type.String({ maxLength: 500 }))),
      coverage: Type.Optional(Type.Array(Type.Object({ surface: Type.String({ maxLength: 200 }), risk: Type.String({ maxLength: 200, description: 'Grouping label for this covered surface; not a severity or a limit.' }), outcome: choices(COVERAGE_OUTCOMES) }))),
      openItems: Type.Optional(Type.Array(Type.String({ maxLength: 1000 }))),
      confidence: choices(['high', 'medium', 'low']),
      blocked: Type.Optional(Type.String({ maxLength: 1000 })),
      outcome:Type.Optional(choices(WORKER_OUTCOMES)),
      holdFor: Type.Optional(Type.Object({ brief: Type.String({ minLength: 3, maxLength: 300, description: 'One sentence naming the successor step that continues this exact work' }) },
        { description: 'A7.5: keep this worker\'s ticket, pane and session alive for follow-up continuations with this brief; the count is holdContinuations' })),
      holdContinuations: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: 'P10/WF-11: how many follow-up briefs this hold authorizes (default 1); 0 names the successor in the report but retires the ticket, pane and session' })),
    });

export const finishParameters = Type.Object({
  narrative: Type.Optional(Type.String({ maxLength: 6000 })),
  /** M3: exporting the report is not termination. `export:true` writes the files and ends nothing. */
  export: Type.Optional(Type.Boolean({ description: 'Write REPORT.md/CSV from committed state and end nothing; workers, sandboxes and the run stay as they are' })),
  /** A6.6/D9: the final finish of an incomplete campaign records a partial stop with this operator-facing reason. */
  partial: Type.Optional(Type.String({ maxLength: 600, description: 'Final path only: why this campaign stops incomplete (required when the derived completion is incomplete and a campaign was recorded). Recorded as campaign.partial; it never claims coverage' })),
});
