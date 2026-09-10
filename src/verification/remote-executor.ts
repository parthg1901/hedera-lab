import { LabExecutor } from "./executor.js";
import { executionTerms } from "./contracts.js";
import { workerRequest } from "./worker.js";
import { hash, Fault, type Pack, type Quote, type Job } from "./model.js";
import type { Executor } from "./engine.js";
/** The API owns payments; the worker owns testnet keys and fixture journals. */
export class RoutedExecutor implements Executor {
  constructor(
    private local: LabExecutor,
    private socket: string,
    private secret: string,
  ) {}
  async readiness(pack: Pack, probe = false, jobId?: string) {
    if ((await executionTerms(pack)).environment !== "testnet")
      return this.local.readiness(pack, probe);
    try {
      return await workerRequest(
        this.socket,
        this.secret,
        "/readiness/" +
          encodeURIComponent(pack.id) +
          (jobId ? "?job=" + encodeURIComponent(jobId) : ""),
      );
    } catch {
      return {
        available: false,
        reason: "Dedicated testnet worker is offline or unreachable",
      };
    }
  }
  private remote(q: Quote) {
    return q.selection.filter(
      (s) =>
        q.execution?.find((e) => e.pack === s.pack)?.terms.environment ===
        "testnet",
    );
  }
  canResume(q: Quote) {
    return (
      this.remote(q).length > 0 && this.remote(q).length === q.selection.length
    );
  }
  async reserve(q: Quote, j: Job) {
    if (!this.remote(q).length) return;
    try {
      await workerRequest(this.socket, this.secret, "/reserve", "POST", {
        quote: q,
        job: j,
      });
    } catch (e) {
      throw e instanceof Fault
        ? e
        : new Fault(
            503,
            "Worker reservation unavailable; payment was not submitted",
          );
    }
  }
  async release(q: Quote, j: Job) {
    if (this.remote(q).length)
      await workerRequest(
        this.socket,
        this.secret,
        "/jobs/" + j.id + "/release",
        "POST",
      );
  }
  async run(q: Quote, j: Job) {
    const remote = this.remote(q);
    if (!remote.length) return this.local.run(q, j);
    const local = q.selection.filter(
      (s) => !remote.some((r) => r.pack === s.pack),
    );
    const pieces: any[] = [];
    if (local.length) {
      const result = await this.local.run(q, j, local);
      pieces.push(result);
      if (result.infrastructureFailure) {
        await this.release(q, j).catch(() => undefined);
        return result;
      }
    }
    // Resend only the idempotent dispatch command. Worker persists 'running' before
    // execution; its process restart marks that state interrupted, never queued.
    for (let attempt = 0; ; attempt++) {
      try {
        await workerRequest(
          this.socket,
          this.secret,
          "/jobs/" + j.id + "/run",
          "POST",
        );
        break;
      } catch (e) {
        if (attempt >= 2 || (e instanceof Fault && e.status < 500)) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const deadline = Date.now() + 240000;
    let terminal: any;
    while (Date.now() < deadline) {
      try {
        const state = await workerRequest(
          this.socket,
          this.secret,
          "/jobs/" + j.id,
        );
        if (state.binding !== hash({ quote: q, jobId: j.id }))
          throw new Fault(409, "Worker result binding mismatch");
        if (["complete", "interrupted"].includes(state.state)) {
          terminal = state;
          break;
        }
      } catch (e) {
        if (e instanceof Fault && e.status < 500) throw e;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!terminal?.result)
      throw new Error(
        "Worker result unavailable; do not submit a replacement job blindly",
      );
    const report = terminal.result.report;
    if (report?.jobId !== j.id || report?.contractHash !== q.contractHash)
      throw new Error("Unbound worker report");
    pieces.push(terminal.result);
    const runs = pieces.flatMap((p) => p.report.runs ?? []);
    const infrastructureFailure = pieces.some((p) => p.infrastructureFailure);
    return {
      infrastructureFailure,
      report: {
        schemaVersion: 1,
        jobId: j.id,
        quoteId: q.id,
        contractHash: q.contractHash,
        settlement: q.settlement,
        execution: q.execution,
        serviceFeeTinybar: q.price,
        quotedExecutions: q.selection.reduce((n, s) => n + s.repetitions, 0),
        executed: runs.length,
        passed: !infrastructureFailure && runs.every((r) => r.report.passed),
        funding: pieces.flatMap((p) => p.report.funding ?? []),
        runs,
        worker: {
          transport: "private-unix-socket",
          jobId: j.id,
          state: terminal.state,
        },
      },
    };
  }
}
