import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import type { Assertion, BrowserAction, LabFixtures, LabNetwork, LabScenario, LabStep, Operation } from "./types.js";

function object(value: unknown, label: string, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (keys) for (const key of Object.keys(result)) if (!keys.includes(key)) throw new Error(`${label}: unknown field ${key}`);
  return result;
}
function str(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function num(value: unknown, label: string, min = 0, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be between ${min} and ${max}`);
  return value;
}
function hbar(value: unknown, label: string, min = 0, max = 1_000_000): number {
  const n = num(value, label, min, max);
  if (Math.abs(Math.round(n * 100_000_000) / 100_000_000 - n) > 1e-12) throw new Error(`${label} must have at most 8 decimal places`);
  return n;
}
function integer(value: unknown, label: string, min = 1, max = 1000): number {
  const n = num(value, label, min, max);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
}
function name(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error(`Invalid fixture/step name: ${value}`);
  return value;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const values = value.map(v => str(v, label));
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicates`);
  return values;
}
export function parseOperation(value: unknown, fixtures: LabFixtures): Operation {
  const o = object(value, "operation");
  const type = str(o.type, "operation.type");
  const fields: Record<string, string[]> = {
    associate: ["type", "actor", "token"], transferNft: ["type", "actor", "to", "token", "serial"],
    transferHbar: ["type", "actor", "to", "amount"], submitMessage: ["type", "actor", "topic", "message"],
  };
  if (!fields[type]) throw new Error(`Unknown operation ${type}`);
  object(value, "operation", fields[type]);
  reference(o.actor, fixtures.accounts, "actor");
  if ("to" in o) reference(o.to, fixtures.accounts, "to");
  if ("token" in o) reference(o.token, fixtures.tokens, "token");
  if (type === "transferNft") integer(o.serial, "serial");
  if (type === "transferHbar") hbar(o.amount, "amount", 0.00000001);
  if (type === "submitMessage") {
    reference(o.topic, Object.fromEntries(fixtures.topics.map(t => [t, true])), "topic");
    if (Buffer.byteLength(str(o.message, "message")) > 1024) throw new Error("message exceeds 1024 bytes");
  }
  for (const key of fields[type]) if (!(key in o)) throw new Error(`operation.${key} is required`);
  return o as unknown as Operation;
}
function reference(value: unknown, refs: object, label: string): void {
  const key = str(value, label);
  if (!Object.hasOwn(refs, key)) throw new Error(`Unknown ${label}: ${key}`);
}
function assertion(value: unknown, fixtures: LabFixtures): Assertion {
  const a = object(value, "assert");
  switch (a.type) {
    case "nftOwner":
      object(a, "assert", ["type", "token", "serial", "account"]);
      reference(a.token, fixtures.tokens, "token"); reference(a.account, fixtures.accounts, "account");
      integer(a.serial, "serial"); break;
    case "topicMessage":
      object(a, "assert", ["type", "topic", "message"]);
      reference(a.topic, Object.fromEntries(fixtures.topics.map(t => [t, true])), "topic"); str(a.message, "message"); break;
    case "hbarBalance":
      object(a, "assert", ["type", "account", "min", "max"]);
      reference(a.account, fixtures.accounts, "account"); num(a.min, "min"); num(a.max, "max");
      if ((a.min as number) > (a.max as number)) throw new Error("min exceeds max"); break;
    case "text":
      object(a, "assert", ["type", "selector", "equals"]); str(a.selector, "selector"); str(a.equals, "equals"); break;
    default: throw new Error(`Unknown assertion ${String(a.type)}`);
  }
  return a as unknown as Assertion;
}
export function parseScenario(value: unknown): LabScenario {
  const s = object(value, "scenario", ["schemaVersion", "name", "network", "fixtures", "faults", "server", "steps", "timeoutMs", "pollIntervalMs"]);
  if (s.schemaVersion !== 1) throw new Error("scenario.schemaVersion must be 1");
  const network = object(s.network, "network", ["mode", "mirrorUrl", "nodeAddress", "nodeAccountId", "operatorIdEnv", "operatorKeyEnv"]);
  if (!["simulated", "local", "testnet"].includes(String(network.mode))) throw new Error("network.mode must be simulated, local, or testnet");
  for (const key of ["operatorIdEnv", "operatorKeyEnv"]) if (network[key] !== undefined && !/^[A-Z_][A-Z0-9_]*$/.test(str(network[key], key))) throw new Error(`Invalid ${key}`);
  if (network.mode === "local") {
    if (!/^(localhost|127\.0\.0\.1):\d+$/.test(str(network.nodeAddress, "nodeAddress"))) throw new Error("local nodeAddress must be a loopback host:port");
    if (!/^0\.0\.\d+$/.test(str(network.nodeAccountId, "nodeAccountId"))) throw new Error("nodeAccountId must be 0.0.N");
    localUrl(str(network.mirrorUrl, "mirrorUrl"));
  } else if (network.mirrorUrl !== undefined || network.nodeAddress !== undefined || network.nodeAccountId !== undefined) {
    throw new Error("Endpoint overrides are only supported for local mode");
  }
  const f = object(s.fixtures, "fixtures", ["accounts", "tokens", "topics"]);
  const accounts: LabFixtures["accounts"] = {};
  for (const [key, value] of Object.entries(object(f.accounts, "accounts"))) {
    const a = object(value, `account ${key}`, ["hbar"]);
    accounts[name(key)] = { hbar: hbar(a.hbar, "hbar", 0, 1000) };
  }
  if (Object.keys(accounts).length === 0 || Object.keys(accounts).length > 20) throw new Error("fixtures requires 1–20 accounts");
  const tokens: LabFixtures["tokens"] = {};
  for (const [key, value] of Object.entries(object(f.tokens ?? {}, "tokens"))) {
    const t = object(value, `token ${key}`, ["treasury", "supply"]);
    reference(t.treasury, accounts, "treasury");
    tokens[name(key)] = { treasury: t.treasury as string, supply: integer(t.supply, "supply", 1, 10) };
  }
  const topics = strings(f.topics ?? [], "topics").map(name);
  if (topics.length > 20 || Object.keys(tokens).length > 20) throw new Error("Maximum 20 tokens and topics per scenario");
  const fixtures = { accounts, tokens, topics };
  const fault = object(s.faults ?? {}, "faults", ["mirrorDelayMs", "rejectActors"]);
  const faults = { mirrorDelayMs: num(fault.mirrorDelayMs ?? 0, "mirrorDelayMs", 0, 60_000), rejectActors: strings(fault.rejectActors ?? [], "rejectActors") };
  for (const actor of faults.rejectActors) reference(actor, accounts, "rejectActors");
  if (network.mode !== "simulated" && (faults.mirrorDelayMs || faults.rejectActors.length)) throw new Error("Fault injection requires simulated mode; live errors must come from real state");
  let server: LabScenario["server"];
  if (s.server !== undefined) {
    const v = object(s.server, "server", ["command", "url", "timeoutMs"]);
    server = { command: str(v.command, "server.command"), url: localUrl(str(v.url, "server.url")), timeoutMs: num(v.timeoutMs ?? 30_000, "server.timeoutMs", 100, 120_000) };
  }
  if (!Array.isArray(s.steps) || !s.steps.length || s.steps.length > 200) throw new Error("steps requires 1–200 entries");
  const ids = new Set<string>();
  const steps: LabStep[] = s.steps.map(value => {
    const step = object(value, "step", ["id", "operation", "planOperation", "assert", "browser", "expectStatus"]);
    const id = name(str(step.id, "step.id"));
    if (["fixtures", "cleanup", "run-error", "runtime-cleanup"].includes(id)) throw new Error(`Reserved step id ${id}`);
    if (ids.has(id)) throw new Error(`Duplicate step id ${id}`); ids.add(id);
    if ([step.operation, step.planOperation, step.assert, step.browser].filter(v => v !== undefined).length !== 1) throw new Error(`${id}: exactly one operation, planOperation, assert, or browser required`);
    const out: LabStep = { id };
    if (step.operation !== undefined) out.operation = parseOperation(step.operation, fixtures);
    if (step.planOperation !== undefined) {
      const p = object(step.planOperation, "planOperation", ["file", "index"]);
      const file = str(p.file, "planOperation.file");
      if (!/^[A-Za-z0-9_-][A-Za-z0-9_./-]*\.json$/.test(file) || file.split("/").some(v => !v || v === "." || v === "..")) throw new Error("planOperation.file must be a relative JSON workspace path");
      out.planOperation = { file, index: integer(p.index, "planOperation.index", 0, 19) };
    }
    if (step.assert !== undefined) out.assert = assertion(step.assert, fixtures);
    if (step.expectStatus !== undefined) {
      if (!out.operation && !out.planOperation) throw new Error("expectStatus requires operation");
      out.expectStatus = str(step.expectStatus, "expectStatus");
      if (!/^[A-Z][A-Z0-9_]+$/.test(out.expectStatus)) throw new Error("expectStatus must be a status code");
    }
    if (step.browser !== undefined) {
      const b = object(step.browser, "browser", ["type", "path", "selector", "value"]);
      if (b.type === "goto") {
        object(b, "browser", ["type", "path"]);
        const route = str(b.path, "browser.path");
        if (!route.startsWith("/") || route.startsWith("//") || route.includes("\\")) throw new Error("browser.path must be an app-relative path");
      } else if (b.type === "click" || b.type === "fill") {
        object(b, "browser", b.type === "click" ? ["type", "selector"] : ["type", "selector", "value"]);
        str(b.selector, "selector"); if (b.type === "fill") str(b.value, "value");
      } else throw new Error("Unknown browser action");
      out.browser = b as unknown as BrowserAction;
    }
    if ((out.browser || out.assert?.type === "text") && !server) throw new Error("Browser actions/assertions require server");
    return out;
  });
  if (!steps.some(step => step.assert)) throw new Error("At least one assertion is required");
  return { schemaVersion: 1, name: str(s.name, "name"), network: network as unknown as LabNetwork, fixtures, faults, server, steps, timeoutMs: num(s.timeoutMs ?? 10_000, "timeoutMs", 10, 120_000), pollIntervalMs: num(s.pollIntervalMs ?? 100, "pollIntervalMs", 1, 5000) };
}
export function localUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash) throw new Error("Expected an HTTP loopback URL without credentials, query, or fragment");
  return value.replace(/\/$/, "");
}
export async function loadScenario(file: string): Promise<{ scenario: LabScenario; hash: string }> {
  const raw = await readFile(file, "utf8");
  return { scenario: parseScenario(parse(raw)), hash: createHash("sha256").update(raw).digest("hex") };
}
