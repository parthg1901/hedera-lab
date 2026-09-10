import { createHash } from "node:crypto";
export const SAUCE_TOKEN = "0x00000000000000000000000000000000000b2ad5";
export const MAINNET_MIRROR = "https://mainnet.mirrornode.hedera.com/api/v1";
export interface Proposal {
  network: "hedera-mainnet";
  from: string;
  to: string;
  data: string;
  value: string;
  gas: number;
}
export interface Policy {
  integration: "saucerswap-sauce-approval-v1";
  network: "hedera-mainnet";
  owner: string;
  token: string;
  spender: string;
  minAllowance: string;
  maxAllowance: string;
  maxGas: number;
}
export interface Observation {
  request: Record<string, unknown>;
  httpStatus: number;
  body: unknown;
  durationMs: number;
  observedAt: string;
}
export interface Snapshot {
  network: "hedera-mainnet";
  block: string;
  blockHash: string;
  timestamp: unknown;
}
export interface Check {
  id: string;
  status: "passed" | "failed" | "unknown";
  message: string;
  expected?: unknown;
  observed?: unknown;
}
export const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function address(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error("Expected a 20-byte EVM address");
  return value.toLowerCase();
}
export function uint(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]{0,77})$/.test(value) ||
    BigInt(value) >= 1n << 256n
  )
    throw new Error("Expected a uint256 decimal string");
  return BigInt(value);
}
export function validatePolicy(value: Policy): Policy {
  if (
    !value ||
    value.integration !== "saucerswap-sauce-approval-v1" ||
    value.network !== "hedera-mainnet"
  )
    throw new Error("Unsupported policy integration/network");
  for (const k of ["owner", "token", "spender"] as const) address(value[k]);
  if (address(value.token) !== SAUCE_TOKEN)
    throw new Error(
      "This integration supports the canonical mainnet SAUCE token only",
    );
  if (uint(value.minAllowance) > uint(value.maxAllowance))
    throw new Error("Invalid allowance bounds");
  if (
    !Number.isSafeInteger(value.maxGas) ||
    value.maxGas < 21000 ||
    value.maxGas > 15000000
  )
    throw new Error("Invalid gas ceiling");
  return value;
}
export function encodeApproval(spender: string, amount: string) {
  return (
    "0x095ea7b3" +
    address(spender).slice(2).padStart(64, "0") +
    uint(amount).toString(16).padStart(64, "0")
  );
}
export function decodeApproval(data: unknown) {
  if (
    typeof data !== "string" ||
    !/^0x095ea7b3[0-9a-fA-F]{128}$/.test(data) ||
    !/^0{24}$/.test(data.slice(10, 34))
  )
    throw new Error(
      "Expected canonical approve(address,uint256) calldata without trailing bytes",
    );
  return {
    spender: address("0x" + data.slice(34, 74)),
    allowance: BigInt("0x" + data.slice(74)).toString(),
  };
}
export function validateProposal(p: Proposal) {
  if (!p || p.network !== "hedera-mainnet")
    throw new Error("Unsupported proposal network");
  address(p.from);
  address(p.to);
  uint(p.value);
  if (
    typeof p.data !== "string" ||
    !/^0x(?:[0-9a-fA-F]{2}){0,4096}$/.test(p.data)
  )
    throw new Error("Invalid calldata");
  if (!Number.isSafeInteger(p.gas) || p.gas < 21000 || p.gas > 15000000)
    throw new Error("Invalid gas limit");
  return p;
}
