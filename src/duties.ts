import { WORK_PURPOSES } from './work.js';

/**
 * Purpose is what a worker is for. Role picks a model and a tool set; purpose decides what counts as done and what the
 * worker may not produce. The lead supplies it as `work.purpose`; when it does not, it is derived from the role so every
 * worker still gets one line naming its job.
 */
export type WorkPurpose = typeof WORK_PURPOSES[number];

export interface Duty {
  /** What this worker does, in one sentence. */
  duty: string;
  /** The failure this purpose exists to prevent. */
  forbids: string;
  /** What a report from this purpose must contain to count as finished. */
  produces: string;
}

export const DUTIES: Readonly<Record<WorkPurpose, Duty>> = {
  mapping: {
    duty: 'Map the reachable surface and its trust boundaries; produce assets, anchors and labelled unknowns, not vulnerability claims.',
    forbids: 'turning an unexamined surface into a finding',
    produces: 'assets, anchors, labelled unknowns',
  },
  discovery: {
    duty: 'Turn one mapped surface into a falsifiable hypothesis and try to break it; produce candidates with closure, proof level and policy basis.',
    forbids: 'reporting a hypothesis as a confirmed effect',
    produces: 'candidates with closure, proof level, policy basis',
  },
  investigation: {
    duty: 'Given someone else\u2019s concrete anomaly, find the root cause and the smallest trigger; produce the fact plus the invariant it establishes.',
    forbids: 'stopping at the symptom the brief already names',
    produces: 'the root-cause fact and the invariant it establishes',
  },
  refinement: {
    duty: 'Tighten a claim another worker left open or noisy; produce the narrower claim or the negative control that kills it.',
    forbids: 're-running the same test expecting a different answer',
    produces: 'a narrower claim, or the negative control that rules it out',
  },
  validation: {
    duty: 'Reproduce another worker\u2019s claim from its own evidence with a negative control and an independent receipt; produce a confirmed or ruled-out closure, never a new discovery.',
    forbids: 'new discovery, or trusting the author\u2019s own receipt',
    produces: 'confirmed or ruled-out closure with an independent receipt',
  },
  retest: {
    duty: 'Re-run the stated reproduction against the changed revision; produce the same-or-different verdict with receipts.',
    forbids: 're-rating on the old revision\u2019s evidence',
    produces: 'the same-or-different verdict with receipts',
  },
  exploitation: {
    duty: 'Take a confirmed primitive to a demonstrated effect; produce the payload, the environment and the observation, or the exact wall.',
    forbids: 'reporting an effect the primitive did not demonstrate',
    produces: 'a stored payload, a verified environment and the observed effect \u2014 or the exact wall',
  },
  chaining: {
    duty: 'Compose two demonstrated primitives into an effect neither reaches alone; produce the link and the proof the composition ran.',
    forbids: 'assuming two primitives compose because they look adjacent',
    produces: 'the link, the observed combined effect and the step where it stopped',
  },
  reporting: {
    // planning_update.md A1: the reporter is a read-only second reader. Missing evidence is a limitation to report, not a
    // reason to run a new probe; the worker that owns execution writes the evidence.
    duty: 'Read the accepted case, its evidence, traces and artifacts; write a reader-ready report without running target work or creating a claim.',
    forbids: 'new target work, a new claim or changing a case verdict',
    produces: 'a reader-ready report over accepted cases, with missing evidence named as a limitation',
  },
};

/** A role on its own still implies a purpose; the lead can override it with `work.purpose`. */
export function purposeFromRole(role: string): WorkPurpose {
  switch (role) {
    case 'recon': return 'mapping';
    case 'discovery': return 'discovery';
    case 'validation': return 'validation';
    case 'reporting': return 'reporting';
    // P14.4: an exploit worker's job is the effect, not the root cause; `general` still means investigation.
    case 'exploit': return 'exploitation';
    default: return 'investigation';
  }
}

export function isWorkPurpose(value: unknown): value is WorkPurpose {
  return typeof value === 'string' && (WORK_PURPOSES as readonly string[]).includes(value);
}

/** The one line a worker reads about its own job. */
export function dutyLine(purpose: WorkPurpose): string {
  const entry = DUTIES[purpose];
  return `Your duty (${purpose}): ${entry.duty} Forbidden: ${entry.forbids}. Expected output: ${entry.produces}.`;
}
