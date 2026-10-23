/**
 * CVSS v4.0 base score (planning_update.md P14.9).
 *
 * The lookup tables and the interpolation steps are a direct port of FIRST's reference implementation
 * (github.com/FIRSTdotorg/cvss-v4-calculator, "Copyright FIRST, Red Hat, and contributors", BSD-2-Clause); the repository keeps
 * that attribution here because a hand-written CVSS table would be a guess. Only base metrics are scored: this project has no
 * threat or environmental input, so `E` defaults to `A` and `CR`/`IR`/`AR` to `H` exactly as the specification's default path
 * requires, and no modified metric exists.
 *
 * A score is never a judgement about a target here: it is what the recorded vector evaluates to. `severityOf` maps the score to
 * the specification's qualitative rating bands and nothing else.
 */
export type Cvss4Severity = 'none' | 'low' | 'medium' | 'high' | 'critical';
export interface Cvss4Result { vector: string; score: number; severity: Cvss4Severity; macrovector: string }

/** Base metric order and the values each accepts, from the specification's Base metric group. */
export const CVSS4_BASE_METRICS = {
  AV: ['N', 'A', 'L', 'P'], AC: ['L', 'H'], AT: ['N', 'P'], PR: ['N', 'L', 'H'], UI: ['N', 'P', 'A'],
  VC: ['H', 'L', 'N'], VI: ['H', 'L', 'N'], VA: ['H', 'L', 'N'], SC: ['H', 'L', 'N'], SI: ['H', 'L', 'N'], SA: ['H', 'L', 'N'],
} as const;
export type Cvss4Metric = keyof typeof CVSS4_BASE_METRICS;
export type Cvss4Base = Record<Cvss4Metric, string>;
const METRIC_ORDER = Object.keys(CVSS4_BASE_METRICS) as Cvss4Metric[];

/** MacroVector -> base score of its highest-severity vector (FIRST lookup table, 270 entries). */
const CVSS4_LOOKUP: Readonly<Record<string, number>> = {
  "000000": 10,
  "000001": 9.9,
  "000010": 9.8,
  "000011": 9.5,
  "000020": 9.5,
  "000021": 9.2,
  "000100": 10,
  "000101": 9.6,
  "000110": 9.3,
  "000111": 8.7,
  "000120": 9.1,
  "000121": 8.1,
  "000200": 9.3,
  "000201": 9,
  "000210": 8.9,
  "000211": 8,
  "000220": 8.1,
  "000221": 6.8,
  "001000": 9.8,
  "001001": 9.5,
  "001010": 9.5,
  "001011": 9.2,
  "001020": 9,
  "001021": 8.4,
  "001100": 9.3,
  "001101": 9.2,
  "001110": 8.9,
  "001111": 8.1,
  "001120": 8.1,
  "001121": 6.5,
  "001200": 8.8,
  "001201": 8,
  "001210": 7.8,
  "001211": 7,
  "001220": 6.9,
  "001221": 4.8,
  "002001": 9.2,
  "002011": 8.2,
  "002021": 7.2,
  "002101": 7.9,
  "002111": 6.9,
  "002121": 5,
  "002201": 6.9,
  "002211": 5.5,
  "002221": 2.7,
  "010000": 9.9,
  "010001": 9.7,
  "010010": 9.5,
  "010011": 9.2,
  "010020": 9.2,
  "010021": 8.5,
  "010100": 9.5,
  "010101": 9.1,
  "010110": 9,
  "010111": 8.3,
  "010120": 8.4,
  "010121": 7.1,
  "010200": 9.2,
  "010201": 8.1,
  "010210": 8.2,
  "010211": 7.1,
  "010220": 7.2,
  "010221": 5.3,
  "011000": 9.5,
  "011001": 9.3,
  "011010": 9.2,
  "011011": 8.5,
  "011020": 8.5,
  "011021": 7.3,
  "011100": 9.2,
  "011101": 8.2,
  "011110": 8,
  "011111": 7.2,
  "011120": 7,
  "011121": 5.9,
  "011200": 8.4,
  "011201": 7,
  "011210": 7.1,
  "011211": 5.2,
  "011220": 5,
  "011221": 3,
  "012001": 8.6,
  "012011": 7.5,
  "012021": 5.2,
  "012101": 7.1,
  "012111": 5.2,
  "012121": 2.9,
  "012201": 6.3,
  "012211": 2.9,
  "012221": 1.7,
  "100000": 9.8,
  "100001": 9.5,
  "100010": 9.4,
  "100011": 8.7,
  "100020": 9.1,
  "100021": 8.1,
  "100100": 9.4,
  "100101": 8.9,
  "100110": 8.6,
  "100111": 7.4,
  "100120": 7.7,
  "100121": 6.4,
  "100200": 8.7,
  "100201": 7.5,
  "100210": 7.4,
  "100211": 6.3,
  "100220": 6.3,
  "100221": 4.9,
  "101000": 9.4,
  "101001": 8.9,
  "101010": 8.8,
  "101011": 7.7,
  "101020": 7.6,
  "101021": 6.7,
  "101100": 8.6,
  "101101": 7.6,
  "101110": 7.4,
  "101111": 5.8,
  "101120": 5.9,
  "101121": 5,
  "101200": 7.2,
  "101201": 5.7,
  "101210": 5.7,
  "101211": 5.2,
  "101220": 5.2,
  "101221": 2.5,
  "102001": 8.3,
  "102011": 7,
  "102021": 5.4,
  "102101": 6.5,
  "102111": 5.8,
  "102121": 2.6,
  "102201": 5.3,
  "102211": 2.1,
  "102221": 1.3,
  "110000": 9.5,
  "110001": 9,
  "110010": 8.8,
  "110011": 7.6,
  "110020": 7.6,
  "110021": 7,
  "110100": 9,
  "110101": 7.7,
  "110110": 7.5,
  "110111": 6.2,
  "110120": 6.1,
  "110121": 5.3,
  "110200": 7.7,
  "110201": 6.6,
  "110210": 6.8,
  "110211": 5.9,
  "110220": 5.2,
  "110221": 3,
  "111000": 8.9,
  "111001": 7.8,
  "111010": 7.6,
  "111011": 6.7,
  "111020": 6.2,
  "111021": 5.8,
  "111100": 7.4,
  "111101": 5.9,
  "111110": 5.7,
  "111111": 5.7,
  "111120": 4.7,
  "111121": 2.3,
  "111200": 6.1,
  "111201": 5.2,
  "111210": 5.7,
  "111211": 2.9,
  "111220": 2.4,
  "111221": 1.6,
  "112001": 7.1,
  "112011": 5.9,
  "112021": 3,
  "112101": 5.8,
  "112111": 2.6,
  "112121": 1.5,
  "112201": 2.3,
  "112211": 1.3,
  "112221": 0.6,
  "200000": 9.3,
  "200001": 8.7,
  "200010": 8.6,
  "200011": 7.2,
  "200020": 7.5,
  "200021": 5.8,
  "200100": 8.6,
  "200101": 7.4,
  "200110": 7.4,
  "200111": 6.1,
  "200120": 5.6,
  "200121": 3.4,
  "200200": 7,
  "200201": 5.4,
  "200210": 5.2,
  "200211": 4,
  "200220": 4,
  "200221": 2.2,
  "201000": 8.5,
  "201001": 7.5,
  "201010": 7.4,
  "201011": 5.5,
  "201020": 6.2,
  "201021": 5.1,
  "201100": 7.2,
  "201101": 5.7,
  "201110": 5.5,
  "201111": 4.1,
  "201120": 4.6,
  "201121": 1.9,
  "201200": 5.3,
  "201201": 3.6,
  "201210": 3.4,
  "201211": 1.9,
  "201220": 1.9,
  "201221": 0.8,
  "202001": 6.4,
  "202011": 5.1,
  "202021": 2,
  "202101": 4.7,
  "202111": 2.1,
  "202121": 1.1,
  "202201": 2.4,
  "202211": 0.9,
  "202221": 0.4,
  "210000": 8.8,
  "210001": 7.5,
  "210010": 7.3,
  "210011": 5.3,
  "210020": 6,
  "210021": 5,
  "210100": 7.3,
  "210101": 5.5,
  "210110": 5.9,
  "210111": 4,
  "210120": 4.1,
  "210121": 2,
  "210200": 5.4,
  "210201": 4.3,
  "210210": 4.5,
  "210211": 2.2,
  "210220": 2,
  "210221": 1.1,
  "211000": 7.5,
  "211001": 5.5,
  "211010": 5.8,
  "211011": 4.5,
  "211020": 4,
  "211021": 2.1,
  "211100": 6.1,
  "211101": 5.1,
  "211110": 4.8,
  "211111": 1.8,
  "211120": 2,
  "211121": 0.9,
  "211200": 4.6,
  "211201": 1.8,
  "211210": 1.7,
  "211211": 0.7,
  "211220": 0.8,
  "211221": 0.2,
  "212001": 5.3,
  "212011": 2.4,
  "212021": 1.4,
  "212101": 2.4,
  "212111": 1.2,
  "212121": 0.5,
  "212201": 1,
  "212211": 0.3,
  "212221": 0.1
};

/** Depth of each equivalence class in severity steps (FIRST max_severity.js). */
const CVSS4_MAX_SEVERITY = {
  "eq1": {
    "0": 1,
    "1": 4,
    "2": 5
  },
  "eq2": {
    "0": 1,
    "1": 2
  },
  "eq3eq6": {
    "0": {
      "0": 7,
      "1": 6
    },
    "1": {
      "0": 8,
      "1": 8
    },
    "2": {
      "1": 10
    }
  },
  "eq4": {
    "0": 6,
    "1": 5,
    "2": 4
  },
  "eq5": {
    "0": 1,
    "1": 1,
    "2": 1
  }
} as const;

/** Highest-severity metric combination per EQ level (FIRST max_composed.js). */
type LevelMap = Readonly<Record<string, readonly string[]>>;
const CVSS4_MAX_COMPOSED: { eq1: LevelMap; eq2: LevelMap; eq3: Readonly<Record<string, LevelMap>>; eq4: LevelMap; eq5: LevelMap } = {
  "eq1": {
    "0": ["AV:N/PR:N/UI:N/"],
    "1": ["AV:A/PR:N/UI:N/", "AV:N/PR:L/UI:N/", "AV:N/PR:N/UI:P/"],
    "2": ["AV:P/PR:N/UI:N/", "AV:A/PR:L/UI:P/"]
  },
  "eq2": {
    "0": ["AC:L/AT:N/"],
    "1": ["AC:H/AT:N/", "AC:L/AT:P/"]
  },
  "eq3": {
    "0": {
      "0": ["VC:H/VI:H/VA:H/CR:H/IR:H/AR:H/"],
      "1": ["VC:H/VI:H/VA:L/CR:M/IR:M/AR:H/", "VC:H/VI:H/VA:H/CR:M/IR:M/AR:M/"]
    },
    "1": {
      "0": ["VC:L/VI:H/VA:H/CR:H/IR:H/AR:H/", "VC:H/VI:L/VA:H/CR:H/IR:H/AR:H/"],
      "1": ["VC:L/VI:H/VA:L/CR:H/IR:M/AR:H/", "VC:L/VI:H/VA:H/CR:H/IR:M/AR:M/", "VC:H/VI:L/VA:H/CR:M/IR:H/AR:M/", "VC:H/VI:L/VA:L/CR:M/IR:H/AR:H/", "VC:L/VI:L/VA:H/CR:H/IR:H/AR:M/"]
    },
    "2": {
      "1": ["VC:L/VI:L/VA:L/CR:H/IR:H/AR:H/"]
    }
  },
  "eq4": {
    "0": ["SC:H/SI:S/SA:S/"],
    "1": ["SC:H/SI:H/SA:H/"],
    "2": ["SC:L/SI:L/SA:L/"]
  },
  "eq5": {
    "0": ["E:A/"],
    "1": ["E:P/"],
    "2": ["E:U/"]
  }
};


/** Spec severity order per metric: the leftmost value is the most severe. */
const LEVELS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  AV: { N: 0, A: 0.1, L: 0.2, P: 0.3 }, PR: { N: 0, L: 0.1, H: 0.2 }, UI: { N: 0, P: 0.1, A: 0.2 },
  AC: { L: 0, H: 0.1 }, AT: { N: 0, P: 0.1 },
  VC: { H: 0, L: 0.1, N: 0.2 }, VI: { H: 0, L: 0.1, N: 0.2 }, VA: { H: 0, L: 0.1, N: 0.2 },
  SC: { H: 0.1, L: 0.2, N: 0.3 }, SI: { S: 0, H: 0.1, L: 0.2, N: 0.3 }, SA: { S: 0, H: 0.1, L: 0.2, N: 0.3 },
  CR: { H: 0, M: 0.1, L: 0.2 }, IR: { H: 0, M: 0.1, L: 0.2 }, AR: { H: 0, M: 0.1, L: 0.2 },
};
/** Defaults the specification defines when a metric is absent: E:A, CR:H, IR:H, AR:H. */
const DEFAULTS = { E: 'A', CR: 'H', IR: 'H', AR: 'H' } as const;

/** Parse a base-only CVSS:4.0 vector. Every base metric is required exactly once; nothing else is accepted. */
export function parseCvss4(vector: string): Cvss4Base {
  if (typeof vector !== 'string' || !vector) throw Error('CVSS 4.0 vector is required');
  const body = vector.startsWith('CVSS:4.0/') ? vector.slice('CVSS:4.0/'.length) : vector;
  const base: Record<string, string> = {};
  for (const part of body.split('/')) {
    const [metric, value, ...rest] = part.split(':');
    if (rest.length) throw Error(`CVSS 4.0 metric ${metric} has an unexpected value`);
    if (!METRIC_ORDER.includes(metric as Cvss4Metric)) throw Error(`CVSS 4.0 base vector has no metric ${metric}; only ${METRIC_ORDER.join('/')} are scored here`);
    if (metric in base) throw Error(`CVSS 4.0 metric ${metric} appears twice`);
    if (!(CVSS4_BASE_METRICS[metric as Cvss4Metric] as readonly string[]).includes(value)) throw Error(`CVSS 4.0 metric ${metric} does not accept ${value}`);
    base[metric] = value;
  }
  for (const metric of METRIC_ORDER) if (!(metric in base)) throw Error(`CVSS 4.0 base vector is missing ${metric}`);
  return base as Cvss4Base;
}

/** The canonical vector text, in specification order. */
export const cvss4Vector = (base: Cvss4Base) => `CVSS:4.0/${METRIC_ORDER.map(metric => `${metric}:${base[metric]}`).join('/')}`;

const m = (base: Cvss4Base, metric: string): string => DEFAULTS[metric as keyof typeof DEFAULTS] ?? base[metric as Cvss4Metric];

/** The macrovector (equivalence class) the base metrics belong to, per the specification's six EQs. */
export function cvss4MacroVector(base: Cvss4Base): string {
  const av = m(base, 'AV'), pr = m(base, 'PR'), ui = m(base, 'UI');
  const eq1 = av === 'N' && pr === 'N' && ui === 'N' ? '0'
    : (av === 'N' || pr === 'N' || ui === 'N') && !(av === 'N' && pr === 'N' && ui === 'N') && av !== 'P' ? '1' : '2';
  const eq2 = m(base, 'AC') === 'L' && m(base, 'AT') === 'N' ? '0' : '1';
  const vc = m(base, 'VC'), vi = m(base, 'VI'), va = m(base, 'VA');
  const eq3 = vc === 'H' && vi === 'H' ? '0' : vc === 'H' || vi === 'H' || va === 'H' ? '1' : '2';
  const sc = m(base, 'SC'), si = m(base, 'SI'), sa = m(base, 'SA');
  const eq4 = sc === 'H' || si === 'H' || sa === 'H' ? '1' : '2';
  const eq5 = m(base, 'E') === 'A' ? '0' : m(base, 'E') === 'P' ? '1' : '2';
  const eq6 = (m(base, 'CR') === 'H' && vc === 'H') || (m(base, 'IR') === 'H' && vi === 'H') || (m(base, 'AR') === 'H' && va === 'H') ? '0' : '1';
  return `${eq1}${eq2}${eq3}${eq4}${eq5}${eq6}`;
}

const maxesFor = (macroVector: string, eq: number): readonly string[] => {
  const all = CVSS4_MAX_COMPOSED as unknown as Record<string, LevelMap | Record<string, LevelMap>>;
  const level = macroVector[eq - 1];
  const entry = all[`eq${eq}`] as LevelMap | Record<string, LevelMap>;
  if (eq === 3) {
    const nested = entry as Record<string, LevelMap>;
    return nested[level]?.[macroVector[5]] ?? [];
  }
  return (entry as LevelMap)[level] ?? [];
};
const metricValue = (text: string, metric: string): string => {
  const start = text.indexOf(`${metric}:`);
  if (start < 0) throw Error(`Highest-severity vector is missing ${metric}`);
  const rest = text.slice(start + metric.length + 1);
  const end = rest.indexOf('/');
  return end < 0 ? rest : rest.slice(0, end);
};

/** Score a base vector the way FIRST's reference implementation does, including the interpolation between macrovectors. */
export function cvss4Score(vector: string): Cvss4Result {
  const base = parseCvss4(vector);
  const selected: Record<string, string> = { ...base, E: 'A', CR: 'H', IR: 'H', AR: 'H' };
  const macrovector = cvss4MacroVector(base);
  const scoreOf = (key: string) => CVSS4_LOOKUP[key];
  if (['VC', 'VI', 'VA', 'SC', 'SI', 'SA'].every(metric => base[metric as Cvss4Metric] === 'N')) return { vector: cvss4Vector(base), score: 0, severity: 'none', macrovector };
  let value = scoreOf(macrovector);
  if (typeof value !== 'number') throw Error(`CVSS 4.0 macrovector ${macrovector} is not in the lookup table`);
  const eq = macrovector.split('').map(Number);
  const lower = (index: number, delta: number) => macrovector.slice(0, index) + String(eq[index] + delta) + macrovector.slice(index + 1);
  const next: (string | undefined)[] = [lower(0, 1), lower(1, 1), undefined, lower(3, 1), lower(4, 1)];
  const [eq3, eq6] = [eq[2], eq[5]];
  if (eq3 === 1 && eq6 === 1) next[2] = `${eq[0]}${eq[1]}2${eq[3]}${eq[4]}${eq[5]}`;
  else if (eq3 === 0 && eq6 === 1) next[2] = lower(2, 1);
  else if (eq3 === 1 && eq6 === 0) next[2] = lower(5, 1);
  else if (eq3 === 0 && eq6 === 0) {
    const left = scoreOf(lower(5, 1)), right = scoreOf(lower(2, 1));
    next[2] = (left ?? Number.NaN) > (right ?? Number.NaN) ? lower(5, 1) : lower(2, 1);
  } else next[2] = `${eq[0]}${eq[1]}${eq[2] + 1}${eq[3]}${eq[4]}${eq[5] + 1}`;

  const distance = [0, 0, 0, 0, 0];
  const maxVectors: string[] = [];
  for (const one of maxesFor(macrovector, 1)) for (const two of maxesFor(macrovector, 2))
    for (const three of maxesFor(macrovector, 3)) for (const four of maxesFor(macrovector, 4))
      for (const five of maxesFor(macrovector, 5)) maxVectors.push(`${one}${two}${three}${four}${five}`);
  let chosen: string | undefined;
  for (const candidate of maxVectors) {
    const gaps: number[] = [];
    const add = (metric: string) => gaps.push((LEVELS[metric][selected[metric]] ?? Number.NaN) - (LEVELS[metric][metricValue(candidate, metric)] ?? Number.NaN));
    for (const metric of ['AV', 'PR', 'UI', 'AC', 'AT', 'VC', 'VI', 'VA', 'SC', 'SI', 'SA', 'CR', 'IR', 'AR']) add(metric);
    if (gaps.some(gap => gap < 0)) continue;
    chosen = candidate;
    distance[0] = gaps[0] + gaps[1] + gaps[2];
    distance[1] = gaps[3] + gaps[4];
    distance[2] = gaps[5] + gaps[6] + gaps[7] + gaps[11] + gaps[12] + gaps[13];
    distance[3] = gaps[8] + gaps[9] + gaps[10];
    break;
  }
  if (!chosen) throw Error('CVSS 4.0 highest-severity vector could not be matched');
  const eq3eq6Depth = CVSS4_MAX_SEVERITY.eq3eq6 as unknown as Readonly<Record<string, Readonly<Record<string, number>>>>;
  // EQ5's own proportion is always zero, but a macrovector below it still counts towards the mean — that is the
  // specification's denominator, and dropping it moves scores by a tenth.
  const depth = [CVSS4_MAX_SEVERITY.eq1[eq[0] as 0 | 1 | 2], CVSS4_MAX_SEVERITY.eq2[eq[1] as 0 | 1], eq3eq6Depth[String(eq[2])][String(eq[5])], CVSS4_MAX_SEVERITY.eq4[eq[3] as 0 | 1 | 2], 0];
  let total = 0, existing = 0;
  for (const index of [0, 1, 2, 3, 4]) {
    const available = typeof next[index] === 'string' ? value - (scoreOf(next[index]!) ?? Number.NaN) : Number.NaN;
    if (Number.isNaN(available)) continue;
    existing += 1;
    const max = depth[index] * 0.1;
    total += max ? available * (distance[index] / max) : 0;
  }
  if (existing) value -= total / existing;
  value = Math.max(0, Math.min(10, value));
  const score = Math.round(value * 10) / 10;
  return { vector: cvss4Vector(base), score, severity: severityOf(score), macrovector };
}

/** The specification's qualitative rating bands, applied to a computed score and nothing else. */
export function severityOf(score: number): Cvss4Severity {
  if (!Number.isFinite(score) || score <= 0) return 'none';
  if (score < 4) return 'low';
  if (score < 7) return 'medium';
  if (score < 9) return 'high';
  return 'critical';
}
