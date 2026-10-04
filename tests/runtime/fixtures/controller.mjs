import fs from "node:fs/promises";
import { createHeadlessRuntime } from "../../../src/runtime/index.js";
// Separate-process controller: dispatches one inert attempt, then publishes a durable handle as
// soon as the worker is provably executing. It never decides test outcomes; it reports them.
const settingsFile = process.argv[2];
const { options, request, readyFile } = JSON.parse(await fs.readFile(settingsFile, "utf8"));
// JSON cannot carry callbacks. Rehydrate ONLY this explicit inert-fixture no-resource declaration.
if (options.sessions?.releasers) options.sessions.releasers = options.sessions.releasers.map(releaser => {
  if (releaser.name !== 'inert-worker-no-pack-resources' || releaser.ownsNoResources !== true) throw new Error('Unsupported serialized fixture pack');
  return { ...releaser, release: async () => 0, outstanding: () => 0 };
});
const runtime = createHeadlessRuntime({ ...options, nodeBinary: process.execPath });
// A controller that cannot dispatch must fail the handshake with its own reason, not leave the test
// waiting for a file that will never appear.
const report = (reason) => fs.writeFile(`${readyFile}.error`, `${reason}\n`).catch(() => {});
let handle;
try { handle = await runtime.start(request); }
catch (error) { await report(`start rejected: ${error?.message ?? error}`); throw error; }
const terminal = ["completed", "failed", "cancelled", "timed-out", "stopped", "quarantined"];
while (Date.now() < request.deadlineAt + 10_000) {
  const snapshot = await runtime.collect(handle);
  if (snapshot.outcome === "running") { await fs.writeFile(readyFile, JSON.stringify(snapshot.handle)); break; }
  if (terminal.includes(snapshot.outcome)) { await report(`worker never reached running (outcome ${snapshot.outcome}${snapshot.handle.startupError ? `: ${snapshot.handle.startupError}` : ""})`); break; }
  await new Promise((r) => setTimeout(r, 20));
}
if (!(await fs.stat(readyFile).then(() => true, () => false))) await report(`dispatch handshake window exhausted (outcome ${(await runtime.collect(handle)).outcome})`);
setInterval(() => {}, 1000);
