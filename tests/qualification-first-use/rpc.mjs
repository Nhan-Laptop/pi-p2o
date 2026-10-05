import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync } from 'node:fs';

export const GITHUB = 'https://github.com/octocat/Hello-World';
/** Owner-authorized fixed public read-only fixture commit. Verified 2026-10-03 via GitHub API HTTP 200
 *  and `git ls-remote` (the earlier parent-supplied hash was wrong). Deliberate fixture pin; NOT permission
 *  for production auto-repin — production still requires an owner-approved full commit. */
export const GITHUB_COMMIT = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
/** Superseded pin that does NOT exist upstream; retained ONLY so the negative mismatch test stays covered. */
export const GITHUB_COMMIT_SUPERSEDED = '7fd1a60b01f91b314f59955a4e4b2d59b3d22937';
export const CONSENT_LABEL = 'automated-human-consent-simulation';
/** Live-model runs. Still automated consent simulation (no human in the loop); the parent explicitly authorized
 *  the provider budget. Never describes the run as a human-operated TUI qualification. */
export const LIVE_CONSENT_LABEL = 'automated-consent-simulation-live-provider-parent-authorized';
export const LIVE_SELECTION = Object.freeze({ provider: 'deepseek', model: 'deepseek-flash', thinking: 'max' });

/** Answers REAL extension_ui_request records. Unknown prompts are CANCELLED, never blindly approved. */
export function answerDialog(request, { decline, kind = 'local', live, liveLimits, preflight } = {}) {
  const title = request.title ?? '';
  const response = { type: 'extension_ui_response', id: request.id };
  if (request.method === 'confirm') {
    // Ordinary /p2o consent has no budget/quota dialog: the model confirmation is either the accounting-only
    // 'Use this Pi assessment model?' or the legacy bounded 'Use this assessment model and bounded planning spend?'.
    const known = /^(First-use owner consent:|Scope\/rights\/limits renewal or expansion:|Save this owner-only scope consent\?|Use this (?:Pi assessment model|assessment model and bounded planning spend)\?|Qualify the pinned dedicated-lab container boundary\?|Consent to scoped TOOL PACK|Confirm ONE local TOOL PACK|Approve p2o (run|plan) |Approve plan |Approve immutable source for the exact model plan\?|Proceed with observation-only assessment \(no independent verification\)\?)/.test(title);
    if (!known) return { ...response, cancelled: true, reason: 'UNRECOGNIZED_CONFIRMATION' };
    if (decline && title.includes(decline)) return { ...response, confirmed: false };
    if (title.startsWith('Approve immutable source') && kind === 'github' && !request.message?.includes(`Commit: ${GITHUB_COMMIT}`)) {
      return { ...response, confirmed: false, reason: 'PINNED_GITHUB_COMMIT_MISMATCH' };
    }
    return { ...response, confirmed: true };
  }
  if (request.method === 'select') {
    // Zero-cost live preflight: stop at the model dialog so provider availability is proven with no completion.
    // Zero-cost live preflight: answer the model dialog, then abort at the thinking dialog so BOTH the
    // authorized model and the authorized thinking level are observed with no completion and no provider call.
    if (preflight && (request.title ?? '').startsWith('Assessment thinking')) {
      return { ...response, cancelled: true, reason: 'LIVE_PREFLIGHT_ABORT_NO_PROVIDER_CALL' };
    }
    const choices = request.options ?? [];
    let value;
    // Public source review is the honest basis for a public repository; owner/written-permission are not true there.
    if (title.startsWith('What is your authorization basis')) value = choices[kind === 'github' ? 3 : 0];
    else if (title.startsWith('Read/static analysis') || title.startsWith('Separately permit state-changing')) value = choices.find(option => option.startsWith('No —'));
    else if (title.startsWith('Assessment model')) value = live
      ? choices.find(option => option.startsWith(`${live.provider}/${live.model}`) && !option.includes('BLOCKED'))
      : choices.find(option => option.startsWith('inert-fixture/inert-worker') && !option.includes('BLOCKED'));
    else if (title.startsWith('Assessment thinking')) value = live
      ? choices.find(option => option === live.thinking)
      : choices.find(option => option === 'off');
    // Ordinary first-use asks for the pinned container tool boundary explicitly; the harness always answers that
    // exact option, and any other pack boundary is declined (never silently substituted).
    else if (title.startsWith('First-use tool boundary')) value = choices.find(option => option.startsWith('Pinned container static pack'));
    else if (title.startsWith('TOOL PACK ')) value = choices[0];
    if (value) return { ...response, value };
    return { ...response, cancelled: true, reason: live ? `LIVE_SELECTION_UNAVAILABLE: ${title}`.slice(0, 200) : 'UNRECOGNIZED_OR_UNSUPPORTED_SELECTION' };
  }
  if (request.method === 'input') {
    const fields = [
      ['Authorization reference', kind === 'github' ? 'User-authorized public read-only fixed-commit clone; no push, issues, scans or repository execution' : 'Harness owns this exact isolated source or loopback fixture; automated human consent simulation'],
      ['Total USD ceiling', '2'], ['Maximum target requests', '1'], ['Maximum model tokens', '400000'],
      ['Maximum tool calls', '8'], ['Maximum worker attempts', '2'], ['Maximum concurrent workers', '1'], ['Deadline in minutes', '5'],
    ];
    // Live runs bind the owner budget to the parent-authorized cap instead of the mechanical fixture values.
    const liveFields = live && liveLimits ? [
      ['Total USD ceiling', String(liveLimits.usd)], ['Maximum target requests', String(liveLimits.requests)],
      ['Maximum model tokens', String(liveLimits.tokens)], ['Maximum tool calls', String(liveLimits.toolCalls)],
      ['Maximum worker attempts', String(liveLimits.attempts)], ['Maximum concurrent workers', String(liveLimits.concurrency)],
      ['Deadline in minutes', String(liveLimits.deadlineMinutes)],
    ] : [];
    const value = [...liveFields, ...fields].find(([prefix]) => title.startsWith(prefix))?.[1];
    return value ? { ...response, value } : { ...response, cancelled: true, reason: 'UNRECOGNIZED_INPUT' };
  }
  return undefined;
}

export class PiRpc {
  records = []; stderr = ''; sequence = 0; pending = new Map(); prompts = []; exit = undefined;
  constructor({ binary, args, cwd, env, log, stderrPath, kind, decline, live, liveLimits, preflight, beforeDialog = async () => {} }) {
    this.log = log; this.kind = kind; this.decline = decline; this.live = live; this.liveLimits = liveLimits; this.preflight = preflight;
    appendFileSync(stderrPath, '', { mode: 0o600 });
    this.child = spawn(binary, args, { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.exit = { code, signal }; for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Pi exited ${code}/${signal}`)); }
      this.pending.clear(); resolve(this.exit);
    }));
    this.child.once('error', error => { for (const waiter of this.pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); } this.pending.clear(); });
    this.child.stderr.on('data', bytes => { this.stderr += bytes.toString(); appendFileSync(stderrPath, bytes, { mode: 0o600 }); });
    const decoder = new StringDecoder('utf8'); let buffer = '';
    this.child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes);
      for (;;) {
        const index = buffer.indexOf('\n'); if (index < 0) break;
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!line) continue;
        let record;
        try { record = JSON.parse(line); } catch {
          this.record('protocol-error', { line: line.slice(0, 1000) }); continue;
        }
        this.records.push(record); this.record('receive', record);
        if (record.type === 'response') {
          const waiter = this.pending.get(record.id);
          if (waiter) { this.pending.delete(record.id); clearTimeout(waiter.timer); waiter.resolve(record); }
        }
        if (record.type === 'extension_ui_request' && ['confirm', 'select', 'input', 'editor'].includes(record.method)) {
          void (async () => {
            const at = Date.now(); await beforeDialog(record);
            const answer = answerDialog(record, { kind, decline, live, liveLimits, preflight });
            this.prompts.push({ at, request: record, answer, label: live ? LIVE_CONSENT_LABEL : CONSENT_LABEL });
            this.record('consent-simulation', this.prompts.at(-1));
            // reason is local evidence only; not a protocol property.
            const { reason: _reason, ...wire } = answer ?? { type: 'extension_ui_response', id: record.id, cancelled: true };
            this.send(wire);
          })().catch(error => {
            this.record('ui-driver-error', { error: error.message });
            this.send({ type: 'extension_ui_response', id: record.id, cancelled: true });
          });
        }
      }
    });
    this.record('invocation', { binary, args, cwd, pid: this.child.pid,
      environment: { HOME: env.HOME, PI_CODING_AGENT_DIR: env.PI_CODING_AGENT_DIR,
        P2O_CONFIG: env.P2O_CONFIG ?? null, P2O_APP_CONFIG: env.P2O_APP_CONFIG ?? null,
        P2O_CONTROL_MODULE: env.P2O_CONTROL_MODULE ?? null, P2O_PLAN_AUTHOR_MODULE: env.P2O_PLAN_AUTHOR_MODULE ?? null,
        inheritedCredentials: false,
        providerCredential: live ? 'explicit-single-provider-key-injected-for-live-run-value-never-logged' : 'none-inert-fixture' } });
  }
  record(direction, record) { appendFileSync(this.log, `${JSON.stringify({ at: Date.now(), direction, record })}\n`, { mode: 0o600 }); }
  send(record) {
    this.record('send', record);
    if (this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }
  request(type, fields = {}, timeout = 70000) {
    const id = `qualification-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC_TIMEOUT: ${type} ${JSON.stringify(fields)}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, type, ...fields });
    });
  }
  async command(message) {
    const before = (await this.request('get_messages')).data?.messages?.length ?? 0;
    const response = await this.request('prompt', { message });
    if (!response.success) return { response, error: response.error };
    const read = await this.request('get_messages');
    const messages = (read.data?.messages ?? []).slice(before);
    const outcome = messages.findLast(item => item.customType === 'p2o_result' || item.customType === 'p2o_error');
    return { response, outcome, error: outcome?.customType === 'p2o_error' ? outcome.content : undefined };
  }
  async close() {
    if (this.exit) return this.exit;
    this.child.stdin.end();
    const completed = await Promise.race([this.closed, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 12000); timer.unref(); })]);
    if (completed) return completed;
    // Exact child identity from spawn; no broad signal or pkill. Runtime cleanup is NOT inferred from this.
    this.record('shutdown-timeout', { pid: this.child.pid }); this.child.kill('SIGTERM');
    return await Promise.race([this.closed, new Promise(resolve => { const timer = setTimeout(() => resolve({ code: null, signal: 'shutdown-unverified' }), 3000); timer.unref(); })]);
  }
}
