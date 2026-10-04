import { open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { attemptKey } from "./filesystem-hooks.js";
import { readJson } from "./io.js";
import { alive, processIdentity, sameProcess } from "./processes.js";
import type { ProcessIdentity, ProcessProbe, RuntimeHandle } from "./types.js";

interface Lease { instance: string; token: string; process: ProcessIdentity }
/**
 * Prevents two live supervisor instances from controlling/publishing the SAME attempt.
 *
 * [B4] `identity()` exposes the kernel identity this fence already resolved for its own process, so the
 * session lease does not have to repeat the same `/proc` inventory on every attempt start.
 */
export class ControllerLease {
  private readonly instance = randomUUID();
  /** This supervisor process's own kernel identity, resolved on the first fence acquisition. */
  private own?: ProcessIdentity;
  constructor(private readonly root: string, private readonly probe: ProcessProbe) {}
  /** [B4] The identity already proven by this fence; no extra inventory is needed for session leases. */
  identity(): ProcessIdentity | undefined { return this.own; }
  private file(h: RuntimeHandle): string { return path.join(this.root, `controller-${attemptKey(h)}-${h.ownerToken}.lock`); }
  async acquire(h: RuntimeHandle): Promise<boolean> {
    const rows = await this.probe.snapshot();
    const own = rows.find((p) => p.pid === process.pid && alive(p));
    if (!own) throw new Error("Cannot identify supervisor process for durable control fencing");
    this.own ??= processIdentity(own);
    const lease: Lease = { instance: this.instance, token: h.ownerToken, process: this.own };
    const create = async (): Promise<boolean> => {
      let fd;
      try { fd = await open(this.file(h), "wx", 0o600); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
      try { await fd.writeFile(JSON.stringify(lease)); await fd.sync(); } finally { await fd.close(); }
      return true;
    };
    if (await create()) return true;
    const old = await readJson<Lease>(this.file(h), 4096);
    if (!old || old.token !== h.ownerToken) throw new Error("Corrupt controller ownership receipt");
    if (old.instance === this.instance) return true;
    if (rows.some((p) => sameProcess(p, old.process) && alive(p))) return false;
    // Serialize reclaimers. An interrupted reclaim is quarantined, never auto-deleted.
    const gate = `${this.file(h)}.reclaim`;
    let fd;
    try { fd = await open(gate, "wx", 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return false; throw e; }
    try {
      const current = await readJson<Lease>(this.file(h), 4096);
      if (JSON.stringify(current) !== JSON.stringify(old)) return false;
      const fresh = await this.probe.snapshot();
      if (fresh.some((p) => sameProcess(p, old.process) && alive(p))) return false;
      await unlink(this.file(h));
      return await create();
    } finally { await fd.close(); await unlink(gate); }
  }
  async release(h: RuntimeHandle): Promise<void> {
    const old = await readJson<Lease>(this.file(h), 4096);
    if (!old) return;
    if (old.instance !== this.instance || old.token !== h.ownerToken) throw new Error("Stale supervisor cannot release controller fence");
    await unlink(this.file(h));
  }
}
