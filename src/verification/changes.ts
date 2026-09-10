import { amount, Fault, hash, type Pack, type Selection } from "./model.js";
export interface ChangeSet {
  files: string[];
  summary: string;
  patch?: string;
}
export interface Recommendation {
  pack: string;
  mandatory: boolean;
  score: number;
  reasons: string[];
  priceTinybar: string;
}
export function validateChanges(value: unknown): ChangeSet {
  const c = value as ChangeSet;
  if (
    !c ||
    !Array.isArray(c.files) ||
    c.files.length > 100 ||
    c.files.some(
      (f) => typeof f !== "string" || f.length > 300 || f.includes("\0"),
    ) ||
    typeof c.summary !== "string" ||
    c.summary.length > 4000 ||
    (c.patch !== undefined &&
      (typeof c.patch !== "string" || c.patch.length > 50000))
  )
    throw new Fault(400, "Invalid change description");
  return {
    files: [...new Set(c.files)].sort(),
    summary: c.summary,
    ...(c.patch ? { patch: c.patch } : {}),
  };
}
const rules: [string, RegExp, string][] = [
  [
    "payment",
    /pay(?:ment|load|er)?|settle|x402|invoice|quote|fee/i,
    "Payment or settlement changes",
  ],
  [
    "replay",
    /retry|replay|idempot|duplicate|purchase|buy|check.?in/i,
    "Retry, purchase, or idempotency changes",
  ],
  [
    "concurrency",
    /concurr|parallel|queue|lock|mutex|budget|balance|reserve/i,
    "Concurrency or shared-state changes",
  ],
  [
    "recovery",
    /timeout|receipt|unknown|recover|network|mirror|observe/i,
    "Uncertain outcomes or network recovery changes",
  ],
  [
    "ownership",
    /token|nft|transfer|associat|owner|ticket/i,
    "Token ownership or association changes",
  ],
  [
    "delivery",
    /message|attendance|check.?in|hcs|submit|deliver/i,
    "Service delivery or attendance changes",
  ],
];
export function recommend(
  packs: Pack[],
  required: string[],
  changes: ChangeSet,
) {
  const c = validateChanges(changes);
  const text = [...c.files, c.summary, c.patch ?? ""].join("\n");
  const matched = rules.filter(([, pattern]) => pattern.test(text));
  const recommendations: Recommendation[] = packs
    .map((p) => {
      const relevant = matched.filter(([risk]) =>
        (p.risks ?? []).includes(risk),
      );
      const mandatory = required.includes(p.id);
      return {
        pack: p.id,
        mandatory,
        score: (mandatory ? 1000 : 0) + relevant.length * 10,
        reasons: [
          ...(mandatory ? ["Customer-required acceptance check"] : []),
          ...relevant.map(([, , reason]) => reason),
        ],
        priceTinybar: p.priceTinybar,
      };
    })
    .sort((a, b) => b.score - a.score || a.pack.localeCompare(b.pack));
  return {
    source: "caller-declared changes; not a verified Git diff",
    changeHash: hash(c),
    changes: c,
    matchedRisks: matched.map(([risk]) => risk),
    recommendations,
  };
}
export function selectCoverage(
  recommendations: Recommendation[],
  budget: string,
) {
  let remaining = amount(budget);
  const selection: Selection[] = [];
  const omitted: Recommendation[] = [];
  for (const r of recommendations.filter((r) => r.mandatory)) {
    remaining -= amount(r.priceTinybar);
    if (remaining < 0n)
      throw new Fault(
        402,
        "Mandatory coverage exceeds the available allocation",
      );
    selection.push({ pack: r.pack, repetitions: 1 });
  }
  for (const r of recommendations.filter((r) => !r.mandatory)) {
    if (r.score > 0 && amount(r.priceTinybar) <= remaining) {
      selection.push({ pack: r.pack, repetitions: 1 });
      remaining -= amount(r.priceTinybar);
    } else omitted.push(r);
  }
  return {
    selection,
    price: (amount(budget) - remaining).toString(),
    remaining: remaining.toString(),
    omitted,
    rationale:
      "Buy mandatory coverage first, then distinct checks relevant to the declared changes. Repetitions do not substitute for coverage.",
  };
}
