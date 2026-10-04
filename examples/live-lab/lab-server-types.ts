// Structural type for the loopback lab instance returned by `examples/live-lab/lab-server.mjs`.
//
// The lab target is intentionally dependency-free plain JavaScript (it is also the hashed source snapshot
// the pinned offline pack analyses), so its shape is declared here instead of derived from a compiled
// module. Only types live in this file.
export interface LabItem {
  readonly id: string;
  readonly tenant: string;
  readonly label: string;
  readonly value: string;
}

export interface LabInstance {
  readonly origin: string;
  readonly port: number;
  readonly environmentId: string;
  readonly instanceId: string;
  readonly configurationDigest: string;
  readonly items: readonly LabItem[];
  readonly requests: number;
  /** Minted session token for a seeded account (owner-side only; the broker injects it at dispatch). */
  tokenFor(accountId: string): string | undefined;
  close(): Promise<void>;
}
