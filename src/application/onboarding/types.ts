import type { BundledRuntimeEnvironment } from './runtime-prerequisites.js';

/** Owner-authored scope consent, not a run manifest, model plan, or independently verified ownership proof. */
export interface OnboardingTarget {
  kind: 'local-dir' | 'github-repo' | 'http-url';
  raw: string;
  locator: string;
}
export interface OwnerScope {
  target: OnboardingTarget;
  /** No implicit extra hosts, redirects, symlink targets, repositories or URL paths. */
  boundary: 'directory-tree-no-symlinks' | 'single-repository' | 'exact-url-no-redirects';
}
export interface OwnerPermissions {
  readStatic: true;
  repositoryScripts: boolean;
  stateChanges: boolean;
}
export type OwnerAction = 'read' | 'analyze' | 'repo-script' | 'state-change';
export interface OwnerLimits {
  maxCostUsd: number;
  maxRequests: number;
  maxTokens: number;
  maxToolCalls: number;
  maxAttempts: number;
  deadlineMs: number;
  concurrency: number;
}
export interface OwnerConfiguration {
  schemaVersion: 1;
  owner: { uid: number };
  scope: OwnerScope;
  authorization: {
    /** `public-source-review` covers publicly accessible source only: static read/clone and static
     *  analysis. It never implies authority to test the hosting service or to run scripts/state changes. */
    basis: 'owner' | 'written-permission' | 'published-program' | 'public-source-review';
    reference: string;
    /** UI attestation is not evidence that a third party verified legal ownership. */
    attestation: 'human-self-attested';
  };
  permissions: OwnerPermissions;
  allowedActions: OwnerAction[];
  limits: OwnerLimits;
  disclosure: { version: 1; modelCosts: true; modelDataSharing: true; planOnlyTargetIO: 0 };
}
export interface ConsentReceipt {
  schemaVersion: 1;
  receiptId: string;
  source: 'human-ui';
  kind: 'scope-consent-not-plan-approval';
  ownerUid: number;
  confirmedAt: string;
  configurationDigest: string;
  previousConfigurationDigest: string | null;
  disclosureVersion: 1;
}
export interface OwnerConsentBundle {
  schemaVersion: 1;
  configuration: OwnerConfiguration;
  receipt: ConsentReceipt;
}
export interface OnboardingReady {
  status: 'ready';
  configuration: OwnerConfiguration;
  /** Per-invocation narrowing of saved owner consent. Never exceeds configuration.limits. */
  effectiveLimits: OwnerLimits;
  effectivePermissions: OwnerPermissions;
  /** Canonical private bundle path. Config and receipt share one atomic publication. */
  configPath: string;
  receiptPath: string;
  reused: boolean;
}
export type OnboardingResult = OnboardingReady
  | { status: 'cancelled' }
  | { status: 'unsupported'; code: 'ONBOARDING_UI_UNSUPPORTED'; message: string };
export interface OnboardingUI {
  confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean>;
  select(title: string, options: string[], dialogOptions?: { signal?: AbortSignal }): Promise<string | undefined>;
  input(title: string, placeholder?: string, options?: { signal?: AbortSignal }): Promise<string | undefined>;
  notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
}
/**
 * Owner-selectable ceiling profile for the one-dialog quick path.
 *
 * Every profile is a finite, validated set of limits; none of them is unbounded, because an unbounded
 * spend cap and an unbounded deadline stop being guards. `wide` is the default so that a normal run needs
 * no questions, and `ceiling` uses the engine's validated maxima when an owner genuinely wants that.
 */
export type OnboardingProfile = 'conservative' | 'wide' | 'ceiling';
export interface OnboardingInput {
  target: OnboardingTarget;
  cwd: string;
  hasUI: boolean;
  ui?: OnboardingUI;
  signal?: AbortSignal;
  /** Requests may narrow existing consent. Expansion always needs new human UI confirmation. */
  limits?: Partial<OwnerLimits>;
  permissions?: Partial<Pick<OwnerPermissions, 'repositoryScripts' | 'stateChanges'>>;
  /**
   * `quick` asks exactly one consent dialog built from the selected profile; `guided` asks every question
   * separately. Quick mode never grants more than the profile plus these explicit requests, and the dialog
   * always shows the exact limits, rights and authorization basis being consented to.
   */
  mode?: 'quick' | 'guided';
  /** Quick-mode ceiling profile; ignored in guided mode, which asks for each value. */
  profile?: OnboardingProfile;
  /** Quick-mode authorization basis. Defaults per target kind and is always shown in the consent dialog. */
  basis?: OwnerConfiguration['authorization']['basis'];
  /** Optional authorization reference text; the basis default is used when omitted. */
  reference?: string;
}
export interface OnboardingOptions {
  /** Host-only override, never taken from command arguments, model content or target files. */
  storageRoot?: string;
  now?: () => number;
  /**
   * Host-only readiness seam for the bundled-runtime check: the package root and environment to validate.
   * Production omits it and validates the discovered package root with the real environment. It is never
   * taken from command arguments, target content, UI input or model output.
   */
  runtime?: BundledRuntimeEnvironment;
}
export type OnboardingHandler = (input: OnboardingInput) => Promise<OnboardingResult>;
export class OnboardingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'OnboardingError';
  }
}
