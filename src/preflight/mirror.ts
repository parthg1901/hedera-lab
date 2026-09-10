import {
  MAINNET_MIRROR,
  type Observation,
  type Proposal,
  type Snapshot,
  validateProposal,
} from "./model.js";
/** Read/simulate only. No SDK signer, private key, relay transaction method or caller-supplied URL. */
export class MainnetMirror {
  async snapshot(): Promise<Snapshot> {
    const r = await fetch(MAINNET_MIRROR + "/blocks?limit=1&order=desc", {
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error("Block discovery HTTP " + r.status);
    const b = ((await r.json()) as any).blocks?.[0];
    if (!b || !/^\d+$/.test(String(b.number)) || typeof b.hash !== "string")
      throw new Error("Invalid block response");
    return {
      network: "hedera-mainnet",
      block: String(b.number),
      blockHash: b.hash,
      timestamp: b.timestamp,
    };
  }
  async call(
    proposal: Proposal,
    snapshot: Snapshot,
    estimate = false,
  ): Promise<Observation> {
    validateProposal(proposal);
    if (snapshot.network !== "hedera-mainnet" || !/^\d+$/.test(snapshot.block))
      throw new Error("A fixed mainnet block is required");
    if (BigInt(proposal.value) > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Native value exceeds lossless mirror JSON range");
    const request = {
      block: snapshot.block,
      from: proposal.from,
      to: proposal.to,
      data: proposal.data,
      value: Number(proposal.value),
      gas: proposal.gas,
      estimate,
    };
    const started = Date.now();
    const r = await fetch(MAINNET_MIRROR + "/contracts/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await r.text();
    if (raw.length > 1_000_000) throw new Error("Mirror response too large");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = { unparsed: true };
    }
    return {
      request,
      httpStatus: r.status,
      body,
      durationMs: Date.now() - started,
      observedAt: new Date().toISOString(),
    };
  }
}
