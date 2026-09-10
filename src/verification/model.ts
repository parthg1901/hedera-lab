import { createHash, randomUUID } from "node:crypto";
export type Mode = "simulated" | "testnet";
export class Fault extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const id = () => randomUUID();
export function canonical(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map((v) => canonical(v ?? null)).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function amount(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,15})$/.test(value))
    throw new Fault(
      400,
      "Amounts must be nonnegative integer tinybar strings (at most 16 digits)",
    );
  return BigInt(value);
}
export function label(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value)
  )
    throw new Fault(400, `Invalid ${name}`);
  return value;
}
export interface Pack {
  funding?: import("./contracts.js").FundingTerms;
  id: string;
  title: string;
  description: string;
  priceTinybar: string;
  scenario: string;
  workspace: string;
  driver?:
    | "lab"
    | "ticket-protocol"
    | "exchange-protocol"
    | "mainnet-preflight";
  risks?: string[];
}
export interface Mandate {
  id: string;
  target: string;
  revision: string;
  required: string[];
  ceiling: string;
  reserve: string;
  executionEnvironments?: import("./contracts.js").Environment[];
  executionCeilings?: Partial<Record<"local" | "testnet", string>>;
  tokenHash: string;
  createdAt: string;
}
export interface Selection {
  pack: string;
  repetitions: number;
}
export interface Quote {
  id: string;
  mandateId: string;
  parent?: string;
  round: number;
  selection: Selection[];
  price: string;
  expiresAt: number;
  contractHash: string;
  artifacts: Record<string, string>;
  rationale: string;
  changeHash?: string;
  execution?: Array<{
    pack: string;
    repetitions: number;
    terms: import("./contracts.js").ExecutionTerms;
  }>;
  settlement?: {
    network: Mode;
    asset: "HBAR";
    serviceFeeTinybar: string;
    executionFundingIncluded: false;
    paymentTransactionFee: string;
  };
  executionExposure?: Partial<Record<"local" | "testnet", string>>;
  target?: string;
  revision?: string;
}
export interface Job {
  id: string;
  quoteId: string;
  mandateId: string;
  state:
    | "reserved"
    | "settling"
    | "payment_unknown"
    | "paid"
    | "running"
    | "complete"
    | "infrastructure_failed"
    | "payment_failed";
  paymentHash?: string;
  transaction?: string;
  payer?: string;
  report?: unknown;
  reportHash?: string;
  audit?: {
    state: "recorded" | "failed";
    topicId?: string;
    transactionId?: string;
  };
  error?: string;
  createdAt: string;
}
export interface Event {
  sequence: number;
  at: string;
  type: string;
  data: unknown;
  previousHash: string;
  hash: string;
}
export interface State {
  workerIdentity?: string;
  version: 1;
  serviceIdentity?: string;
  mandates: Record<string, Mandate>;
  quotes: Record<string, Quote>;
  jobs: Record<string, Job>;
  events: Event[];
}
export const emptyState = (): State => ({
  version: 1,
  mandates: {},
  quotes: {},
  jobs: {},
  events: [],
});
export function event(s: State, type: string, data: unknown) {
  const body = {
    sequence: s.events.length + 1,
    at: new Date().toISOString(),
    type,
    data,
    previousHash: s.events.at(-1)?.hash ?? "genesis",
  };
  s.events.push({ ...body, hash: hash(body) });
}
