import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { acquireJournalOwnership } from "../lab/ownership.js";
import { emptyState, hash, type State } from "./model.js";
/** One process owns a store; serialized mutations and fsync precede external effects. */
export class Store {
  private queue: Promise<unknown> = Promise.resolve();
  private releaseOwnership?: () => Promise<void>;
  private state: State = emptyState();
  constructor(readonly directory: string) {}
  async start() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (this.releaseOwnership) throw new Error("Store already started");
    this.releaseOwnership = await acquireJournalOwnership(this.directory, "service");
    try {
      try {
        this.state = JSON.parse(
          await readFile(path.join(this.directory, "state.json"), "utf8"),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (this.state.version !== 1)
        throw new Error("Unsupported verification store version");
      let previous = "genesis";
      for (const e of this.state.events) {
        const { hash: recorded, ...body } = e;
        if (e.previousHash !== previous || hash(body) !== recorded)
          throw new Error("Verification event journal integrity check failed");
        previous = recorded;
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  async read(): Promise<State> {
    await this.queue;
    return structuredClone(this.state);
  }
  mutate<T>(fn: (s: State) => T): Promise<T> {
    const task = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = fn(next);
      const temp = path.join(this.directory, "state.json.tmp");
      const file = await open(temp, "w", 0o600);
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path.join(this.directory, "state.json"));
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      this.state = next;
      return structuredClone(result);
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
  async close() {
    await this.queue;
    await this.releaseOwnership?.();
    this.releaseOwnership = undefined;
  }
}
