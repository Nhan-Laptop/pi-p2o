#!/usr/bin/env node
// Inert, standalone public-RPC/TUI fixture. No network, model, or external target.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) { console.log("0.85.1"); process.exit(0); }
const config = JSON.parse(fs.readFileSync(process.env.P2O_CONFIG, "utf8"));
const modeFile = path.join(config.workspace, "fixture.json");
const mode = fs.existsSync(modeFile) ? JSON.parse(fs.readFileSync(modeFile, "utf8")) : {};
const session = JSON.parse(fs.readFileSync(config.sessionFile, "utf8").split("\n")[0]);
const selection = { ...config.requested, ...(mode.receiptMismatch ? { thinking: "off" } : {}) };
const receipt = { token: config.token, seq: 0, ready: !mode.noReady, events: [] };
const emit = (x) => {
  const bytes = Buffer.from(`${JSON.stringify(x)}\n`);
  if (mode.fragment && bytes.length > 3) { process.stdout.write(bytes.subarray(0, 2)); process.stdout.write(bytes.subarray(2)); }
  else process.stdout.write(bytes);
};
function record(type, assistant) {
  receipt.events.push({ seq: ++receipt.seq, at: Date.now(), type, selection, ...(assistant ? { assistant } : {}), ...(type === "agent_settled" ? { idle: true } : {}) });
  receipt.events = receipt.events.slice(-64);
  const tmp = `${config.receiptFile}.fixture.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(receipt)); fs.renameSync(tmp, config.receiptFile);
}
record("session_start");
fs.writeFileSync(path.join(config.workspace, "environment.json"), JSON.stringify({ env: process.env, config, argv: process.argv, pid: process.pid }));
if (mode.ignoreTerm) process.on("SIGTERM", () => {});
const keepalive = setInterval(() => {}, 1000);
let parent = null;
for (const line of fs.readFileSync(config.sessionFile, "utf8").trim().split("\n").slice(1)) { const e = JSON.parse(line); if (e.id) parent = e.id; }
let seq = 0;
function message(role, content) {
  const id = `fixture-${process.pid}-${++seq}`;
  fs.appendFileSync(config.sessionFile, `${JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date().toISOString(), message: { role, content, timestamp: Date.now() } })}\n`);
  parent = id;
}
// A held worker rewrites alive.json at this cadence (mirrored by HEARTBEAT_MS in the test file) so a
// test can prove from the worker's own evidence that it was still executing just before its deadline.
// It is replaced atomically (temp file + rename), exactly like the receipt ring below, so a reader can never
// observe a zero-length or half-written file — only the previous or the current heartbeat (R4 §11).
let heartbeat = null;
function heartbeats() {
  if (heartbeat) return;
  const file = path.join(config.workspace, "alive.json");
  const beat = () => {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: Date.now(), pid: process.pid }));
      fs.renameSync(tmp, file);
    } catch {}
  };
  beat();
  heartbeat = setInterval(beat, 250);
}
function prompt(text) {
  message("user", text);
  record("agent_start"); emit({ type: "agent_start" });
  fs.writeFileSync(path.join(config.workspace, "working.json"), JSON.stringify({ at: Date.now(), pid: process.pid }));
  if (mode.hold) heartbeats();
  if (mode.descendants) {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore", env: config.env });
    child.unref(); fs.writeFileSync(path.join(config.workspace, "descendant.json"), JSON.stringify({ pid: child.pid }));
  }
  if (mode.hugeFrame) { process.stdout.write(`{"type":"message_update","x":"${"x".repeat(350000)}"}\n`); return; }
  if (mode.noisy) {
    for (let i = 0; i < 500; i++) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "é".repeat(500) } });
    process.stderr.write("bounded fixture stderr ".repeat(40000));
  }
  if (mode.hold) return;
  if (mode.retry) { record("agent_end"); emit({ type: "agent_end" }); }
  const finish = () => {
    const assistant = { provider: config.requested.provider, model: mode.assistantMismatch ? "unrequested" : config.requested.model,
      stopReason: mode.assistantError ? "error" : "stop", ...(mode.assistantError ? { errorMessage: "inert provider failed" } : {}) };
    const output = "Inert result: é\u2028漢字";
    message("assistant", [{ type: "text", text: output }]);
    record("message_end", assistant); emit({ type: "message_end", message: { role: "assistant", ...assistant } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: output } });
    record("agent_end"); emit({ type: "agent_end" });
    record("agent_settled"); emit({ type: "agent_settled" });
    fs.writeFileSync(path.join(config.workspace, "settled.json"), JSON.stringify({ at: Date.now() }));
    setTimeout(() => { clearInterval(keepalive); process.exit(mode.nonzero ? 2 : 0); }, 35);
  };
  if (typeof mode.settleFile === 'string') {
    const timer = setInterval(() => { if (fs.existsSync(path.join(config.workspace, mode.settleFile))) { clearInterval(timer); finish(); } }, 25);
  } else setTimeout(finish, mode.delayMs ?? 500);
}
readline.createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  let command;
  try { command = JSON.parse(line); }
  catch { if (!process.argv.includes("rpc")) prompt(line); return; }
  if (command.type === "get_state") emit({ type: "response", id: command.id, command: "get_state", success: true,
    data: { model: { provider: config.requested.provider, id: config.requested.model }, thinkingLevel: mode.stateMismatch ? "off" : config.requested.thinking,
      sessionFile: config.sessionFile, sessionId: session.id, isStreaming: false } });
  else if (command.type === "prompt") { emit({ type: "response", id: command.id, command: "prompt", success: true }); prompt(command.message); }
});
