import { WSTG_MAP, isWstgKey, wstgKey } from './wstg-map.js';

/**
 * MITRE ATT&CK Enterprise crosswalk. Curated data and three pure helpers only: no new state, no new field, no tool.
 *
 * This is a SUBSET of the ATT&CK Enterprise matrix, not the matrix: 59 techniques chosen because a web/infrastructure/AD/cloud
 * pentest can meet them, pinned to the v18.1 release (data read 2026-10-28). ATT&CK assigns several tactics to many techniques;
 * `tactic` keeps the one used to order the catalog, so this file never claims to reproduce the full tactic membership.
 *
 * A WSTG key is already the `questionKey` of work identities and coverage cells (see src/wstg-map.ts), so a technique is derived
 * from the keys a case already carries: no model-writable field, no duplicated WSTG list. The crosswalk is a judgement about the
 * behaviour a test exercises or looks for, not a claim that p2o detects that behaviour; docs/ATTACK_MAP.md states the limits.
 */
export const ATTACK_SOURCE = 'https://attack.mitre.org/';
export const ATTACK_VERSION = 'v18.1';

/** Enterprise tactics in kill-chain (matrix) order. Resource Development has no row in the curated subset. */
export const ATTACK_TACTICS = [
  'reconnaissance',
  'resource-development',
  'initial-access',
  'execution',
  'persistence',
  'privilege-escalation',
  'defense-evasion',
  'credential-access',
  'discovery',
  'lateral-movement',
  'collection',
  'command-and-control',
  'exfiltration',
  'impact',
] as const;

export interface AttackTechnique {
  id: string;
  name: string;
  tactic: string;
  url: string;
}

type Row = readonly [id: string, name: string, tactic: string];

/** Names are the v18.1 Enterprise names; a sub-technique keeps the `Parent: Sub` form the site prints. */
const ROWS: readonly Row[] = [
  ['T1595', 'Active Scanning', 'reconnaissance'],
  ['T1592', 'Gather Victim Host Information', 'reconnaissance'],
  ['T1590', 'Gather Victim Network Information', 'reconnaissance'],
  ['T1190', 'Exploit Public-Facing Application', 'initial-access'],
  ['T1133', 'External Remote Services', 'initial-access'],
  ['T1566', 'Phishing', 'initial-access'],
  ['T1189', 'Drive-by Compromise', 'initial-access'],
  ['T1078', 'Valid Accounts', 'initial-access'],
  ['T1078.004', 'Valid Accounts: Cloud Accounts', 'initial-access'],
  ['T1059', 'Command and Scripting Interpreter', 'execution'],
  ['T1059.007', 'Command and Scripting Interpreter: JavaScript', 'execution'],
  ['T1204', 'User Execution', 'execution'],
  ['T1203', 'Exploitation for Client Execution', 'execution'],
  ['T1053', 'Scheduled Task/Job', 'execution'],
  ['T1547', 'Boot or Logon Autostart Execution', 'persistence'],
  ['T1505', 'Server Software Component', 'persistence'],
  ['T1136', 'Create Account', 'persistence'],
  ['T1098', 'Account Manipulation', 'persistence'],
  ['T1548', 'Abuse Elevation Control Mechanism', 'privilege-escalation'],
  ['T1068', 'Exploitation for Privilege Escalation', 'privilege-escalation'],
  ['T1055', 'Process Injection', 'privilege-escalation'],
  ['T1070', 'Indicator Removal', 'defense-evasion'],
  ['T1562', 'Impair Defenses', 'defense-evasion'],
  ['T1110', 'Brute Force', 'credential-access'],
  ['T1003', 'OS Credential Dumping', 'credential-access'],
  ['T1552', 'Unsecured Credentials', 'credential-access'],
  ['T1555', 'Credentials from Password Stores', 'credential-access'],
  ['T1539', 'Steal Web Session Cookie', 'credential-access'],
  ['T1528', 'Steal Application Access Token', 'credential-access'],
  ['T1557', 'Adversary-in-the-Middle', 'credential-access'],
  ['T1556.006', 'Modify Authentication Process: Multi-Factor Authentication', 'credential-access'],
  ['T1087', 'Account Discovery', 'discovery'],
  ['T1046', 'Network Service Discovery', 'discovery'],
  ['T1018', 'Remote System Discovery', 'discovery'],
  ['T1049', 'System Network Connections Discovery', 'discovery'],
  ['T1016', 'System Network Configuration Discovery', 'discovery'],
  ['T1082', 'System Information Discovery', 'discovery'],
  ['T1083', 'File and Directory Discovery', 'discovery'],
  ['T1526', 'Cloud Service Discovery', 'discovery'],
  ['T1619', 'Cloud Storage Object Discovery', 'discovery'],
  ['T1021', 'Remote Services', 'lateral-movement'],
  ['T1021.001', 'Remote Services: Remote Desktop Protocol', 'lateral-movement'],
  ['T1021.002', 'Remote Services: SMB/Windows Admin Shares', 'lateral-movement'],
  ['T1021.004', 'Remote Services: SSH', 'lateral-movement'],
  ['T1550', 'Use Alternate Authentication Material', 'lateral-movement'],
  ['T1210', 'Exploitation of Remote Services', 'lateral-movement'],
  ['T1005', 'Data from Local System', 'collection'],
  ['T1213', 'Data from Information Repositories', 'collection'],
  ['T1530', 'Data from Cloud Storage', 'collection'],
  ['T1071', 'Application Layer Protocol', 'command-and-control'],
  ['T1572', 'Protocol Tunneling', 'command-and-control'],
  ['T1090', 'Proxy', 'command-and-control'],
  ['T1041', 'Exfiltration Over C2 Channel', 'exfiltration'],
  ['T1048', 'Exfiltration Over Alternative Protocol', 'exfiltration'],
  ['T1567', 'Exfiltration Over Web Service', 'exfiltration'],
  ['T1485', 'Data Destruction', 'impact'],
  ['T1565', 'Data Manipulation', 'impact'],
  ['T1499', 'Endpoint Denial of Service', 'impact'],
  ['T1531', 'Account Access Removal', 'impact'],
];

/** ATT&CK prints a sub-technique as `<parent>/<sub>/`; the dotted id stays the key. */
const attackUrl = (id: string): string => `https://attack.mitre.org/techniques/${id.split('.').join('/')}/`;

export const ATTACK_TECHNIQUES: readonly AttackTechnique[] = ROWS.map(([id, name, tactic]) => ({ id, name, tactic, url: attackUrl(id) }));

const TACTIC_ORDER = new Map<string, number>(ATTACK_TACTICS.map((tactic, index): [string, number] => [tactic, index]));
const TECHNIQUES_BY_ID = new Map<string, AttackTechnique>();
for (const technique of ATTACK_TECHNIQUES) {
  if (TECHNIQUES_BY_ID.has(technique.id)) throw new Error(`ATTACK_TECHNIQUES repeats ${technique.id}`);
  if (!TACTIC_ORDER.has(technique.tactic)) throw new Error(`${technique.id} uses unknown tactic ${technique.tactic}`);
  TECHNIQUES_BY_ID.set(technique.id, technique);
}

type CrosswalkRow = readonly [key: string, techniques: readonly string[]];

/**
 * One row per in-scope WSTG test (support is not 'O'), keyed by the lower-case `wstgKey` used as `questionKey`.
 * The list follows WSTG_MAP order. Each row names 1-3 techniques whose behaviour the test exercises or looks for; a row is a
 * judgement, not an ATT&CK statement, and the out-of-scope tests are deliberately absent. The module refuses to load when a key
 * does not belong to an in-scope WSTG test or when a technique id is missing, so data and library cannot drift silently.
 */
const CROSSWALK: readonly CrosswalkRow[] = [
  ['wstg-info-02', ['T1592', 'T1595']],
  ['wstg-info-03', ['T1592', 'T1083']],
  ['wstg-info-04', ['T1595', 'T1590']],
  ['wstg-info-05', ['T1592', 'T1083']],
  ['wstg-info-06', ['T1595', 'T1083']],
  ['wstg-info-07', ['T1083', 'T1595']],
  ['wstg-info-08', ['T1592', 'T1595']],
  ['wstg-info-10', ['T1590', 'T1592']],
  ['wstg-conf-02', ['T1592', 'T1190']],
  ['wstg-conf-04', ['T1083', 'T1552']],
  ['wstg-conf-05', ['T1083', 'T1133']],
  ['wstg-conf-06', ['T1190', 'T1485']],
  ['wstg-conf-07', ['T1557', 'T1595']],
  ['wstg-conf-09', ['T1083', 'T1552']],
  ['wstg-conf-12', ['T1189', 'T1204']],
  ['wstg-conf-13', ['T1190', 'T1083']],
  ['wstg-conf-14', ['T1189', 'T1204']],
  ['wstg-conf-15', ['T1548', 'T1190']],
  ['wstg-idnt-01', ['T1087', 'T1078']],
  ['wstg-idnt-02', ['T1136', 'T1087']],
  ['wstg-idnt-03', ['T1136', 'T1098', 'T1087']],
  ['wstg-idnt-04', ['T1087', 'T1110']],
  ['wstg-athn-02', ['T1078', 'T1110']],
  ['wstg-athn-03', ['T1110', 'T1531']],
  ['wstg-athn-04', ['T1190', 'T1078']],
  ['wstg-athn-05', ['T1555', 'T1539']],
  ['wstg-athn-06', ['T1539', 'T1005']],
  ['wstg-athn-07', ['T1110', 'T1550']],
  ['wstg-athn-08', ['T1110', 'T1078']],
  ['wstg-athn-09', ['T1098', 'T1531']],
  ['wstg-athn-10', ['T1078', 'T1550']],
  ['wstg-athn-11', ['T1556.006', 'T1110']],
  ['wstg-athz-01', ['T1083', 'T1005']],
  ['wstg-athz-02', ['T1190', 'T1078']],
  ['wstg-athz-03', ['T1068', 'T1548']],
  ['wstg-athz-04', ['T1213', 'T1078']],
  ['wstg-athz-05', ['T1528', 'T1550']],
  ['wstg-sess-01', ['T1539', 'T1550']],
  ['wstg-sess-02', ['T1539']],
  ['wstg-sess-03', ['T1539', 'T1550']],
  ['wstg-sess-04', ['T1539', 'T1552']],
  ['wstg-sess-05', ['T1204', 'T1189']],
  ['wstg-sess-06', ['T1539']],
  ['wstg-sess-07', ['T1539']],
  ['wstg-sess-08', ['T1539', 'T1550']],
  ['wstg-sess-09', ['T1539', 'T1557']],
  ['wstg-sess-10', ['T1528', 'T1550']],
  ['wstg-sess-11', ['T1539', 'T1078']],
  ['wstg-injt-01', ['T1059.007', 'T1189', 'T1204']],
  ['wstg-injt-02', ['T1059.007', 'T1189', 'T1204']],
  ['wstg-injt-04', ['T1190']],
  ['wstg-injt-05', ['T1190', 'T1213']],
  ['wstg-injt-06', ['T1190', 'T1087']],
  ['wstg-injt-07', ['T1190', 'T1005']],
  ['wstg-injt-08', ['T1190', 'T1059', 'T1005']],
  ['wstg-injt-09', ['T1190', 'T1213']],
  ['wstg-injt-10', ['T1190', 'T1566']],
  ['wstg-injt-11', ['T1059', 'T1190']],
  ['wstg-injt-12', ['T1059', 'T1190']],
  ['wstg-injt-13', ['T1190', 'T1068']],
  ['wstg-injt-14', ['T1190', 'T1204']],
  ['wstg-injt-15', ['T1190', 'T1059.007']],
  ['wstg-injt-16', ['T1190', 'T1557']],
  ['wstg-injt-17', ['T1557', 'T1190']],
  ['wstg-injt-18', ['T1059', 'T1190']],
  ['wstg-injt-19', ['T1190', 'T1090', 'T1046']],
  ['wstg-injt-20', ['T1548', 'T1098']],
  ['wstg-injt-21', ['T1204', 'T1059']],
  ['wstg-injt-22', ['T1059.007', 'T1190']],
  ['wstg-injt-23', ['T1059', 'T1190']],
  ['wstg-errh-01', ['T1592']],
  ['wstg-cryp-01', ['T1557', 'T1595']],
  ['wstg-cryp-02', ['T1190', 'T1557']],
  ['wstg-cryp-03', ['T1557', 'T1552']],
  ['wstg-cryp-04', ['T1557']],
  ['wstg-busl-01', ['T1565', 'T1190']],
  ['wstg-busl-02', ['T1565', 'T1190']],
  ['wstg-busl-03', ['T1565']],
  ['wstg-busl-04', ['T1565', 'T1499']],
  ['wstg-busl-05', ['T1110', 'T1499']],
  ['wstg-busl-06', ['T1565', 'T1190']],
  ['wstg-busl-07', ['T1110']],
  ['wstg-busl-08', ['T1505', 'T1190']],
  ['wstg-busl-09', ['T1505', 'T1059']],
  ['wstg-busl-10', ['T1565']],
  ['wstg-clnt-01', ['T1059.007', 'T1189', 'T1204']],
  ['wstg-clnt-02', ['T1059.007', 'T1189']],
  ['wstg-clnt-03', ['T1189', 'T1059.007']],
  ['wstg-clnt-04', ['T1566', 'T1189']],
  ['wstg-clnt-05', ['T1189']],
  ['wstg-clnt-06', ['T1189', 'T1059.007']],
  ['wstg-clnt-07', ['T1213']],
  ['wstg-clnt-09', ['T1204']],
  ['wstg-clnt-10', ['T1071', 'T1572', 'T1539']],
  ['wstg-clnt-11', ['T1059.007', 'T1539']],
  ['wstg-clnt-12', ['T1539', 'T1552']],
  ['wstg-clnt-13', ['T1539', 'T1213']],
  ['wstg-clnt-14', ['T1566', 'T1189']],
  ['wstg-clnt-15', ['T1059.007', 'T1189']],
  ['wstg-apit-01', ['T1595', 'T1083']],
  ['wstg-apit-02', ['T1213', 'T1078']],
  ['wstg-apit-03', ['T1213', 'T1078']],
  ['wstg-apit-04', ['T1548', 'T1078']],
  ['wstg-apit-99', ['T1592', 'T1190']],
];

const IN_SCOPE_WSTG = new Set(WSTG_MAP.filter(test => test.support !== 'O').map(test => wstgKey(test.id)));
const crosswalk = new Map<string, readonly string[]>();
for (const [key, techniques] of CROSSWALK) {
  if (crosswalk.has(key)) throw new Error(`WSTG_ATTACK repeats ${key}`);
  if (!isWstgKey(key) || !IN_SCOPE_WSTG.has(key)) throw new Error(`WSTG_ATTACK maps ${key}, which is not an in-scope WSTG test`);
  if (techniques.length < 1 || techniques.length > 3) throw new Error(`${key} must name 1 to 3 techniques`);
  if (new Set(techniques).size !== techniques.length) throw new Error(`${key} repeats a technique`);
  for (const id of techniques) if (!TECHNIQUES_BY_ID.has(id)) throw new Error(`${key} names unknown technique ${id}`);
  crosswalk.set(key, techniques);
}
for (const key of IN_SCOPE_WSTG) if (!crosswalk.has(key)) throw new Error(`WSTG_ATTACK misses in-scope test ${key}`);

/** Lower-case WSTG key (`wstg-athz-04`) to the ATT&CK technique ids that test exercises or looks for. */
export const WSTG_ATTACK: Readonly<Record<string, readonly string[]>> = Object.freeze(Object.fromEntries(crosswalk));

export function isAttackTechnique(id: string): boolean {
  return TECHNIQUES_BY_ID.has(id);
}

/** Known ids only, deduped, ordered by tactic (ATTACK_TACTICS order) and then by id. Unknown ids are ignored. */
export function attackTechniques(ids: readonly string[]): AttackTechnique[] {
  return [...new Set(ids)]
    .flatMap(id => { const technique = TECHNIQUES_BY_ID.get(id); return technique ? [technique] : []; })
    .sort((left, right) => (TACTIC_ORDER.get(left.tactic) ?? ATTACK_TACTICS.length) - (TACTIC_ORDER.get(right.tactic) ?? ATTACK_TACTICS.length)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

/** Resolves lower-case WSTG keys to their techniques; deduped and in the same order as `attackTechniques`. Unknown keys contribute nothing. */
export function attackForWstg(keys: readonly string[]): AttackTechnique[] {
  return attackTechniques(keys.flatMap(key => WSTG_ATTACK[key] ?? []));
}
