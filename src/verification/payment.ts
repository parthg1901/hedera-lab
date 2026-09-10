import { hash, type Quote, type Job } from "./model.js";
import { RejectedPayment, type Payment } from "./engine.js";
import { importHieroSdk } from "../optionalDeps.js";
export class SimulatedPayment implements Payment {
  readonly mode = "simulated" as const;
  async requirements(q: Quote) {
    return {
      simulation: true,
      quoteId: q.id,
      amount: q.price,
      contractHash: q.contractHash,
    };
  }
  async settle(payload: unknown, q: Quote) {
    const p = payload as { simulation?: boolean; quoteId?: string };
    if (!p || p.simulation !== true || p.quoteId !== q.id)
      throw new RejectedPayment("Invalid simulated payment");
    return {
      transaction: `simulated:${hash({ q: q.id, payload })}`,
      payer: "simulated-customer",
    };
  }
}
/** Exact Hedera x402 v2. Server verifies/settles; clients only sign and retry. */
export class BlockyPayment implements Payment {
  readonly mode = "testnet" as const;
  readonly base = "https://api.testnet.blocky402.com";
  private feePayer?: string;
  constructor(readonly payTo: string) {
    if (!/^0\.0\.\d+$/.test(payTo))
      throw new Error("VERIFIER_PAY_TO must be a Hedera account ID");
  }
  async requirements(q: Quote) {
    if (!this.feePayer) {
      const s = await this.call("/supported");
      const k = s.kinds?.find(
        (k: any) =>
          k.network === "hedera:testnet" &&
          k.scheme === "exact" &&
          k.x402Version === 2,
      );
      this.feePayer = k?.extra?.feePayer ?? s.signers?.["hedera:*"]?.[0];
      if (!this.feePayer)
        throw new Error("Facilitator does not advertise Hedera testnet");
    }
    return {
      scheme: "exact",
      network: "hedera:testnet",
      amount: q.price,
      asset: "0.0.0",
      payTo: this.payTo,
      maxTimeoutSeconds: 300,
      extra: {
        feePayer: this.feePayer,
        quoteId: q.id,
        contractHash: q.contractHash,
        memo: `verify:${q.contractHash}`,
      },
    };
  }
  async prepare(payload: unknown, q: Quote) {
    const p = payload as any;
    const r = await this.requirements(q);
    if (
      !p ||
      p.x402Version !== 2 ||
      hash(p.accepted) !== hash(r) ||
      typeof p.payload?.transaction !== "string"
    )
      throw new RejectedPayment("Payment requirements mismatch");
    const sdk = await importHieroSdk();
    let tx;
    try {
      tx = sdk.Transaction.fromBytes(
        Buffer.from(p.payload.transaction, "base64"),
      );
    } catch {
      throw new RejectedPayment("Invalid transaction");
    }
    if (
      !(tx instanceof sdk.TransferTransaction) ||
      tx.transactionMemo !== r.extra.memo ||
      !tx.transactionId
    )
      throw new RejectedPayment(
        "Payment must bind the quoted contract in its transaction memo",
      );
    if (
      tx.tokenTransfers.size ||
      tx.nftTransfers.size ||
      tx.transactionId.accountId?.toString() !== r.extra.feePayer
    )
      throw new RejectedPayment(
        "Payment includes unrelated assets or an unexpected fee payer",
      );
    const transfers = tx.hbarTransfers;
    const credit = transfers.get(sdk.AccountId.fromString(this.payTo));
    if (
      !credit ||
      credit.toTinybars().toString() !== q.price ||
      transfers.size !== 2
    )
      throw new RejectedPayment("Unexpected payment transfers");
    const debit = [...transfers].find(([, v]) => v.toTinybars().isNegative());
    if (
      !debit ||
      debit[1].toTinybars().negate().toString() !== q.price ||
      debit[0].toString() === this.payTo
    )
      throw new RejectedPayment("Unexpected payer");
    return {
      transaction: tx.transactionId.toString(),
      payer: debit[0].toString(),
    };
  }
  async settle(payload: unknown, q: Quote) {
    const identity = await this.prepare(payload, q);
    const requirements = await this.requirements(q);
    const body = {
      x402Version: 2,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };
    const verified = await this.call("/verify", body);
    if (verified.isValid !== true)
      throw new RejectedPayment("Facilitator rejected payment");
    const settled = await this.call("/settle", body);
    if (settled.success !== true || !settled.transaction)
      throw new Error("Settlement not confirmed");
    // Preserve the submitted Hedera transaction ID for receipt reconciliation.
    return identity;
  }
  async reconcile(q: Quote, j: Job): Promise<"paid" | "failed" | "unknown"> {
    if (!j.transaction || !j.payer) return "unknown";
    const match = j.transaction.match(/^(0\.0\.\d+)@(\d+)\.(\d+)$/);
    if (!match) return "unknown";
    const response = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/transactions/${match[1]}-${match[2]}-${match[3]}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (response.status === 404) return "unknown";
    if (!response.ok) throw new Error("Mirror reconciliation unavailable");
    const body = (await response.json()) as any;
    const tx = body.transactions?.find(
      (t: any) =>
        t.nonce === 0 &&
        t.scheduled === false &&
        Buffer.from(t.memo_base64 ?? "", "base64").toString() ===
          `verify:${q.contractHash}`,
    );
    if (!tx) return "unknown";
    if (tx.result !== "SUCCESS") return "failed";
    const sum = (account: string) =>
      (tx.transfers ?? [])
        .filter((t: any) => t.account === account)
        .reduce((n: bigint, t: any) => n + BigInt(t.amount), 0n);
    return sum(this.payTo) === BigInt(q.price) &&
      sum(j.payer) === -BigInt(q.price)
      ? "paid"
      : "unknown";
  }
  private async call(route: string, body?: unknown): Promise<any> {
    const res = await fetch(this.base + route, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Facilitator HTTP ${res.status}`);
    return res.json();
  }
}
export async function signPayment(
  requirements: any,
  accountId: string,
  rawKey: string,
) {
  if (
    requirements.network !== "hedera:testnet" ||
    requirements.asset !== "0.0.0" ||
    requirements.scheme !== "exact"
  )
    throw new Error("Only exact testnet HBAR payments are supported");
  const sdk = await importHieroSdk();
  const key = sdk.PrivateKey.fromStringECDSA(rawKey.replace(/^0x/, ""));
  const client = sdk.Client.forTestnet();
  try {
    const tx = new sdk.TransferTransaction()
      .setTransactionId(sdk.TransactionId.generate(requirements.extra.feePayer))
      .setTransactionMemo(requirements.extra.memo)
      .addHbarTransfer(
        accountId,
        sdk.Hbar.fromTinybars(`-${requirements.amount}`),
      )
      .addHbarTransfer(
        requirements.payTo,
        sdk.Hbar.fromTinybars(requirements.amount),
      )
      .freezeWith(client);
    await tx.sign(key);
    return {
      x402Version: 2,
      accepted: requirements,
      payload: { transaction: Buffer.from(tx.toBytes()).toString("base64") },
    };
  } finally {
    client.close();
  }
}
