export type LabMode = "simulated" | "local" | "testnet";
export interface LabNetwork {
  mode: LabMode;
  mirrorUrl?: string;
  nodeAddress?: string;
  nodeAccountId?: string;
  operatorIdEnv?: string;
  operatorKeyEnv?: string;
}
export interface LabFixtures {
  accounts: Record<string, { hbar: number }>;
  tokens: Record<string, { treasury: string; supply: number }>;
  topics: string[];
}
export type Operation =
  | { type: "associate"; actor: string; token: string }
  | { type: "transferNft"; actor: string; to: string; token: string; serial: number }
  | { type: "transferHbar"; actor: string; to: string; amount: number }
  | { type: "submitMessage"; actor: string; topic: string; message: string };
export type Assertion =
  | { type: "nftOwner"; token: string; serial: number; account: string }
  | { type: "topicMessage"; topic: string; message: string }
  | { type: "hbarBalance"; account: string; min: number; max: number }
  | { type: "text"; selector: string; equals: string };
export interface BrowserAction {
  type: "goto" | "click" | "fill";
  path?: string;
  selector?: string;
  value?: string;
}
export interface LabStep {
  id: string;
  operation?: Operation;
  planOperation?: { file: string; index: number };
  browser?: BrowserAction;
  assert?: Assertion;
  expectStatus?: string;
}
export interface LabScenario {
  schemaVersion: 1;
  name: string;
  network: LabNetwork;
  fixtures: LabFixtures;
  faults: { mirrorDelayMs: number; rejectActors: string[] };
  server?: { command: string; url: string; timeoutMs: number };
  steps: LabStep[];
  timeoutMs: number;
  pollIntervalMs: number;
}
export interface TxEvidence {
  status: string;
  transactionId: string;
  operation: Operation;
  consensusTimestamp?: string;
}
export interface LabEvent {
  id: string;
  kind: "fixture" | "transaction" | "assertion" | "browser" | "infrastructure" | "cleanup";
  status: "passed" | "failed" | "skipped";
  message: string;
  evidence?: unknown;
  durationMs: number;
  at: string;
}
export interface LabReport {
  applicationArtifacts?: Record<string, string>;
  funding?: Awaited<ReturnType<import("./funding.js").FundingMeter["reconcile"]>>;
  schemaVersion: 1;
  runId: string;
  name: string;
  scenarioPath: string;
  scenarioHash: string;
  mode: LabMode;
  passed: boolean;
  infrastructureFailure: boolean;
  startedAt: string;
  durationMs: number;
  events: LabEvent[];
  resources: PublicFixtures;
  browserExecuted: boolean;
}
export interface PublicFixtures {
  accounts: Record<string, string>;
  tokens: Record<string, string>;
  topics: Record<string, string>;
}
export interface Ledger {
  readonly mode: LabMode;
  readonly recoveryScope?: string;
  readonly resources: PublicFixtures;
  provision(fixtures: LabFixtures): Promise<void>;
  execute(operation: Operation, beforeSubmit?: (transactionId: string) => Promise<void>): Promise<TxEvidence>;
  reconcile?(transactionId: string, operation: Operation): Promise<TxEvidence | null>;
  observe(assertion: Exclude<Assertion, { type: "text" }>): Promise<{ matches: boolean; evidence: unknown }>;
  cleanup(): Promise<string[]>;
  close(): void;
}
export class LabInfrastructureError extends Error {}
