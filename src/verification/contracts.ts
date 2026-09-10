import { loadScenario } from "../lab/schema.js";
import { amount, Fault, type Pack } from "./model.js";

export type Environment =
  | "simulated"
  | "local"
  | "testnet"
  | "mainnet-preflight";
export interface FundingTerms {
  tokenCreateMaxTinybar?: string;
  estimatedFeeTinybar: string;
  feeCeilingTinybar: string;
  cleanupReserveTinybar: string;
  perTransactionMaxTinybar: string;
}
export interface ExecutionTerms {
  tokenCreateMaxTinybar: string;
  environment: Environment;
  access: "simulated" | "ledger-write" | "read-only";
  fundingNetwork: "none" | "local" | "testnet";
  fixtureFundingTinybar: string;
  estimatedFeeTinybar: string;
  feeCeilingTinybar: string;
  cleanupReserveTinybar: string;
  perTransactionMaxTinybar: string;
  maximumExposureTinybar: string;
  fundingSource: "provider";
  fundingTreatment: string;
  evidence: string[];
}
export const environments: Environment[] = [
  "simulated",
  "local",
  "testnet",
  "mainnet-preflight",
];
export function validateEnvironments(value: unknown): Environment[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((x) => !environments.includes(x)) ||
    new Set(value).size !== value.length
  )
    throw new Fault(400, "Choose unique supported execution environments");
  return value;
}
export async function executionTerms(pack: Pack): Promise<ExecutionTerms> {
  let environment: Environment;
  let fixture = 0n;
  if (pack.driver === "mainnet-preflight") environment = "mainnet-preflight";
  else if (
    pack.driver === "ticket-protocol" ||
    pack.driver === "exchange-protocol"
  )
    environment = "simulated";
  else {
    const { scenario } = await loadScenario(pack.scenario);
    environment = scenario.network.mode;
    for (const account of Object.values(scenario.fixtures.accounts)) {
      const tinybar = Math.round(account.hbar * 100000000);
      if (!Number.isSafeInteger(tinybar) || tinybar < 0)
        throw new Fault(400, "Fixture funding exceeds supported precision");
      fixture += BigInt(tinybar);
    }
  }
  const live = environment === "local" || environment === "testnet";
  const f = live ? pack.funding : undefined;
  if (f) {
    for (const v of Object.values(f)) amount(v);
    if (
      amount(f.perTransactionMaxTinybar) === 0n ||
      amount(f.feeCeilingTinybar) < amount(f.estimatedFeeTinybar) ||
      amount(f.cleanupReserveTinybar) >= amount(f.feeCeilingTinybar)
    )
      throw new Fault(400, "Invalid live execution funding limits");
  }
  const fees = f?.feeCeilingTinybar ?? "0";
  return {
    environment,
    access: live
      ? "ledger-write"
      : environment === "mainnet-preflight"
        ? "read-only"
        : "simulated",
    fundingNetwork:
      environment === "local" || environment === "testnet"
        ? environment
        : "none",
    fixtureFundingTinybar: live ? fixture.toString() : "0",
    estimatedFeeTinybar: f?.estimatedFeeTinybar ?? "0",
    feeCeilingTinybar: fees,
    cleanupReserveTinybar: f?.cleanupReserveTinybar ?? "0",
    perTransactionMaxTinybar: f?.perTransactionMaxTinybar ?? "0",
    tokenCreateMaxTinybar:
      f?.tokenCreateMaxTinybar ?? f?.perTransactionMaxTinybar ?? "0",
    maximumExposureTinybar: (amount(fees) + (live ? fixture : 0n)).toString(),
    fundingSource: "provider",
    fundingTreatment: live
      ? "Provider supplies testing funds; not added to the x402 service price. Fixture funding is temporary capital, not a fee. Unknown or unrecovered amounts remain explicit."
      : "No application network funds required. Service price covers execution and evidence.",
    evidence:
      environment === "mainnet-preflight"
        ? [
            "Mainnet state reference",
            "Call simulation and gas estimate",
            "Approval policy checks",
            "No transaction submitted",
          ]
        : live
          ? [
              "SDK transaction IDs",
              "Independent mirror assertions",
              "Cleanup outcome",
              "Network spending reconciliation",
            ]
          : [
              "Controlled scenario assertions",
              "Execution environment labels",
              "Browser results when applicable",
            ],
  };
}

/** Keep an agent's proposal inside separately denominated execution ceilings.
 * Never exchange local/testnet funding for service-payment budget. */
export function fitExecutionExposure(
  selection: import("./model.js").Selection[],
  required: string[],
  packs: Array<{ id: string; execution: ExecutionTerms }>,
  available: Partial<Record<"local" | "testnet", string>>,
) {
  const result = structuredClone(selection);
  for (const network of ["local", "testnet"] as const) {
    const cost = (s: import("./model.js").Selection) => {
      const terms = packs.find((p) => p.id === s.pack)?.execution;
      return terms?.fundingNetwork === network
        ? amount(terms.maximumExposureTinybar)
        : 0n;
    };
    const total = () =>
      result.reduce((n, s) => n + cost(s) * BigInt(s.repetitions), 0n);
    while (total() > amount(available[network] ?? "0")) {
      const candidate = result
        .filter(
          (s) =>
            cost(s) > 0n && (s.repetitions > 1 || !required.includes(s.pack)),
        )
        .sort((a, b) => Number(cost(b) - cost(a)))[0];
      if (!candidate)
        throw new Fault(
          422,
          `Mandatory ${network} exposure cannot fit the authorized execution ceiling`,
        );
      if (candidate.repetitions > 1) candidate.repetitions--;
      else result.splice(result.indexOf(candidate), 1);
    }
  }
  return result;
}
