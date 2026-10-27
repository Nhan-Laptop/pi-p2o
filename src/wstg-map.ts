import { isTestedCell } from './claims.js';
import type { CaseView } from './cases.js';
import type { CoverageCellView } from './coverage.js';

/**
 * OWASP WSTG tests mapped onto the library p2o ships, pinned to one upstream commit. Data and two pure helpers only: no new state, no new field.
 * A test's key (`wstgKey`, lower case, e.g. `wstg-athz-04`) is used as the `questionKey` of a work identity and of a coverage cell, so the
 * existing duplicate detection and coverage views apply to it unchanged. `support` describes the LIBRARY (what knowledge p2o carries for the test),
 * never the target and never detection ability; see docs/WSTG_MAP.md for the meaning of every column and planning_update.md for the rationale.
 */
export const WSTG_COMMIT = '28553f878d48358767892916d53e59a9d664811c';

/** D: a skill names this class of test. T: only generic techniques apply. N: no skill. O: outside p2o's scope by design (other origins, DNS, third parties). */
export type WstgSupport = 'D' | 'T' | 'N' | 'O';
export interface WstgTest {
  id: string; title: string; support: WstgSupport;
  /** The effect happens in a browser; the sandbox ships Chromium and the agent-browser CLI (P11/A11), so the transport is executable and the flag only marks it. */
  browser: boolean;
  /** Needs identities supplied by the operator. */
  identity: boolean;
  phase: 'recon' | 'discovery';
  skills: readonly string[];
  /** Recon features that make the test worth planning (vocabulary: WSTG_FEATURES); empty when the test is out of scope. */
  trigger: readonly string[];
  /** Transports that can carry the test, a subset of WSTG_MODES; empty when out of scope. */
  modes: string;
  /** The skill that owns the test ('' when out of scope) and the reference card under it that says how to run it ('' while it only has a generic method). */
  owner: string; card: string;
}
type Row = readonly [id: string, title: string, support: WstgSupport, flags: '' | 'B' | 'I' | 'BI', phase: 'recon' | 'discovery', skills: readonly string[]];

const ROWS: readonly Row[] = [
  ['WSTG-INFO-01', 'Conduct Search Engine Reconnaissance for Information Leakage', 'O', '', 'recon', []],
  ['WSTG-INFO-02', 'Fingerprint Web Server', 'D', '', 'recon', ['web-deployment-hygiene', 'attack-surface-mapping']],
  ['WSTG-INFO-03', 'Review Webserver Metafiles for Information Leakage', 'D', '', 'recon', ['web-deployment-hygiene', 'attack-surface-mapping', 'web-route-input-inventory']],
  ['WSTG-INFO-04', 'Attack Surface Identification', 'T', '', 'recon', ['attack-surface-mapping']],
  ['WSTG-INFO-05', 'Review Web Page Content for Information Leakage', 'D', '', 'recon', ['web-deployment-hygiene', 'attack-surface-mapping', 'source-code-auditing']],
  ['WSTG-INFO-06', 'Identify Application Entry Points', 'D', '', 'recon', ['web-route-input-inventory']],
  ['WSTG-INFO-07', 'Map Execution Paths Through Application', 'D', '', 'recon', ['web-route-input-inventory', 'data-flow-analysis']],
  ['WSTG-INFO-08', 'Fingerprint Web Application Framework', 'D', '', 'recon', ['web-deployment-hygiene', 'attack-surface-mapping']],
  ['WSTG-INFO-10', 'Map Application Architecture', 'T', '', 'recon', ['attack-surface-mapping']],
  ['WSTG-CONF-01', 'Network Infrastructure Configuration', 'O', '', 'discovery', []],
  ['WSTG-CONF-02', 'Application Platform Configuration', 'D', '', 'discovery', ['web-deployment-hygiene', 'source-code-auditing', 'attack-surface-mapping']],
  ['WSTG-CONF-04', 'Review Old Backup and Unreferenced Files for Sensitive Information', 'D', '', 'discovery', ['web-deployment-hygiene', 'source-code-auditing', 'attack-surface-mapping']],
  ['WSTG-CONF-05', 'Enumerate Infrastructure and Application Admin Interfaces', 'D', '', 'recon', ['web-deployment-hygiene', 'attack-surface-mapping', 'web-route-input-inventory']],
  ['WSTG-CONF-06', 'HTTP Methods', 'D', '', 'recon', ['web-deployment-hygiene', 'attack-surface-mapping']],
  ['WSTG-CONF-07', 'HTTP Strict Transport Security', 'D', '', 'recon', ['web-deployment-hygiene']],
  ['WSTG-CONF-09', 'File Permissions', 'D', '', 'discovery', ['web-deployment-hygiene']],
  ['WSTG-CONF-10', 'Subdomain Takeover', 'O', '', 'discovery', []],
  ['WSTG-CONF-11', 'Cloud Storage', 'O', '', 'discovery', []],
  ['WSTG-CONF-12', 'Content Security Policy', 'D', 'B', 'recon', ['web-browser-trust-controls']],
  ['WSTG-CONF-13', 'Path Confusion', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-CONF-14', 'Other HTTP Security Header Misconfigurations', 'D', 'B', 'recon', ['web-deployment-hygiene']],
  ['WSTG-CONF-15', 'Feature Flag Security Bypass', 'D', '', 'discovery', ['web-deployment-hygiene', 'source-code-auditing']],
  ['WSTG-IDNT-01', 'Role Definitions', 'D', 'I', 'discovery', ['web-object-authorization']],
  ['WSTG-IDNT-02', 'User Registration Process', 'D', 'I', 'discovery', ['web-credential-lifecycle', 'authorization-auditing']],
  ['WSTG-IDNT-03', 'Account Provisioning Process', 'D', 'I', 'discovery', ['web-credential-lifecycle', 'authorization-auditing']],
  ['WSTG-IDNT-04', 'Account Enumeration and Guessable User Account', 'D', '', 'discovery', ['web-credential-lifecycle', 'authorization-auditing']],
  ['WSTG-ATHN-02', 'Default Credentials', 'D', 'I', 'discovery', ['web-credential-lifecycle']],
  ['WSTG-ATHN-03', 'Weak Lock Out Mechanism', 'D', 'I', 'discovery', ['web-credential-lifecycle']],
  ['WSTG-ATHN-04', 'Bypassing Authentication Schema', 'D', 'I', 'discovery', ['authorization-auditing', 'fastapi-security-parity']],
  ['WSTG-ATHN-05', 'Vulnerable Remember Password', 'D', 'I', 'discovery', ['web-credential-lifecycle']],
  ['WSTG-ATHN-06', 'Browser Cache Weaknesses', 'D', 'B', 'discovery', ['web-deployment-hygiene']],
  ['WSTG-ATHN-07', 'Weak Authentication Methods', 'D', 'I', 'discovery', ['web-credential-lifecycle']],
  ['WSTG-ATHN-08', 'Weak Security Question Answer', 'D', 'I', 'discovery', ['web-credential-lifecycle']],
  ['WSTG-ATHN-09', 'Weak Password Change or Reset Functionalities', 'D', 'I', 'discovery', ['web-credential-lifecycle']],
  ['WSTG-ATHN-10', 'Weaker Authentication in Alternative Channel', 'D', 'I', 'discovery', ['authorization-auditing']],
  ['WSTG-ATHN-11', 'Multi-Factor Authentication (MFA)', 'D', 'I', 'discovery', ['web-credential-lifecycle']],
  ['WSTG-ATHZ-01', 'Directory Traversal File Include', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis', 'source-code-auditing']],
  ['WSTG-ATHZ-02', 'Bypassing Authorization Schema', 'D', 'I', 'discovery', ['web-object-authorization', 'authorization-auditing', 'fastapi-security-parity']],
  ['WSTG-ATHZ-03', 'Privilege Escalation', 'D', 'I', 'discovery', ['web-object-authorization', 'authorization-auditing']],
  ['WSTG-ATHZ-04', 'Insecure Direct Object References', 'D', 'I', 'discovery', ['web-object-authorization']],
  ['WSTG-ATHZ-05', 'OAuth Weaknesses', 'D', 'I', 'discovery', ['web-token-and-federation']],
  ['WSTG-SESS-01', 'Session Management Schema', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-SESS-02', 'Cookies Attributes', 'D', '', 'discovery', ['web-session-management']],
  ['WSTG-SESS-03', 'Session Fixation', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-SESS-04', 'Exposed Session Variables', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-SESS-05', 'Cross Site Request Forgery', 'D', 'BI', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-SESS-06', 'Logout Functionality', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-SESS-07', 'Session Timeout', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-SESS-08', 'Session Puzzling', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-SESS-09', 'Session Hijacking', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-SESS-10', 'JSON Web Tokens', 'D', 'I', 'discovery', ['web-token-and-federation']],
  ['WSTG-SESS-11', 'Concurrent Sessions', 'D', 'I', 'discovery', ['web-session-management']],
  ['WSTG-INJT-01', 'Reflected Cross Site Scripting', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-INJT-02', 'Stored Cross Site Scripting', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-INJT-04', 'HTTP Parameter Pollution', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-INJT-05', 'SQL Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis', 'source-code-auditing']],
  ['WSTG-INJT-06', 'LDAP Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-07', 'XML Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis', 'source-code-auditing']],
  ['WSTG-INJT-08', 'SSI Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-09', 'XPath Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-10', 'IMAP SMTP Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-11', 'Code Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis', 'source-code-auditing']],
  ['WSTG-INJT-12', 'Command Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-13', 'Format String Injection', 'D', '', 'discovery', ['web-server-side-injection', 'memory-safety-auditing']],
  ['WSTG-INJT-14', 'Incubated Vulnerability', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-15', 'HTTP Response Splitting', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-INJT-16', 'HTTP Request Smuggling', 'D', '', 'discovery', ['parser-differential-auditing']],
  ['WSTG-INJT-17', 'Host Header Injection', 'D', '', 'discovery', ['attack-surface-mapping', 'data-flow-analysis']],
  ['WSTG-INJT-18', 'Server-side Template Injection', 'D', '', 'discovery', ['deserialization-and-dispatch-auditing']],
  ['WSTG-INJT-19', 'Server-Side Request Forgery', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-20', 'Mass Assignment', 'D', 'I', 'discovery', ['web-object-authorization', 'authorization-auditing']],
  ['WSTG-INJT-21', 'CSV Injection', 'D', '', 'discovery', ['web-server-side-injection', 'data-flow-analysis']],
  ['WSTG-INJT-22', 'Prototype Pollution', 'D', '', 'discovery', ['deserialization-and-dispatch-auditing']],
  ['WSTG-INJT-23', 'Insecure Deserialization', 'D', '', 'discovery', ['deserialization-and-dispatch-auditing']],
  ['WSTG-ERRH-01', 'Improper Error Handling', 'D', '', 'discovery', ['web-deployment-hygiene']],
  ['WSTG-CRYP-01', 'Weak Transport Layer Security', 'D', '', 'discovery', ['web-deployment-hygiene']],
  ['WSTG-CRYP-02', 'Padding Oracle', 'D', '', 'discovery', ['web-crypto-usage-review']],
  ['WSTG-CRYP-03', 'Sensitive Information Sent via Unencrypted Channels', 'D', '', 'discovery', ['web-deployment-hygiene']],
  ['WSTG-CRYP-04', 'Weak Cryptographic Primitives', 'D', '', 'discovery', ['web-crypto-usage-review', 'source-code-auditing']],
  ['WSTG-BUSL-01', 'Business Logic Data Validation', 'D', 'I', 'discovery', ['web-business-logic-misuse']],
  ['WSTG-BUSL-02', 'Ability to Forge Requests', 'D', 'I', 'discovery', ['web-business-logic-misuse']],
  ['WSTG-BUSL-03', 'Integrity Checks', 'D', 'I', 'discovery', ['web-business-logic-misuse']],
  ['WSTG-BUSL-04', 'Process Timing', 'D', 'I', 'discovery', ['web-business-logic-misuse', 'source-code-auditing']],
  ['WSTG-BUSL-05', 'Number of Times a Function Can Be Used Limits', 'D', 'I', 'discovery', ['race-condition-auditing']],
  ['WSTG-BUSL-06', 'Circumvention of Work Flows', 'D', 'I', 'discovery', ['web-business-logic-misuse', 'source-code-auditing', 'data-flow-analysis']],
  ['WSTG-BUSL-07', 'Defenses Against Application Misuse', 'D', 'I', 'discovery', ['web-business-logic-misuse']],
  ['WSTG-BUSL-08', 'Upload of Unexpected File Types', 'D', 'I', 'discovery', ['web-business-logic-misuse']],
  ['WSTG-BUSL-09', 'Upload of Malicious Files', 'D', 'I', 'discovery', ['web-business-logic-misuse']],
  ['WSTG-BUSL-10', 'Payment Functionality', 'D', 'I', 'discovery', ['web-business-logic-misuse']],
  ['WSTG-CLNT-01', 'DOM-Based Cross Site Scripting', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-CLNT-02', 'JavaScript Execution', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-CLNT-03', 'HTML Injection', 'D', 'B', 'discovery', ['web-output-context']],
  ['WSTG-CLNT-04', 'Client-side URL Redirect', 'D', 'B', 'discovery', ['web-browser-trust-controls', 'data-flow-analysis']],
  ['WSTG-CLNT-05', 'CSS Injection', 'D', 'B', 'discovery', ['web-browser-trust-controls', 'data-flow-analysis']],
  ['WSTG-CLNT-06', 'Client-side Resource Manipulation', 'D', 'B', 'discovery', ['web-browser-trust-controls', 'data-flow-analysis']],
  ['WSTG-CLNT-07', 'Cross Origin Resource Sharing', 'D', 'B', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-CLNT-09', 'Clickjacking', 'D', 'B', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-CLNT-10', 'WebSockets', 'D', 'B', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-CLNT-11', 'Web Messaging', 'D', 'B', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-CLNT-12', 'Browser Storage', 'D', 'B', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-CLNT-13', 'Cross Site Script Inclusion', 'D', 'B', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-CLNT-14', 'Reverse Tabnabbing', 'D', 'B', 'discovery', ['web-browser-trust-controls']],
  ['WSTG-CLNT-15', 'Client-side Template Injection', 'D', 'B', 'discovery', ['web-browser-trust-controls', 'data-flow-analysis']],
  ['WSTG-APIT-01', 'API Reconnaissance', 'D', '', 'recon', ['web-route-input-inventory']],
  ['WSTG-APIT-02', 'API Broken Object Level Authorization', 'D', 'I', 'discovery', ['web-object-authorization']],
  ['WSTG-APIT-03', 'Excessive Data Exposure', 'D', '', 'discovery', ['web-object-authorization', 'data-flow-analysis']],
  ['WSTG-APIT-04', 'API Broken Function Level Authorization', 'D', 'I', 'discovery', ['web-object-authorization', 'authorization-auditing']],
  ['WSTG-APIT-99', 'GraphQL', 'D', '', 'discovery', ['web-graphql-testing']]
];

/**
 * Planning data kept beside the support level, one row per test (no new state or field; the document and a test pin them).
 * Trigger: the recon features that make the test worth planning, from the vocabulary below (shared with the lead in HANDOFFS.md); empty when the test is out of scope.
 * Modes: the transports that can carry the test. S source review, H anonymous same-origin HTTP, A HTTP with an authenticated principal (the operator's sealed identity or one the worker provisions), N sandbox network
 * (TCP, TLS, WebSocket), B the effect needs the browser transport, which the sandbox image provides and the worker drives as an ordinary command. The flags stay as planning labels: the browser and identity filters below are the caller's.
 */
export const WSTG_FEATURES = ['any', 'config', 'https', 'login', 'session-token', 'registration', 'password-reset', 'mfa', 'remember-me', 'jwt', 'oauth', 'roles', 'object-id', 'upload', 'xml-input', 'template-render', 'dynamic-code', 'outbound-fetch', 'db-query', 'os-command', 'file-path', 'mail-send', 'export-csv', 'serialized-input', 'crypto-use', 'reflected-input', 'stored-input', 'intermediary', 'redirect', 'client-js', 'client-storage', 'postmessage', 'websocket', 'graphql', 'api', 'payment', 'workflow', 'cors', 'frames'] as const;
export const WSTG_MODES = 'SHANB';
const FEATURES: Readonly<Record<string, readonly [trigger: string, modes: string]>> = {
  'WSTG-INFO-01': ['', ''],
  'WSTG-INFO-02': ['any', 'H'],
  'WSTG-INFO-03': ['any', 'SH'],
  'WSTG-INFO-04': ['any', 'H'],
  'WSTG-INFO-05': ['any', 'SH'],
  'WSTG-INFO-06': ['any', 'SH'],
  'WSTG-INFO-07': ['workflow', 'SH'],
  'WSTG-INFO-08': ['any', 'SH'],
  'WSTG-INFO-10': ['any', 'SH'],
  'WSTG-CONF-01': ['', ''],
  'WSTG-CONF-02': ['config', 'SH'],
  'WSTG-CONF-04': ['any', 'SH'],
  'WSTG-CONF-05': ['any', 'SH'],
  'WSTG-CONF-06': ['any', 'H'],
  'WSTG-CONF-07': ['https', 'H'],
  'WSTG-CONF-09': ['config', 'S'],
  'WSTG-CONF-10': ['', ''],
  'WSTG-CONF-11': ['', ''],
  'WSTG-CONF-12': ['any', 'HB'],
  'WSTG-CONF-13': ['any', 'SH'],
  'WSTG-CONF-14': ['any', 'HB'],
  'WSTG-CONF-15': ['config', 'SH'],
  'WSTG-IDNT-01': ['roles', 'SA'],
  'WSTG-IDNT-02': ['registration', 'SHA'],
  'WSTG-IDNT-03': ['registration,roles', 'SA'],
  'WSTG-IDNT-04': ['login,registration,password-reset', 'SH'],
  'WSTG-ATHN-02': ['login', 'SHA'],
  'WSTG-ATHN-03': ['login', 'SHA'],
  'WSTG-ATHN-04': ['login', 'SHA'],
  'WSTG-ATHN-05': ['remember-me', 'SA'],
  'WSTG-ATHN-06': ['session-token', 'HB'],
  'WSTG-ATHN-07': ['login,registration', 'SA'],
  'WSTG-ATHN-08': ['password-reset', 'SA'],
  'WSTG-ATHN-09': ['password-reset', 'SHA'],
  'WSTG-ATHN-10': ['login', 'SA'],
  'WSTG-ATHN-11': ['mfa', 'SA'],
  'WSTG-ATHZ-01': ['file-path', 'SH'],
  'WSTG-ATHZ-02': ['login,roles', 'SA'],
  'WSTG-ATHZ-03': ['roles', 'SA'],
  'WSTG-ATHZ-04': ['object-id', 'SA'],
  'WSTG-ATHZ-05': ['oauth', 'SA'],
  'WSTG-SESS-01': ['session-token', 'SA'],
  'WSTG-SESS-02': ['session-token', 'SH'],
  'WSTG-SESS-03': ['session-token,login', 'SA'],
  'WSTG-SESS-04': ['session-token', 'SA'],
  'WSTG-SESS-05': ['session-token,workflow', 'SAB'],
  'WSTG-SESS-06': ['session-token,login', 'SA'],
  'WSTG-SESS-07': ['session-token', 'SA'],
  'WSTG-SESS-08': ['session-token,workflow', 'SA'],
  'WSTG-SESS-09': ['session-token', 'SA'],
  'WSTG-SESS-10': ['jwt', 'SA'],
  'WSTG-SESS-11': ['session-token,login', 'SA'],
  'WSTG-INJT-01': ['reflected-input', 'SHB'],
  'WSTG-INJT-02': ['stored-input', 'SHB'],
  'WSTG-INJT-04': ['any', 'SH'],
  'WSTG-INJT-05': ['db-query', 'SH'],
  'WSTG-INJT-06': ['db-query', 'SH'],
  'WSTG-INJT-07': ['xml-input', 'SH'],
  'WSTG-INJT-08': ['template-render', 'SH'],
  'WSTG-INJT-09': ['xml-input', 'SH'],
  'WSTG-INJT-10': ['mail-send', 'SH'],
  'WSTG-INJT-11': ['dynamic-code', 'SH'],
  'WSTG-INJT-12': ['os-command', 'SH'],
  'WSTG-INJT-13': ['dynamic-code', 'S'],
  'WSTG-INJT-14': ['stored-input', 'SH'],
  'WSTG-INJT-15': ['reflected-input', 'SH'],
  'WSTG-INJT-16': ['intermediary', 'SN'],
  'WSTG-INJT-17': ['intermediary', 'SH'],
  'WSTG-INJT-18': ['template-render', 'SH'],
  'WSTG-INJT-19': ['outbound-fetch', 'SHN'],
  'WSTG-INJT-20': ['api', 'SA'],
  'WSTG-INJT-21': ['export-csv', 'SH'],
  'WSTG-INJT-22': ['api,client-js', 'SH'],
  'WSTG-INJT-23': ['serialized-input', 'SH'],
  'WSTG-ERRH-01': ['any', 'SH'],
  'WSTG-CRYP-01': ['https', 'SHN'],
  'WSTG-CRYP-02': ['crypto-use', 'SH'],
  'WSTG-CRYP-03': ['any', 'SHN'],
  'WSTG-CRYP-04': ['crypto-use', 'S'],
  'WSTG-BUSL-01': ['workflow', 'SA'],
  'WSTG-BUSL-02': ['workflow', 'SA'],
  'WSTG-BUSL-03': ['workflow', 'SA'],
  'WSTG-BUSL-04': ['workflow', 'SA'],
  'WSTG-BUSL-05': ['workflow', 'SA'],
  'WSTG-BUSL-06': ['workflow', 'SA'],
  'WSTG-BUSL-07': ['workflow', 'SA'],
  'WSTG-BUSL-08': ['upload', 'SA'],
  'WSTG-BUSL-09': ['upload', 'SA'],
  'WSTG-BUSL-10': ['payment', 'SA'],
  'WSTG-CLNT-01': ['client-js', 'SHB'],
  'WSTG-CLNT-02': ['client-js', 'SHB'],
  'WSTG-CLNT-03': ['reflected-input', 'SHB'],
  'WSTG-CLNT-04': ['redirect', 'SHB'],
  'WSTG-CLNT-05': ['reflected-input', 'SHB'],
  'WSTG-CLNT-06': ['client-js', 'SHB'],
  'WSTG-CLNT-07': ['cors', 'HB'],
  'WSTG-CLNT-09': ['frames', 'HB'],
  'WSTG-CLNT-10': ['websocket', 'SNB'],
  'WSTG-CLNT-11': ['postmessage', 'SHB'],
  'WSTG-CLNT-12': ['client-storage', 'SHB'],
  'WSTG-CLNT-13': ['client-js', 'HB'],
  'WSTG-CLNT-14': ['client-js', 'SHB'],
  'WSTG-CLNT-15': ['client-js', 'SHB'],
  'WSTG-APIT-01': ['api', 'SH'],
  'WSTG-APIT-02': ['api,object-id', 'SA'],
  'WSTG-APIT-03': ['api', 'SH'],
  'WSTG-APIT-04': ['api,roles', 'SA'],
  'WSTG-APIT-99': ['graphql', 'SH'],
};
/**
 * The one skill that owns each in-scope test and the reference card under that skill's references/ that says how to run it. The card is '' while the owner only
 * has a generic method. A card counts only once its skill and file exist and its first line `Tests:` lists the key (tests/minimal/wstg-skills.test.ts); from then on
 * the test must be supported as D. Skills named here before they exist are the plan, not a claim.
 */
const OWNERS: Readonly<Record<string, readonly [owner: string, card: string]>> = {
  'WSTG-INFO-02': ['web-deployment-hygiene', 'fingerprint-and-metafiles'],
  'WSTG-INFO-03': ['web-deployment-hygiene', 'fingerprint-and-metafiles'],
  'WSTG-INFO-04': ['attack-surface-mapping', ''],
  'WSTG-INFO-05': ['web-deployment-hygiene', 'content-and-backup-exposure'],
  'WSTG-INFO-06': ['web-route-input-inventory', ''],
  'WSTG-INFO-07': ['web-route-input-inventory', ''],
  'WSTG-INFO-08': ['web-deployment-hygiene', 'fingerprint-and-metafiles'],
  'WSTG-INFO-10': ['attack-surface-mapping', ''],
  'WSTG-CONF-02': ['web-deployment-hygiene', 'platform-config-and-flags'],
  'WSTG-CONF-04': ['web-deployment-hygiene', 'content-and-backup-exposure'],
  'WSTG-CONF-05': ['web-deployment-hygiene', 'content-and-backup-exposure'],
  'WSTG-CONF-06': ['web-deployment-hygiene', 'response-headers-methods-cache'],
  'WSTG-CONF-07': ['web-deployment-hygiene', 'response-headers-methods-cache'],
  'WSTG-CONF-09': ['web-deployment-hygiene', 'platform-config-and-flags'],
  'WSTG-CONF-12': ['web-browser-trust-controls', 'cross-origin-and-framing-policy'],
  'WSTG-CONF-13': ['parser-differential-auditing', ''],
  'WSTG-CONF-14': ['web-deployment-hygiene', 'response-headers-methods-cache'],
  'WSTG-CONF-15': ['web-deployment-hygiene', 'platform-config-and-flags'],
  'WSTG-IDNT-01': ['web-object-authorization', 'roles-and-field-exposure'],
  'WSTG-IDNT-02': ['web-credential-lifecycle', 'account-creation-and-enumeration'],
  'WSTG-IDNT-03': ['web-credential-lifecycle', 'account-creation-and-enumeration'],
  'WSTG-IDNT-04': ['web-credential-lifecycle', 'account-creation-and-enumeration'],
  'WSTG-ATHN-02': ['web-credential-lifecycle', 'credential-policy-and-defaults'],
  'WSTG-ATHN-03': ['web-credential-lifecycle', 'lockout-and-recovery'],
  'WSTG-ATHN-04': ['authorization-auditing', ''],
  'WSTG-ATHN-05': ['web-credential-lifecycle', 'mfa-and-remember-me'],
  'WSTG-ATHN-06': ['web-deployment-hygiene', 'response-headers-methods-cache'],
  'WSTG-ATHN-07': ['web-credential-lifecycle', 'credential-policy-and-defaults'],
  'WSTG-ATHN-08': ['web-credential-lifecycle', 'lockout-and-recovery'],
  'WSTG-ATHN-09': ['web-credential-lifecycle', 'lockout-and-recovery'],
  'WSTG-ATHN-10': ['authorization-auditing', ''],
  'WSTG-ATHN-11': ['web-credential-lifecycle', 'mfa-and-remember-me'],
  'WSTG-ATHZ-01': ['web-server-side-injection', 'outbound-requests-and-paths'],
  'WSTG-ATHZ-02': ['web-object-authorization', ''],
  'WSTG-ATHZ-03': ['web-object-authorization', ''],
  'WSTG-ATHZ-04': ['web-object-authorization', ''],
  'WSTG-ATHZ-05': ['web-token-and-federation', 'delegated-authorization-flow'],
  'WSTG-SESS-01': ['web-session-management', 'token-issuance-and-attributes'],
  'WSTG-SESS-02': ['web-session-management', 'token-issuance-and-attributes'],
  'WSTG-SESS-03': ['web-session-management', 'fixation-and-hijack'],
  'WSTG-SESS-04': ['web-session-management', 'token-issuance-and-attributes'],
  'WSTG-SESS-05': ['web-browser-trust-controls', 'request-origin-enforcement'],
  'WSTG-SESS-06': ['web-session-management', 'logout-timeout-concurrency'],
  'WSTG-SESS-07': ['web-session-management', 'logout-timeout-concurrency'],
  'WSTG-SESS-08': ['web-session-management', 'fixation-and-hijack'],
  'WSTG-SESS-09': ['web-session-management', 'fixation-and-hijack'],
  'WSTG-SESS-10': ['web-token-and-federation', 'signed-token-verification'],
  'WSTG-SESS-11': ['web-session-management', 'logout-timeout-concurrency'],
  'WSTG-INJT-01': ['web-output-context', ''],
  'WSTG-INJT-02': ['web-output-context', ''],
  'WSTG-INJT-04': ['parser-differential-auditing', 'http-framing-and-parameters'],
  'WSTG-INJT-05': ['web-server-side-injection', 'query-languages'],
  'WSTG-INJT-06': ['web-server-side-injection', 'query-languages'],
  'WSTG-INJT-07': ['web-server-side-injection', 'document-parsers'],
  'WSTG-INJT-08': ['web-server-side-injection', 'process-and-template-interpreters'],
  'WSTG-INJT-09': ['web-server-side-injection', 'document-parsers'],
  'WSTG-INJT-10': ['web-server-side-injection', 'stored-and-second-order-effects'],
  'WSTG-INJT-11': ['web-server-side-injection', 'process-and-template-interpreters'],
  'WSTG-INJT-12': ['web-server-side-injection', 'process-and-template-interpreters'],
  'WSTG-INJT-13': ['web-server-side-injection', 'representation-dependent-behavior'],
  'WSTG-INJT-14': ['web-server-side-injection', 'stored-and-second-order-effects'],
  'WSTG-INJT-15': ['parser-differential-auditing', 'http-framing-and-parameters'],
  'WSTG-INJT-16': ['parser-differential-auditing', ''],
  'WSTG-INJT-17': ['attack-surface-mapping', 'host-header-trust'],
  'WSTG-INJT-18': ['deserialization-and-dispatch-auditing', ''],
  'WSTG-INJT-19': ['web-server-side-injection', 'outbound-requests-and-paths'],
  'WSTG-INJT-20': ['web-object-authorization', 'roles-and-field-exposure'],
  'WSTG-INJT-21': ['web-server-side-injection', 'stored-and-second-order-effects'],
  'WSTG-INJT-22': ['deserialization-and-dispatch-auditing', ''],
  'WSTG-INJT-23': ['deserialization-and-dispatch-auditing', ''],
  'WSTG-ERRH-01': ['web-deployment-hygiene', 'error-disclosure'],
  'WSTG-CRYP-01': ['web-deployment-hygiene', 'transport-security'],
  'WSTG-CRYP-02': ['web-crypto-usage-review', 'decryption-error-path-observation'],
  'WSTG-CRYP-03': ['web-deployment-hygiene', 'transport-security'],
  'WSTG-CRYP-04': ['web-crypto-usage-review', 'primitive-and-parameter-review'],
  'WSTG-BUSL-01': ['web-business-logic-misuse', 'invariants-and-misuse-cases'],
  'WSTG-BUSL-02': ['web-business-logic-misuse', 'invariants-and-misuse-cases'],
  'WSTG-BUSL-03': ['web-business-logic-misuse', 'invariants-and-misuse-cases'],
  'WSTG-BUSL-04': ['web-business-logic-misuse', 'workflow-order-timing-and-defenses'],
  'WSTG-BUSL-05': ['race-condition-auditing', 'usage-limit-bypass'],
  'WSTG-BUSL-06': ['web-business-logic-misuse', 'workflow-order-timing-and-defenses'],
  'WSTG-BUSL-07': ['web-business-logic-misuse', 'workflow-order-timing-and-defenses'],
  'WSTG-BUSL-08': ['web-business-logic-misuse', 'file-upload-acceptance'],
  'WSTG-BUSL-09': ['web-business-logic-misuse', 'file-upload-acceptance'],
  'WSTG-BUSL-10': ['web-business-logic-misuse', 'payment-and-pricing'],
  'WSTG-CLNT-01': ['web-output-context', ''],
  'WSTG-CLNT-02': ['web-output-context', ''],
  'WSTG-CLNT-03': ['web-output-context', ''],
  'WSTG-CLNT-04': ['web-browser-trust-controls', 'client-side-navigation-and-resource-sinks'],
  'WSTG-CLNT-05': ['web-browser-trust-controls', 'client-side-navigation-and-resource-sinks'],
  'WSTG-CLNT-06': ['web-browser-trust-controls', 'client-side-navigation-and-resource-sinks'],
  'WSTG-CLNT-07': ['web-browser-trust-controls', 'cross-origin-and-framing-policy'],
  'WSTG-CLNT-09': ['web-browser-trust-controls', 'cross-origin-and-framing-policy'],
  'WSTG-CLNT-10': ['web-browser-trust-controls', 'request-origin-enforcement'],
  'WSTG-CLNT-11': ['web-browser-trust-controls', 'messaging-storage-and-outbound-links'],
  'WSTG-CLNT-12': ['web-browser-trust-controls', 'messaging-storage-and-outbound-links'],
  'WSTG-CLNT-13': ['web-browser-trust-controls', 'cross-origin-and-framing-policy'],
  'WSTG-CLNT-14': ['web-browser-trust-controls', 'messaging-storage-and-outbound-links'],
  'WSTG-CLNT-15': ['web-browser-trust-controls', 'client-side-navigation-and-resource-sinks'],
  'WSTG-APIT-01': ['web-route-input-inventory', ''],
  'WSTG-APIT-02': ['web-object-authorization', ''],
  'WSTG-APIT-03': ['web-object-authorization', 'roles-and-field-exposure'],
  'WSTG-APIT-04': ['web-object-authorization', ''],
  'WSTG-APIT-99': ['web-graphql-testing', 'schema-exposure-and-query-bounds'],
};

export const WSTG_MAP: readonly WstgTest[] = ROWS.map(([id, title, support, flags, phase, skills]) => {
  const [trigger, modes] = FEATURES[id] ?? ['', ''], [owner, card] = OWNERS[id] ?? ['', ''];
  return { id, title, support, browser: flags.includes('B'), identity: flags.includes('I'), phase, skills, trigger: trigger ? trigger.split(',') : [], modes, owner, card };
});
/** `WSTG-ATHZ-04` becomes `wstg-athz-04`, a valid `key()` value for questionKey. */
export const wstgKey = (id: string): string => id.toLowerCase();
export const WSTG_BY_KEY: ReadonlyMap<string, WstgTest> = new Map(WSTG_MAP.map(test => [wstgKey(test.id), test]));
export const isWstgKey = (key: string): boolean => key.startsWith('wstg-');

/** The markdown rows of docs/WSTG_MAP.md, so the document and the data cannot drift (checked by a test; regenerate with scripts/render-wstg-map.mjs). */
export function wstgTableRows(): string[] {
  return WSTG_MAP.map(test => `| ${wstgKey(test.id)} | ${test.id} | ${test.title} | ${test.support} | ${`${test.browser ? 'B' : ''}${test.identity ? 'I' : ''}` || '-'} | ${test.phase} | ${test.skills.length ? test.skills.map(name => name === test.owner ? `**${name}**` : name).join(', ') : '-'} | ${test.trigger.length ? test.trigger.join(', ') : '-'} | ${test.modes || '-'} |`);
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
  const tested = live.filter(cell => isTestedCell(cell));
  if (tested.some(cell => cell.currentness === 'current' && cell.caseRefs.some(ref => accepted.has(`${ref.caseId}@${ref.revision}`)))) return 'L3';
  if (tested.some(cell => cell.currentness === 'current')) return 'L2';
  if (tested.length || live.some(cell => cell.execution === 'attempted' || cell.execution === 'blocked')) return 'L1';
  return 'L0';
}

/** Chapter number of each WSTG test group in the guide (the directory under document/4-Web_Application_Security_Testing starts with it). */
const GROUP_NUMBER: Readonly<Record<string, string>> = { INFO: '01', CONF: '02', IDNT: '03', ATHN: '04', ATHZ: '05', SESS: '06', INPV: '07', ERRH: '08', CRYP: '09', BUSL: '10', CLNT: '11', APIT: '12' };
const PAGE_ROOT = 'my_references/wstg/4-Web_Application_Security_Testing/';
/**
 * Address of one test's upstream page at the pinned commit, or undefined when the library did not register that page.
 * `paths` are the package-relative paths of the catalog's wstg-source documents (my_references/wstg/4-Web_Application_Security_Testing/<NN-group>/<NN-title>.md);
 * the page is found by the group's chapter number and the test's own number, so no title or directory name is guessed. The address is for the reader to open, never fetched.
 */
export function wstgPageUrl(id: string, paths: readonly string[]): string | undefined {
  const match = /^WSTG-([A-Z]{4})-(\d{2})$/.exec(id.toUpperCase()), group = match && GROUP_NUMBER[match[1]];
  if (!match || !group) return;
  const found = paths.find(path => { if (!path.startsWith(PAGE_ROOT)) return false; const [directory, file, ...rest] = path.slice(PAGE_ROOT.length).split('/'); return rest.length === 0 && directory?.startsWith(`${group}-`) && file?.startsWith(`${match[2]}-`); });
  return found ? `https://github.com/OWASP/wstg/blob/${WSTG_COMMIT}/document/4-Web_Application_Security_Testing/${found.slice(PAGE_ROOT.length)}` : undefined;
}

/**
 * Recon features recorded in the graph: values of the asset attribute `feature` (separators: whitespace , ; |), matched case-insensitively against WSTG_FEATURES.
 * `any` is never derived (it always matches already). Unknown words are returned in `ignored` (at most 10) so the caller can show what was not understood.
 */
export function featuresFromAttributeValues(values: readonly string[]): { features: string[]; ignored: string[] } {
  const seen = new Set<string>(), ignored = new Set<string>();
  for (const value of values) for (const token of value.toLowerCase().split(/[\s,;|]+/)) {
    if (!token || token === 'any') continue;
    if ((WSTG_FEATURES as readonly string[]).includes(token)) seen.add(token); else if (ignored.size < 10) ignored.add(token);
  }
  return { features: WSTG_FEATURES.filter(feature => seen.has(feature)), ignored: [...ignored] };
}

export interface WstgSuggestion { key: string; title: string; support: WstgSupport; flags: string; owner: string; card: string; phase: WstgTest['phase'] }
/**
 * Planning aid: the in-scope tests whose trigger matches one of the recon features the caller names (`any` always matches) and that have no live cell yet,
 * in map order. Pure and read-only; a suggestion is not a finding, not permission and not coverage until a cell records it.
 */
export function wstgSuggest(features: readonly string[], options: { modes?: string; covered: ReadonlySet<string>; offset?: number; limit?: number }): { matched: number; suggestions: WstgSuggestion[] } {
  const wanted = new Set(features), matches = WSTG_MAP.filter(test => test.trigger.length > 0 && !options.covered.has(wstgKey(test.id))
    && (test.trigger.includes('any') || test.trigger.some(feature => wanted.has(feature))) && (!options.modes || [...options.modes].some(mode => test.modes.includes(mode))));
  const offset = options.offset ?? 0, limit = options.limit ?? 20;
  return { matched: matches.length, suggestions: matches.slice(offset, offset + limit).map(test => ({ key: wstgKey(test.id), title: test.title, support: test.support, flags: `${test.browser ? 'B' : ''}${test.identity ? 'I' : ''}`, owner: test.owner, card: test.card, phase: test.phase })) };
}

type FeatureAsset = { assetId: string; features: readonly string[] };
/**
 * A6.4 in planning_update.md: the applicable-test denominator. A row applies when one of its trigger features is recorded on an asset; `any` is the vocabulary's
 * always-match trigger (docs/WSTG_MAP.md), so it applies to every asset that records at least one recognised feature. Feature values are normalised with
 * featuresFromAttributeValues, so raw values like "API, cors ; jwt" are accepted and unknown tokens are ignored, never refused. Browser rows are dropped unless
 * `browser` is true and identity rows unless `identity` is true; both are caller-supplied capability facts, and the shipped run supplies both (`src/debt.ts`),
 * because the sandbox image carries the browser transport and a worker provisions its own principals. One row per test in WSTG_MAP order, carrying the
 * sorted unique asset ids that made it applicable. Pure, deterministic, no I/O: being applicable is a planning hint, not permission and not coverage.
 */
export function applicableTests(assets: readonly FeatureAsset[], options: { browser?: boolean; identity?: boolean } = {}): { test: WstgTest; assets: string[] }[] {
  const byAsset = new Map<string, Set<string>>();
  for (const asset of assets) {
    const known = byAsset.get(asset.assetId) ?? new Set<string>();
    for (const feature of featuresFromAttributeValues(asset.features).features) known.add(feature);
    if (known.size) byAsset.set(asset.assetId, known);
  }
  const rows: { test: WstgTest; assets: string[] }[] = [];
  for (const test of WSTG_MAP) {
    if (!test.trigger.length || (test.browser && !options.browser) || (test.identity && !options.identity)) continue;
    const matched = [...byAsset].filter(([, features]) => test.trigger.includes('any') || test.trigger.some(feature => features.has(feature))).map(([assetId]) => assetId).sort();
    if (matched.length) rows.push({ test, assets: matched });
  }
  return rows;
}

/**
 * A6.4 in planning_update.md: `applicableTests` minus the tests a live cell already covers, in the shape debt's WSTG_UNPLANNED entry needs. A test counts as
 * covered when `wstgKey(test.id)` is in `options.covered`. key/title/support/flags carry the same values `wstgSuggest` returns, assetIds are the assets that made
 * the row applicable, and detail is one deterministic ASCII sentence under 300 characters (no markdown) a report can print. Pure and read-only; a suggestion is
 * not a finding, not permission and not coverage.
 */
export function unplannedTests(assets: readonly FeatureAsset[], options: { browser?: boolean; identity?: boolean; covered?: ReadonlySet<string> } = {}): { key: string; title: string; support: WstgSupport; flags: string; assetIds: string[]; detail: string }[] {
  const covered = options.covered ?? new Set<string>();
  return applicableTests(assets, options).filter(({ test }) => !covered.has(wstgKey(test.id))).map(({ test, assets: assetIds }) => {
    const flags = `${test.browser ? 'B' : ''}${test.identity ? 'I' : ''}`;
    return { key: wstgKey(test.id), title: test.title, support: test.support, flags, assetIds, detail: `${test.title} (${test.support}${flags ? `, ${flags}` : ''}) applies to recorded feature(s) on ${assetIds.length} asset${assetIds.length === 1 ? '' : 's'}` };
  });
}
