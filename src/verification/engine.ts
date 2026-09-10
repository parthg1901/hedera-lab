import {
  executionTerms,
  validateEnvironments,
  type ExecutionTerms,
} from "./contracts.js";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { recommend, validateChanges, type ChangeSet } from "./changes.js";
import { Store } from "./store.js";
import {
  amount,
  event,
  Fault,
  hash,
  id,
  label,
  type Job,
  type Mandate,
  type Pack,
  type Quote,
  type Selection,
  type State,
} from "./model.js";
export interface Auditor {
  record(
    job: Job,
    quote: Quote,
  ): Promise<{ topicId: string; transactionId: string }>;
}
export interface Executor {
  canResume?(quote: Quote): boolean;
  reserve?(quote: Quote, job: Job): Promise<void>;
  release?(quote: Quote, job: Job): Promise<void>;
  readiness?(
    pack: Pack,
    probe?: boolean,
    jobId?: string,
  ): Promise<{ available: boolean; reason: string }>;
  run(
    quote: Quote,
    job: Job,
  ): Promise<{ infrastructureFailure: boolean; report: unknown }>;
}
export interface Payment {
  mode: "simulated" | "testnet";
  requirements(quote: Quote): Promise<unknown>;
  reconcile?(quote: Quote, job: Job): Promise<"paid" | "failed" | "unknown">;
  prepare?(
    payload: unknown,
    quote: Quote,
  ): Promise<{ transaction: string; payer: string }>;
  settle(
    payload: unknown,
    quote: Quote,
  ): Promise<{ transaction: string; payer: string }>;
}
export class RejectedPayment extends Error {}
export function authenticate(m: Mandate | undefined, token: string) {
  if (
    !m ||
    !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(m.tokenHash))
  )
    throw new Fault(401, "Invalid mandate capability");
}
export function totals(s: State, mandateId: string) {
  let spent = 0n,
    reserved = 0n;
  for (const j of Object.values(s.jobs).filter(
    (j) => j.mandateId === mandateId,
  )) {
    const price = amount(s.quotes[j.quoteId].price);
    if (
      ["paid", "running", "complete", "infrastructure_failed"].includes(j.state)
    )
      spent += price;
    else if (j.state !== "payment_failed") reserved += price;
  }
  return { spent: spent.toString(), reserved: reserved.toString() };
}
export async function fingerprint(pack: Pack): Promise<string> {
  const files: Record<string, string> = {};
  let count = 0;
  async function visit(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if ([".git", "node_modules", ".harness", "dist"].includes(entry.name))
        continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new Fault(409, "Registered workspaces must not contain symlinks");
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        if (++count > 2000)
          throw new Fault(413, "Workspace exceeds 2000 files");
        files[path.relative(pack.workspace, file)] = hash(
          (await readFile(file)).toString("base64"),
        );
      }
    }
  }
  await visit(pack.workspace);
  return hash({
    scenario: hash((await readFile(pack.scenario)).toString("base64")),
    files,
  });
}
export class Exchange {
  private settling = new Map<string, Promise<Job>>();
  private running = new Map<string, Promise<void>>();
  constructor(
    readonly store: Store,
    readonly packs: Pack[],
    readonly target: string,
    readonly payment: Payment,
    readonly executor: Executor,
    readonly auditor?: Auditor,
  ) {
    if (new Set(packs.map((p) => p.id)).size !== packs.length)
      throw new Error("Duplicate pack IDs");
    packs.forEach((p) => {
      label(p.id, "pack ID");
      if (amount(p.priceTinybar) <= 0n)
        throw new Error("Pack price must be positive");
    });
  }
  async catalog() {
    return Promise.all(
      this.packs.map(async (pack) => {
        const terms = await executionTerms(pack);
        const readiness = this.executor.readiness
          ? await this.executor.readiness(pack)
          : {
              available: terms.access !== "ledger-write",
              reason: "Executor has no live funding support",
            };
        return {
          id: pack.id,
          title: pack.title,
          description: pack.description,
          priceTinybar: pack.priceTinybar,
          risks: pack.risks ?? [],
          driver: pack.driver ?? "lab",
          execution: terms,
          availability: readiness,
        };
      }),
    );
  }
  private async checkPack(
    pack: Pack,
    allowed: string[],
    probe: boolean,
    jobId?: string,
  ): Promise<ExecutionTerms> {
    const terms = await executionTerms(pack);
    if (!allowed.includes(terms.environment))
      throw new Fault(
        422,
        `Execution environment ${terms.environment} is outside the mandate`,
      );
    const ready = this.executor.readiness
      ? await this.executor.readiness(pack, probe, jobId)
      : {
          available: terms.access !== "ledger-write",
          reason: "Executor has no live funding support",
        };
    if (!ready.available)
      throw new Fault(503, `Package ${pack.id} unavailable: ${ready.reason}`);
    return terms;
  }
  private async validateExecution(q: Quote, m: Mandate, jobId?: string) {
    if (!q.execution)
      throw new Fault(
        409,
        "Legacy quote requires a new explicit execution contract",
      );
    for (const entry of q.execution) {
      const pack = this.packs.find((p) => p.id === entry.pack);
      if (
        !pack ||
        hash(
          await this.checkPack(
            pack,
            m.executionEnvironments ?? ["simulated", "mainnet-preflight"],
            true,
            jobId,
          ),
        ) !== hash(entry.terms)
      )
        throw new Fault(409, "Execution terms changed; obtain a new quote");
    }
  }
  async createMandate(input: {
    target: string;
    revision: string;
    required: string[];
    ceiling: string;
    reserve?: string;
    executionEnvironments?: import("./contracts.js").Environment[];
    executionCeilings?: Partial<Record<"local" | "testnet", string>>;
  }) {
    if (input.target !== this.target)
      throw new Fault(400, "Unknown registered target");
    label(input.revision, "revision");
    if (
      !Array.isArray(input.required) ||
      !input.required.length ||
      new Set(input.required).size !== input.required.length ||
      input.required.some((p) => !this.packs.some((x) => x.id === p))
    )
      throw new Fault(400, "Required checks must be unique registered packs");
    const ceiling = amount(input.ceiling),
      reserve = amount(input.reserve ?? "0");
    if (ceiling <= reserve)
      throw new Fault(400, "Budget must exceed safety reserve");
    const allowed = validateEnvironments(
      input.executionEnvironments ?? ["simulated", "mainnet-preflight"],
    );
    const ceilings = input.executionCeilings ?? {};
    for (const [network, value] of Object.entries(ceilings)) {
      if (!["local", "testnet"].includes(network))
        throw new Fault(400, "Unknown execution funding network");
      amount(value);
    }
    for (const pid of input.required)
      await this.checkPack(
        this.packs.find((p) => p.id === pid)!,
        allowed,
        false,
      );
    const token = id() + id();
    const m: Mandate = {
      id: id(),
      target: this.target,
      revision: input.revision,
      required: input.required,
      ceiling: ceiling.toString(),
      reserve: reserve.toString(),
      executionEnvironments: allowed,
      executionCeilings: ceilings,
      tokenHash: hash(token),
      createdAt: new Date().toISOString(),
    };
    await this.store.mutate((s) => {
      s.mandates[m.id] = m;
      event(s, "mandate.created", { ...m, tokenHash: undefined });
    });
    return { mandateId: m.id, token };
  }
  async view(mid: string, token: string) {
    const s = await this.store.read();
    const m = s.mandates[mid];
    authenticate(m, token);
    return {
      mandate: { ...m, tokenHash: undefined },
      budget: totals(s, mid),
      executionAvailable: Object.fromEntries(
        (["local", "testnet"] as const).map((network) => {
          const committed = Object.values(s.jobs)
            .filter((j) => j.mandateId === mid && j.state !== "payment_failed")
            .reduce(
              (n, j) =>
                n +
                amount(s.quotes[j.quoteId].executionExposure?.[network] ?? "0"),
              0n,
            );
          const remaining =
            amount(m.executionCeilings?.[network] ?? "0") - committed;
          return [network, (remaining > 0n ? remaining : 0n).toString()];
        }),
      ),
      quotes: Object.values(s.quotes).filter((q) => q.mandateId === mid),
      jobs: Object.values(s.jobs).filter((j) => j.mandateId === mid),
      timeline: s.events.filter((e) => {
        const d = e.data as {
          mandateId?: string;
          id?: string;
          jobId?: string;
          quoteId?: string;
        };
        return (
          d.mandateId === mid ||
          d.id === mid ||
          (d.jobId && s.jobs[d.jobId]?.mandateId === mid) ||
          (d.quoteId && s.quotes[d.quoteId]?.mandateId === mid)
        );
      }),
    };
  }
  async quote(
    mid: string,
    token: string,
    selection: Selection[],
    parent?: string,
    changes?: ChangeSet,
  ): Promise<Quote> {
    const s = await this.store.read();
    const m = s.mandates[mid];
    authenticate(m, token);
    if (
      !Array.isArray(selection) ||
      selection.length < 1 ||
      selection.length > 20 ||
      new Set(selection.map((x) => x.pack)).size !== selection.length
    )
      throw new Fault(400, "Select 1–20 unique packs");
    if (m.required.some((p) => !selection.some((x) => x.pack === p)))
      throw new Fault(422, "Counteroffer cannot remove mandatory checks");
    let price = 0n;
    const artifacts: Record<string, string> = {};
    const execution: NonNullable<Quote["execution"]> = [];
    const executionExposure: NonNullable<Quote["executionExposure"]> = {};
    for (const item of selection) {
      const pack = this.packs.find((p) => p.id === item.pack);
      if (
        !pack ||
        !Number.isInteger(item.repetitions) ||
        item.repetitions < 1 ||
        item.repetitions > 20
      )
        throw new Fault(400, "Unknown pack or repetitions outside 1–20");
      const terms = await this.checkPack(
        pack,
        m.executionEnvironments ?? ["simulated", "mainnet-preflight"],
        true,
      );
      execution.push({ pack: pack.id, repetitions: item.repetitions, terms });
      if (terms.fundingNetwork !== "none") {
        const network = terms.fundingNetwork;
        executionExposure[network] = (
          amount(executionExposure[network] ?? "0") +
          amount(terms.maximumExposureTinybar) * BigInt(item.repetitions)
        ).toString();
        if (
          amount(executionExposure[network]!) >
          amount(m.executionCeilings?.[network] ?? "0")
        )
          throw new Fault(
            422,
            `${network} execution exposure exceeds authorized ceiling`,
          );
      }
      price += amount(pack.priceTinybar) * BigInt(item.repetitions);
      artifacts[pack.id] = await fingerprint(pack);
    }
    const prior = parent ? s.quotes[parent] : undefined;
    if (parent && (!prior || prior.mandateId !== mid))
      throw new Fault(404, "Parent quote not found");
    if (prior && prior.round >= 5)
      throw new Fault(
        409,
        "Negotiation reached five rounds; request a new proposal",
      );
    const assessment = changes
      ? recommend(this.packs, m.required, validateChanges(changes))
      : undefined;
    const contract = {
      id: id(),
      mandateId: mid,
      ...(parent ? { parent } : {}),
      round: (prior?.round ?? 0) + 1,
      ...(assessment ? { changeHash: assessment.changeHash } : {}),
      selection,
      target: m.target,
      revision: m.revision,
      execution,
      executionExposure,
      settlement: {
        network: this.payment.mode,
        asset: "HBAR" as const,
        serviceFeeTinybar: price.toString(),
        executionFundingIncluded: false as const,
        paymentTransactionFee:
          "Separate payer/facilitator network fee; not an application execution fee",
      },
      price: price.toString(),
      expiresAt: Date.now() + 300_000,
      artifacts,
      rationale: `${selection.reduce((n, x) => n + x.repetitions, 0)} executions; mandatory checks preserved; fixed prices from the provider catalog. Payment buys execution and evidence, regardless of pass/fail.`,
    };
    const quote: Quote = { ...contract, contractHash: hash(contract) };
    await this.store.mutate((state) => {
      state.quotes[quote.id] = quote;
      event(state, "quote.issued", quote);
      if (assessment)
        event(state, "change.assessed", {
          mandateId: mid,
          quoteId: quote.id,
          ...assessment,
        });
    });
    return quote;
  }
  async accept(qid: string, token: string): Promise<Job> {
    const snapshot = await this.store.read();
    const quoted = snapshot.quotes[qid];
    if (!quoted) throw new Fault(404, "Quote not found");
    authenticate(snapshot.mandates[quoted.mandateId], token);
    if (!Object.values(snapshot.jobs).some((j) => j.quoteId === qid))
      await this.validateExecution(quoted, snapshot.mandates[quoted.mandateId]);
    return this.store.mutate((s) => {
      const q = s.quotes[qid];
      if (!q) throw new Fault(404, "Quote not found");
      const m = s.mandates[q.mandateId];
      authenticate(m, token);
      const existing = Object.values(s.jobs).find((j) => j.quoteId === qid);
      if (existing) return existing;
      if (q.expiresAt < Date.now()) throw new Fault(410, "Quote expired");
      const t = totals(s, m.id);
      if (
        amount(t.spent) + amount(t.reserved) + amount(q.price) >
        amount(m.ceiling) - amount(m.reserve)
      )
        throw new Fault(402, "Quote exceeds available customer budget");
      for (const network of ["local", "testnet"] as const) {
        const committed = Object.values(s.jobs)
          .filter((j) => j.mandateId === m.id && j.state !== "payment_failed")
          .reduce(
            (sum, j) =>
              sum +
              amount(s.quotes[j.quoteId].executionExposure?.[network] ?? "0"),
            0n,
          );
        if (
          committed + amount(q.executionExposure?.[network] ?? "0") >
          amount(m.executionCeilings?.[network] ?? "0")
        )
          throw new Fault(
            402,
            `${network} cumulative execution ceiling exceeded`,
          );
      }
      const j: Job = {
        id: id(),
        quoteId: qid,
        mandateId: m.id,
        state: "reserved",
        createdAt: new Date().toISOString(),
      };
      s.jobs[j.id] = j;
      event(s, "quote.accepted", {
        jobId: j.id,
        quoteId: qid,
        contractHash: q.contractHash,
      });
      return j;
    });
  }
  async cancel(jid: string, token: string) {
    const cancelled = await this.store.mutate((s) => {
      const j = s.jobs[jid];
      if (!j) throw new Fault(404, "Job not found");
      authenticate(s.mandates[j.mandateId], token);
      if (j.state !== "reserved")
        throw new Fault(409, "Only unpaid, unsubmitted jobs can be cancelled");
      j.state = "payment_failed";
      j.error = "Cancelled before submission";
      event(s, "job.cancelled", { jobId: jid });
      return j;
    });
    const state = await this.store.read();
    await this.executor.release?.(state.quotes[cancelled.quoteId], cancelled);
    return cancelled;
  }
  async job(jid: string, token: string) {
    const s = await this.store.read();
    const j = s.jobs[jid];
    if (!j) throw new Fault(404, "Job not found");
    authenticate(s.mandates[j.mandateId], token);
    return j;
  }
  async pay(jid: string, token: string, payload: unknown): Promise<Job> {
    await this.job(jid, token);
    if (this.settling.has(jid)) return this.settling.get(jid)!;
    const task = this.payOnce(jid, payload);
    this.settling.set(jid, task);
    try {
      return await task;
    } finally {
      this.settling.delete(jid);
    }
  }
  private async payOnce(jid: string, payload: unknown) {
    const s = await this.store.read();
    const j = s.jobs[jid],
      q = s.quotes[j.quoteId];
    if (
      ["paid", "running", "complete", "infrastructure_failed"].includes(j.state)
    )
      return j;
    if (j.state !== "reserved")
      throw new Fault(
        409,
        "Payment outcome needs reconciliation; do not pay again",
      );
    if (q.expiresAt < Date.now())
      throw new Fault(
        410,
        "Quote expired; cancel the reservation and negotiate again",
      );
    for (const entry of q.selection)
      if (
        (await fingerprint(this.packs.find((p) => p.id === entry.pack)!)) !==
        q.artifacts[entry.pack]
      )
        throw new Fault(
          409,
          "Target or scenario changed since quotation; obtain a new quote",
        );
    await this.validateExecution(q, s.mandates[j.mandateId], j.id);
    let identity: { transaction: string; payer: string } | undefined;
    try {
      identity = await this.payment.prepare?.(payload, q);
    } catch (error) {
      if (error instanceof RejectedPayment)
        throw new Fault(
          402,
          "Payment proof rejected before submission; reservation remains available",
        );
      throw error;
    }
    await this.executor.reserve?.(q, j);
    const paymentHash = hash(payload);
    await this.store.mutate((state) => {
      if (state.jobs[jid].state !== "reserved")
        throw new Fault(409, "Job no longer accepts payment");
      if (
        Object.values(state.jobs).some(
          (x) => x.paymentHash === paymentHash && x.id !== jid,
        )
      )
        throw new Fault(409, "Payment proof already bound to another job");
      Object.assign(state.jobs[jid], identity);
      state.jobs[jid].paymentHash = paymentHash;
      state.jobs[jid].state = "settling";
      event(state, "payment.submitting", { jobId: jid, paymentHash });
    });
    try {
      const result = await this.payment.settle(payload, q);
      await this.store.mutate((state) => {
        Object.assign(state.jobs[jid], result, { state: "paid" });
        event(state, "payment.settled", { jobId: jid, ...result });
      });
    } catch (e) {
      const definite = e instanceof RejectedPayment;
      await this.store.mutate((state) => {
        state.jobs[jid].state = definite ? "payment_failed" : "payment_unknown";
        state.jobs[jid].error = definite
          ? "Payment rejected before settlement"
          : "Settlement outcome unknown; reservation retained for reconciliation";
        event(state, "payment.unresolved", { jobId: jid, definite });
      });
      if (definite) await this.executor.release?.(q, j).catch(() => undefined);
      throw new Fault(
        definite ? 402 : 503,
        definite
          ? "Payment rejected"
          : "Settlement outcome unknown; do not pay again",
      );
    }
    this.dispatch(jid);
    return (await this.store.read()).jobs[jid];
  }
  dispatch(jid: string) {
    if (this.running.has(jid)) return;
    const task = this.execute(jid).finally(() => this.running.delete(jid));
    this.running.set(jid, task);
    task.catch(() => undefined);
  }
  private async execute(jid: string) {
    const s = await this.store.read();
    const j = s.jobs[jid];
    if (j.state !== "paid") return;
    const q = s.quotes[j.quoteId];
    await this.store.mutate((state) => {
      state.jobs[jid].state = "running";
      event(state, "verification.started", { jobId: jid });
    });
    try {
      for (const entry of q.selection)
        if (
          (await fingerprint(this.packs.find((p) => p.id === entry.pack)!)) !==
          q.artifacts[entry.pack]
        )
          throw new Error(
            "Artifact changed after payment; operator remediation required",
          );
      await this.validateExecution(q, s.mandates[j.mandateId], j.id);
      const result = await this.executor.run(q, j);
      for (const entry of q.selection)
        if (
          (await fingerprint(this.packs.find((p) => p.id === entry.pack)!)) !==
          q.artifacts[entry.pack]
        )
          throw new Error("Artifact changed during execution");
      await this.store.mutate((state) => {
        Object.assign(state.jobs[jid], {
          state: result.infrastructureFailure
            ? "infrastructure_failed"
            : "complete",
          report: result.report,
          reportHash: hash(result.report),
        });
        event(state, "verification.delivered", {
          jobId: jid,
          reportHash: hash(result.report),
          infrastructureFailure: result.infrastructureFailure,
        });
      });
      if (this.auditor) {
        try {
          const record = await this.auditor.record(
            (await this.store.read()).jobs[jid],
            q,
          );
          await this.store.mutate((state) => {
            state.jobs[jid].audit = { state: "recorded", ...record };
            event(state, "evidence.anchored", { jobId: jid, ...record });
          });
        } catch {
          await this.store.mutate((state) => {
            state.jobs[jid].audit = { state: "failed" };
            event(state, "evidence.anchor_failed", { jobId: jid });
          });
        }
      }
    } catch {
      await this.store.mutate((state) => {
        state.jobs[jid].state = "infrastructure_failed";
        state.jobs[jid].error =
          "Execution interrupted or artifacts changed; operator remediation required";
        event(state, "verification.interrupted", { jobId: jid });
      });
    }
  }
  async reconcile(jid: string) {
    const s = await this.store.read();
    const j = s.jobs[jid];
    if (!j || j.state !== "payment_unknown" || !this.payment.reconcile)
      throw new Fault(409, "Job is not eligible for payment reconciliation");
    const outcome = await this.payment.reconcile(s.quotes[j.quoteId], j);
    await this.store.mutate((state) => {
      const current = state.jobs[jid];
      if (current.state !== "payment_unknown")
        throw new Fault(409, "Payment state changed");
      if (outcome !== "unknown") {
        current.state = outcome === "paid" ? "paid" : "payment_failed";
        delete current.error;
      }
      event(state, "payment.reconciled", { jobId: jid, outcome });
    });
    if (outcome === "failed")
      await this.executor
        .release?.(s.quotes[j.quoteId], j)
        .catch(() => undefined);
    if (outcome === "paid") this.dispatch(jid);
    return (await this.store.read()).jobs[jid];
  }
  async recoverStartup() {
    const identity = hash({
      target: this.target,
      mode: this.payment.mode,
      payTo: (this.payment as Payment & { payTo?: string }).payTo,
      packs: this.packs,
    });
    const ids = await this.store.mutate((s) => {
      if (s.serviceIdentity && s.serviceIdentity !== identity)
        throw new Error(
          "Store belongs to a different service configuration; use a separate store",
        );
      s.serviceIdentity = identity;
      for (const j of Object.values(s.jobs)) {
        if (j.state === "settling") {
          j.state = "payment_unknown";
          event(s, "payment.recovery_required", { jobId: j.id });
        }
        if (
          j.state === "running" &&
          this.executor.canResume?.(s.quotes[j.quoteId])
        ) {
          j.state = "paid";
          event(s, "worker.resume_requested", { jobId: j.id });
        } else if (j.state === "running") {
          j.state = "infrastructure_failed";
          j.error =
            "Process stopped during execution; live writes are not automatically replayed";
          event(s, "verification.interrupted", { jobId: j.id });
        }
      }
      return Object.values(s.jobs)
        .filter((j) => j.state === "paid")
        .map((j) => j.id);
    });
    ids.forEach((j) => this.dispatch(j));
  }
  async idle() {
    await Promise.all([...this.settling.values(), ...this.running.values()]);
  }
}
