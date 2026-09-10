import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseOperation } from "./schema.js";
import type { LabScenario, Operation } from "./types.js";

/** Load inert, registered application output before any fixture is funded.
 * No imports, commands, absolute entity IDs, symlinks or external files. */
export async function prepareApplicationOperations(
  scenario: LabScenario,
  workspace: string,
) {
  const root = await realpath(workspace);
  const plans = new Map<string, Operation[]>();
  const artifacts: Record<string, string> = {};
  const selected = new Map<string, Set<number>>();
  const prepared = structuredClone(scenario);
  for (const step of prepared.steps) {
    const ref = step.planOperation;
    if (!ref) continue;
    if (!plans.has(ref.file)) {
      if (plans.size >= 20) throw Error("Too many application plans");
      const parts = ref.file.split("/");
      if (
        path.isAbsolute(ref.file) ||
        ref.file.includes("\\") ||
        parts.some((p) => !p || p === "." || p === "..")
      )
        throw Error("Application plan must be a relative workspace file");
      let current = root;
      for (const part of parts) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink())
          throw Error("Application plan symlinks are forbidden");
      }
      const info = await lstat(current);
      if (!info.isFile() || info.size > 65536)
        throw Error(
          "Application plan must be a regular file of at most 64 KiB",
        );
      const raw = await readFile(current);
      if (raw.length > 65536) throw Error("Application plan exceeds 64 KiB");
      const value = JSON.parse(raw.toString("utf8"));
      if (
        !value ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (k) => !["schemaVersion", "operations"].includes(k),
        ) ||
        value.schemaVersion !== 1 ||
        !Array.isArray(value.operations) ||
        value.operations.length < 1 ||
        value.operations.length > 20
      )
        throw Error(
          "Application plan requires schemaVersion 1 and 1–20 operations",
        );
      plans.set(
        ref.file,
        value.operations.map((o: unknown) =>
          parseOperation(o, scenario.fixtures),
        ),
      );
      artifacts[ref.file] = createHash("sha256").update(raw).digest("hex");
    }
    const indices = selected.get(ref.file) ?? new Set<number>();
    if (indices.has(ref.index))
      throw Error("Application plan operation referenced more than once");
    indices.add(ref.index);
    selected.set(ref.file, indices);
    const operation = plans.get(ref.file)![ref.index];
    if (!operation) throw Error("Application plan operation index is missing");
    step.operation = structuredClone(operation);
  }
  for (const [file, operations] of plans)
    if (selected.get(file)!.size !== operations.length)
      throw Error(
        "Every application plan operation must be covered by the scenario",
      );
  return { scenario: prepared, artifacts };
}
