// Shared types for the live vertical slice. Owned by the live-lab workstream; no runtime behaviour.
import type { LabInstance } from './lab-server-types.js';

export type { LabInstance } from './lab-server-types.js';

export interface LabServerModule {
  readonly LAB_NAME: string;
  readonly LAB_VERSION: number;
  readonly LAB_ROUTES: readonly string[];
  readonly LAB_ITEMS: readonly { readonly id: string; readonly tenant: string; readonly label: string; readonly value: string }[];
  readonly LAB_ACCOUNTS: readonly { readonly accountId: string; readonly tenant: string; readonly role: string; readonly password: string }[];
  startLabServer(options: {
    environmentId: string;
    port: number;
    configurationDigest: string;
    instanceId?: string;
    /** Seeded account identities for this instance (defaults to the module's LAB_ACCOUNTS). */
    accounts?: readonly { accountId: string; tenant: string; role: string; password: string }[];
  }): Promise<LabInstance>;
  labOrigin(port: number): string;
}

/** The one pinned live selection this slice is allowed to dispatch. */
export interface LiveSelection {
  readonly provider: string;
  readonly model: string;
  readonly thinking: 'low';
}

/** Owner-declared provenance of the live provider credential; never the credential material. */
export interface LiveCredentialProvenance {
  readonly accountId: string;
  readonly version: string;
  readonly source: string;
}
