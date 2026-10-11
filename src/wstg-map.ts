import type { CaseView } from './cases.js';
import type { CoverageCellView } from './coverage.js';

/**
 * OWASP WSTG tests mapped onto the library p2o ships, pinned to one upstream commit. Data and two pure helpers only: no new state, no new field.
 * A test's key (`wstgKey`, lower case, e.g. `wstg-athz-04`) is used as the `questionKey` of a work identity and of a coverage cell, so the
 * existing duplicate detection and coverage views apply to it unchanged. `support` describes the LIBRARY (what knowledge p2o carries for the test),
 * never the target and never detection ability; see docs/WSTG_MAP.md for the meaning of every column and planning_update.md for the rationale.
 */
export const WSTG_COMMIT = '28553f878d48358767892916d53e59a9d664811c';
export const WSTG_SOURCE = 'https://github.com/OWASP/wstg';

/** D: a skill names this class of test. T: only generic techniques apply. N: no skill. O: outside p2o's scope by design (other origins, DNS, third parties). */
export type WstgSupport = 'D' | 'T' | 'N' | 'O';
export interface WstgTest {
  id: string; title: string; support: WstgSupport;
  /** The effect happens in a browser; p2o has none, so proof stops at offline_reproduction. */
  browser: boolean;
  /** Needs identities supplied by the operator. */
  identity: boolean;
  phase: 'recon' | 'discovery';
  skills: readonly string[];
}
type Row = readonly [id: string, title: string, support: WstgSupport, flags: '' | 'B' | 'I' | 'BI', phase: 'recon' | 'discovery', skills: readonly string[]];

const ROWS: readonly Row[] = [
  ['WSTG-INFO-01', 'Conduct Search Engine Reconnaissance for Information Leakage', 'O', '', 'recon', []],
  ['WSTG-INFO-02', 'Fingerprint Web Server', 'T', '', 'recon', ['attack-surface-mapping']],
  ['WSTG-INFO-03', 'Review Webserver Metafiles for Information Leakage', 'T', '', 'recon', ['attack-surface-mapping', 'web-route-input-inventory']],
  ['WSTG-INFO-04', 'Attack Surface Identification', 'T', '', 'recon', ['attack-surface-mapping']],
  ['WSTG-INFO-05', 'Review Web Page Content for Information Leakage', 'T', '', 'recon', ['attack-surface-mapping', 'source-code-auditing']],
  ['WSTG-INFO-06', 'Identify Application Entry Points', 'D', '', 'recon', ['web-route-input-inventory']],
  ['WSTG-INFO-07', 'Map Execution Paths Through Application', 'D', '', 'recon', ['web-route-input-inventory', 'data-flow-analysis']],
  ['WSTG-INFO-08', 'Fingerprint Web Application Framework', 'T', '', 'recon', ['attack-surface-mapping']],
  ['WSTG-INFO-10', 'Map Application Architecture', 'T', '', 'recon', ['attack-surface-mapping']],
  ['WSTG-CONF-01', 'Network Infrastructure Configuration', 'O', '', 'discovery', []],
  ['WSTG-CONF-02', 'Application Platform Configuration', 'T', '', 'discovery', ['source-code-auditing', 'attack-surface-mapping']],
  ['WSTG-CONF-04', 'Review Old Backup and Unreferenced Files for Sensitive Information', 'T', '', 'discovery', ['source-code-auditing', 'attack-surface-mapping']],
  ['WSTG-CONF-05', 'Enumerate Infrastructure and Application Admin Interfaces', 'T', '', 'recon', ['attack-surface-mapping', 'web-route-input-inventory']],
  ['WSTG-CONF-06', 'HTTP Methods', 'T', '', 'recon', ['attack-surface-mapping']],
  ['WSTG-CONF-07', 'HTTP Strict Transport Security', 'N', '', 'recon', []],
  ['WSTG-CONF-09', 'File Permissions', 'N', '', 'discovery', []],
  ['WSTG-CONF-10', 'Subdomain Takeover', 'O', '', 'discovery', []],
  ['WSTG-CONF-11', 'Cloud Storage', 'O', '', 'discovery', []],
  ['WSTG-CONF-12', 'Content Security Policy', 'N', 'B', 'recon', []],
  ['WSTG-CONF-13', 'Path Confusion', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-CONF-14', 'Other HTTP Security Header Misconfigurations', 'N', 'B', 'recon', []],
  ['WSTG-CONF-15', 'Feature Flag Security Bypass', 'T', '', 'discovery', ['source-code-auditing']],
  ['WSTG-IDNT-01', 'Role Definitions', 'D', 'I', 'discovery', ['web-object-authorization']],
  ['WSTG-IDNT-02', 'User Registration Process', 'T', 'I', 'discovery', ['authorization-auditing']],
  ['WSTG-IDNT-03', 'Account Provisioning Process', 'T', 'I', 'discovery', ['authorization-auditing']],
  ['WSTG-IDNT-04', 'Account Enumeration and Guessable User Account', 'T', '', 'discovery', ['authorization-auditing']],
  ['WSTG-ATHN-02', 'Default Credentials', 'N', 'I', 'discovery', []],
  ['WSTG-ATHN-03', 'Weak Lock Out Mechanism', 'N', 'I', 'discovery', []],
  ['WSTG-ATHN-04', 'Bypassing Authentication Schema', 'D', 'I', 'discovery', ['authorization-auditing', 'fastapi-security-parity']],
  ['WSTG-ATHN-05', 'Vulnerable Remember Password', 'N', 'I', 'discovery', []],
  ['WSTG-ATHN-06', 'Browser Cache Weaknesses', 'N', 'B', 'discovery', []],
  ['WSTG-ATHN-07', 'Weak Authentication Methods', 'N', 'I', 'discovery', []],
  ['WSTG-ATHN-08', 'Weak Security Question Answer', 'N', 'I', 'discovery', []],
  ['WSTG-ATHN-09', 'Weak Password Change or Reset Functionalities', 'N', 'I', 'discovery', []],
  ['WSTG-ATHN-10', 'Weaker Authentication in Alternative Channel', 'D', 'I', 'discovery', ['authorization-auditing']],
  ['WSTG-ATHN-11', 'Multi-Factor Authentication (MFA)', 'N', 'I', 'discovery', []],
  ['WSTG-ATHZ-01', 'Directory Traversal File Include', 'T', '', 'discovery', ['data-flow-analysis', 'source-code-auditing']],
  ['WSTG-ATHZ-02', 'Bypassing Authorization Schema', 'D', 'I', 'discovery', ['web-object-authorization', 'authorization-auditing', 'fastapi-security-parity']],
  ['WSTG-ATHZ-03', 'Privilege Escalation', 'D', 'I', 'discovery', ['web-object-authorization', 'authorization-auditing']],
  ['WSTG-ATHZ-04', 'Insecure Direct Object References', 'D', 'I', 'discovery', ['web-object-authorization']],
  ['WSTG-ATHZ-05', 'OAuth Weaknesses', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-01', 'Session Management Schema', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-02', 'Cookies Attributes', 'N', '', 'discovery', []],
  ['WSTG-SESS-03', 'Session Fixation', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-04', 'Exposed Session Variables', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-05', 'Cross Site Request Forgery', 'N', 'BI', 'discovery', []],
  ['WSTG-SESS-06', 'Logout Functionality', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-07', 'Session Timeout', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-08', 'Session Puzzling', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-09', 'Session Hijacking', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-10', 'JSON Web Tokens', 'N', 'I', 'discovery', []],
  ['WSTG-SESS-11', 'Concurrent Sessions', 'N', 'I', 'discovery', []],
  ['WSTG-INJT-01', 'Reflected Cross Site Scripting', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-INJT-02', 'Stored Cross Site Scripting', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-INJT-04', 'HTTP Parameter Pollution', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-INJT-05', 'SQL Injection', 'T', '', 'discovery', ['data-flow-analysis', 'source-code-auditing']],
  ['WSTG-INJT-06', 'LDAP Injection', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-07', 'XML Injection', 'T', '', 'discovery', ['data-flow-analysis', 'source-code-auditing']],
  ['WSTG-INJT-08', 'SSI Injection', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-09', 'XPath Injection', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-10', 'IMAP SMTP Injection', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-11', 'Code Injection', 'T', '', 'discovery', ['data-flow-analysis', 'source-code-auditing']],
  ['WSTG-INJT-12', 'Command Injection', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-13', 'Format String Injection', 'D', '', 'discovery', ['memory-safety-auditing']],
  ['WSTG-INJT-14', 'Incubated Vulnerability', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-15', 'HTTP Response Splitting', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-INJT-16', 'HTTP Request Smuggling', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-INJT-17', 'Host Header Injection', 'T', '', 'discovery', ['attack-surface-mapping', 'data-flow-analysis']],
  ['WSTG-INJT-18', 'Server-side Template Injection', 'D', '', 'discovery', ['deserialization-and-dispatch-auditing']],
  ['WSTG-INJT-19', 'Server-Side Request Forgery', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-20', 'Mass Assignment', 'D', 'I', 'discovery', ['authorization-auditing']],
  ['WSTG-INJT-21', 'CSV Injection', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-INJT-22', 'Prototype Pollution', 'D', '', 'discovery', ['deserialization-and-dispatch-auditing']],
  ['WSTG-INJT-23', 'Insecure Deserialization', 'D', '', 'discovery', ['deserialization-and-dispatch-auditing']],
  ['WSTG-ERRH-01', 'Improper Error Handling', 'N', '', 'discovery', []],
  ['WSTG-CRYP-01', 'Weak Transport Layer Security', 'N', '', 'discovery', []],
  ['WSTG-CRYP-02', 'Padding Oracle', 'N', '', 'discovery', []],
  ['WSTG-CRYP-03', 'Sensitive Information Sent via Unencrypted Channels', 'N', '', 'discovery', []],
  ['WSTG-CRYP-04', 'Weak Cryptographic Primitives', 'T', '', 'discovery', ['source-code-auditing']],
  ['WSTG-BUSL-01', 'Business Logic Data Validation', 'N', 'I', 'discovery', []],
  ['WSTG-BUSL-02', 'Ability to Forge Requests', 'N', 'I', 'discovery', []],
  ['WSTG-BUSL-03', 'Integrity Checks', 'N', 'I', 'discovery', []],
  ['WSTG-BUSL-04', 'Process Timing', 'T', 'I', 'discovery', ['source-code-auditing']],
  ['WSTG-BUSL-05', 'Number of Times a Function Can Be Used Limits', 'D', 'I', 'discovery', ['race-condition-auditing']],
  ['WSTG-BUSL-06', 'Circumvention of Work Flows', 'T', 'I', 'discovery', ['source-code-auditing', 'data-flow-analysis']],
  ['WSTG-BUSL-07', 'Defenses Against Application Misuse', 'N', 'I', 'discovery', []],
  ['WSTG-BUSL-08', 'Upload of Unexpected File Types', 'N', 'I', 'discovery', []],
  ['WSTG-BUSL-09', 'Upload of Malicious Files', 'N', 'I', 'discovery', []],
  ['WSTG-BUSL-10', 'Payment Functionality', 'N', 'I', 'discovery', []],
  ['WSTG-CLNT-01', 'DOM-Based Cross Site Scripting', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-CLNT-02', 'JavaScript Execution', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-CLNT-03', 'HTML Injection', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-CLNT-04', 'Client-side URL Redirect', 'T', 'B', 'discovery', ['data-flow-analysis']],
  ['WSTG-CLNT-05', 'CSS Injection', 'T', 'B', 'discovery', ['data-flow-analysis']],
  ['WSTG-CLNT-06', 'Client-side Resource Manipulation', 'T', 'B', 'discovery', ['data-flow-analysis']],
  ['WSTG-CLNT-07', 'Cross Origin Resource Sharing', 'N', 'B', 'discovery', []],
  ['WSTG-CLNT-09', 'Clickjacking', 'N', 'B', 'discovery', []],
  ['WSTG-CLNT-10', 'WebSockets', 'N', 'B', 'discovery', []],
  ['WSTG-CLNT-11', 'Web Messaging', 'N', 'B', 'discovery', []],
  ['WSTG-CLNT-12', 'Browser Storage', 'N', 'B', 'discovery', []],
  ['WSTG-CLNT-13', 'Cross Site Script Inclusion', 'N', 'B', 'discovery', []],
  ['WSTG-CLNT-14', 'Reverse Tabnabbing', 'N', 'B', 'discovery', []],
  ['WSTG-CLNT-15', 'Client-side Template Injection', 'T', 'B', 'discovery', ['data-flow-analysis']],
  ['WSTG-APIT-01', 'API Reconnaissance', 'D', '', 'recon', ['web-route-input-inventory']],
  ['WSTG-APIT-02', 'API Broken Object Level Authorization', 'D', 'I', 'discovery', ['web-object-authorization']],
  ['WSTG-APIT-03', 'Excessive Data Exposure', 'T', '', 'discovery', ['data-flow-analysis']],
  ['WSTG-APIT-04', 'API Broken Function Level Authorization', 'D', 'I', 'discovery', ['web-object-authorization', 'authorization-auditing']],
  ['WSTG-APIT-99', 'GraphQL', 'N', '', 'discovery', []]
];

export const WSTG_MAP: readonly WstgTest[] = ROWS.map(([id, title, support, flags, phase, skills]) => ({ id, title, support, browser: flags.includes('B'), identity: flags.includes('I'), phase, skills }));
/** `WSTG-ATHZ-04` becomes `wstg-athz-04`, a valid `key()` value for questionKey. */
export const wstgKey = (id: string): string => id.toLowerCase();
export const WSTG_BY_KEY: ReadonlyMap<string, WstgTest> = new Map(WSTG_MAP.map(test => [wstgKey(test.id), test]));
export const isWstgKey = (key: string): boolean => key.startsWith('wstg-');

/** The markdown rows of docs/WSTG_MAP.md, so the document and the data cannot drift (checked by a test; regenerate with scripts/render-wstg-map.mjs). */
export function wstgTableRows(): string[] {
  return WSTG_MAP.map(test => `| ${wstgKey(test.id)} | ${test.id} | ${test.title} | ${test.support} | ${`${test.browser ? 'B' : ''}${test.identity ? 'I' : ''}` || '-'} | ${test.phase} | ${test.skills.length ? test.skills.join(', ') : '-'} |`);
}

/** L0 never checked, L1 attempted, blocked or gone stale, L2 checked (a current tested cell), L3 proven (that cell cites an accepted, current, confirmed case), n/a every cell is not_applicable. */
export type WstgEvidence = 'L0' | 'L1' | 'L2' | 'L3' | 'n/a';
export type WstgCell = Pick<CoverageCellView, 'execution' | 'currentness' | 'caseRefs'>;
export type WstgCase = Pick<CaseView, 'id' | 'revision' | 'acceptedFinding'>;

/** Highest evidence level reached for one test over the coverage cells that carry its key. Retired cells do not count; a stale or unknown cell is never current evidence. */
export function wstgEvidence(cells: readonly WstgCell[], cases: readonly WstgCase[]): WstgEvidence {
  const live = cells.filter(cell => cell.currentness !== 'retired');
  if (!live.length) return 'L0';
  if (live.every(cell => cell.execution === 'not_applicable')) return 'n/a';
  const accepted = new Set(cases.filter(item => item.acceptedFinding).map(item => `${item.id}@${item.revision}`));
  const tested = live.filter(cell => cell.execution === 'tested');
  if (tested.some(cell => cell.currentness === 'current' && cell.caseRefs.some(ref => accepted.has(`${ref.caseId}@${ref.revision}`)))) return 'L3';
  if (tested.some(cell => cell.currentness === 'current')) return 'L2';
  if (tested.length || live.some(cell => cell.execution === 'attempted' || cell.execution === 'blocked')) return 'L1';
  return 'L0';
}
