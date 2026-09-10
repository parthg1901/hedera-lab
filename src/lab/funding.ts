import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { mirrorGet } from "./mirror.js";
import { LabInfrastructureError } from "./types.js";
import type { ExecutionTerms } from "../verification/contracts.js";

/** Reserve the SDK fee maximum durably before each submission, including failed
 * or ambiguous writes. Never reclaim an unknown reservation to permit more writes. */
export class FundingMeter {
  private queue: Promise<void> = Promise.resolve();
  private normal = 0n;
  private cleanup = 0n;
  private records: Array<{
    transactionId: string;
    phase: "execution" | "cleanup";
    maxFeeTinybar: string;
    fundedTinybar?: string;
    sweepAccount?: string;
  }> = [];
  constructor(
    readonly terms: ExecutionTerms,
    private directory: string,
  ) {}
  reserve(
    transactionId: string,
    cleanup: boolean,
    detail: {
      fundedTinybar?: string;
      sweepAccount?: string;
      maxFeeTinybar?: string;
    } = {},
  ) {
    const task = this.queue.then(() =>
      this.reserveOnce(transactionId, cleanup, detail),
    );
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async reserveOnce(
    transactionId: string,
    cleanup: boolean,
    detail: {
      fundedTinybar?: string;
      sweepAccount?: string;
      maxFeeTinybar?: string;
    },
  ) {
    const cap = BigInt(
      detail.maxFeeTinybar ?? this.terms.perTransactionMaxTinybar,
    );
    const allowedMax = BigInt(
      this.terms.tokenCreateMaxTinybar ?? this.terms.perTransactionMaxTinybar,
    );
    if (cap > allowedMax && cap > BigInt(this.terms.perTransactionMaxTinybar))
      throw new LabInfrastructureError("Unquoted transaction fee cap");
    const reserve = BigInt(this.terms.cleanupReserveTinybar);
    if (
      cap <= 0n ||
      (cleanup
        ? this.cleanup + cap > reserve
        : this.normal + cap > BigInt(this.terms.feeCeilingTinybar) - reserve)
    )
      throw new LabInfrastructureError(
        "Execution fee ceiling reached before submission; cleanup reserve remains separate",
      );
    if (cleanup) this.cleanup += cap;
    else this.normal += cap;
    this.records.push({
      transactionId,
      phase: cleanup ? "cleanup" : "execution",
      maxFeeTinybar: cap.toString(),
      ...detail,
    });
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, "funding-journal.json");
    const handle = await open(file + ".tmp", "w", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ terms: this.terms, records: this.records }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(file + ".tmp", file);
    const dir = await open(this.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  async reconcile(mirror: string) {
    const rows = await Promise.all(
      this.records.map(async (record) => {
        const match = /^(\d+\.\d+\.\d+)@(\d+)\.(\d+)$/.exec(
          record.transactionId,
        );
        const id = match
          ? `${match[1]}-${match[2]}-${match[3].padStart(9, "0")}`
          : "";
        let found: any[] = [];
        for (let attempt = 0; attempt < 12; attempt++) {
          try {
            const response = await mirrorGet(
              mirror,
              `/api/v1/transactions/${id}?nonce=0&scheduled=false`,
            );
            if (Array.isArray(response.body.transactions))
              found = response.body.transactions.filter(
                (r: any) =>
                  r.transaction_id === id &&
                  r.nonce === 0 &&
                  r.scheduled === false,
              );
          } catch {
            /* Missing evidence is never zero spending. */
          }
          if (found.length) break;
          if (attempt < 11) await new Promise((r) => setTimeout(r, 1000));
        }
        const valid =
          found.length === 1 &&
          Number.isSafeInteger(found[0].charged_tx_fee) &&
          found[0].charged_tx_fee >= 0;
        if (!valid)
          return {
            ...record,
            status: "unresolved" as const,
            actualFeeTinybar: null,
            fundedTinybarActual: null,
            recoveredTinybar: null,
          };
        const row = found[0];
        let recovered: string | null = record.sweepAccount ? null : "0";
        if (
          record.sweepAccount &&
          row.result === "SUCCESS" &&
          Array.isArray(row.transfers)
        ) {
          const entries = row.transfers.filter(
            (t: any) => t.account === record.sweepAccount,
          );
          if (
            entries.length &&
            entries.every((t: any) => Number.isSafeInteger(t.amount))
          )
            recovered = (-entries.reduce(
              (n: bigint, t: any) => n + BigInt(t.amount),
              0n,
            )).toString();
        }
        return {
          ...record,
          status: "observed" as const,
          result: row.result,
          actualFeeTinybar: String(row.charged_tx_fee),
          fundedTinybarActual:
            row.result === "SUCCESS" ? (record.fundedTinybar ?? "0") : "0",
          recoveredTinybar: recovered,
        };
      }),
    );
    const complete = rows.every(
      (r) => r.status === "observed" && r.recoveredTinybar !== null,
    );
    const sum = (
      key: "actualFeeTinybar" | "fundedTinybarActual" | "recoveredTinybar",
    ) => rows.reduce((n, r) => n + BigInt(r[key] ?? "0"), 0n).toString();
    return {
      network: this.terms.fundingNetwork,
      unit: "tinybar",
      status: complete ? "reconciled" : "incomplete",
      estimatedFeeTinybar: this.terms.estimatedFeeTinybar,
      feeCeilingTinybar: this.terms.feeCeilingTinybar,
      reservedFeeTinybar: (this.normal + this.cleanup).toString(),
      observedFeeTinybar: sum("actualFeeTinybar"),
      actualFeeTinybar: complete ? sum("actualFeeTinybar") : null,
      fixtureFundingPlannedTinybar: this.terms.fixtureFundingTinybar,
      fixtureFundedObservedTinybar: sum("fundedTinybarActual"),
      recoveredObservedTinybar: sum("recoveredTinybar"),
      unrecoveredTinybar: complete
        ? (
            BigInt(sum("fundedTinybarActual")) - BigInt(sum("recoveredTinybar"))
          ).toString()
        : null,
      note: "Unrecovered fixture balance includes fixture-paid transaction fees; do not add it to transaction fees as a second cost. Testing funds are provider-supplied, separate from the service payment.",
      transactions: rows,
    };
  }
}
