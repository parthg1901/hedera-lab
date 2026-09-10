import { randomUUID } from "node:crypto";
import type { Assertion, LabFixtures, LabScenario, Ledger, Operation, PublicFixtures, TxEvidence } from "./types.js";
interface State {
  accounts: Record<string, number>;
  tokens: Record<string, { owners: Record<string, string>; associated: string[] }>;
  topics: Record<string, Array<{ message: string; transactionId: string }>>;
}
/** Deliberately limited simulator. No fees, signatures, consensus or SDK emulation. */
export class SimulatedLedger implements Ledger {
  readonly mode = "simulated" as const;
  readonly recoveryScope = randomUUID();
  readonly resources: PublicFixtures = { accounts: {}, tokens: {}, topics: {} };
  private state: State = { accounts: {}, tokens: {}, topics: {} };
  private receipts = new Map<string, TxEvidence>();
  private history: Array<{ visibleAt: number; state: State }> = [];
  constructor(private faults: LabScenario["faults"]) {}
  async provision(fixtures: LabFixtures): Promise<void> {
    let id = 1000;
    for (const [name, account] of Object.entries(fixtures.accounts)) {
      this.resources.accounts[name] = `0.0.${id++}`;
      this.state.accounts[name] = tinybars(account.hbar);
    }
    for (const [name, token] of Object.entries(fixtures.tokens)) {
      this.resources.tokens[name] = `0.0.${id++}`;
      this.state.tokens[name] = { associated: [token.treasury], owners: Object.fromEntries(Array.from({ length: token.supply }, (_, i) => [String(i + 1), token.treasury])) };
    }
    for (const topic of fixtures.topics) { this.resources.topics[topic] = `0.0.${id++}`; this.state.topics[topic] = []; }
    this.history = [{ visibleAt: 0, state: structuredClone(this.state) }];
  }
  async execute(operation: Operation, beforeSubmit?: (transactionId: string) => Promise<void>): Promise<TxEvidence> {
    const transactionId = `sim-${randomUUID()}`;
    await beforeSubmit?.(transactionId);
    let status = "SUCCESS";
    if (this.faults.rejectActors.includes(operation.actor)) status = "USER_REJECTED";
    else switch (operation.type) {
      case "associate": {
        const token = this.state.tokens[operation.token];
        if (token.associated.includes(operation.actor)) status = "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT";
        else token.associated.push(operation.actor);
        break;
      }
      case "transferNft": {
        const token = this.state.tokens[operation.token];
        if (!(String(operation.serial) in token.owners)) status = "INVALID_NFT_ID";
        else if (token.owners[String(operation.serial)] !== operation.actor) status = "SENDER_DOES_NOT_OWN_NFT_SERIAL_NO";
        else if (!token.associated.includes(operation.to)) status = "TOKEN_NOT_ASSOCIATED_TO_ACCOUNT";
        else token.owners[String(operation.serial)] = operation.to;
        break;
      }
      case "transferHbar": {
        const amount = tinybars(operation.amount);
        if (this.state.accounts[operation.actor] < amount) status = "INSUFFICIENT_ACCOUNT_BALANCE";
        else { this.state.accounts[operation.actor] -= amount; this.state.accounts[operation.to] += amount; }
        break;
      }
      case "submitMessage":
        this.state.topics[operation.topic].push({ message: operation.message, transactionId }); break;
    }
    if (status === "SUCCESS") this.history.push({ visibleAt: Date.now() + this.faults.mirrorDelayMs, state: structuredClone(this.state) });
    const evidence = { status, transactionId, operation: structuredClone(operation) };
    this.receipts.set(transactionId, evidence);
    return structuredClone(evidence);
  }
  async reconcile(transactionId: string, operation: Operation): Promise<TxEvidence | null> {
    const receipt = this.receipts.get(transactionId);
    if (!receipt || JSON.stringify(receipt.operation) !== JSON.stringify(operation)) return null;
    return structuredClone(receipt);
  }
  async observe(assertion: Exclude<Assertion, { type: "text" }>): Promise<{ matches: boolean; evidence: unknown }> {
    const state = this.history.filter(h => h.visibleAt <= Date.now()).at(-1)!.state;
    switch (assertion.type) {
      case "nftOwner": {
        const owner = state.tokens[assertion.token].owners[String(assertion.serial)] ?? null;
        return { matches: owner === assertion.account, evidence: { tokenId: this.resources.tokens[assertion.token], serial: assertion.serial, owner, accountId: owner ? this.resources.accounts[owner] : null } };
      }
      case "topicMessage": {
        const messages = state.topics[assertion.topic];
        return { matches: messages.some(m => m.message === assertion.message), evidence: { topicId: this.resources.topics[assertion.topic], messages } };
      }
      case "hbarBalance": {
        const balance = state.accounts[assertion.account] / 100_000_000;
        return { matches: balance >= assertion.min && balance <= assertion.max, evidence: { accountId: this.resources.accounts[assertion.account], balance } };
      }
    }
  }
  async cleanup(): Promise<string[]> { return []; }
  close(): void { this.history = []; }
}
export function tinybars(hbar: number): number {
  const amount = Math.round(hbar * 100_000_000);
  if (!Number.isSafeInteger(amount) || Math.abs(amount / 100_000_000 - hbar) > 1e-12) throw new Error("HBAR amounts must have at most 8 decimal places");
  return amount;
}
