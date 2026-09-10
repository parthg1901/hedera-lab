import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { acquireJournalOwnership } from "./ownership.js";
import { parseOperation } from "./schema.js";
import {
  LabInfrastructureError,
  type LabFixtures,
  type Ledger,
  type Operation,
  type TxEvidence,
} from "./types.js";

type Attempt = { transactionId?: string; result?: TxEvidence };
type Entry = { operation: Operation; attempts: Attempt[] };
type State = { version: 1; scope: string; entries: Record<string, Entry> };
export type RecoveryResult = TxEvidence;
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const final = (status: string) =>
  /^[A-Z][A-Z0-9_]+$/.test(status) &&
  ![
    "PENDING",
    "UNKNOWN",
    "RECEIPT_NOT_FOUND",
    "BUSY",
    "PLATFORM_NOT_ACTIVE",
    "DUPLICATE_TRANSACTION",
    "OK",
  ].includes(status);

/** One trusted bridge owns this journal. Persist intent and ID before network I/O.
 * No lease expiry, missing receipt, or elapsed time authorizes another submission.
 */
export class TransactionJournal {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closing = false;
  private ownsLock = false;
  private releaseOwnership?: () => Promise<void>;
  private ready = false;
  constructor(
    private ledger: Ledger,
    private fixtures: LabFixtures,
    readonly directory: string,
    private onTransaction: (tx: TxEvidence) => void = () => {},
  ) {
    this.state = {
      version: 1,
      scope: hash({
        mode: ledger.mode,
        network: ledger.recoveryScope,
        resources: ledger.resources,
        fixtures,
      }),
      entries: {},
    };
  }
  async start() {
    if (this.ownsLock || this.closing)
      throw new Error("Journal instance cannot be started twice");
    if (!this.ledger.reconcile)
      throw new Error("Ledger does not support receipt recovery");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.releaseOwnership = await acquireJournalOwnership(this.directory);
    this.ownsLock = true;
    try {
      let saved;
      try {
        saved = JSON.parse(
          await readFile(
            path.join(this.directory, "transactions.json"),
            "utf8",
          ),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (saved) {
        const s = saved.state as State;
        if (
          !s ||
          saved.hash !== hash(s) ||
          s.version !== 1 ||
          s.scope !== this.state.scope ||
          !s.entries ||
          typeof s.entries !== "object" ||
          Array.isArray(s.entries)
        )
          throw new Error("Invalid journal or fixture scope mismatch");
        for (const [key, entry] of Object.entries(s.entries)) {
          this.key(key);
          parseOperation(entry.operation, this.fixtures);
          if (!Array.isArray(entry.attempts) || !entry.attempts.length)
            throw new Error("Invalid journal attempts");
          for (const a of entry.attempts) {
            if (
              a.transactionId !== undefined &&
              (typeof a.transactionId !== "string" || !a.transactionId)
            )
              throw new Error("Invalid transaction ID");
            if (
              a.result &&
              (!a.transactionId ||
                a.result.transactionId !== a.transactionId ||
                canonical(a.result.operation) !== canonical(entry.operation) ||
                !final(a.result.status))
            )
              throw new Error("Invalid journal receipt binding");
          }
        }
        this.state = s;
      } else await this.persist(this.state);
      this.ready = true;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private key(key: string) {
    if (
      typeof key !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/.test(key) ||
      Object.hasOwn(Object.prototype, key)
    )
      throw new Error("Invalid request ID");
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.ready || !this.ownsLock)
      return Promise.reject(new Error("Journal must be started before use"));
    if (this.closing) return Promise.reject(new Error("Journal is closing"));
    const task = this.queue.then(() => {
      if (this.poisoned)
        throw new LabInfrastructureError(
          "Journal write failed; restart and inspect durable state before continuing",
        );
      return fn();
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async persist(next: State) {
    try {
      const file = await open(
        path.join(this.directory, "transactions.json.tmp"),
        "w",
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify({ state: next, hash: hash(next) }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(
        path.join(this.directory, "transactions.json.tmp"),
        path.join(this.directory, "transactions.json"),
      );
      const dir = await open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
      this.state = next;
    } catch (e) {
      this.poisoned = true;
      throw e;
    }
  }
  private pending(entry: Entry): RecoveryResult {
    return {
      status: "PENDING",
      transactionId: entry.attempts.at(-1)!.transactionId ?? "not-submitted",
      operation: structuredClone(entry.operation),
    };
  }
  private async record(key: string, result: TxEvidence) {
    const entry = this.state.entries[key];
    const attempt = entry.attempts.at(-1)!;
    if (
      result.transactionId !== attempt.transactionId ||
      canonical(result.operation) !== canonical(entry.operation) ||
      !final(result.status)
    )
      return this.pending(entry);
    const next = structuredClone(this.state);
    next.entries[key].attempts.at(-1)!.result = structuredClone(result);
    await this.persist(next);
    this.onTransaction(structuredClone(result));
    return structuredClone(result);
  }
  private async reconcile(key: string): Promise<RecoveryResult | null> {
    const entry = this.state.entries[key];
    if (!entry) return null;
    const attempt = entry.attempts.at(-1)!;
    if (attempt.result) return structuredClone(attempt.result);
    if (attempt.transactionId) {
      let result;
      try {
        result = await this.ledger.reconcile!(
          attempt.transactionId,
          structuredClone(entry.operation),
        );
      } catch {
        return this.pending(entry);
      }
      if (result) return this.record(key, result);
    }
    return this.pending(entry);
  }
  receipt(key: string) {
    return this.serial(async () => {
      this.key(key);
      return this.reconcile(key);
    });
  }
  execute(
    key: string,
    operation: Operation,
    retryFailed = false,
  ): Promise<RecoveryResult> {
    return this.serial(async () => {
      this.key(key);
      operation = structuredClone(parseOperation(operation, this.fixtures));
      const entry = this.state.entries[key];
      if (entry && canonical(entry.operation) !== canonical(operation))
        throw new Error("Request ID already bound to a different operation");
      if (entry) {
        const known = await this.reconcile(key);
        // An explicit new user request may retry a proven failure. Never retry
        // successful association, success, or an unresolved transaction.
        if (
          !retryFailed ||
          !known ||
          [
            "SUCCESS",
            "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT",
            "PENDING",
          ].includes(known.status)
        )
          return known!;
        if (entry.attempts.length >= 100)
          throw new Error("Request retry limit reached");
      } else if (Object.keys(this.state.entries).length >= 1000)
        throw new Error("Journal request limit reached");
      const next = structuredClone(this.state);
      next.entries[key] ??= { operation, attempts: [] };
      next.entries[key].attempts.push({});
      await this.persist(next);
      let result: TxEvidence;
      try {
        result = await this.ledger.execute(operation, async (id) => {
          if (this.state.entries[key].attempts.at(-1)!.transactionId)
            throw new Error("Adapter attempted to replace transaction ID");
          if (typeof id !== "string" || !id)
            throw new Error("Adapter did not allocate a transaction ID");
          const prepared = structuredClone(this.state);
          prepared.entries[key].attempts.at(-1)!.transactionId = id;
          await this.persist(prepared);
        });
      } catch {
        if (this.poisoned)
          throw new LabInfrastructureError(
            "Journal persistence failed; submission stopped",
          );
        return this.pending(this.state.entries[key]);
      }
      return this.record(key, result);
    });
  }
  async close() {
    this.closing = true;
    await this.queue;
    if (this.ownsLock) {
      await this.releaseOwnership!();
      this.ownsLock = false;
    }
  }
}
