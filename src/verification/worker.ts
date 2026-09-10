import { createServer, request } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { Store } from "./store.js";
import {
  amount,
  event,
  Fault,
  hash,
  label,
  type Job,
  type Pack,
  type Quote,
} from "./model.js";
import { executionTerms } from "./contracts.js";
import { fingerprint, type Executor } from "./engine.js";
import { prepareApplicationOperations } from "../lab/plan.js";
import { loadScenario } from "../lab/schema.js";

export type Result = Awaited<ReturnType<Executor["run"]>>;
export interface WorkerJob {
  id: string;
  binding: string;
  quote: Quote;
  job: Job;
  exposure: string;
  state:
    | "reserved"
    | "queued"
    | "running"
    | "complete"
    | "interrupted"
    | "cancelled";
  result?: Result;
  createdAt: string;
}
/** One trusted API schedules immutable registered work. No uploads, paths or commands
 * from requests are accepted. A running job is never replayed after process death. */
export class TestnetWorker {
  private active = new Map<string, Promise<void>>();
  private queue: Promise<void> = Promise.resolve();
  constructor(
    readonly store: Store,
    readonly packs: Pack[],
    readonly executor: Executor,
    private balance: () => Promise<bigint>,
  ) {}
  async start() {
    const identity = hash(
      await Promise.all(
        this.packs.map(async (p) => ({
          pack: p,
          artifact: await fingerprint(p),
        })),
      ),
    );
    await this.store.mutate((s) => {
      if (s.workerIdentity && s.workerIdentity !== identity)
        throw Error("Worker store belongs to another registered build");
      s.workerIdentity = identity;
      s.workerJobs ??= {};
      for (const w of Object.values(s.workerJobs))
        if (w.state === "running") {
          w.state = "interrupted";
          w.result = {
            infrastructureFailure: true,
            report: {
              jobId: w.id,
              contractHash: w.quote.contractHash,
              passed: false,
              executed: 0,
              runs: [],
              error:
                "Worker stopped during execution; inspect private recovery journals. No automatic replay.",
            },
          };
          event(s, "worker.interrupted", { jobId: w.id });
        }
    });
    const state = await this.store.read();
    for (const w of Object.values(state.workerJobs ?? {}))
      if (w.state === "queued") this.dispatch(w.id);
  }
  private held(jobs: Record<string, WorkerJob>, exclude?: string) {
    return Object.values(jobs)
      .filter(
        (w) =>
          w.id !== exclude &&
          ["reserved", "queued", "running", "interrupted"].includes(w.state),
      )
      .reduce((n, w) => n + amount(w.exposure), 0n);
  }
  async readiness(packId: string, jobId?: string) {
    const pack = this.packs.find((p) => p.id === packId);
    if (!pack)
      return {
        available: false,
        reason: "Package is not registered on this worker",
      };
    try {
      const ready = await this.executor.readiness?.(pack, true);
      if (!ready?.available)
        return (
          ready ?? { available: false, reason: "Live executor is unavailable" }
        );
      const s = await this.store.read();
      const available =
        (await this.balance()) - this.held(s.workerJobs ?? {}, jobId);
      return {
        available:
          available >=
          amount((await executionTerms(pack)).maximumExposureTinybar),
        reason:
          available >=
          amount((await executionTerms(pack)).maximumExposureTinybar)
            ? "Dedicated testnet worker ready; funded capacity reserved before settlement"
            : "Worker execution funds are reserved or insufficient",
      };
    } catch {
      return {
        available: false,
        reason: "Testnet worker network or signer is unavailable",
      };
    }
  }
  private async validate(quote: Quote, job: Job) {
    if (!quote || !job) throw new Fault(400, "Quote and job required");
    label(job.id, "worker job ID");
    const { contractHash, ...contract } = quote;
    if (
      contractHash !== hash(contract) ||
      job.quoteId !== quote.id ||
      job.mandateId !== quote.mandateId
    )
      throw new Fault(409, "Worker contract binding mismatch");
    if (
      !Array.isArray(quote.selection) ||
      quote.selection.length > 20 ||
      new Set(quote.selection.map((s) => s.pack)).size !==
        quote.selection.length
    )
      throw new Fault(400, "Invalid worker selection");
    let exposure = 0n;
    const selection = [];
    for (const item of quote.selection) {
      const entry = quote.execution?.find((e) => e.pack === item.pack);
      if (entry?.terms.environment !== "testnet") continue;
      const p = this.packs.find((p) => p.id === item.pack);
      if (
        !p ||
        !Number.isInteger(item.repetitions) ||
        item.repetitions < 1 ||
        item.repetitions > 20 ||
        entry.repetitions !== item.repetitions
      )
        throw new Fault(400, "Unregistered testnet work");
      const { scenario } = await loadScenario(p.scenario);
      await prepareApplicationOperations(scenario, p.workspace);
      if (scenario.server || scenario.network.mode !== "testnet")
        throw new Fault(
          400,
          "Worker accepts registered direct testnet scenarios only",
        );
      if (
        hash(entry.terms) !== hash(await executionTerms(p)) ||
        quote.artifacts[p.id] !== (await fingerprint(p))
      )
        throw new Fault(
          409,
          "Worker artifacts or funding terms differ from quote",
        );
      exposure +=
        amount(entry.terms.maximumExposureTinybar) * BigInt(item.repetitions);
      selection.push(item);
    }
    if (
      !selection.length ||
      exposure.toString() !== quote.executionExposure?.testnet
    )
      throw new Fault(400, "Worker execution exposure mismatch");
    return {
      exposure: exposure.toString(),
      binding: hash({ quote, jobId: job.id }),
      selection,
    };
  }
  async reserve(q: Quote, j: Job) {
    const valid = await this.validate(q, j);
    const existing = (await this.store.read()).workerJobs?.[j.id];
    if (existing) {
      if (existing.binding !== valid.binding)
        throw new Fault(409, "Worker job binding changed");
      if (existing.state === "cancelled")
        throw new Fault(409, "Worker reservation was cancelled");
      return this.public(existing);
    }
    if (q.expiresAt < Date.now()) throw new Fault(410, "Worker quote expired");
    const balance = await this.balance();
    return this.store.mutate((s) => {
      s.workerJobs ??= {};
      const current = s.workerJobs[j.id];
      if (current) {
        if (current.binding !== valid.binding)
          throw new Fault(409, "Worker job binding changed");
        return this.public(current);
      }
      const pending = Object.values(s.workerJobs).filter((w) =>
        ["reserved", "queued", "running", "interrupted"].includes(w.state),
      );
      if (
        pending.length >= 16 ||
        this.held(s.workerJobs) + amount(valid.exposure) > balance
      )
        throw new Fault(
          503,
          "Worker has no funded execution capacity; payment was not submitted",
        );
      const w: WorkerJob = {
        id: j.id,
        binding: valid.binding,
        quote: q,
        job: j,
        exposure: valid.exposure,
        state: "reserved",
        createdAt: new Date().toISOString(),
      };
      s.workerJobs[j.id] = w;
      event(s, "worker.reserved", { jobId: j.id, exposure: w.exposure });
      return this.public(w);
    });
  }
  async run(id: string) {
    await this.store.mutate((s) => {
      const w = s.workerJobs?.[id];
      if (!w) throw new Fault(404, "Worker reservation not found");
      if (w.state === "cancelled")
        throw new Fault(409, "Worker reservation cancelled");
      if (w.state === "reserved") {
        w.state = "queued";
        event(s, "worker.queued", { jobId: id });
      }
    });
    this.dispatch(id);
    return this.get(id);
  }
  private dispatch(id: string) {
    if (this.active.has(id)) return;
    const task = this.queue
      .then(async () => {
        const w = (await this.store.read()).workerJobs?.[id];
        if (!w || w.state !== "queued") return;
        await this.store.mutate((s) => {
          s.workerJobs![id].state = "running";
          event(s, "worker.started", { jobId: id });
        });
        let result: Result;
        try {
          await this.validate(w.quote, w.job);
          result = await this.executor.run(w.quote, w.job);
        } catch {
          result = {
            infrastructureFailure: true,
            report: {
              jobId: id,
              contractHash: w.quote.contractHash,
              passed: false,
              executed: 0,
              runs: [],
              error:
                "Worker execution interrupted; inspect private recovery journals",
            },
          };
        }
        await this.store.mutate((s) => {
          const current = s.workerJobs![id];
          current.result = result;
          current.state = result.infrastructureFailure
            ? "interrupted"
            : "complete";
          event(s, "worker.delivered", {
            jobId: id,
            reportHash: hash(result.report),
            state: current.state,
          });
        });
      })
      .finally(() => this.active.delete(id));
    this.queue = task.catch(() => undefined);
    this.active.set(id, task);
    task.catch(() => undefined);
  }
  private public(w: WorkerJob) {
    return { id: w.id, binding: w.binding, state: w.state, result: w.result };
  }
  async get(id: string) {
    const w = (await this.store.read()).workerJobs?.[id];
    if (!w) throw new Fault(404, "Worker job not found");
    return this.public(w);
  }
  async release(id: string) {
    return this.store.mutate((s) => {
      const w = s.workerJobs?.[id];
      if (!w) return { released: true };
      if (!["reserved", "cancelled"].includes(w.state))
        throw new Fault(409, "Worker work already started; cannot release");
      w.state = "cancelled";
      event(s, "worker.cancelled", { jobId: id });
      return { released: true };
    });
  }
  async idle() {
    await this.queue;
  }
}

export async function startWorkerServer(
  worker: TestnetWorker,
  socket: string,
  secret: string,
) {
  if (secret.length < 32)
    throw Error("Worker secret must have at least 32 characters");
  // Caller holds the exclusive worker store lock before replacing a stale socket.
  const old = await lstat(socket).catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return undefined;
    throw e;
  });
  if (old) {
    if (!old.isSocket()) throw Error("Worker socket path is not a socket");
    await unlink(socket);
  }
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(data));
    };
    try {
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!timingSafeEqual(Buffer.from(hash(auth)), Buffer.from(hash(secret))))
        throw new Fault(401, "Invalid worker authorization");
      const url = new URL(req.url ?? "/", "http://worker");
      if (req.method === "GET" && url.pathname === "/health") {
        send(200, { ok: true });
        return;
      }
      const ready = url.pathname.match(/^\/readiness\/([\w-]+)$/);
      if (req.method === "GET" && ready) {
        send(
          200,
          await worker.readiness(
            ready[1],
            url.searchParams.get("job") ?? undefined,
          ),
        );
        return;
      }
      if (req.method === "POST" && url.pathname === "/reserve") {
        let size = 0;
        const chunks = [];
        for await (const b of req) {
          size += b.length;
          if (size > 128000) throw new Fault(413, "Worker request too large");
          chunks.push(b);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          throw new Fault(400, "Invalid worker JSON");
        }
        send(201, await worker.reserve(body.quote, body.job));
        return;
      }
      const job = url.pathname.match(/^\/jobs\/([\w-]+)(?:\/(run|release))?$/);
      if (job) {
        if (req.method === "GET" && !job[2]) {
          send(200, await worker.get(job[1]));
          return;
        }
        if (req.method === "POST" && job[2] === "run") {
          send(202, await worker.run(job[1]));
          return;
        }
        if (req.method === "POST" && job[2] === "release") {
          send(200, await worker.release(job[1]));
          return;
        }
      }
      throw new Fault(404, "Worker route not found");
    } catch (e) {
      send(e instanceof Fault ? e.status : 500, {
        error:
          e instanceof Fault
            ? e.message
            : "Worker operation failed; inspect private worker state",
      });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  return server;
}
export function workerRequest(
  socket: string,
  secret: string,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: socket,
        path: route,
        method,
        headers: {
          authorization: "Bearer " + secret,
          "content-type": "application/json",
        },
      },
      (res) => {
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (b) => {
          size += b.length;
          if (size > 8000000) {
            res.destroy();
            reject(Error("Worker response too large"));
            return;
          }
          chunks.push(b);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString());
            if ((res.statusCode ?? 500) >= 400)
              reject(
                new Fault(
                  res.statusCode!,
                  value.error ?? "Worker request failed",
                ),
              );
            else resolve(value);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(20000, () => req.destroy(Error("Worker request timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
