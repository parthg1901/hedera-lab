import { FundingMeter } from "./funding.js";
import type { ExecutionTerms } from "../verification/contracts.js";
import { mkdir, writeFile, rename, unlink, access, readFile } from "node:fs/promises";
import path from "node:path";
import { awaitReceipt } from "./receipt.js";
import type * as SDK from "@hiero-ledger/sdk";
import { importHieroSdk } from "../optionalDeps.js";
import { mirrorGet } from "./mirror.js";
import { LabInfrastructureError, type Assertion, type LabFixtures, type LabNetwork, type Ledger, type Operation, type PublicFixtures, type TxEvidence } from "./types.js";

/** Uses fresh resources for every scenario, so assertions cannot match previous runs. */
export class LiveLedger implements Ledger {
  readonly mode: "local" | "testnet";
  readonly resources: PublicFixtures = { accounts: {}, tokens: {}, topics: {} };
  private sdk!: typeof SDK;
  private client!: SDK.Client;
  private operatorKey!: SDK.PrivateKey;
  private operatorId!: string;
  private keys = new Map<string, SDK.PrivateKey>();
  private mirror: string;
  private pendingCreations = new Map<string, { kind: "accounts" | "tokens" | "topics"; name: string; transactionId: string }>();
  private creationContext?: { kind: "accounts" | "tokens" | "topics"; name: string };
  private recoveryPath?: string;
  private meter?: FundingMeter;
  private cleaning = false;
  private fundingDetail: {fundedTinybar?: string; sweepAccount?: string} = {};
  constructor(private config: LabNetwork, recoveryDirectory?: string, funding?: ExecutionTerms) {
    if(funding && recoveryDirectory) this.meter = new FundingMeter(funding, recoveryDirectory);
    if (recoveryDirectory) this.recoveryPath = path.join(recoveryDirectory, "lab-recovery.json");
    this.mode = config.mode === "local" ? "local" : "testnet";
    this.mirror = this.mode === "testnet" ? "https://testnet.mirrornode.hedera.com" : config.mirrorUrl!;
  }
  get recoveryScope() { return JSON.stringify({ mode: this.mode, mirror: this.mirror, nodeAddress: this.config.nodeAddress, nodeAccountId: this.config.nodeAccountId }); }
  async provision(fixtures: LabFixtures): Promise<void> {
    if (this.recoveryPath) {
      // Never overwrite keys from a previous incomplete run.
      const exists = await access(this.recoveryPath).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      });
      if (exists) throw new LabInfrastructureError("Unfinished recovery journal exists in output directory; recover those resources before reusing it");
    }
    await this.connect();
    try {
      for (const [name, account] of Object.entries(fixtures.accounts)) {
        const key = this.sdk.PrivateKey.generateECDSA();
        this.keys.set(name, key);
        this.creationContext = { kind: "accounts", name };
        await this.persistRecovery();
        this.fundingDetail = { fundedTinybar: new this.sdk.Hbar(account.hbar).toTinybars().toString() };
        const receipt = await this.transact(new this.sdk.AccountCreateTransaction().setECDSAKeyWithAlias(key).setInitialBalance(new this.sdk.Hbar(account.hbar)));
        if (!receipt.accountId) throw new Error("Missing account ID");
        this.resources.accounts[name] = receipt.accountId.toString();
        await this.persistRecovery();
      }
      for (const [name, token] of Object.entries(fixtures.tokens)) {
        this.creationContext = { kind: "tokens", name };
        const receipt = await this.transact(new this.sdk.TokenCreateTransaction()
          .setTokenName(`Lab ${name}`).setTokenSymbol("LAB").setTokenType(this.sdk.TokenType.NonFungibleUnique)
          .setDecimals(0).setInitialSupply(0).setTreasuryAccountId(this.resources.accounts[token.treasury])
          .setAdminKey(this.operatorKey.publicKey).setSupplyKey(this.operatorKey.publicKey), [this.keys.get(token.treasury)!]);
        if (!receipt.tokenId) throw new Error("Missing token ID");
        this.resources.tokens[name] = receipt.tokenId.toString();
        await this.persistRecovery();
        await this.transact(new this.sdk.TokenMintTransaction().setTokenId(receipt.tokenId)
          .setMetadata(Array.from({ length: token.supply }, (_, i) => Buffer.from(`lab:${name}:${i + 1}`))));
      }
      for (const name of fixtures.topics) {
        this.creationContext = { kind: "topics", name };
        const receipt = await this.transact(new this.sdk.TopicCreateTransaction().setTopicMemo(`Lab ${name}`).setAdminKey(this.operatorKey.publicKey));
        if (!receipt.topicId) throw new Error("Missing topic ID");
        this.resources.topics[name] = receipt.topicId.toString();
        await this.persistRecovery();
      }
    } catch (error) { throw new LabInfrastructureError(`Fixture provisioning failed (${safeError(error)}); inspect network/receipt status and recovery journal`); }
  }
  private async connect() {
    this.sdk = await importHieroSdk();
    this.operatorId = process.env[this.config.operatorIdEnv ?? "HEDERA_OPERATOR_ID"]?.trim() ?? "";
    const raw = await operatorKeyMaterial(this.config);
    if (!/^0\.0\.\d+$/.test(this.operatorId) || !raw) throw new LabInfrastructureError("Lab live mode requires operator account ID and key environment variables");
    try { this.operatorKey = this.sdk.PrivateKey.fromStringECDSA(raw.replace(/^0x/i, "")); }
    catch { throw new LabInfrastructureError("Lab requires a valid ECDSA operator key"); }
    if ((await mirrorGet(this.mirror, "/api/v1/network/nodes?limit=1")).status !== 200) throw new LabInfrastructureError("Mirror health endpoint is unavailable");
    this.client = this.mode === "testnet" ? this.sdk.Client.forTestnet() : this.sdk.Client.forNetwork({ [this.config.nodeAddress!]: this.config.nodeAccountId! });
    this.client.setOperator(this.operatorId, this.operatorKey);
    this.client.setRequestTimeout(15_000);
    this.client.setMaxAttempts(2);
  }
  /** Reattach to the SAME disposable fixtures after a process restart. Never
   * provision fresh entities or erase unresolved operation journal entries here.
   */
  async resume(fixtures: LabFixtures): Promise<void> {
    if (!this.recoveryPath) throw new LabInfrastructureError("Recovery directory required");
    const saved = JSON.parse(await readFile(this.recoveryPath, "utf8"));
    const networkKeys = ["mode", "mirrorUrl", "nodeAddress", "nodeAccountId", "operatorIdEnv", "operatorKeyEnv"] as const;
    if (saved.schemaVersion !== 1 || !saved.network || networkKeys.some(k => saved.network[k] !== this.config[k]) || !Array.isArray(saved.pendingCreations) || saved.pendingCreations.length) throw new LabInfrastructureError("Recovery network mismatch or unfinished fixture provisioning");
    await this.connect();
    if (saved.operatorId !== this.operatorId) throw new LabInfrastructureError("Recovery operator mismatch");
    for (const [kind, names] of [["accounts", Object.keys(fixtures.accounts)], ["tokens", Object.keys(fixtures.tokens)], ["topics", fixtures.topics]] as const) {
      const resources = saved.resources?.[kind];
      if (!resources || Object.keys(resources).length !== names.length || names.some(name => typeof resources[name] !== "string" || !/^\d+\.\d+\.\d+$/.test(resources[name]))) throw new LabInfrastructureError("Recovery fixture mismatch");
    }
    const keys = new Map<string, SDK.PrivateKey>();
    for (const name of Object.keys(fixtures.accounts)) {
      try { keys.set(name, this.sdk.PrivateKey.fromStringECDSA(saved.accounts[name].privateKey)); }
      catch { throw new LabInfrastructureError("Invalid disposable fixture key in recovery journal"); }
    }
    this.keys = keys;
    Object.assign(this.resources, structuredClone(saved.resources));
  }
  private async transact(tx: SDK.Transaction, keys: SDK.PrivateKey[] = []): Promise<SDK.TransactionReceipt> {
    if(this.meter) tx.setMaxTransactionFee(this.sdk.Hbar.fromTinybars(tx instanceof this.sdk.TokenCreateTransaction ? this.meter.terms.tokenCreateMaxTinybar : this.meter.terms.perTransactionMaxTinybar)).setMaxAttempts(1).setRegenerateTransactionId(false);
    let frozen = tx.freezeWith(this.client);
    for (const key of keys) frozen = await frozen.sign(key);
    const transactionId = frozen.transactionId!.toString();
    const detail = this.fundingDetail; this.fundingDetail = {};
    await this.meter?.reserve(transactionId, this.cleaning, {...detail, maxFeeTinybar: frozen.maxTransactionFee?.toTinybars().toString()});
    const context = this.creationContext; this.creationContext = undefined;
    if (context) {
      this.pendingCreations.set(transactionId, { ...context, transactionId });
      await this.persistRecovery();
    }
    const receipt = await awaitReceipt(await frozen.execute(this.client), this.client);
    if (context) {
      const id = context.kind === "accounts" ? receipt.accountId : context.kind === "tokens" ? receipt.tokenId : receipt.topicId;
      if (id) this.resources[context.kind][context.name] = id.toString();
      this.pendingCreations.delete(transactionId);
      await this.persistRecovery();
    }
    return receipt;
  }
  async execute(operation: Operation, beforeSubmit?: (transactionId: string) => Promise<void>): Promise<TxEvidence> {
    const s = this.sdk;
    const actor = this.resources.accounts[operation.actor];
    let tx: SDK.Transaction;
    switch (operation.type) {
      case "associate": tx = new s.TokenAssociateTransaction().setAccountId(actor).setTokenIds([this.resources.tokens[operation.token]]); break;
      case "transferNft": tx = new s.TransferTransaction().addNftTransfer(this.resources.tokens[operation.token], operation.serial, actor, this.resources.accounts[operation.to]); break;
      case "transferHbar": tx = new s.TransferTransaction().addHbarTransfer(actor, new s.Hbar(operation.amount).negated()).addHbarTransfer(this.resources.accounts[operation.to], new s.Hbar(operation.amount)); break;
      case "submitMessage": tx = new s.TopicMessageSubmitTransaction().setTopicId(this.resources.topics[operation.topic]).setMessage(operation.message); break;
    }
    // Actor pays transaction fees; operator only pays fixture/cleanup costs.
    const actorClient = this.mode === "testnet" ? s.Client.forTestnet() : s.Client.forNetwork({ [this.config.nodeAddress!]: this.config.nodeAccountId! });
    actorClient.setOperator(actor, this.keys.get(operation.actor)!);
    actorClient.setRequestTimeout(15_000); actorClient.setMaxAttempts(2);
    let transactionId = "not-submitted";
    try {
      if(this.meter) tx.setMaxTransactionFee(s.Hbar.fromTinybars(this.meter.terms.perTransactionMaxTinybar));
      if (beforeSubmit || this.meter) tx.setMaxAttempts(1).setRegenerateTransactionId(false);
      tx.freezeWith(actorClient);
      transactionId = tx.transactionId!.toString();
      await this.meter?.reserve(transactionId, false);
      await beforeSubmit?.(transactionId);
      // A recoverable operation never regenerates its ID or retries a write.
      const response = await tx.execute(actorClient);
      const receipt = await awaitReceipt(response, actorClient);
      return { status: receipt.status.toString(), transactionId, operation };
    } catch (error) {
      const status = statusCode(error);
      if (status && !["BUSY", "PLATFORM_NOT_ACTIVE", "UNKNOWN", "RECEIPT_NOT_FOUND", "DUPLICATE_TRANSACTION"].includes(status)) return { status, transactionId, operation };
      throw new LabInfrastructureError(`Transaction outcome unavailable (${status ?? "SDK/network error"}); do not blindly resubmit`);
    } finally { actorClient.close(); }
  }
  /** Read-only recovery: never execute a transaction from this method. */
  async reconcile(transactionId: string, operation: Operation): Promise<TxEvidence | null> {
    const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d{1,9})$/.exec(transactionId);
    if (!match || match[1] !== this.resources.accounts[operation.actor]) return null;
    try {
      const receipt = await new this.sdk.TransactionReceiptQuery().setTransactionId(transactionId)
        .setValidateStatus(false).setMaxAttempts(2).setMaxBackoff(250).execute(this.client);
      const status = receipt.status.toString();
      if (!unknownStatus(status)) return { status, transactionId, operation };
    } catch { /* Receipt expired, node unavailable, or not yet in consensus. Try archive. */ }
    const mirrorId = `${match[1]}-${match[2]}-${match[3].padStart(9, "0")}`;
    try {
      const response = await mirrorGet(this.mirror, `/api/v1/transactions/${mirrorId}?nonce=0&scheduled=false`);
      const rows = response.body.transactions;
      if (!Array.isArray(rows)) return null;
      // Exclude duplicate submissions and child/scheduled records. An unrelated
      // transaction or empty archive result is never evidence of success/failure.
      const expectedName = operation.type === "associate" ? "TOKENASSOCIATE" : operation.type === "submitMessage" ? "CONSENSUSSUBMITMESSAGE" : "CRYPTOTRANSFER";
      const matches = rows.filter(r => r && r.transaction_id === mirrorId && r.nonce === 0 && r.scheduled === false && r.name === expectedName && typeof r.result === "string" && !unknownStatus(r.result));
      if (matches.length !== 1) return null;
      const row = matches[0];
      return { status: row.result, transactionId, operation, consensusTimestamp: row.consensus_timestamp };
    } catch { return null; }
  }
  async observe(a: Exclude<Assertion, { type: "text" }>): Promise<{ matches: boolean; evidence: unknown }> {
    switch (a.type) {
      case "nftOwner": {
        const response = await mirrorGet(this.mirror, `/api/v1/tokens/${this.resources.tokens[a.token]}/nfts/${a.serial}`);
        return { matches: response.status === 200 && response.body.account_id === this.resources.accounts[a.account], evidence: response };
      }
      case "hbarBalance": {
        // SDK account query reflects consensus state, independent of indexed balance snapshots.
        try {
          const result = await new this.sdk.AccountBalanceQuery().setAccountId(this.resources.accounts[a.account]).execute(this.client);
          const balance = Number(result.hbars.toTinybars().toString()) / 100_000_000;
          return { matches: balance >= a.min && balance <= a.max, evidence: { source: "SDK AccountBalanceQuery", accountId: this.resources.accounts[a.account], balance } };
        } catch { throw new LabInfrastructureError("Account balance query failed"); }
      }
      case "topicMessage": {
        // Fresh topic, maximum 200 scenario steps. Follow bounded mirror pagination.
        let route: string | null = `/api/v1/topics/${this.resources.topics[a.topic]}/messages?limit=100&order=asc`;
        const messages: unknown[] = [];
        for (let page = 0; route && page < 10; page++) {
          const response = await mirrorGet(this.mirror, route);
          if (response.status === 404) return { matches: false, evidence: response };
          if (!Array.isArray(response.body.messages)) throw new LabInfrastructureError("Mirror messages response missing messages array");
          for (const entry of response.body.messages) {
            const message = entry as Record<string, unknown>;
            messages.push(message);
            if (typeof message.message === "string" && Buffer.from(message.message, "base64").toString("utf8") === a.message) return { matches: true, evidence: { topicId: this.resources.topics[a.topic], message } };
          }
          const next = (response.body.links as { next?: unknown } | undefined)?.next;
          if (next && (typeof next !== "string" || !next.startsWith(`/api/v1/topics/${this.resources.topics[a.topic]}/messages?`))) throw new LabInfrastructureError("Invalid mirror pagination link");
          route = typeof next === "string" ? next : null;
        }
        return { matches: false, evidence: { topicId: this.resources.topics[a.topic], messages } };
      }
    }
  }
  async cleanup(): Promise<string[]> {
    if (!this.client) return [];
    this.cleaning = true;
    const errors: string[] = [];
    // Resolve uncertain creates by their original transaction ID; never create again.
    for (const [id, pending] of this.pendingCreations) {
      try {
        const receipt = await new this.sdk.TransactionReceiptQuery().setTransactionId(id)
          .setMaxAttempts(30).setMaxBackoff(1000).execute(this.client);
        const entity = pending.kind === "accounts" ? receipt.accountId : pending.kind === "tokens" ? receipt.tokenId : receipt.topicId;
        if (!entity) throw new Error("Missing receipt entity");
        this.resources[pending.kind][pending.name] = entity.toString();
        this.pendingCreations.delete(id);
      } catch (e) {
        const status = statusCode(e);
        if (status && !["UNKNOWN", "RECEIPT_NOT_FOUND", "BUSY", "PLATFORM_NOT_ACTIVE"].includes(status)) this.pendingCreations.delete(id);
        else errors.push(`unresolved create ${id}; recovery journal retained`);
      }
    }
    await this.persistRecovery();
    const attempt = async (label: string, tx: SDK.Transaction, keys: SDK.PrivateKey[] = [], alreadyDone: string[] = []) => {
      try { await this.transact(tx, keys); } catch (e) { if (!alreadyDone.includes(statusCode(e) ?? "")) errors.push(`${label}: ${statusCode(e) ?? "SDK/network error"}`); }
    };
    for (const id of Object.values(this.resources.tokens)) await attempt(`delete token ${id}`, new this.sdk.TokenDeleteTransaction().setTokenId(id), [], ["TOKEN_WAS_DELETED"]);
    for (const id of Object.values(this.resources.topics)) await attempt(`delete topic ${id}`, new this.sdk.TopicDeleteTransaction().setTopicId(id), [], ["INVALID_TOPIC_ID"]);
    // Deleted tokens can still leave nonzero NFT balances. Dissociate before deleting holders.
    for (const [name, id] of Object.entries(this.resources.accounts)) {
      for (const token of Object.values(this.resources.tokens)) await attempt(`dissociate ${id}/${token}`,
        new this.sdk.TokenDissociateTransaction().setAccountId(id).setTokenIds([token]), [this.keys.get(name)!],
        ["TOKEN_NOT_ASSOCIATED_TO_ACCOUNT", "ACCOUNT_DELETED"]);
    }
    for (const [name, id] of Object.entries(this.resources.accounts)) {
      this.fundingDetail = {sweepAccount:id};
      await attempt(`sweep account ${id}`, new this.sdk.AccountDeleteTransaction().setAccountId(id).setTransferAccountId(this.operatorId), [this.keys.get(name)!], ["ACCOUNT_DELETED"]);
    }
    if (!errors.length && this.recoveryPath) await unlink(this.recoveryPath).catch(() => undefined);
    return errors;
  }
  private async persistRecovery(): Promise<void> {
    if (!this.recoveryPath) return;
    await mkdir(path.dirname(this.recoveryPath), { recursive: true, mode: 0o700 });
    const content = { schemaVersion: 1, network: this.config, operatorId: this.operatorId,
      resources: this.resources, pendingCreations: [...this.pendingCreations.values()],
      // Only disposable fixture keys. The supplied operator key is never persisted.
      accounts: Object.fromEntries([...this.keys].map(([name, key]) => [name, { privateKey: key.toStringRaw() }])) };
    await writeFile(`${this.recoveryPath}.tmp`, JSON.stringify(content), { mode: 0o600 });
    await rename(`${this.recoveryPath}.tmp`, this.recoveryPath);
  }
  async accounting() { return this.meter?.reconcile(this.mirror); }
  close(): void { this.client?.close(); this.keys.clear(); }
}
function statusCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: { toString(): string } }).status?.toString();
  return status && /^[A-Z][A-Z0-9_]+$/.test(status) ? status : undefined;
}

function safeError(error: unknown): string {
  const status = statusCode(error);
  if (status) return status;
  if (!(error instanceof Error)) return "SDK/network error";
  return `${error.name}: ${error.message}`.replace(/(?:0x)?[a-fA-F0-9]{64,}/g, "[redacted]").slice(0, 350);
}

function unknownStatus(status: string): boolean {
  return !/^[A-Z][A-Z0-9_]+$/.test(status) || ["UNKNOWN", "RECEIPT_NOT_FOUND", "BUSY", "PLATFORM_NOT_ACTIVE", "DUPLICATE_TRANSACTION", "INVALID_NODE_ACCOUNT", "INVALID_PAYER_SIGNATURE", "OK"].includes(status);
}

/** File-based worker secret is never copied into process.env or child environments. */
export async function operatorKeyMaterial(config: LabNetwork): Promise<string> {
  const name = config.operatorKeyEnv ?? "HEDERA_OPERATOR_KEY";
  if (process.env[name]) return process.env[name]!.trim();
  if (process.env[name + "_FILE"]) {
    try { return (await readFile(process.env[name + "_FILE"]!, "utf8")).trim(); }
    catch { throw new LabInfrastructureError("Execution signing secret file is unavailable"); }
  }
  return "";
}
